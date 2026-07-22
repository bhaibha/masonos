-- ============================================================
-- MASON OS — Migration 011: Safety (Module 04)
--
--   safety_checklists        — one per project per day
--   safety_checklist_items   — the standard checks, Pass/Fail/NA + remark/photo
--   incidents                — near-miss / first-aid / injury / property damage
--   fn_safety_summary()      — days-since-incident + this-week checklist %
--
-- RLS mirrors tasks: members read; founder/pm/supervisor write; accounts
-- read-only. Audit triggers on the header tables. Photos reuse the site-photos
-- bucket, so migration 006's storage policies already cover them.
--
-- Idempotent: enums guarded, tables if-not-exists, policies drop-then-create,
-- functions/triggers replaced.
-- ============================================================

-- ---------- ENUMS ----------
do $$ begin
  create type safety_result as enum ('pass', 'fail', 'na');
exception when duplicate_object then null; end $$;

do $$ begin
  create type incident_type as enum
    ('near_miss', 'first_aid', 'injury', 'property_damage');
exception when duplicate_object then null; end $$;

do $$ begin
  create type incident_status as enum ('open', 'closed');
exception when duplicate_object then null; end $$;

-- ---------- CHECKLIST (one per site per day) ----------
create table if not exists public.safety_checklists (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  check_date date not null default current_date,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, check_date)
);

create table if not exists public.safety_checklist_items (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references public.safety_checklists(id) on delete cascade,
  item_key text not null,        -- ppe / scaffolding / edge_protection / ...
  result safety_result not null default 'na',
  remark text,
  photo_path text,               -- site-photos bucket
  unique (checklist_id, item_key)
);

-- ---------- INCIDENTS ----------
create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  incident_type incident_type not null,
  description text not null,
  people_involved text,
  immediate_action text,
  photos text[] not null default '{}',   -- site-photos bucket paths
  status incident_status not null default 'open',
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists incidents_project_time_idx
  on public.incidents (project_id, occurred_at desc);

-- ---------- SUMMARY (for Project Detail) ----------
-- security_invoker so a supervisor only ever summarises a project they can see.
-- Dates are evaluated in Asia/Kolkata (CLAUDE.md rule 6). No money here, but
-- the counts still live in SQL rather than being derived in the browser.
create or replace function public.fn_safety_summary(p_project uuid)
returns table (
  last_incident_at    timestamptz,
  days_since_incident int,
  open_incidents      int,
  week_checklist_days int,
  week_days_elapsed   int
)
language sql
stable
security invoker
set search_path = public
as $$
  with today as (
    select (now() at time zone 'Asia/Kolkata')::date as d
  ),
  wk as (
    -- date_trunc('week') is ISO Monday
    select date_trunc('week', (select d from today))::date as monday,
           (select d from today) as today
  ),
  li as (
    select max(occurred_at) as last_at
    from public.incidents where project_id = p_project
  )
  select
    li.last_at,
    case
      when li.last_at is null then null
      else (select d from today)
           - (li.last_at at time zone 'Asia/Kolkata')::date
    end,
    (select count(*)::int from public.incidents
       where project_id = p_project and status = 'open'),
    (select count(distinct check_date)::int from public.safety_checklists
       where project_id = p_project
         and check_date between (select monday from wk) and (select today from wk)),
    ((select today from wk) - (select monday from wk) + 1)::int
  from li;
$$;

revoke all on function public.fn_safety_summary(uuid) from public, anon;
grant execute on function public.fn_safety_summary(uuid) to authenticated;

-- ---------- AUDIT ----------
drop trigger if exists audit_safety_checklists on public.safety_checklists;
create trigger audit_safety_checklists
  after insert or update or delete on public.safety_checklists
  for each row execute function public.fn_audit();

drop trigger if exists audit_incidents on public.incidents;
create trigger audit_incidents
  after insert or update or delete on public.incidents
  for each row execute function public.fn_audit();

-- ---------- RLS ----------
alter table public.safety_checklists      enable row level security;
alter table public.safety_checklist_items enable row level security;
alter table public.incidents              enable row level security;

-- checklists: members read; founder/pm/supervisor write
drop policy if exists sc_read on public.safety_checklists;
create policy sc_read on public.safety_checklists for select to authenticated
  using (public.is_member(project_id));

drop policy if exists sc_insert on public.safety_checklists;
create policy sc_insert on public.safety_checklists for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'supervisor'));

drop policy if exists sc_update on public.safety_checklists;
create policy sc_update on public.safety_checklists for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'supervisor'));

-- items: gated through the parent checklist's project
drop policy if exists sci_read on public.safety_checklist_items;
create policy sci_read on public.safety_checklist_items for select to authenticated
  using (exists (select 1 from public.safety_checklists c
                 where c.id = checklist_id and public.is_member(c.project_id)));

drop policy if exists sci_write on public.safety_checklist_items;
create policy sci_write on public.safety_checklist_items for all to authenticated
  using (exists (select 1 from public.safety_checklists c
                 where c.id = checklist_id and public.is_member(c.project_id)
                   and public.my_role() in ('founder', 'pm', 'supervisor')))
  with check (exists (select 1 from public.safety_checklists c
                 where c.id = checklist_id and public.is_member(c.project_id)
                   and public.my_role() in ('founder', 'pm', 'supervisor')));

-- incidents: members read; founder/pm/supervisor raise; founder/pm or the
-- raiser can update (e.g. close it)
drop policy if exists inc_read on public.incidents;
create policy inc_read on public.incidents for select to authenticated
  using (public.is_member(project_id));

drop policy if exists inc_insert on public.incidents;
create policy inc_insert on public.incidents for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'supervisor'));

drop policy if exists inc_update on public.incidents;
create policy inc_update on public.incidents for update to authenticated
  using (public.is_member(project_id)
         and (public.my_role() in ('founder', 'pm') or created_by = auth.uid()));
