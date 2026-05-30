import { GoogleGenAI } from '@google/genai';
import { logAuditEvent } from '@/lib/agents/audit';
import { requireEnv } from '@/lib/env';
import { sendEmail } from '@/lib/integrations/gmail';
import { getServiceClient } from '@/lib/supabase';

interface ReportTask {
  task: string;
  project: string | null;
  status: string;
  due_date: string | null;
  priority: string;
}

export type WeeklyReportResult =
  | { status: 'sent'; rag: string }
  | { status: 'no_tasks' }
  | { status: 'task_load_failed' }
  | { status: 'send_failed' };

function getAiClient() {
  return new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatNarrativeHtml(narrative: string) {
  const safe = escapeHtml(narrative.trim()).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  if (!safe) return '';

  const lines = safe.split(/\r?\n/);
  let output = '';
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-•]\s+(.+)$/);

    if (!trimmed) {
      if (inList) {
        output += '</ul>';
        inList = false;
      }
      output += '<div style="height:10px;line-height:10px">&nbsp;</div>';
      continue;
    }

    if (bullet) {
      if (!inList) {
        output += '<ul style="margin:8px 0 12px 18px;padding:0">';
        inList = true;
      }
      output += `<li style="margin:4px 0;line-height:1.45">${bullet[1]}</li>`;
      continue;
    }

    if (inList) {
      output += '</ul>';
      inList = false;
    }

    output += `<p style="margin:0 0 10px 0;line-height:1.55">${trimmed}</p>`;
  }

  if (inList) output += '</ul>';
  return output;
}

function formatReportDate(value: Date) {
  return value.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  });
}

function formatDueDate(value: string | null) {
  if (!value) return '—';

  return new Date(value).toLocaleString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  });
}

function isOverdue(task: ReportTask, now: Date) {
  return Boolean(task.status === 'pending' && task.due_date && new Date(task.due_date).getTime() < now.getTime());
}

function getRagColor(rag: string) {
  if (rag.includes('RED')) return { bg: '#fee2e2', fg: '#991b1b', dot: '#dc2626' };
  if (rag.includes('AMBER')) return { bg: '#fef3c7', fg: '#92400e', dot: '#f59e0b' };
  return { bg: '#dcfce7', fg: '#166534', dot: '#16a34a' };
}

function getStatusStyle(status: string, overdue: boolean) {
  if (overdue) return { bg: '#fee2e2', fg: '#991b1b', label: 'OVERDUE' };
  if (status === 'blocked') return { bg: '#fee2e2', fg: '#991b1b', label: 'BLOCKED' };
  if (status === 'in_progress') return { bg: '#dbeafe', fg: '#1d4ed8', label: 'IN PROGRESS' };
  if (status === 'done') return { bg: '#dcfce7', fg: '#166534', label: 'DONE' };
  if (status === 'cancelled') return { bg: '#f3f4f6', fg: '#374151', label: 'CANCELLED' };
  return { bg: '#fef3c7', fg: '#92400e', label: 'PENDING' };
}

function renderPill(label: string, style: { bg: string; fg: string }) {
  return `<span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${style.bg};color:${style.fg};font-size:12px;font-weight:700;letter-spacing:0.2px">${escapeHtml(label)}</span>`;
}

