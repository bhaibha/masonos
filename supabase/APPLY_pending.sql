-- ==============================================================
-- MASON OS — pending migrations 004–010, in order.
-- Paste this whole file into the Supabase SQL editor and Run.
-- FULLY re-runnable: functions/views use create-or-replace, columns use
-- add-if-not-exists, policies drop-if-exists before create. Running it
-- twice is harmless.
-- ==============================================================


-- ############################################################
-- ###  004_expense_totals.sql
-- ############################################################

-- ============================================================
-- MASON OS — Migration 004: server-side expense totals
--
-- 1. fn_expense_total()      — filtered ledger sums, computed in Postgres
-- 2. v_budget_vs_actual      — rebuilt so spend in an unbudgeted category
--                              still shows up (open book means no hiding)
--
-- Both are SECURITY INVOKER: RLS from 002_money.sql still decides who sees
-- what. A supervisor calling fn_expense_total gets zeros, not an error.
-- ============================================================

-- ---------- 1. FILTERED LEDGER TOTAL ----------
-- Mirrors the ledger's filters exactly. Every argument is optional; NULL means
-- "no filter on this column". Returns one row.
--
-- total_with_gst uses the same definition as v_project_spend.total_spent
-- (amount + gst_amount) so the two screens can never disagree.

create or replace function public.fn_expense_total(
  p_project  uuid,
  p_from     date           default null,
  p_to       date           default null,
  p_category int            default null,
  p_source   expense_source default null
)
returns table (
  total_amount   numeric(14,2),
  total_gst      numeric(14,2),
  total_with_gst numeric(14,2),
  entry_count    bigint
)
language sql
stable
security invoker            -- explicit: caller's RLS applies
set search_path = public
as $$
  select
    coalesce(sum(e.amount), 0)::numeric(14,2)                  as total_amount,
    coalesce(sum(e.gst_amount), 0)::numeric(14,2)              as total_gst,
    coalesce(sum(e.amount + e.gst_amount), 0)::numeric(14,2)   as total_with_gst,
    count(*)                                                   as entry_count
  from public.expenses e
  where e.project_id = p_project
    and (p_from     is null or e.expense_date >= p_from)
    and (p_to       is null or e.expense_date <= p_to)
    and (p_category is null or e.category_id  =  p_category)
    and (p_source   is null or e.source       =  p_source);
$$;

revoke all on function public.fn_expense_total(uuid, date, date, int, expense_source) from public;
grant execute on function public.fn_expense_total(uuid, date, date, int, expense_source) to authenticated;


-- ---------- 2. BUDGET VS ACTUAL, INCLUDING UNBUDGETED SPEND ----------
-- The original inner-joined budgets, so a category with spend but no budget row
-- was invisible. This version unions both key sets — the relational equivalent
-- of a full outer join between budgets and per-category actuals — and reports
-- budget 0 where none was set.
--
-- New column: has_budget. Lets the UI distinguish "budget of ₹0 was set
-- deliberately" from "nobody budgeted this at all", which read identically
-- before. Column is appended last so nothing positional breaks.

drop view if exists public.v_budget_vs_actual;

create view public.v_budget_vs_actual with (security_invoker = true) as
with keys as (
  select project_id, category_id from public.budgets
  union
  select project_id, category_id from public.expenses
),
actuals as (
  select project_id,
         category_id,
         sum(amount + gst_amount) as actual
  from public.expenses
  group by project_id, category_id
)
select
  k.project_id,
  c.name                                              as category,
  coalesce(b.amount, 0)::numeric(14,2)                as budget,
  coalesce(a.actual, 0)::numeric(14,2)                as actual,
  (coalesce(b.amount, 0) - coalesce(a.actual, 0))::numeric(14,2) as remaining,
  (b.id is not null)                                  as has_budget
from keys k
join public.expense_categories c
  on c.id = k.category_id
left join public.budgets b
  on b.project_id = k.project_id
 and b.category_id = k.category_id
left join actuals a
  on a.project_id = k.project_id
 and a.category_id = k.category_id;

comment on view public.v_budget_vs_actual is
  'Per-project, per-category budget vs actual. Includes categories with spend '
  'but no budget row (budget 0, has_budget false). security_invoker: RLS applies.';


