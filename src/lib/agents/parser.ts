import { GoogleGenAI } from '@google/genai';
import { formatInTimeZone } from 'date-fns-tz';
import { getServiceClient } from '../supabase';

const TZ = process.env.APP_TIMEZONE || 'Asia/Jakarta';

export interface ParsedTask {
  task: string;
  assignee_hint: string | null;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low';
  project: string | null;
  confidence: number;
}

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing required environment variable: GEMINI_API_KEY');
  }

  return new GoogleGenAI({ apiKey });
}

function isParsedTask(value: unknown): value is ParsedTask {
  if (!value || typeof value !== 'object') return false;

  const task = value as Partial<ParsedTask>;
  const priorities = ['high', 'medium', 'low'];

  return (
    typeof task.task === 'string' &&
    (typeof task.assignee_hint === 'string' || task.assignee_hint === null) &&
    (typeof task.due_date === 'string' || task.due_date === null) &&
    typeof task.priority === 'string' &&
    priorities.includes(task.priority) &&
    (typeof task.project === 'string' || task.project === null) &&
    typeof task.confidence === 'number'
  );
}

async function getTeamNames() {
  const sb = getServiceClient();
  const { data: users, error } = await sb
    .from('users')
    .select('display_name')
    .eq('active', true);

  if (error) {
    console.error('Failed to load team names:', error);
    return '';
  }

  return (users || []).map((user) => user.display_name).join(', ');
}

export async function parseTaskFromMessage(message: string): Promise<ParsedTask | null> {
  const now = new Date();
  const nowLocal = formatInTimeZone(now, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const dayOfWeek = formatInTimeZone(now, TZ, 'EEEE');
  const teamNames = await getTeamNames();

  const instruction = `You are a parser for WhatsApp messages in an Indonesian banking PMO context.

Current datetime: ${nowLocal} (${TZ})
Today is: ${dayOfWeek}
Known team members: ${teamNames || 'none yet'}
Known projects: BCA, Mandiri, CIMB, BNI, Danamon

Output ONLY valid JSON, no preamble:
{
  "task": "concise description, max 100 chars",
  "assignee_hint": "name from team list if mentioned, or null",
  "due_date": "ISO 8601 UTC or null",
  "priority": "high|medium|low",
  "project": "project name if mentioned, or null",
  "confidence": 0.0-1.0
}

Indonesian time expressions:
- "hari ini" = today
- "besok" = tomorrow
- "lusa" = day after tomorrow
- "minggu depan" = next week
- "akhir bulan" = last day of month
- "jam 5 sore" = 17:00, "jam 9 pagi" = 09:00, "jam 8 malam" = 20:00
- "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu" = upcoming weekday

Priority cues: "penting/urgent/ASAP/harus" → high; default medium; "santai/kapan-kapan" → low.

Note: Asia/Jakarta is UTC+7. 17:00 WIB = 10:00 UTC.`;

  try {
    const response = await getAiClient().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: message,
      config: {
        systemInstruction: instruction,
        temperature: 0,
        maxOutputTokens: 400,
        responseMimeType: 'application/json',
      },
    });

    const text = response.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as unknown;
    return isParsedTask(parsed) ? parsed : null;
  } catch (err) {
    console.error('Parser error:', err);
    return null;
  }
}