function renderTaskTable(tasks: ReportTask[], now: Date) {
  const rows = tasks
    .slice()
    .sort((a, b) => {
      const ao = isOverdue(a, now);
      const bo = isOverdue(b, now);
      if (ao !== bo) return ao ? -1 : 1;

      const ad = a.due_date ? new Date(a.due_date).getTime() : Number.POSITIVE_INFINITY;
      const bd = b.due_date ? new Date(b.due_date).getTime() : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;

      return a.task.localeCompare(b.task);
    })
    .map((task) => {
      const overdue = isOverdue(task, now);
      const statusStyle = getStatusStyle(task.status, overdue);
      const pri = task.priority?.toUpperCase?.() || 'MEDIUM';
      const priStyle = pri === 'HIGH'
        ? { bg: '#fee2e2', fg: '#991b1b' }
        : pri === 'LOW'
          ? { bg: '#dcfce7', fg: '#166534' }
          : { bg: '#fef3c7', fg: '#92400e' };

      return `
        <tr>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;vertical-align:top">
            <div style="font-size:14px;color:#111827;line-height:1.4">${escapeHtml(task.task)}</div>
          </td>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;vertical-align:top;white-space:nowrap">
            ${renderPill(statusStyle.label, statusStyle)}
          </td>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;vertical-align:top;white-space:nowrap">
            ${renderPill(pri, priStyle)}
          </td>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;vertical-align:top;white-space:nowrap;color:#374151;font-size:13px">
            ${escapeHtml(formatDueDate(task.due_date))}
          </td>
        </tr>
      `;
    })
    .join('');

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;background:#ffffff">
      <thead>
        <tr style="background:#f9fafb">
          <th align="left" style="padding:10px 12px;font-size:12px;letter-spacing:0.4px;color:#6b7280">TASK</th>
          <th align="left" style="padding:10px 12px;font-size:12px;letter-spacing:0.4px;color:#6b7280">STATUS</th>
          <th align="left" style="padding:10px 12px;font-size:12px;letter-spacing:0.4px;color:#6b7280">PRIORITY</th>
          <th align="left" style="padding:10px 12px;font-size:12px;letter-spacing:0.4px;color:#6b7280">DUE (WIB)</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function getRag(tasks: ReportTask[]) {
  const blocked = tasks.filter((task) => task.status === 'blocked').length;
  const overdue = tasks.filter((task) => task.due_date && new Date(task.due_date) < new Date() && task.status === 'pending').length;

  if (blocked >= 3 || overdue >= 3) return '🔴 RED';
  if (overdue >= 1) return '🟡 AMBER';
  return '🟢 GREEN';
}

function groupByProject(tasks: ReportTask[]) {
  return tasks.reduce<Record<string, ReportTask[]>>((acc, task) => {
    const project = task.project ?? 'No Project';
    acc[project] = acc[project] ?? [];
    acc[project].push(task);
    return acc;
  }, {});
}

export async function sendWeeklyReportEmail(opts: { requestor: string }): Promise<WeeklyReportResult> {
  const sb = getServiceClient();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: tasks, error } = await sb
    .from('tasks')
    .select('task, project, status, due_date, priority')
    .gte('updated_at', weekAgo)
    .order('project', { ascending: true });

  if (error) return { status: 'task_load_failed' };
  if (!tasks || tasks.length === 0) return { status: 'no_tasks' };

  const typedTasks = tasks as ReportTask[];
  const grouped = groupByProject(typedTasks);
  const rag = getRag(typedTasks);
  const now = new Date();

  const response = await getAiClient().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `Status: ${rag}\nThis week's tasks:\n${JSON.stringify(grouped, null, 2)}\n\nWrite the executive narrative.`,
    config: {
      systemInstruction: 'You are a PMO assistant. Write a concise weekly status report in English. Use formal but warm tone. Max 200 words. Highlight wins, risks, and next steps.',
      temperature: 0.4,
      maxOutputTokens: 800,
    },
  });

  const narrative = response.text ?? '';
  const ragStyle = getRagColor(rag);
  const overdueCount = typedTasks.filter((task) => isOverdue(task, now)).length;
  const blockedCount = typedTasks.filter((task) => task.status === 'blocked').length;
  const openCount = typedTasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled').length;
  const doneCount = typedTasks.filter((task) => task.status === 'done').length;
  const narrativeHtml = formatNarrativeHtml(narrative);

  const htmlBody = `
    <div style="background:#f3f4f6;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:920px;margin:0 auto">
        <tr>
          <td>
            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:18px 18px 12px 18px">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <div>
                  <div style="font-size:26px;font-weight:800;color:#0F1E3D;line-height:1.2">Weekly PMO Status</div>
                  <div style="font-size:13px;color:#6b7280;margin-top:4px">${escapeHtml(formatReportDate(now))}</div>
                </div>
                <div style="text-align:right">
                  <div style="display:inline-block;padding:8px 12px;border-radius:999px;background:${ragStyle.bg};color:${ragStyle.fg};font-weight:800">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${ragStyle.dot};margin-right:8px;vertical-align:middle"></span>
                    ${escapeHtml(rag.replace(/^[^A-Z]+\\s*/, ''))}
                  </div>
                </div>
              </div>
            </div>

            <div style="height:12px"></div>

            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:16px 18px">
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                <tr>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb">
                    <div style="font-size:11px;color:#6b7280;letter-spacing:0.4px">OPEN</div>
                    <div style="font-size:20px;font-weight:800;color:#111827">${openCount}</div>
                  </td>
                  <td style="width:10px"></td>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb">
                    <div style="font-size:11px;color:#6b7280;letter-spacing:0.4px">OVERDUE</div>
                    <div style="font-size:20px;font-weight:800;color:#991b1b">${overdueCount}</div>
                  </td>
                  <td style="width:10px"></td>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb">
                    <div style="font-size:11px;color:#6b7280;letter-spacing:0.4px">BLOCKED</div>
                    <div style="font-size:20px;font-weight:800;color:#991b1b">${blockedCount}</div>
                  </td>
                  <td style="width:10px"></td>
                  <td style="padding:8px 10px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb">
                    <div style="font-size:11px;color:#6b7280;letter-spacing:0.4px">DONE</div>
                    <div style="font-size:20px;font-weight:800;color:#166534">${doneCount}</div>
                  </td>
                </tr>
              </table>
            </div>

            <div style="height:12px"></div>

            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:16px 18px">
              <div style="font-size:16px;font-weight:800;color:#0F1E3D;margin-bottom:8px">Executive Summary</div>
              <div style="font-size:14px;color:#111827">
                ${narrativeHtml || '<span style="color:#6b7280">No narrative generated.</span>'}
              </div>
            </div>

            <div style="height:12px"></div>

            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:16px 18px">
              <div style="font-size:16px;font-weight:800;color:#0F1E3D;margin-bottom:12px">Task Details</div>
              ${Object.entries(grouped).map(([project, items]) => `
                <div style="font-size:14px;font-weight:800;color:#111827;margin:14px 0 8px 0">${escapeHtml(project)}</div>
                ${renderTaskTable(items, now)}
              `).join('')}
            </div>

            <div style="height:14px"></div>
            <div style="text-align:center;font-size:11px;color:#9ca3af">
              Generated by PMO Pulse on TRAE.
            </div>
          </td>
        </tr>
      </table>
    </div>
  `;

  const stakeholderEmails = (process.env.REPORT_RECIPIENTS || 'stakeholder@example.com')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);

  const ragEnglish = rag.replace(/^[^A-Z]+\s*/, '');

  try {
    await sendEmail({ to: stakeholderEmails, subject: `Weekly PMO Status - ${ragEnglish}`, htmlBody });
    await logAuditEvent({ event_type: 'report_sent', actor_phone: opts.requestor, payload: { recipients: stakeholderEmails, rag } });
    return { status: 'sent', rag };
  } catch (err) {
    console.error('Report send failed:', err);
    return { status: 'send_failed' };
  }
}