-- ############################################################
-- ###  005_rollover_scope.sql
-- ############################################################

-- ============================================================
-- MASON OS — Migration 005: scope rollover_tasks to one project
--
-- The 001_core.sql version took only p_date, ran SECURITY DEFINER, and had no
-- authorisation check — so any authenticated user rolled over unfinished tasks
-- for EVERY project in the database, including ones they can't see.
--
-- This replaces it with a project-scoped, membership-checked version.
-- ============================================================

-- Drop the old unscoped overload first. If both existed, a call passing only
-- p_date would silently resolve to the dangerous one.
drop function if exists public.rollover_tasks(date);

create or replace function public.rollover_tasks(
  p_project uuid,
  p_date    date default current_date
)
returns int
language plpgsql
security definer                       -- needed so the copy runs as one unit
set search_path = public
as $$
declare
  n int;
begin
  -- Authorisation. SECURITY DEFINER bypasses RLS, so the checks that the
  -- tasks_read / tasks_write policies would have made are made explicitly here.
  -- auth.uid() still reflects the calling user's JWT inside a definer function.
  if auth.uid() is null then
    raise exception 'rollover_tasks: no authenticated user';
  end if;

  if not public.is_member(p_project) then
    raise exception 'rollover_tasks: not a member of project %', p_project
      using errcode = '42501';         -- insufficient_privilege
  end if;

  -- Mirrors tasks_write: accounts may read tasks but never create them.
  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'rollover_tasks: role % may not create tasks', public.my_role()
      using errcode = '42501';
  end if;

  with src as (
    select *
    from public.tasks
    where project_id = p_project                 -- << the scoping fix
      and planned_date = p_date
      and status in ('pending', 'partial', 'not_done')
      -- don't roll the same task twice
      and not exists (
        select 1 from public.tasks c where c.rolled_from = tasks.id
      )
  ),
  ins as (
    insert into public.tasks
      (project_id, title, trade, work_area, planned_date,
       target_qty, qty_unit, rolled_from, created_by)
    select
      project_id, title, trade, work_area, p_date + 1,
      case
        when status = 'partial'
          then greatest(coalesce(target_qty, 0) - coalesce(done_qty, 0), 0)
        else target_qty
      end,
      qty_unit, id, created_by
    from src
    returning 1
  )
  select count(*) into n from ins;

  return n;
end $$;

comment on function public.rollover_tasks(uuid, date) is
  'Copies unfinished tasks for ONE project from p_date to the next day. '
  'SECURITY DEFINER with explicit is_member + role checks standing in for RLS.';

-- Only signed-in users may call it. Without this, `anon` inherits EXECUTE from
-- PUBLIC and reaches a definer function that writes rows.
revoke all on function public.rollover_tasks(uuid, date) from public;
revoke all on function public.rollover_tasks(uuid, date) from anon;
grant execute on function public.rollover_tasks(uuid, date) to authenticated;


-- ############################################################
-- ###  006_storage_and_rate_privacy.sql
-- ############################################################

-- ============================================================
-- MASON OS — Migration 006: close two read-side holes
--
-- 1. storage.objects — the blanket `storage_rw` policy let ANY authenticated
--    user read ANY object in receipts / site-photos / documents. Replaced with
--    per-bucket policies keyed on the leading path segment (= project_id) and
--    public.is_member(). The documents bucket additionally hides confidential
--    files from supervisors, matching docs_read on the table.
--
-- 2. material_inward.rate / vendor_id — RLS cannot restrict columns, and every
--    app user shares the `authenticated` role, so supervisors could read
--    purchase rates straight from PostgREST. Fixed with column-level GRANTs
--    plus a rate-bearing view restricted to founder/pm/accounts.
--
-- Object paths are already `<project_id>/<uuid>.<ext>` for all three buckets,
-- so no data migration is needed. Verify before running:
--   select name from storage.objects
--   where bucket_id in ('receipts','site-photos','documents')
--     and split_part(name,'/',1) !~
--       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--   -- expect zero rows
-- ============================================================


-- ---------- HELPERS ----------

