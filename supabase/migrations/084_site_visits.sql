-- ============================================================================
-- 084 — M18 Site Visits Tracker
--       who came, what they said, and what we now have to do about it
-- ============================================================================
--
-- ACTION ITEMS ARE TASKS. THERE IS NO SECOND TABLE.
-- ------------------------------------------------
-- `tasks` (001, extended in 048) already carries title, `work_area`,
-- `planned_date` as the due date, `status`, `assigned_to` and `priority` — and
-- around it sit the daily list, the rollover chain, the push digest (036) and
-- the EVM activity tag (042). A `visit_actions` table would have duplicated the
-- columns and none of the machinery: the site would have two lists to check,
-- rollover and the digest would cover one of them, and "what is overdue on this
-- project" would become two queries that eventually disagree.
--
-- So this migration adds ONE nullable column — `tasks.visit_id` — and the
-- action items a consultant leaves behind are ordinary tasks that happen to
-- know where they came from. Same judgement as 040 (don't model overheads as a
-- pseudo-project) and 062 (reuse the enum that already means this).
--
-- `tasks_write` is already `founder/pm/supervisor` on a project they belong to,
-- which is exactly who M18 wants logging visits, so **no policy changes to
-- `tasks` at all**. And `tasks` is not column-granted (checked — the 027 trap
-- applies to `projects`, `po_lines`, `material_inward` and
-- `schedule_activities`), so the new column is readable the moment it exists.
--
-- THE CLIENT VISIT AND MIGRATION 083
-- ----------------------------------
-- 083 shipped `comm_channel` with a `site_visit` value, so a client walking the
-- site was already loggable in the Client Communication Log. That is a real
-- overlap and pretending otherwise would leave the firm typing the same visit
-- twice into two records that drift (the 054 rule: say when you are duplicating
-- an existing fact).
--
-- The resolution: **this table is the record of the VISIT** — who came, what
-- was observed, the photographs, what has to be done — and `comm_entry_id` is
-- an optional pointer at the M36 entry when the visit also produced a
-- CONVERSATION worth keeping. Two different facts, one link, neither copied.
-- ON DELETE SET NULL, never cascade (031): deleting the note of a conversation
-- must not delete the record that somebody came to site.
--
-- WHAT "SPECIAL HANDLING" FOR A CLIENT VISIT ACTUALLY IS
-- -----------------------------------------------------
-- A flag that only changes a colour is not handling. Two things differ, and
-- only one of them can live in the database:
--   1. `svt_client_needs_observations` — a client visit CANNOT be saved with an
--      empty observations field. A CHECK constraint, not a form rule, so it
--      survives anything talking to the API directly (the 050 lesson). A client
--      visit with no observations is the one record that is certain to be
--      wanted later and certain not to have been written down.
--   2. The screen offers to log the conversation in the Client log afterwards.
--      That is a PROMPT and lives in the app, because forcing it would mean a
--      site visit could not be recorded until somebody also wrote a summary of
--      the small talk.
-- Deliberately NOT hidden from supervisors: the supervisor usually escorts the
-- client round the site and is the person who knows what was pointed at.
-- Hiding it would mean they cannot log the visit they personally attended.
--
-- THE VISITOR IS NOT A USER
-- -------------------------
-- `visitor_name` and `visitor_org` are plain text. A structural consultant, a
-- BBMP officer and a client's brother-in-law will never have accounts, and
-- giving them `profiles` rows would imply logins nobody will ever issue — the
-- 060 rule about modelling the RECORD of what an outsider did rather than the
-- outsider as a user.
--
-- Re-runnable: enum `if not exists`, table `if not exists`, `add column if not
-- exists`, `drop policy if exists` before create, `drop trigger if exists`
-- before create.
-- ============================================================================

-- ############################################################
-- ###  1. Type
-- ############################################################
do $$ begin
  create type visit_type as enum
    ('client','consultant','pm','inspection','authority','vendor');
exception when duplicate_object then null; end $$;

-- ############################################################
-- ###  2. The visit
-- ############################################################
create sequence if not exists public.visit_no_seq;

create table if not exists public.site_visits (
  id uuid primary key default gen_random_uuid(),
  visit_no text not null unique
    default 'SV-' || lpad(nextval('public.visit_no_seq')::text, 4, '0'),

  project_id uuid not null references public.projects(id) on delete cascade,

  visit_type visit_type not null,

  -- The day they CAME, not the day it was typed up (the 060 rule).
  visit_date date not null default current_date,
  visit_time time,

  -- Plain text — see the header. `visitor_org` is separate because "Sharma" and
  -- "Sharma, of the structural consultants" are different facts a year later.
  visitor_name text not null check (btrim(visitor_name) <> ''),
  visitor_org text,

  purpose text,
  observations text,

  -- Storage paths, same convention as site_logs.photos (001): every path
  -- starts `${projectId}/`, which is what the bucket policies key off.
  photos text[] not null default '{}',

  -- Optional pointer at the M36 conversation, when the visit also produced one.
  comm_entry_id uuid
    references public.client_comm_entries(id) on delete set null,

  logged_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The one piece of "special handling" that can be enforced. See the header.
  constraint svt_client_needs_observations check (
    visit_type <> 'client'::visit_type
    or btrim(coalesce(observations, '')) <> ''
  )
);

