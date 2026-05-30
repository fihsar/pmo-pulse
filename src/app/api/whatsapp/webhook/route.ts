import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { logAuditEvent } from '@/lib/agents/audit';
import { parseTaskFromMessage } from '@/lib/agents/parser';
import { routeTask } from '@/lib/agents/router';
import { handleCommand } from '@/lib/commands';
import { createCalendarEvent } from '@/lib/integrations/calendar';
import { sendWhatsApp } from '@/lib/integrations/twilio';
import { getServiceClient } from '@/lib/supabase';

const MessagingResponse = twilio.twiml.MessagingResponse;

function twimlReply(reply: string) {
  const twiml = new MessagingResponse();
  twiml.message(reply);
  return new NextResponse(twiml.toString(), {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

function formatDueDate(dueDate: string | null) {
  if (!dueDate) return 'no deadline';

  return new Date(dueDate).toLocaleString('id-ID', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const message = (formData.get('Body') as string) || '';
    const from = (formData.get('From') as string) || '';
    const userPhone = from.replace('whatsapp:', '');

    if (!message || !userPhone) return new NextResponse('Bad request', { status: 400 });

    const sb = getServiceClient();
    await sb.from('users').upsert(
      { phone: userPhone, display_name: userPhone, last_seen_at: new Date().toISOString() },
      { onConflict: 'phone', ignoreDuplicates: false }
    );

    const cmd = await handleCommand(message, userPhone);
    if (cmd.handled) return twimlReply(cmd.reply);

    const parsed = await parseTaskFromMessage(message);
    if (!parsed) return twimlReply("🤔 I couldn't parse that. Try being specific. Type 'help' for commands.");

    const routed = await routeTask(userPhone, parsed.assignee_hint);
    if (!routed) return twimlReply("❌ Couldn't determine assignee. Please retry.");

    const { data: task, error } = await sb
      .from('tasks')
      .insert({
        creator_phone: userPhone,
        assignee_phone: routed.assignee_phone,
        task: parsed.task,
        project: parsed.project,
        due_date: parsed.due_date,
        priority: parsed.priority,
        raw_message: message,
        parser_confidence: parsed.confidence,
      })
      .select()
      .single();

    if (error || !task) {
      console.error(error);
      return twimlReply('❌ Failed to save task.');
    }

    const fanOut: Promise<unknown>[] = [
      logAuditEvent({
        event_type: 'task_created',
        actor_phone: userPhone,
        target_id: task.id,
        payload: { task: parsed.task, assignee: routed.assignee_phone, project: parsed.project },
      }),
    ];

    if (parsed.due_date) {
      const start = new Date(parsed.due_date);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      fanOut.push(createCalendarEvent({
        summary: parsed.task,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        description: `Project: ${parsed.project ?? '—'}\nAssigned to: ${routed.assignee_name}`,
      }).catch((e) => console.error('cal err', e)));
    }

    if (!routed.is_self) {
      fanOut.push(sendWhatsApp(
        routed.assignee_phone,
        `📌 New task assigned by ${userPhone}:\n\n*${parsed.task}*\n📅 ${formatDueDate(parsed.due_date)}\n🏷 ${parsed.project ?? '—'}`
      ).catch((e) => console.error('wa err', e)));
    }

    void Promise.all(fanOut);

    const priIcon = parsed.priority === 'high' ? '🔴' : parsed.priority === 'low' ? '🟢' : '🟡';
    const assigneeLine = routed.is_self ? '' : `\n👤 Assigned to: ${routed.assignee_name}`;
    const overloadWarn = routed.was_overloaded ? `\n⚠️ Note: ${routed.assignee_name} has > 15 pending tasks.` : '';
    const calLine = parsed.due_date ? '\n📅 Calendar event created' : '';

    return twimlReply(`✅ Saved!\n\n${priIcon} *${parsed.task}*\n📅 ${formatDueDate(parsed.due_date)}${assigneeLine}${overloadWarn}${calLine}`);
  } catch (err) {
    console.error('Webhook error:', err);
    return twimlReply('⚠️ Something went wrong. Please retry.');
  }
}
