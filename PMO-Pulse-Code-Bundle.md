# PMO Pulse — Complete Code Bundle

Built on TRAE. Copy-paste ready for 8-hour solo hackathon.

---

## 0. Prerequisites (do these BEFORE the clock starts)

Accounts to set up:
1. **TRAE** — https://www.trae.ai/download (install IDE)
2. **Supabase** — create project in Singapore region (data residency for Indonesian banking)
3. **Twilio** — Sandbox for WhatsApp activated
4. **Google Gemini** — API key (free tier from Google AI Studio: https://aistudio.google.com/apikey)
5. **Google Cloud** — OAuth credentials for Gmail + Calendar APIs

> ⚠️ **Two different Google credentials, don't confuse them:** The Gemini API key (#4) comes from **AI Studio** and is a simple `AIza...` string — that's all the parser/report agent needs. The Gmail + Calendar integration (#5) needs separate **OAuth credentials** from Google Cloud Console (client ID + secret + refresh token). You can skip #5 entirely for the core demo if you cut the calendar/email fan-out — the WhatsApp → task → dashboard flow only needs the Gemini key.
6. **GitHub** — Personal Access Token with `repo` scope
7. **Vercel** — connected to your GitHub

Environment variables you'll need:

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Google Gemini (parser + report narrative)
GEMINI_API_KEY=AIza...

# Twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886

# Google (for Gmail + Calendar)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

# GitHub (for MCP)
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...

# App config
APP_TIMEZONE=Asia/Jakarta
APP_URL=https://pmo-pulse.vercel.app
CRON_SECRET=any-random-string
```

---

## 1. Supabase Schema (run in SQL Editor)

```sql
create extension if not exists "pgcrypto";

-- Users (team members)
create table users (
  phone text primary key,
  display_name text not null,
  role text default 'member' check (role in ('pm','member','stakeholder','admin')),
  projects text[] default array[]::text[],
  active boolean default true,
  created_at timestamptz default now(),
  last_seen_at timestamptz
);

-- Tasks (the core table)
create table tasks (
  id uuid primary key default gen_random_uuid(),
  creator_phone text not null,
  assignee_phone text not null,
  task text not null,
  project text,
  due_date timestamptz,
  priority text default 'medium' check (priority in ('high','medium','low')),
  status text default 'pending' check (status in ('pending','in_progress','done','blocked','cancelled')),
  raw_message text,
  parser_confidence numeric(3,2),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);

-- Standups (daily collection)
create table standups (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  user_phone text not null references users(phone),
  yesterday text,
  today text,
  blockers text,
  created_at timestamptz default now(),
  unique(date, user_phone)
);

-- RAID Log
create table raid_log (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('risk','action','issue','decision')),
  description text not null,
  owner_phone text references users(phone),
  status text default 'open',
  project text,
  raised_at timestamptz default now(),
  closed_at timestamptz
);

-- Audit log (hash-chained for banking compliance)
create table audit_log (
  id bigserial primary key,
  event_type text not null,
  actor_phone text,
  target_id text,
  payload jsonb,
  payload_hash text not null,
  prev_hash text,
  timestamp timestamptz default now()
);

create index idx_tasks_assignee on tasks(assignee_phone);
create index idx_tasks_status on tasks(status);
create index idx_tasks_due on tasks(due_date);
create index idx_audit_actor on audit_log(actor_phone);

-- Seed your team (replace with real numbers)
insert into users (phone, display_name, role, projects) values
('+628111111111', 'Fihsar', 'pm', array['BCA','Mandiri']),
('+628222222222', 'Tasya', 'pm', array['BCA']),
('+628333333333', 'Yugen', 'stakeholder', array['CIMB']);

-- Triggers to update updated_at
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at := now(); return new; end;
$$ language plpgsql;

create trigger tasks_updated_at before update on tasks
  for each row execute function set_updated_at();
```

---

## 2. Project Init

```bash
npx create-next-app@latest pmo-pulse --typescript --tailwind --app --src-dir --import-alias "@/*"
cd pmo-pulse
npm install @supabase/supabase-js @supabase/ssr @google/genai twilio date-fns date-fns-tz googleapis
npx shadcn@latest init -d
npx shadcn@latest add button card checkbox input label badge toast sonner select
```

---

## 3. Core Library Files

### `src/lib/supabase.ts`

```typescript
import { createClient } from '@supabase/supabase-js';
import { createBrowserClient } from '@supabase/ssr';

export function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export function getBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

### `src/lib/agents/parser.ts` — The Parser Agent

```typescript
import { GoogleGenAI } from '@google/genai';
import { formatInTimeZone } from 'date-fns-tz';
import { getServiceClient } from '../supabase';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const TZ = process.env.APP_TIMEZONE || 'Asia/Jakarta';

export interface ParsedTask {
  task: string;
  assignee_hint: string | null;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low';
  project: string | null;
  confidence: number;
}

export async function parseTaskFromMessage(message: string): Promise<ParsedTask | null> {
  const now = new Date();
  const nowLocal = formatInTimeZone(now, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const dayOfWeek = formatInTimeZone(now, TZ, 'EEEE');

  // Pull known team names to help parser resolve mentions
  const sb = getServiceClient();
  const { data: users } = await sb.from('users').select('display_name').eq('active', true);
  const teamNames = (users || []).map(u => u.display_name).join(', ');

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
- "Senin","Selasa","Rabu","Kamis","Jumat","Sabtu","Minggu" = upcoming weekday

Priority cues: "penting/urgent/ASAP/harus" → high; default medium; "santai/kapan-kapan" → low.

Note: Asia/Jakarta is UTC+7. 17:00 WIB = 10:00 UTC.

Examples:
"Tasya weekly report BCA Jumat jam 4 sore penting"
→ {"task":"Weekly report BCA","assignee_hint":"Tasya","due_date":"2026-05-22T09:00:00Z","priority":"high","project":"BCA","confidence":0.95}

"Review PRD kapan-kapan"
→ {"task":"Review PRD","assignee_hint":null,"due_date":null,"priority":"low","project":null,"confidence":0.75}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: message,
      config: {
        systemInstruction: instruction,
        temperature: 0,
        maxOutputTokens: 400,
        // Force clean JSON — no markdown fences to strip
        responseMimeType: 'application/json',
      },
    });

    const text = response.text;
    if (!text) return null;
    return JSON.parse(text) as ParsedTask;
  } catch (err) {
    console.error('Parser error:', err);
    return null;
  }
}
```

> **Note on `responseMimeType: 'application/json'`** — Gemini supports native JSON mode, so unlike the original Anthropic version you don't need to strip ```` ``` ```` fences. The response comes back as clean parseable JSON. You can optionally pass a full `responseSchema` for even stricter typing; for a hackathon the mime type alone is enough.

### `src/lib/agents/router.ts` — The Router Agent

```typescript
import { getServiceClient } from '../supabase';

export interface RouterResult {
  assignee_phone: string;
  assignee_name: string;
  is_self: boolean;
  was_overloaded: boolean;
}

export async function routeTask(
  creator_phone: string,
  assignee_hint: string | null
): Promise<RouterResult | null> {
  const sb = getServiceClient();

  // If no hint, assign to creator
  if (!assignee_hint) {
    const { data: self } = await sb.from('users').select('display_name').eq('phone', creator_phone).single();
    return {
      assignee_phone: creator_phone,
      assignee_name: self?.display_name ?? 'Self',
      is_self: true,
      was_overloaded: false,
    };
  }

  // Fuzzy match on display_name
  const { data: matches } = await sb
    .from('users')
    .select('phone, display_name')
    .eq('active', true)
    .ilike('display_name', `%${assignee_hint}%`);

  if (!matches || matches.length === 0) {
    // Fall back to creator
    const { data: self } = await sb.from('users').select('display_name').eq('phone', creator_phone).single();
    return {
      assignee_phone: creator_phone,
      assignee_name: self?.display_name ?? 'Self',
      is_self: true,
      was_overloaded: false,
    };
  }

  const target = matches[0];

  // Check workload (pending tasks in last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await sb
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('assignee_phone', target.phone)
    .eq('status', 'pending')
    .gte('created_at', weekAgo);

  const overloaded = (count ?? 0) > 15;

  return {
    assignee_phone: target.phone,
    assignee_name: target.display_name,
    is_self: target.phone === creator_phone,
    was_overloaded: overloaded,
  };
}
```

### `src/lib/agents/audit.ts` — The Audit Agent (hash-chained)

```typescript
import { createHash } from 'crypto';
import { getServiceClient } from '../supabase';

export async function logAuditEvent(event: {
  event_type: string;
  actor_phone: string;
  target_id?: string;
  payload?: any;
}) {
  const sb = getServiceClient();

  // Get previous hash for chain
  const { data: prev } = await sb
    .from('audit_log')
    .select('payload_hash')
    .order('id', { ascending: false })
    .limit(1)
    .single();

  const payloadStr = JSON.stringify(event.payload ?? {});
  const prevHash = prev?.payload_hash ?? '0000000000000000';
  const combined = prevHash + payloadStr + event.event_type + event.actor_phone;
  const hash = createHash('sha256').update(combined).digest('hex');

  await sb.from('audit_log').insert({
    event_type: event.event_type,
    actor_phone: event.actor_phone,
    target_id: event.target_id ?? null,
    payload: event.payload ?? {},
    payload_hash: hash,
    prev_hash: prevHash,
  });
}
```

### `src/lib/integrations/calendar.ts` — Google Calendar (via Gmail MCP creds)

```typescript
import { google } from 'googleapis';

function getOAuthClient() {
  const oauth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth;
}

export async function createCalendarEvent(opts: {
  summary: string;
  startISO: string;
  endISO: string;
  description?: string;
  attendeeEmail?: string;
}) {
  const auth = getOAuthClient();
  const cal = google.calendar({ version: 'v3', auth });
  return cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: opts.summary,
      description: opts.description,
      start: { dateTime: opts.startISO, timeZone: 'Asia/Jakarta' },
      end: { dateTime: opts.endISO, timeZone: 'Asia/Jakarta' },
      attendees: opts.attendeeEmail ? [{ email: opts.attendeeEmail }] : undefined,
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    },
  });
}
```

### `src/lib/integrations/gmail.ts`

```typescript
import { google } from 'googleapis';

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  htmlBody: string;
}) {
  const oauth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  const gmail = google.gmail({ version: 'v1', auth: oauth });

  const raw = Buffer.from(
    `To: ${opts.to.join(', ')}\r\n` +
      `Subject: ${opts.subject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n\r\n` +
      opts.htmlBody
  ).toString('base64url');

  return gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}
```

### `src/lib/integrations/twilio.ts`

```typescript
import twilio from 'twilio';

const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

export async function sendWhatsApp(to: string, body: string) {
  return client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER!,
    to: `whatsapp:${to}`,
    body,
  });
}
```

---

## 4. WhatsApp Webhook (the main orchestration endpoint)

### `src/app/api/whatsapp/webhook/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { parseTaskFromMessage } from '@/lib/agents/parser';
import { routeTask } from '@/lib/agents/router';
import { logAuditEvent } from '@/lib/agents/audit';
import { createCalendarEvent } from '@/lib/integrations/calendar';
import { sendWhatsApp } from '@/lib/integrations/twilio';
import { handleCommand } from '@/lib/commands';
import { getServiceClient } from '@/lib/supabase';

const MessagingResponse = twilio.twiml.MessagingResponse;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const message = (formData.get('Body') as string) || '';
    const from = (formData.get('From') as string) || '';
    const userPhone = from.replace('whatsapp:', '');
    if (!message || !userPhone) return new NextResponse('Bad request', { status: 400 });

    const sb = getServiceClient();

    // Upsert user
    await sb.from('users').upsert({ phone: userPhone, display_name: userPhone, last_seen_at: new Date().toISOString() }, { onConflict: 'phone', ignoreDuplicates: false });

    // Try command first
    const cmd = await handleCommand(message, userPhone);
    let reply: string;

    if (cmd.handled) {
      reply = cmd.reply;
    } else {
      // Parse → Route → Save → Fan-out
      const parsed = await parseTaskFromMessage(message);

      if (!parsed) {
        reply = "🤔 I couldn't parse that. Try being specific. Type 'help' for commands.";
      } else {
        const routed = await routeTask(userPhone, parsed.assignee_hint);
        if (!routed) {
          reply = "❌ Couldn't determine assignee. Please retry.";
        } else {
          // Insert task
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
            reply = '❌ Failed to save task.';
          } else {
            // Fan-out (best-effort, don't block reply)
            const fanOut: Promise<any>[] = [
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
              fanOut.push(
                createCalendarEvent({
                  summary: parsed.task,
                  startISO: start.toISOString(),
                  endISO: end.toISOString(),
                  description: `Project: ${parsed.project ?? '—'}\nAssigned to: ${routed.assignee_name}`,
                }).catch(e => console.error('cal err', e))
              );
            }

            if (!routed.is_self) {
              const dueStr = parsed.due_date
                ? new Date(parsed.due_date).toLocaleString('id-ID', {
                    weekday: 'short', day: 'numeric', month: 'short',
                    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta',
                  })
                : 'no deadline';
              fanOut.push(
                sendWhatsApp(routed.assignee_phone,
                  `📌 New task assigned by ${userPhone}:\n\n*${parsed.task}*\n📅 ${dueStr}\n🏷 ${parsed.project ?? '—'}`
                ).catch(e => console.error('wa err', e))
              );
            }

            // Fire and forget
            Promise.all(fanOut);

            const dueLabel = parsed.due_date
              ? new Date(parsed.due_date).toLocaleString('id-ID', {
                  weekday: 'short', day: 'numeric', month: 'short',
                  hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta',
                })
              : 'no deadline';
            const priIcon = parsed.priority === 'high' ? '🔴' : parsed.priority === 'low' ? '🟢' : '🟡';
            const assigneeLine = routed.is_self ? '' : `\n👤 Assigned to: ${routed.assignee_name}`;
            const overloadWarn = routed.was_overloaded ? '\n⚠️ Note: ' + routed.assignee_name + ' has > 15 pending tasks.' : '';
            const calLine = parsed.due_date ? '\n📅 Calendar event created' : '';

            reply = `✅ Saved!\n\n${priIcon} *${parsed.task}*\n📅 ${dueLabel}${assigneeLine}${overloadWarn}${calLine}`;
          }
        }
      }
    }

    const twiml = new MessagingResponse();
    twiml.message(reply);
    return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
  } catch (err) {
    console.error('Webhook error:', err);
    const twiml = new MessagingResponse();
    twiml.message('⚠️ Something went wrong. Please retry.');
    return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }
}
```

---

## 5. Commands Handler

### `src/lib/commands.ts`

```typescript
import { getServiceClient } from './supabase';

