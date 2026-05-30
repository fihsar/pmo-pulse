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

export type MissingField = 'due_time' | 'due_date' | 'assignee' | 'task_details' | 'project';

export type PartialParsedTask = Partial<ParsedTask>;

export type ParseTaskResult =
  | { status: 'ok'; task: ParsedTask }
  | { status: 'needs_clarification'; question: string; missing_fields: MissingField[]; partial_task?: PartialParsedTask }
  | { status: 'error'; reason: string; raw_output?: string };

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

function isMissingField(value: unknown): value is MissingField {
  return value === 'due_time' || value === 'due_date' || value === 'assignee' || value === 'task_details' || value === 'project';
}

function hasAmbiguousHour(message: string) {
  const lower = message.toLowerCase();
  const hasPlainHour = /\bjam\s+\d{1,2}\b/.test(lower);
  const hasQualifier = /\b(pagi|siang|sore|malam|wib)\b/.test(lower);
  const has24hFormat = /\b\d{1,2}[:.]\d{2}\b/.test(lower);
  return hasPlainHour && !hasQualifier && !has24hFormat;
}

function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('No JSON object found');
    }

    return JSON.parse(text.slice(start, end + 1)) as unknown;
  }
}

function normalizeParsedTaskPayload(value: unknown): ParsedTask | null {
  if (isParsedTask(value)) return value;
  if (value && typeof value === 'object' && 'task' in (value as Record<string, unknown>)) {
    const taskPayload = (value as Record<string, unknown>).task;
    if (isParsedTask(taskPayload)) return taskPayload;
  }
  return null;
}

function normalizePartialTaskPayload(value: Record<string, unknown>): PartialParsedTask | null {
  const task = typeof value.task === 'string' ? value.task : undefined;
  const assignee_hint = typeof value.assignee_hint === 'string' || value.assignee_hint === null ? (value.assignee_hint as string | null | undefined) : undefined;
  const due_date = typeof value.due_date === 'string' || value.due_date === null ? (value.due_date as string | null | undefined) : undefined;
  const priority = value.priority === 'high' || value.priority === 'medium' || value.priority === 'low' ? value.priority : undefined;
  const project = typeof value.project === 'string' || value.project === null ? (value.project as string | null | undefined) : undefined;
  const confidence = typeof value.confidence === 'number' ? value.confidence : undefined;

  const partial: PartialParsedTask = {};
  if (task !== undefined) partial.task = task;
  if (assignee_hint !== undefined) partial.assignee_hint = assignee_hint;
  if (due_date !== undefined) partial.due_date = due_date;
  if (priority !== undefined) partial.priority = priority;
  if (project !== undefined) partial.project = project;
  if (confidence !== undefined) partial.confidence = confidence;

  return Object.keys(partial).length > 0 ? partial : null;
}

export function parseParserModelOutput(text: string): ParseTaskResult {
  try {
    const parsed = parseJsonLenient(text) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { status: 'error', reason: 'Invalid parser response object' };
    }

    const data = parsed as Record<string, unknown>;
    const status = data.status;

    if (status === 'ok') {
      const normalized = normalizeParsedTaskPayload(data);
      return normalized ? { status: 'ok', task: normalized } : { status: 'error', reason: 'Invalid parsed task payload' };
    }

    if (status === 'needs_clarification') {
      const question = data.question;
      const missingFieldsRaw = data.missing_fields;
      const missingFields = Array.isArray(missingFieldsRaw) ? missingFieldsRaw.filter(isMissingField) : [];

      if (typeof question !== 'string' || !question.trim()) {
        return { status: 'error', reason: 'Clarification response missing question' };
      }

      const partialTask = normalizePartialTaskPayload(data);
      return {
        status: 'needs_clarification',
        question: question.trim(),
        missing_fields: missingFields,
        partial_task: partialTask ?? undefined,
      };
    }

    if (status === undefined) {
      const normalized = normalizeParsedTaskPayload(data);
      return normalized ? { status: 'ok', task: normalized } : { status: 'error', reason: 'Unknown parser status' };
    }

    return { status: 'error', reason: 'Unknown parser status' };
  } catch {
    return { status: 'error', reason: 'Parser returned invalid JSON' };
  }
}

async function getTeamNames() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return '';
  }

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

export async function parseTaskFromMessage(message: string): Promise<ParseTaskResult> {
  if (hasAmbiguousHour(message)) {
    return {
      status: 'needs_clarification',
      question: 'Jam berapa maksudnya? Tolong pilih format jelas, misalnya 05:00, 17:00, jam 5 pagi, atau jam 5 sore.',
      missing_fields: ['due_time'],
    };
  }

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
  "status": "ok|needs_clarification",
  "task": "concise description, max 100 chars",
  "assignee_hint": "name from team list if mentioned, or null",
  "due_date": "ISO 8601 UTC or null",
  "priority": "high|medium|low",
  "project": "project name if mentioned, or null",
  "confidence": 0.0-1.0,
  "question": "follow-up question in Indonesian if status=needs_clarification",
  "missing_fields": ["due_time|due_date|assignee|task_details|project"]
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

If the message is ambiguous or missing key details, set status=needs_clarification.
When status=needs_clarification:
- Fill question with one direct follow-up question in Indonesian.
- Fill missing_fields with one or more items.
- Still fill any fields you can infer with high confidence.
- For any field listed in missing_fields, set that field to null.
- Do not fabricate due_date or assignee if you cannot infer them.

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
    if (!text) return { status: 'error', reason: 'Empty parser response' };

    const result = parseParserModelOutput(text);
    if (result.status === 'error') return { ...result, raw_output: text };
    return result;
  } catch (err) {
    console.error('Parser error:', err);
    return { status: 'error', reason: 'Parser request failed' };
  }
}
