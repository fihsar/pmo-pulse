import { NextRequest, NextResponse } from 'next/server';
import { logAuditEvent } from '@/lib/agents/audit';
import { validateCronRequest } from '@/lib/cron';
import { sendWhatsApp } from '@/lib/integrations/twilio';
import { getServiceClient } from '@/lib/supabase';

type ReminderType = 'due_soon' | 'overdue';

function formatDueDate(value: string) {
  return new Date(value).toLocaleString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  });
}

function getReminderCooldownHours() {
  const parsed = Number.parseInt(process.env.REMINDER_COOLDOWN_HOURS || '20', 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(1, parsed);
}

function getReminderLeadHours() {
  const parsed = Number.parseInt(process.env.REMINDER_LEAD_HOURS || '24', 10);
  if (!Number.isFinite(parsed)) return 24;
  return Math.max(1, parsed);
}

function isOlderThanHours(value: string | null, hours: number, now: Date) {
  if (!value) return true;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return true;
  return now.getTime() - ts >= hours * 60 * 60 * 1000;
}

function formatReminderMessage(task: {
  task: string;
  project: string | null;
  due_date: string;
  priority: string;
  status: string;
}, type: ReminderType) {
  const typeLabel = type === 'overdue' ? 'OVERDUE' : 'Due soon';
  const project = task.project ? `🏷 ${task.project}\n` : '';
  const due = `📅 ${formatDueDate(task.due_date)} WIB\n`;
  const pri = `⚡ ${task.priority.toUpperCase()}\n`;
  const status = `📌 ${task.status.toUpperCase()}\n`;
  return `⏰ Task reminder (${typeLabel})\n\n*${task.task}*\n${project}${due}${pri}${status}\nReply with:\n- done <keyword>\n- delete <keyword>`;
}

export async function GET(req: NextRequest) {
  const validation = validateCronRequest(req);
  if (validation) return validation;

  const leadHours = getReminderLeadHours();
  const cooldownHours = getReminderCooldownHours();
  const now = new Date();
  const soonThreshold = new Date(now.getTime() + leadHours * 60 * 60 * 1000);
  const sb = getServiceClient();

  const { data: tasks, error } = await sb
    .from('tasks')
    .select('id, task, project, due_date, priority, status, assignee_phone, due_soon_reminded_at, overdue_reminded_at')
    .in('status', ['pending', 'in_progress'])
    .not('due_date', 'is', null)
    .order('due_date', { ascending: true });

  if (error) {
    return NextResponse.json({ status: 'task_load_failed' }, { status: 500 });
  }

  let checked = 0;
  let dueSoonSent = 0;
  let overdueSent = 0;

  for (const task of tasks || []) {
    checked++;
    const dueDate = task.due_date ? new Date(task.due_date) : null;
    if (!dueDate) continue;

    const isOverdue = dueDate.getTime() < now.getTime();
    const isDueSoon = !isOverdue && dueDate.getTime() <= soonThreshold.getTime();

    let reminderType: ReminderType | null = null;
    if (isOverdue && isOlderThanHours(task.overdue_reminded_at ?? null, cooldownHours, now)) {
      reminderType = 'overdue';
    } else if (isDueSoon && !task.due_soon_reminded_at) {
      reminderType = 'due_soon';
    }

    if (!reminderType) continue;

    try {
      await sendWhatsApp(
        task.assignee_phone,
        formatReminderMessage(
          {
            task: task.task,
            project: task.project,
            due_date: task.due_date,
            priority: task.priority,
            status: task.status,
          },
          reminderType
        )
      );

      const update: Record<string, string> = {};
      if (reminderType === 'due_soon') update.due_soon_reminded_at = now.toISOString();
      if (reminderType === 'overdue') update.overdue_reminded_at = now.toISOString();

      await sb
        .from('tasks')
        .update(update)
        .eq('id', task.id);

      await logAuditEvent({
        event_type: 'task_reminder_sent',
        actor_phone: 'system',
        target_id: task.id,
        payload: {
          reminder_type: reminderType,
          assignee_phone: task.assignee_phone,
          due_date: task.due_date,
        },
      });

      if (reminderType === 'due_soon') dueSoonSent++;
      if (reminderType === 'overdue') overdueSent++;
    } catch (err) {
      console.error('Reminder send failed:', err);
      await logAuditEvent({
        event_type: 'task_reminder_failed',
        actor_phone: 'system',
        target_id: task.id,
        payload: { reminder_type: reminderType },
      });
    }
  }

  return NextResponse.json({
    status: 'ok',
    checked,
    due_soon_sent: dueSoonSent,
    overdue_sent: overdueSent,
    lead_hours: leadHours,
    cooldown_hours: cooldownHours,
  });
}