export async function handleCommand(message: string, userPhone: string) {
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
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date(); endOfDay.setHours(23,59,59,999);
    const { data } = await sb
      .from('tasks')
      .select('*')
      .eq('assignee_phone', userPhone)
      .eq('status', 'pending')
      .or(`due_date.is.null,and(due_date.gte.${startOfDay.toISOString()},due_date.lte.${endOfDay.toISOString()})`)
      .order('due_date', { ascending: true, nullsFirst: false });

    if (!data || data.length === 0) return { handled: true, reply: '✨ No tasks today.' };
    const lines = data.map((t, i) => {
      const time = t.due_date ? new Date(t.due_date).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) : '⏰';
      const icon = t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
      return `${i + 1}. ${icon} ${t.task} — ${time}`;
    });
    return { handled: true, reply: `📋 *Today:*\n\n${lines.join('\n')}` };
  }

  if (text.startsWith('done ') || text.startsWith('selesai ')) {
    const keyword = message.replace(/^(done|selesai)\s+/i, '').trim();
    const { data: matches } = await sb
      .from('tasks')
      .select('*')
      .eq('assignee_phone', userPhone)
      .eq('status', 'pending')
      .ilike('task', `%${keyword}%`);
    if (!matches || matches.length === 0) return { handled: true, reply: `❌ No match for "${keyword}"` };
    if (matches.length > 1) {
      return { handled: true, reply: `🤔 Multiple matches:\n${matches.slice(0,5).map((t,i) => `${i+1}. ${t.task}`).join('\n')}` };
    }
    await sb.from('tasks').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', matches[0].id);
    return { handled: true, reply: `✅ Done: *${matches[0].task}*` };
  }

  if (text === 'report') {
    // Trigger report agent (covered in next file)
    const res = await fetch(`${process.env.APP_URL}/api/agents/report?phone=${encodeURIComponent(userPhone)}`, { method: 'POST' });
    return { handled: true, reply: res.ok ? '📊 Generating weekly report and emailing stakeholders...' : '❌ Report generation failed' };
  }

  if (text === 'dashboard') {
    return { handled: true, reply: `🌐 ${process.env.APP_URL}` };
  }

  return { handled: false, reply: '' };
}
```

---

## 6. Standup & Report Agents (cron endpoints)

### `src/app/api/cron/standup/route.ts` — runs daily 9 AM

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { sendWhatsApp } from '@/lib/integrations/twilio';
import { logAuditEvent } from '@/lib/agents/audit';

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  const sb = getServiceClient();
  const { data: team } = await sb.from('users').select('phone, display_name').eq('active', true).neq('role','stakeholder');
  if (!team) return NextResponse.json({ prompted: 0 });

  let prompted = 0;
  for (const member of team) {
    try {
      await sendWhatsApp(member.phone,
        `Selamat pagi ${member.display_name}! 🌅\n\n*Daily Standup*\nReply dalam 30 menit:\n1️⃣ Yesterday\n2️⃣ Today\n3️⃣ Blockers (kosongkan jika none)`);
      prompted++;
    } catch (e) { console.error('Standup send failed:', e); }
  }
  await logAuditEvent({ event_type: 'standup_initiated', actor_phone: 'system', payload: { count: prompted } });
  return NextResponse.json({ prompted });
}
```

