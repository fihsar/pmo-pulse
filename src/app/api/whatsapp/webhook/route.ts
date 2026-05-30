import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
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

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeAssigneeReply(value: string) {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return null;
  if (lower === 'me' || lower === 'saya' || lower === 'aku') return null;
  return trimmed;
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

    const { data: openClarification } = await sb
      .from('pending_clarifications')
      .select('id, original_message, missing_fields, partial_task')
      .eq('user_phone', userPhone)
      .is('resolved_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (
      openClarification &&
      Array.isArray(openClarification.missing_fields) &&
      openClarification.missing_fields.length === 1 &&
      openClarification.missing_fields[0] === 'assignee' &&
      openClarification.partial_task &&
      typeof openClarification.partial_task === 'object' &&
      openClarification.partial_task !== null
    ) {
      const partial = openClarification.partial_task as Record<string, unknown>;
      const assigneeHint = normalizeAssigneeReply(message);
      const taskText = typeof partial.task === 'string' ? partial.task : '';
      const priority = partial.priority === 'high' || partial.priority === 'medium' || partial.priority === 'low' ? partial.priority : 'medium';
      const dueDate = typeof partial.due_date === 'string' || partial.due_date === null ? (partial.due_date as string | null) : null;
      const project = typeof partial.project === 'string' || partial.project === null ? (partial.project as string | null) : null;
      const confidence = typeof partial.confidence === 'number' ? partial.confidence : 0.7;

      if (taskText.trim()) {
        await sb
          .from('pending_clarifications')
          .update({ resolved_at: new Date().toISOString() })
          .eq('id', openClarification.id);

        void logAuditEvent({
          event_type: 'task_parse_clarification_resolved',
          actor_phone: userPhone,
          payload: {
            missing_fields: openClarification.missing_fields,
            message_hash: sha256(openClarification.original_message),
          },
        }).catch((err) => console.error('Audit log failed:', err));

        const routed = await routeTask(userPhone, assigneeHint);
        if (!routed) return twimlReply("❌ Couldn't determine assignee. Please retry.");

        const { data: task, error } = await sb
          .from('tasks')
          .insert({
            creator_phone: userPhone,
            assignee_phone: routed.assignee_phone,
            task: taskText.trim(),
            project,
            due_date: dueDate,
            priority,
            raw_message: openClarification.original_message,
            parser_confidence: confidence,
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
            payload: { task: taskText.trim(), assignee: routed.assignee_phone, project },
          }),
        ];

        if (dueDate) {
          const start = new Date(dueDate);
          const end = new Date(start.getTime() + 30 * 60 * 1000);
          fanOut.push(createCalendarEvent({
            summary: taskText.trim(),
            startISO: start.toISOString(),
            endISO: end.toISOString(),
            description: `Project: ${project ?? '—'}\nAssigned to: ${routed.assignee_name}`,
          }).catch((e) => console.error('cal err', e)));
        }

        if (!routed.is_self) {
          fanOut.push(sendWhatsApp(
            routed.assignee_phone,
            `📌 New task assigned by ${userPhone}:\n\n*${taskText.trim()}*\n📅 ${formatDueDate(dueDate)}\n🏷 ${project ?? '—'}`
          ).catch((e) => console.error('wa err', e)));
        }

        void Promise.all(fanOut);

        const priIcon = priority === 'high' ? '🔴' : priority === 'low' ? '🟢' : '🟡';
        const assigneeLine = routed.is_self ? '' : `\n👤 Assigned to: ${routed.assignee_name}`;
        const overloadWarn = routed.was_overloaded ? `\n⚠️ Note: ${routed.assignee_name} has > 15 pending tasks.` : '';
        const calLine = dueDate ? '\n📅 Calendar event created' : '';

        return twimlReply(`✅ Saved!\n\n${priIcon} *${taskText.trim()}*\n📅 ${formatDueDate(dueDate)}${assigneeLine}${overloadWarn}${calLine}`);
      }
    }

    const messageForParse = openClarification
      ? `${openClarification.original_message}\nKlarifikasi pengguna: ${message}`
      : message;

    const parsed = await parseTaskFromMessage(messageForParse);

    if (parsed.status === 'needs_clarification') {
      void logAuditEvent({
        event_type: 'task_parse_needs_clarification',
        actor_phone: userPhone,
        payload: {
          missing_fields: parsed.missing_fields,
          has_open_clarification: Boolean(openClarification),
          has_partial_task: Boolean(parsed.partial_task),
          message_hash: sha256(messageForParse),
        },
      }).catch((err) => console.error('Audit log failed:', err));

      if (openClarification) {
        await sb
          .from('pending_clarifications')
          .update({
            question: parsed.question,
            missing_fields: parsed.missing_fields,
            partial_task: parsed.partial_task ?? null,
          })
          .eq('id', openClarification.id);
      } else {
        await sb
          .from('pending_clarifications')
          .insert({
            user_phone: userPhone,
            original_message: message,
            question: parsed.question,
            missing_fields: parsed.missing_fields,
            partial_task: parsed.partial_task ?? null,
          });
      }

      return twimlReply(`🤔 ${parsed.question}`);
    }

    if (parsed.status === 'error') {
      const logIncludeMessage = process.env.LOG_PARSER_MESSAGES === 'true';
      const logIncludeModelOutput = process.env.LOG_PARSER_MODEL_OUTPUT === 'true';

      void logAuditEvent({
        event_type: 'task_parse_failed',
        actor_phone: userPhone,
        payload: {
          reason: parsed.reason,
          has_open_clarification: Boolean(openClarification),
          message_hash: sha256(messageForParse),
          message: logIncludeMessage ? messageForParse : undefined,
          model_output: logIncludeModelOutput ? parsed.raw_output?.slice(0, 2000) : undefined,
        },
      }).catch((err) => console.error('Audit log failed:', err));

      return twimlReply("🤔 I couldn't parse that. Try being specific. Type 'help' for commands.");
    }

    if (openClarification) {
      await sb
        .from('pending_clarifications')
        .update({ resolved_at: new Date().toISOString() })
        .eq('id', openClarification.id);
    }

    const parsedTask = parsed.task;

    const routed = await routeTask(userPhone, parsedTask.assignee_hint);
    if (!routed) return twimlReply("❌ Couldn't determine assignee. Please retry.");

    const { data: task, error } = await sb
      .from('tasks')
      .insert({
        creator_phone: userPhone,
        assignee_phone: routed.assignee_phone,
        task: parsedTask.task,
        project: parsedTask.project,
        due_date: parsedTask.due_date,
        priority: parsedTask.priority,
        raw_message: message,
        parser_confidence: parsedTask.confidence,
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
        payload: { task: parsedTask.task, assignee: routed.assignee_phone, project: parsedTask.project },
      }),
    ];

    if (parsedTask.due_date) {
      const start = new Date(parsedTask.due_date);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      fanOut.push(createCalendarEvent({
        summary: parsedTask.task,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
        description: `Project: ${parsedTask.project ?? '—'}\nAssigned to: ${routed.assignee_name}`,
      }).catch((e) => console.error('cal err', e)));
    }

    if (!routed.is_self) {
      fanOut.push(sendWhatsApp(
        routed.assignee_phone,
        `📌 New task assigned by ${userPhone}:\n\n*${parsedTask.task}*\n📅 ${formatDueDate(parsedTask.due_date)}\n🏷 ${parsedTask.project ?? '—'}`
      ).catch((e) => console.error('wa err', e)));
    }

    void Promise.all(fanOut);

    const priIcon = parsedTask.priority === 'high' ? '🔴' : parsedTask.priority === 'low' ? '🟢' : '🟡';
    const assigneeLine = routed.is_self ? '' : `\n👤 Assigned to: ${routed.assignee_name}`;
    const overloadWarn = routed.was_overloaded ? `\n⚠️ Note: ${routed.assignee_name} has > 15 pending tasks.` : '';
    const calLine = parsedTask.due_date ? '\n📅 Calendar event created' : '';

    return twimlReply(`✅ Saved!\n\n${priIcon} *${parsedTask.task}*\n📅 ${formatDueDate(parsedTask.due_date)}${assigneeLine}${overloadWarn}${calLine}`);
  } catch (err) {
    console.error('Webhook error:', err);
    return twimlReply('⚠️ Something went wrong. Please retry.');
  }
}
