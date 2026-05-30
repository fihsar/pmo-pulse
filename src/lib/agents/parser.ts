import { GoogleGenAI } from '@google/genai';
import { formatInTimeZone } from 'date-fns-tz';
import { requireEnv } from '@/lib/env';
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
  | { status: 'error'; reason: string; raw_output?: string; retry_after_seconds?: number };

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing required environment variable: GEMINI_API_KEY');
  }

  return new GoogleGenAI({ apiKey });
}

function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function hasGeminiKey() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function getOpenAiModel() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

async function callOpenAiParser(opts: { instruction: string; message: string }) {
  const apiKey = requireEnv('OPENAI_API_KEY');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: getOpenAiModel(),
      temperature: 0,
      messages: [
        { role: 'system', content: opts.instruction },
        { role: 'user', content: opts.message },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const retryAfter = res.headers.get('retry-after');
    const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : undefined;
    const body = await res.text();
    const err = new Error(body || `OpenAI request failed (${res.status})`);
    (err as any).status = res.status;
    (err as any).retryAfterSeconds = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined;
    throw err;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  return text;
}

async function callGeminiParser(opts: { instruction: string; message: string }) {
  const response = await getAiClient().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: opts.message,
    config: {
      systemInstruction: opts.instruction,
      temperature: 0,
      maxOutputTokens: 400,
      responseMimeType: 'application/json',
    },
  });

  return response.text ?? '';
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
    if (start !== -1 && end === -1) {
      throw new Error('Incomplete JSON object');
    }
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

      const optionalMissingFields: MissingField[] = ['assignee', 'project', 'due_date', 'due_time'];
      const canProceedWithoutClarification = missingFields.length > 0
        && missingFields.every((field) => optionalMissingFields.includes(field))
        && Boolean(partialTask?.task);

      if (canProceedWithoutClarification) {
        const priority = partialTask?.priority ?? 'medium';
        const confidence = typeof partialTask?.confidence === 'number' ? partialTask.confidence : 0.6;

        return {
          status: 'ok',
          task: {
            task: partialTask?.task ?? '',
            assignee_hint: partialTask?.assignee_hint ?? null,
            due_date: partialTask?.due_date ?? null,
            priority,
            project: partialTask?.project ?? null,
            confidence,
          },
        };
      }

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
  } catch (err) {
    const reason = err instanceof Error && err.message === 'Incomplete JSON object'
      ? 'Parser returned incomplete JSON'
      : 'Parser returned invalid JSON';
    return { status: 'error', reason };
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

Important:
- assignee_hint, project, due_date are OPTIONAL. If missing, set them to null and still return status=ok.
- Only use status=needs_clarification when the message is truly ambiguous (e.g. unclear time like "jam 5" without pagi/sore) or the task description is too vague to act on.

When status=needs_clarification:
- Fill question with one direct follow-up question in Indonesian.
- Fill missing_fields with one or more items.
- Still fill any fields you can infer with high confidence.
- For any field listed in missing_fields, set that field to null.
- Do not fabricate due_date or assignee if you cannot infer them.

Note: Asia/Jakarta is UTC+7. 17:00 WIB = 10:00 UTC.`;

  const providers: Array<'openai' | 'gemini'> = [];
  if (hasOpenAiKey()) providers.push('openai');
  if (hasGeminiKey()) providers.push('gemini');

  if (providers.length === 0) {
    return { status: 'error', reason: 'No parser provider is configured' };
  }

  let lastError: ParseTaskResult | null = null;

  for (const provider of providers) {
    try {
      const text = provider === 'openai'
        ? await callOpenAiParser({ instruction, message })
        : await callGeminiParser({ instruction, message });

      if (!text) {
        lastError = { status: 'error', reason: 'Empty parser response' };
        continue;
      }

      const result = parseParserModelOutput(text);
      if (result.status === 'error') {
        lastError = { ...result, raw_output: text };
        continue;
      }

      return result;
    } catch (err) {
      const status = typeof err === 'object' && err && 'status' in err ? (err as { status?: unknown }).status : undefined;
      const messageText = err instanceof Error ? err.message : '';

      const openAiRetryAfterSeconds = typeof err === 'object' && err && 'retryAfterSeconds' in err
        ? (err as { retryAfterSeconds?: unknown }).retryAfterSeconds
        : undefined;

      const isRateLimited = status === 429 || messageText.includes('RESOURCE_EXHAUSTED') || messageText.includes('Quota exceeded');
      if (isRateLimited) {
        const geminiRetryMatch = messageText.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
        const geminiRetryAfterSeconds = geminiRetryMatch ? Math.max(1, Math.round(Number.parseFloat(geminiRetryMatch[1]))) : undefined;

        const retryAfterSeconds = typeof openAiRetryAfterSeconds === 'number'
          ? openAiRetryAfterSeconds
          : geminiRetryAfterSeconds;

        lastError = { status: 'error', reason: 'rate_limited', retry_after_seconds: retryAfterSeconds };
        continue;
      }

      console.error('Parser error:', err);
      lastError = { status: 'error', reason: 'Parser request failed' };
    }
  }

  return lastError ?? { status: 'error', reason: 'Parser request failed' };
}