### `src/app/api/agents/report/route.ts` — Friday weekly report

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { getServiceClient } from '@/lib/supabase';
import { sendEmail } from '@/lib/integrations/gmail';
import { logAuditEvent } from '@/lib/agents/audit';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const requestor = url.searchParams.get('phone') || 'system';
  const sb = getServiceClient();

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: tasks } = await sb
    .from('tasks')
    .select('*')
    .gte('updated_at', weekAgo)
    .order('project, status');

  if (!tasks || tasks.length === 0) {
    return NextResponse.json({ status: 'no_tasks' });
  }

  // Group by project & status
  const grouped: Record<string, any[]> = {};
  for (const t of tasks) {
    const p = t.project ?? 'No Project';
    grouped[p] = grouped[p] ?? [];
    grouped[p].push(t);
  }

  // Compute RAG
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const overdue = tasks.filter(t => t.due_date && new Date(t.due_date) < new Date() && t.status === 'pending').length;
  const rag = blocked >= 3 || overdue >= 3 ? '🔴 RED' : overdue >= 1 ? '🟡 AMBER' : '🟢 GREEN';

  // Have Gemini generate the narrative
  const summary = JSON.stringify(grouped, null, 2);
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `Status: ${rag}\nThis week's tasks:\n${summary}\n\nWrite the executive narrative.`,
    config: {
      systemInstruction: 'You are a PMO assistant. Write a concise weekly status report in Indonesian. Use formal but warm tone. Max 200 words. Highlight wins, risks, and next steps.',
      temperature: 0.4,
      maxOutputTokens: 800,
    },
  });

  const narrative = response.text ?? '';

  const htmlBody = `
    <h1 style="color:#0F1E3D;font-family:Arial">Weekly PMO Status — ${new Date().toLocaleDateString('id-ID')}</h1>
    <p style="font-size:18px"><strong>Overall: ${rag}</strong></p>
    <div style="white-space:pre-wrap;font-family:Arial">${narrative}</div>
    <hr/>
    <h3 style="color:#0F1E3D">Task Detail</h3>
    ${Object.entries(grouped).map(([proj, items]) => `
      <h4>${proj}</h4>
      <ul>${(items as any[]).map(t => `<li>${t.task} — <em>${t.status}</em></li>`).join('')}</ul>
    `).join('')}
    <p style="font-size:11px;color:#999">Generated by PMO Pulse on TRAE.</p>
  `;

  // Get stakeholder emails (in real app, this would come from users table)
  const stakeholderEmails = ['stakeholder@example.com']; // replace
  try {
    await sendEmail({
      to: stakeholderEmails,
      subject: `Weekly PMO Status — ${rag}`,
      htmlBody,
    });
    await logAuditEvent({ event_type: 'report_sent', actor_phone: requestor, payload: { recipients: stakeholderEmails, rag } });
    return NextResponse.json({ status: 'sent', rag });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ status: 'send_failed' }, { status: 500 });
  }
}
```

---

## 7. Dashboard

### `src/app/page.tsx` — Phone login

```typescript
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';