-- Leading path segment as a uuid, or NULL if it isn't one. A bare
-- `split_part(name,'/',1)::uuid` would raise on a malformed key and error the
-- whole query rather than just denying the row.
create or replace function public.fn_storage_project(p_name text)
returns uuid
language plpgsql
immutable
as $$
declare
  seg text;
begin
  seg := split_part(p_name, '/', 1);
  if seg !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return null;
  end if;
  return seg::uuid;
exception when others then
  return null;
end $$;

-- Is the object at this path a confidential document?
--
-- MUST be SECURITY DEFINER. A plain subquery against public.documents inside a
-- storage policy runs as the caller, so RLS (docs_read) would hide the
-- confidential row from a supervisor, `exists` would come back false, and the
-- policy would conclude "not confidential" and GRANT access — the exact
-- opposite of the intent. Running as owner sees the true value.
create or replace function public.fn_doc_is_confidential(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select d.is_confidential
     from public.documents d
     where d.file_path = p_path
     limit 1),
    false)
$$;

revoke all on function public.fn_doc_is_confidential(text) from public, anon;
grant execute on function public.fn_doc_is_confidential(text) to authenticated;

-- The policy looks up by file_path on every object read.
create index if not exists documents_file_path_idx
  on public.documents (file_path);


-- ---------- 1. STORAGE POLICIES ----------

drop policy if exists storage_rw on storage.objects;

-- Each policy is dropped before it's created so this migration re-runs cleanly.
-- `create policy` has no OR REPLACE / IF NOT EXISTS, so a second run without
-- these drops fails with "policy already exists".

-- READ ------------------------------------------------------

drop policy if exists receipts_read on storage.objects;
create policy receipts_read on storage.objects for select to authenticated
using (
  bucket_id = 'receipts'
  and public.is_member(public.fn_storage_project(name))
);

drop policy if exists site_photos_read on storage.objects;
create policy site_photos_read on storage.objects for select to authenticated
using (
  bucket_id = 'site-photos'
  and public.is_member(public.fn_storage_project(name))
);

drop policy if exists documents_read on storage.objects;
create policy documents_read on storage.objects for select to authenticated
using (
  bucket_id = 'documents'
  and public.is_member(public.fn_storage_project(name))
  and (
    not public.fn_doc_is_confidential(name)
    or public.my_role() in ('founder', 'pm', 'accounts')
  )
);

-- WRITE -----------------------------------------------------
-- Supervisors upload challan and site photos; they never upload to the vault
-- (mirrors docs_write on public.documents).

drop policy if exists receipts_insert on storage.objects;
create policy receipts_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'receipts'
  and public.is_member(public.fn_storage_project(name))
);

drop policy if exists site_photos_insert on storage.objects;
create policy site_photos_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'site-photos'
  and public.is_member(public.fn_storage_project(name))
);

drop policy if exists documents_insert on storage.objects;
create policy documents_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'documents'
  and public.is_member(public.fn_storage_project(name))
  and public.my_role() in ('founder', 'pm', 'accounts')
);

-- DELETE ----------------------------------------------------
-- Founder, or whoever uploaded it. No UPDATE policy: objects are immutable
-- once written (uploads always use a fresh uuid, upsert:false).

drop policy if exists storage_delete on storage.objects;
create policy storage_delete on storage.objects for delete to authenticated
using (
  bucket_id in ('receipts', 'site-photos', 'documents')
  and public.is_member(public.fn_storage_project(name))
  and (public.is_founder() or owner = auth.uid())
);


-- ---------- 2. material_inward RATE PRIVACY ----------

-- Column-level SELECT. Postgres grants are per-database-role, and all app
-- users share `authenticated`, so this hides rate and vendor_id from everyone
-- reading the table directly — including the founder. Privileged reads go
-- through v_material_inward_rates below.
revoke select on public.material_inward from authenticated;

grant select (
  id, project_id, material_id, inward_date, qty,
  challan_no, challan_photo, remarks, created_by, created_at
) on public.material_inward to authenticated;

-- INSERT is untouched: the app still writes rate when a founder/pm enters one.

-- Safe read for everyone. security_invoker → RLS (inward_read) still applies
-- and the caller's column grants are satisfied.
create or replace view public.v_material_inward with (security_invoker = true) as
select id, project_id, material_id, inward_date, qty,
       challan_no, challan_photo, remarks, created_by, created_at
