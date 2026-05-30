create extension if not exists "pgcrypto";

create table if not exists users (
  phone text primary key,
  display_name text not null,
  role text default 'member' check (role in ('pm', 'member', 'stakeholder', 'admin')),
  projects text[] default array[]::text[],
  active boolean default true,
  created_at timestamptz default now(),
  last_seen_at timestamptz
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  creator_phone text not null,
  assignee_phone text not null,
  task text not null,
  project text,
  due_date timestamptz,
  priority text default 'medium' check (priority in ('high', 'medium', 'low')),
  status text default 'pending' check (status in ('pending', 'in_progress', 'done', 'blocked', 'cancelled')),
  raw_message text,
  parser_confidence numeric(3, 2),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);

create table if not exists standups (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  user_phone text not null references users(phone),
  yesterday text,
  today text,
  blockers text,
  created_at timestamptz default now(),
  unique(date, user_phone)
);

create table if not exists raid_log (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('risk', 'action', 'issue', 'decision')),
  description text not null,
  owner_phone text references users(phone),
  status text default 'open',
  project text,
  raised_at timestamptz default now(),
  closed_at timestamptz
);

create table if not exists audit_log (
  id bigserial primary key,
  event_type text not null,
  actor_phone text,
  target_id text,
  payload jsonb,
  payload_hash text not null,
  prev_hash text,
  timestamp timestamptz default now()
);

create table if not exists pending_clarifications (
  id uuid primary key default gen_random_uuid(),
  user_phone text not null references users(phone),
  original_message text not null,
  question text not null,
  missing_fields text[] not null default array[]::text[],
  partial_task jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  resolved_at timestamptz
);

create index if not exists idx_tasks_assignee on tasks(assignee_phone);
create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_tasks_due on tasks(due_date);
create index if not exists idx_audit_actor on audit_log(actor_phone);
create index if not exists idx_pending_clarifications_user on pending_clarifications(user_phone);
create unique index if not exists idx_pending_clarifications_open_user
  on pending_clarifications(user_phone)
  where resolved_at is null;

alter table users enable row level security;
alter table tasks enable row level security;
alter table standups enable row level security;
alter table raid_log enable row level security;
alter table audit_log enable row level security;
alter table pending_clarifications enable row level security;

drop policy if exists "demo users readable" on users;
drop policy if exists "demo tasks readable" on tasks;
drop policy if exists "demo tasks updatable" on tasks;
drop policy if exists "demo standups readable" on standups;
drop policy if exists "demo raid readable" on raid_log;
drop policy if exists "demo pending_clarifications_readable" on pending_clarifications;

create policy "demo users readable" on users
  for select to anon using (true);

create policy "demo tasks readable" on tasks
  for select to anon using (true);

create policy "demo tasks updatable" on tasks
  for update to anon using (true) with check (true);

create policy "demo standups readable" on standups
  for select to anon using (true);

create policy "demo raid readable" on raid_log
  for select to anon using (true);

create policy "demo pending_clarifications_readable" on pending_clarifications
  for select to anon using (true);

insert into users (phone, display_name, role, projects)
values
  ('+628111111111', 'Fihsar', 'pm', array['BCA', 'Mandiri']),
  ('+628222222222', 'Tasya', 'pm', array['BCA']),
  ('+628333333333', 'Yugen', 'stakeholder', array['CIMB'])
on conflict (phone) do update set
  display_name = excluded.display_name,
  role = excluded.role,
  projects = excluded.projects,
  active = true;

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_updated_at on tasks;

drop trigger if exists pending_clarifications_updated_at on pending_clarifications;

create trigger tasks_updated_at before update on tasks
  for each row execute function set_updated_at();

create trigger pending_clarifications_updated_at before update on pending_clarifications
  for each row execute function set_updated_at();

alter table pending_clarifications
  add column if not exists partial_task jsonb;