export default function Login() {
  const [phone, setPhone] = useState('');
  const router = useRouter();
  function handleLogin() {
    const normalized = phone.replace(/\D/g, '');
    if (normalized.length < 10) return alert('Invalid phone');
    localStorage.setItem('pulse_phone', '+' + normalized);
    router.push('/dashboard');
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="p-8 max-w-md w-full">
        <h1 className="text-3xl font-bold mb-1" style={{color:'#0F1E3D'}}>PMO Pulse</h1>
        <p className="text-sm text-slate-500 mb-6">WhatsApp-first project intelligence</p>
        <label className="text-sm font-medium">Your WhatsApp number</label>
        <Input type="tel" placeholder="+628123456789" value={phone} onChange={e => setPhone(e.target.value)} className="mb-4 mt-1" />
        <Button onClick={handleLogin} className="w-full" style={{background:'#0F1E3D'}}>Open Dashboard</Button>
      </Card>
    </div>
  );
}
```

### `src/app/dashboard/page.tsx`

```typescript
'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Task {
  id: string; task: string; assignee_phone: string; project: string | null;
  due_date: string | null; priority: 'high'|'medium'|'low';
  status: 'pending'|'in_progress'|'done'|'blocked'|'cancelled';
}

export default function Dashboard() {
  const router = useRouter();
  const [phone, setPhone] = useState<string|null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<'mine'|'team'|'overdue'|'done'>('mine');

  useEffect(() => {
    const p = typeof window !== 'undefined' ? localStorage.getItem('pulse_phone') : null;
    if (!p) { router.push('/'); return; }
    setPhone(p);
    void load(p);

    const sb = getBrowserClient();
    const channel = sb.channel('tasks-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => void load(p))
      .subscribe();
    return () => { void sb.removeChannel(channel); };
  }, [router]);

  async function load(p: string) {
    const sb = getBrowserClient();
    const { data } = await sb.from('tasks').select('*').order('due_date', { ascending: true, nullsFirst: false });
    setTasks((data as Task[]) ?? []);
  }

  async function toggle(t: Task) {
    const sb = getBrowserClient();
    const newStatus = t.status === 'done' ? 'pending' : 'done';
    await sb.from('tasks').update({ status: newStatus, completed_at: newStatus === 'done' ? new Date().toISOString() : null }).eq('id', t.id);
  }

  const filtered = tasks.filter(t => {
    if (!phone) return false;
    if (filter === 'done') return t.status === 'done';
    if (t.status === 'done') return false;
    if (filter === 'mine') return t.assignee_phone === phone;
    if (filter === 'overdue') return t.due_date && new Date(t.due_date) < new Date();
    return true; // team
  });

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="font-bold text-lg" style={{color:'#0F1E3D'}}>PMO Pulse</h1>
          <p className="text-xs text-slate-500">{phone}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { localStorage.removeItem('pulse_phone'); router.push('/'); }}>Logout</Button>
      </header>
      <div className="p-4 max-w-3xl mx-auto">
        <div className="flex gap-2 mb-4 overflow-x-auto">
          {(['mine','team','overdue','done'] as const).map(k => (
            <button key={k} onClick={() => setFilter(k)}
              className={`px-3 py-1.5 rounded-full text-sm capitalize ${filter===k ? 'text-white' : 'bg-white border'}`}
              style={filter===k ? {background:'#0F1E3D'} : {}}>{k}</button>
          ))}
        </div>
        {filtered.length === 0 ? (
          <Card className="p-8 text-center text-slate-400">✨ Nothing here. Send a WhatsApp message to add a task.</Card>
        ) : (
          <div className="space-y-2">
            {filtered.map(t => (
              <Card key={t.id} className="p-4 flex items-start gap-3">
                <Checkbox checked={t.status==='done'} onCheckedChange={() => toggle(t)} className="mt-1" />
                <div className="flex-1 min-w-0">
                  <p className={t.status==='done' ? 'line-through text-slate-400' : ''}>{t.task}</p>
                  <div className="flex flex-wrap gap-2 mt-1 text-xs">
                    {t.due_date && <span className="text-slate-500">{new Date(t.due_date).toLocaleString('id-ID',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span>}
                    {t.project && <Badge variant="secondary">{t.project}</Badge>}
                    <Badge variant="outline" className={t.priority==='high'?'border-red-300 text-red-700':t.priority==='low'?'border-green-300 text-green-700':'border-yellow-300 text-yellow-700'}>{t.priority}</Badge>
                    <span className="text-slate-400">→ {t.assignee_phone}</span>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 8. Vercel Cron Config — `vercel.json`

```json
{
  "crons": [
    { "path": "/api/cron/standup", "schedule": "0 2 * * 1-5" },
    { "path": "/api/cron/report",  "schedule": "0 9 * * 5" }
  ]
}
```

(UTC times: 02:00 UTC = 09:00 Jakarta for standup, 09:00 UTC Fri = 16:00 Fri Jakarta for report)

---

## 9. Test Script — `scripts/test-pipeline.ts`

```typescript
import { parseTaskFromMessage } from '../src/lib/agents/parser';

const tests = [
  'Tasya weekly report BCA Jumat jam 4 sore penting',
  'Buat meeting prep client Mandiri besok jam 10 pagi',
  'Yugen review PRD kapan-kapan',
  'Submit timesheet hari ini',
  'Lunch dengan stakeholder Senin jam 12',
  'Follow up CIMB integration urgent',
  'Standup notes besok',
  'Quarterly review akhir bulan',
  'Beli kopi',
  'Tasya, status update BCA project minggu depan ASAP',
];

(async () => {
  let pass = 0;
  for (const t of tests) {
    const r = await parseTaskFromMessage(t);
    console.log(`\n📨 ${t}`);
    console.log(`   →`, r ? JSON.stringify(r) : 'NULL');
    if (r && r.task && r.confidence > 0.5) pass++;
  }
  console.log(`\n${pass}/${tests.length} parsed (target: 8+)`);
})();
```

Run before moving on from hour 3: `npx tsx scripts/test-pipeline.ts`

---

## 10. Demo Polish — README skeleton

```markdown
# PMO Pulse

> WhatsApp-first project intelligence for banking PMOs.
> Built solo in 8 hours on TRAE.

## What it does
Type a task in WhatsApp like "Tasya weekly report BCA Jumat jam 4 sore" —
it gets parsed by 5 TRAE agents, assigned, calendar event created,
notified, and audit-logged. Friday it emails the stakeholders a status report.

## Demo
- Live: https://pmo-pulse.vercel.app
- Video: [link]

## Stack
TRAE · Next.js · Supabase · Twilio · Gemini · Gmail/Calendar MCP

## ROI
Rp 1.04 Billion saved annually for an 8-person banking PMO team.
See ROI workbook for sensitivity scenarios.
```

---

## 11. Cheat-sheet — common pitfalls

1. **Twilio Sandbox expires after 72 hrs inactivity.** Send a test the morning before hackathon.
2. **Webhook must return XML/TwiML.** Forgetting → no reply.
3. **Vercel free tier: 10s function timeout.** `gemini-2.5-flash` is fast enough; if you hit limits, try `gemini-2.5-flash-lite`. Fan-out async (don't await).
4. **Calendar event needs invitee email, not phone.** Map phone → email in `users` table for production.
5. **RLS will block reads** if misconfigured. Use service role for the webhook. Tighten security post-demo.
6. **Hash chain must be sequential.** Don't parallelize audit log writes — use a transaction queue if scaling.

---

That's the full bundle. ~1100 LOC. Built phase-by-phase via TRAE Builder mode, each agent created as a TRAE Custom Agent during hours 2-3.