create index if not exists svt_project_idx
  on public.site_visits (project_id, visit_date desc);

-- ############################################################
-- ###  3. The link from a task back to the visit that caused it
-- ############################################################
-- SET NULL, not cascade: deleting a visit record must not delete the work it
-- generated. The task stands on its own — somebody still has to do it.
alter table public.tasks
  add column if not exists visit_id uuid
  references public.site_visits(id) on delete set null;

create index if not exists tasks_visit_idx
  on public.tasks (visit_id) where visit_id is not null;

-- ############################################################
-- ###  4. Triggers
-- ############################################################
create or replace function public.fn_site_visit_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists svt_touch on public.site_visits;
create trigger svt_touch before update on public.site_visits
  for each row execute function public.fn_site_visit_touch();

-- Keyed by `id`, so the standard fn_audit applies (the 051 trap only bites
-- code-keyed tables).
drop trigger if exists audit_svt on public.site_visits;
create trigger audit_svt after insert or update or delete
  on public.site_visits for each row execute function public.fn_audit();

-- ############################################################
-- ###  5. RLS
-- ############################################################
alter table public.site_visits enable row level security;

-- Read: anyone on the project. `is_member()` already returns FALSE for a client
-- (065) and for a deactivated profile (078), so an `is_internal()` clause would
-- restate something already true — and the neighbouring `tasks_read` and
-- `logs_read` policies are written exactly this way.
drop policy if exists svt_read on public.site_visits;
create policy svt_read on public.site_visits for select to authenticated
  using (public.is_member(project_id));

-- Write: founder / pm / supervisor — the same three as `tasks_write`, and for
-- the same reason. The person who walked the site is the person who logs it.
drop policy if exists svt_write on public.site_visits;
create policy svt_write on public.site_visits for insert to authenticated
  with check (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','supervisor')
  );

drop policy if exists svt_update on public.site_visits;
create policy svt_update on public.site_visits for update to authenticated
  using (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','supervisor')
  )
  with check (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','supervisor')
  );

-- No DELETE policy. A visit happened; the record of it does not go away.
-- Consistent with `site_logs`, and with the 069 shape where the ABSENCE of a
-- policy is the protection.

-- ############################################################
-- ###  6. What is still open, for the project detail strip
-- ############################################################
-- Returns ZERO ROWS when nothing is outstanding, so the strip vanishes rather
-- than rendering "0 open" — the 073 rule. The 066 wrapper keeps a client or an
-- outsider from getting a row of zeros.
--
-- Counts TASKS, because that is where visit actions live. `is_member()` inside
-- the task subquery is unnecessary — RLS already scopes it — but the project
-- filter is not, and neither is the visit_id filter: an ordinary site task is
-- not a visit action.
create or replace function public.fn_visit_open_actions(p_project uuid)
returns table (
  open_actions int,
  overdue_actions int,
  visits_30d int,
  last_visit_on date
)
language sql stable security invoker set search_path = public as $$
  select * from (
    select
      (select count(*) from public.tasks t
        where t.project_id = p_project
          and t.visit_id is not null
          and t.status = 'pending'::task_status)::int              as open_actions,
      (select count(*) from public.tasks t
        where t.project_id = p_project
          and t.visit_id is not null
          and t.status = 'pending'::task_status
          and t.planned_date < (now() at time zone 'Asia/Kolkata')::date)::int
                                                                    as overdue_actions,
      (select count(*) from public.site_visits v
        where v.project_id = p_project
          and v.visit_date >= (now() at time zone 'Asia/Kolkata')::date - 30)::int
                                                                    as visits_30d,
      (select max(v.visit_date) from public.site_visits v
        where v.project_id = p_project)                             as last_visit_on
  ) q
  where public.is_internal()
    and (q.open_actions > 0 or q.visits_30d > 0);
$$;

revoke all on function public.fn_visit_open_actions(uuid) from public, anon;
grant execute on function public.fn_visit_open_actions(uuid) to authenticated;

-- ############################################################
-- ###  7. Verify
-- ############################################################
-- One final SELECT — the Supabase SQL editor shows only the LAST result set
-- and does not display `raise notice`.
--
-- Expect: tbl = 1, enum = 1, visit_col = 1, policies = 3, no_delete = 0,
--         client_check = 1, audit_trg = 1, touch_trg = 1, fn = 1, idx = 2.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'site_visits')          as tbl,
  (select count(*) from pg_type where typname = 'visit_type')              as enum,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks'
      and column_name = 'visit_id')                                        as visit_col,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'site_visits')             as policies,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'site_visits'
      and cmd = 'DELETE')                                                  as no_delete,
  (select count(*) from pg_constraint
    where conname = 'svt_client_needs_observations')                       as client_check,
  (select count(*) from pg_trigger
    where tgname = 'audit_svt' and not tgisinternal)                       as audit_trg,
  (select count(*) from pg_trigger
    where tgname = 'svt_touch' and not tgisinternal)                       as touch_trg,
  (select count(*) from pg_proc
    where proname = 'fn_visit_open_actions')                               as fn,
  (select count(*) from pg_indexes
    where schemaname = 'public'
      and indexname in ('svt_project_idx','tasks_visit_idx'))              as idx;
