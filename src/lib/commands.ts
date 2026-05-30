import { getServiceClient } from './supabase';

export interface CommandResult {
  handled: boolean;
  reply: string;
}

function formatTaskLine(task: { task: string; due_date: string | null; priority: string }, index: number) {
  const time = task.due_date
    ? new Date(task.due_date).toLocaleString('id-ID', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jakarta',
      })
    : 'no deadline';
  const icon = task.priority === 'high' ? '🔴' : task.priority === 'low' ? '🟢' : '🟡';

  return `${index + 1}. ${icon} ${task.task} — ${time}`;
}

export async function handleCommand(message: string, userPhone: string): Promise<CommandResult> {
  const text = message.trim().toLowerCase();
  const sb = getServiceClient();

  if (text === 'help' || text === 'bantuan') {
    return {
      handled: true,
      reply: `🤖 *PMO Pulse Commands*

📝 Add task: just type naturally
  "Tasya weekly report BCA Jumat jam 4 sore"

📋 *list* — your tasks today
📋 *mine* — all your pending
📋 *team* — team-wide pending
✅ *done [keyword]* — mark complete
🗑 *delete [keyword]* — remove
📊 *report* — generate weekly status
🌐 *dashboard* — web app link`,
    };
  }

  if (text === 'list' || text === 'today') {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const { data } = await sb
      .from('tasks')
      .select('task, due_date, priority')
      .eq('assignee_phone', userPhone)
      .eq('status', 'pending')
      .or(`due_date.is.null,and(due_date.gte.${startOfDay.toISOString()},due_date.lte.${endOfDay.toISOString()})`)
      .order('due_date', { ascending: true, nullsFirst: false });

    if (!data || data.length === 0) return { handled: true, reply: '✨ No tasks today.' };
    return { handled: true, reply: `📋 *Today:*

${data.map(formatTaskLine).join('\n')}` };
  }

  if (text === 'mine') {
    const { data } = await sb
      .from('tasks')
      .select('task, due_date, priority')
      .eq('assignee_phone', userPhone)
      .eq('status', 'pending')
      .order('due_date', { ascending: true, nullsFirst: false });

    if (!data || data.length === 0) return { handled: true, reply: '✨ No pending tasks.' };
    return { handled: true, reply: `📋 *Your pending tasks:*

${data.map(formatTaskLine).join('\n')}` };
  }

  if (text === 'team') {
    const { data } = await sb
      .from('tasks')
      .select('task, due_date, priority')
      .eq('status', 'pending')
      .order('due_date', { ascending: true, nullsFirst: false })
      .limit(20);

    if (!data || data.length === 0) return { handled: true, reply: '✨ No team pending tasks.' };
    return { handled: true, reply: `📋 *Team pending tasks:*

${data.map(formatTaskLine).join('\n')}` };
  }

  if (text.startsWith('done ') || text.startsWith('selesai ')) {
    return updateTaskByKeyword(message, userPhone, 'done');
  }

  if (text.startsWith('delete ') || text.startsWith('hapus ')) {
    return updateTaskByKeyword(message, userPhone, 'cancelled');
  }

  if (text === 'report') {
    const res = await fetch(`${process.env.APP_URL}/api/agents/report?phone=${encodeURIComponent(userPhone)}`, { method: 'POST' });
    return { handled: true, reply: res.ok ? '📊 Generating weekly report and emailing stakeholders...' : '❌ Report generation failed' };
  }

  if (text === 'dashboard') return { handled: true, reply: `🌐 ${process.env.APP_URL}` };

  return { handled: false, reply: '' };
}

async function updateTaskByKeyword(message: string, userPhone: string, status: 'done' | 'cancelled'): Promise<CommandResult> {
  const keyword = message.replace(/^(done|selesai|delete|hapus)\s+/i, '').trim();
  const sb = getServiceClient();
  const { data: matches } = await sb
    .from('tasks')
    .select('id, task')
    .eq('assignee_phone', userPhone)
    .eq('status', 'pending')
    .ilike('task', `%${keyword}%`);

  if (!matches || matches.length === 0) return { handled: true, reply: `❌ No match for "${keyword}"` };
  if (matches.length > 1) return { handled: true, reply: `🤔 Multiple matches:\n${matches.slice(0, 5).map((t, i) => `${i + 1}. ${t.task}`).join('\n')}` };

  await sb
    .from('tasks')
    .update({ status, completed_at: status === 'done' ? new Date().toISOString() : null })
    .eq('id', matches[0].id);

  return { handled: true, reply: status === 'done' ? `✅ Done: *${matches[0].task}*` : `🗑 Deleted: *${matches[0].task}*` };
}