from public.material_inward;

grant select on public.v_material_inward to authenticated;

-- Rate-bearing read. Deliberately NOT security_invoker: it runs as the view
-- owner so it can see the restricted columns, therefore it does its own
-- authorisation in the WHERE clause. Both checks are required.
create or replace view public.v_material_inward_rates as
select i.id, i.project_id, i.material_id, i.inward_date, i.qty,
       i.vendor_id, i.challan_no, i.rate, i.challan_photo, i.remarks,
       i.created_by, i.created_at
from public.material_inward i
where public.is_member(i.project_id)
  and public.my_role() in ('founder', 'pm', 'accounts');

grant select on public.v_material_inward_rates to authenticated;

comment on view public.v_material_inward_rates is
  'Inward rows including rate and vendor_id. Runs as owner, so the WHERE '
  'clause is the access control: project membership + founder/pm/accounts.';


-- ############################################################
-- ###  007_project_spend_remaining.sql
-- ############################################################

-- ============================================================
-- MASON OS — Migration 007: remaining + pct_used on v_project_spend
--
-- The dashboard wants to show "₹76,736 over" / "₹4,20,000 remaining".
-- That is budget − spent, i.e. money math, which CLAUDE.md rule 2 puts in
-- Postgres and nowhere else. So the view computes it and the browser prints it.
--
-- Also adds pct_used so the status pill stops deriving its own percentage.
--
-- Dropped and recreated rather than CREATE OR REPLACE: the numeric casts
-- change the existing columns' declared types, which replace-in-place refuses.
-- Nothing depends on this view.
-- ============================================================

drop view if exists public.v_project_spend;

create view public.v_project_spend with (security_invoker = true) as
select
  p.id                                                        as project_id,
  p.name,
  coalesce(s.spent, 0)::numeric(14,2)                         as total_spent,
  coalesce(b.budget, 0)::numeric(14,2)                        as total_budget,
  -- positive = under budget, negative = overspent
  (coalesce(b.budget, 0) - coalesce(s.spent, 0))::numeric(14,2) as remaining,
  case
    when coalesce(b.budget, 0) > 0
      then round(coalesce(s.spent, 0) * 100.0 / b.budget, 1)
  end                                                         as pct_used
from public.projects p
left join lateral (
  select sum(e.amount + e.gst_amount) as spent
  from public.expenses e
  where e.project_id = p.id
) s on true
left join lateral (
  select sum(bg.amount) as budget
  from public.budgets bg
  where bg.project_id = p.id
) b on true;

comment on view public.v_project_spend is
  'Per-project spend vs budget. remaining and pct_used are computed here so the '
  'client never does money arithmetic. security_invoker: RLS applies, so a '
  'supervisor sees zero spend rather than an error.';


-- ############################################################
-- ###  008_management_fee_amount.sql
-- ############################################################

-- ============================================================
-- MASON OS — Migration 008: management fee amount
--
-- The Project Detail header shows the fee in rupees, not just the percentage.
-- contract_value × management_fee_pct ÷ 100 is a fee calculation, which
-- CLAUDE.md rule 2 puts in Postgres — and names generated columns as one of
-- the sanctioned ways to do it.
--
-- STORED generated column rather than a view: it travels with every existing
-- `select` on projects, so the project picker, dashboard and detail screen all
-- get it without another join.
-- ============================================================

alter table public.projects
  add column if not exists management_fee_amount numeric(14,2)
  generated always as (
    round(contract_value * management_fee_pct / 100.0, 2)
  ) stored;

comment on column public.projects.management_fee_amount is
  'contract_value x management_fee_pct / 100, computed by Postgres. NULL when '
  'either input is NULL. Never calculated in the browser (CLAUDE.md rule 2).';

-- NOTE: this column inherits the same exposure as contract_value —
-- `projects_read` is `using (is_member(id))` with no column restriction, so
-- supervisors can read it directly from PostgREST even though the UI hides it.
-- The proposed migration 009 (column-level grants on projects, same shape as
-- 006 for material_inward.rate) should cover contract_value,
-- management_fee_pct and management_fee_amount together.


-- ############################################################
-- ###  009_portfolio_summary.sql
-- ############################################################

-- ============================================================
-- MASON OS — Migration 009: portfolio summary
--
-- The dashboard shows an "all projects" strip above the per-project grid.
-- Those are sums of money across projects, so they're computed here rather
-- than by adding up rows in the browser (CLAUDE.md rule 2).
--
-- Depends on v_project_spend as rebuilt by migration 007 — run 007 first.
-- If 007 is ever re-run after this, drop this view first, since 007 does a
-- DROP VIEW on v_project_spend.
--
-- security_invoker cascades: v_project_spend and projects both apply RLS, so a
-- user only ever aggregates the projects they can already see. A supervisor
-- gets zero spend rather than an error, exactly as on the per-project view.
-- ============================================================

create or replace view public.v_portfolio_summary with (security_invoker = true) as
select
  count(*)::int                                              as project_count,
  count(*) filter (where p.status = 'active')::int           as active_count,
  count(*) filter (where s.remaining < 0)::int               as over_budget_count,
  coalesce(sum(s.total_spent), 0)::numeric(14,2)             as total_spent,
  coalesce(sum(s.total_budget), 0)::numeric(14,2)            as total_budget,
  coalesce(sum(s.remaining), 0)::numeric(14,2)               as remaining,
  case
    when coalesce(sum(s.total_budget), 0) > 0
      then round(sum(s.total_spent) * 100.0 / sum(s.total_budget), 1)
  end                                                        as pct_used
from public.v_project_spend s
join public.projects p on p.id = s.project_id;

comment on view public.v_portfolio_summary is
  'Single-row roll-up of spend vs budget across every project the caller can '
  'see. Sums live here so the browser never adds money together.';


-- ############################################################
-- ###  010_project_commercials_privacy.sql
-- ############################################################

-- ============================================================
-- MASON OS — Migration 010: commercial-figure privacy on projects
--
-- contract_value, management_fee_pct and management_fee_amount are readable by
-- any project member today, supervisors included, because projects_read is
-- `using (is_member(id))` with no column restriction and RLS cannot limit
-- columns. The Project Detail header hides them in the UI, but a supervisor can
-- read them straight from PostgREST — the same gap 006 closed for
-- material_inward.rate. This closes it at the database level.
--
-- Shape mirrors 006: revoke SELECT on the table, re-grant the safe columns
-- one by one, and expose the sensitive three through an owner-run view that
-- carries its own role check.
--
-- Requires the frontend change shipped alongside (fetchProjects/fetchProject
-- select only the safe columns; commercials come from v_project_commercials).
-- The client tolerates either order — it falls back if the view is absent.
-- ============================================================

-- ---------- COLUMN-LEVEL SELECT ----------

-- All app users share the `authenticated` Postgres role; per-user access is via
-- JWT + RLS, not roles. So this hides the three columns from EVERYONE reading
-- the table directly — including the founder. Privileged reads go through the
-- view below. INSERT/UPDATE are untouched, so the (SQL-only, for now) project
-- admin path still writes them.
revoke select on public.projects from authenticated;

grant select (
  id, name, client_name, site_address, status,
  start_date, target_end_date, created_at
) on public.projects to authenticated;


-- ---------- ROLE-GATED COMMERCIAL VIEW ----------

-- Deliberately NOT security_invoker: it runs as the view owner so it can read
-- the columns `authenticated` no longer can. That makes the WHERE clause the
-- access control, so it must check BOTH membership and role. Drop either and
-- it leaks.
create or replace view public.v_project_commercials as
select
  p.id,
  p.contract_value,
  p.management_fee_pct,
  p.management_fee_amount
from public.projects p
where public.is_member(p.id)
  and public.my_role() in ('founder', 'pm', 'accounts');

grant select on public.v_project_commercials to authenticated;

comment on view public.v_project_commercials is
  'Contract value and management fee per project. Owner-run, so the WHERE '
  'clause is the access control: project membership AND founder/pm/accounts. '
  'Supervisors get zero rows.';


-- ---------- NOTE ----------
-- If a project edit screen is added later, its UPDATE cannot use PostgREST''s
-- default return=representation (that re-SELECTs every column and will hit the
-- revoke). Use Prefer: return=minimal, or return only the granted columns.



-- ############################################################
-- ###  011_safety.sql
-- ############################################################

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
