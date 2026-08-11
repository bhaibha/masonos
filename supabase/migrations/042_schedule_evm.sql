-- ============================================================
-- MASON OS — Migration 042: schedule + earned value (B1 / Module 02)
--
-- Two things that look like one module and are not:
--
--   1. A SCHEDULE — what should happen, when, and in what order. Everyone on
--      the project can see it, supervisors included. A programme nobody on site
--      can read is a programme nobody follows.
--   2. EARNED VALUE — what that schedule is worth, what has been earned, and
--      what it has cost. That is cost performance, so it is founder / PM /
--      accounts only, exactly like every other money surface.
--
-- The split is the whole design problem, and it is solved with COLUMN GRANTS
-- rather than two tables. `schedule_activities.budget_amount` is revoked from
-- `authenticated` (the 010 pattern), so a supervisor selecting the table gets
-- dates, sequence and % complete and cannot reach the money even by asking for
-- it directly. Everything derived from that column — PV, EV, AC, CPI, EAC —
-- lives behind owner-run functions that gate on role in their WHERE clause.
--
-- ---------- WHY % COMPLETE GOES THROUGH AN RPC ----------
-- Supervisors SHOULD update progress; they are the ones standing in front of
-- the slab. But a column grant is table-wide for the `authenticated` role, so
-- any UPDATE policy permissive enough to let them set `pct_complete` would also
-- let them set `budget_amount`. So: the UPDATE policy is founder/PM only, and
-- `fn_set_activity_progress` is the supervisor's way in — it writes exactly
-- three columns and cannot be argued into writing a fourth.
--
-- ---------- DEPENDENCIES ----------
-- Finish-to-start only, with an optional lag. There is deliberately no `type`
-- column: a column with one possible value is a promise the code does not
-- keep. Start-to-start and finish-to-finish can be a later migration if a real
-- programme ever needs them.
--
-- Cycles are refused at write time by a trigger rather than defended against at
-- read time. A cycle makes the critical path meaningless and the forward pass
-- non-terminating, and there is no sensible way to render one — far better to
-- refuse the edit that creates it, while the person still remembers what they
-- were trying to express.
--
-- ---------- DIVIDE BY ZERO ----------
-- EVM is a pile of ratios and every one of them has a real-world zero:
--   * PV = 0 — the activity has not started per the plan. SPI is undefined,
--     not 0 and not infinity. Being "infinitely ahead" of a plan that expected
--     nothing is not a finding.
--   * AC = 0 — nothing has been spent. CPI is undefined for the same reason.
--   * CPI = 0 — money spent, nothing earned. EAC = BAC/CPI is genuinely
--     undefined, and a screen that showed ∞ would be worse than one that says
--     "n/a".
-- Every one of these returns NULL. The UI prints "n/a"; nothing computes with
-- a null downstream.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. ACTIVITIES
-- ############################################################
create table if not exists public.schedule_activities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  -- WBS code as free text ("2", "2.1", "2.1.a"). Sorting is by sort_order, not
  -- by this — "1.10" sorts before "1.9" as text and always will.
  code text not null,
  name text not null,

  planned_start date not null,
  planned_end   date not null,

  -- BAC for this activity. REVOKED from authenticated below; the only way to
  -- read it is through the EVM functions, which gate on role.
  budget_amount numeric(14,2) not null default 0 check (budget_amount >= 0),

  planned_qty numeric(12,2),
  qty_unit    text,

  -- Physical progress, 0–100. The single most abused number in construction
  -- reporting, which is why it is the only input to EV and why the audit log
  -- carries every change to it.
  pct_complete numeric(5,2) not null default 0
    check (pct_complete >= 0 and pct_complete <= 100),

  actual_start date,
  actual_end   date,

  notes text,
  sort_order int not null default 100,

  -- Reading aid only: the screen groups and collapses by this. It is NOT a
  -- parent row — every activity is a leaf, so nothing double-counts in earned
  -- value. A micro schedule is 120+ lines and unreadable without grouping.
  phase text,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sched_act_dates_ck check (planned_end >= planned_start)
);

-- `create table if not exists` is a NO-OP on a table that already exists, so a
-- column added to this file after an earlier version of it was run would never
-- appear — and the column grant below, which names `phase`, aborts the whole
-- script with "column phase does not exist". Every column added to this table
-- after its first release therefore gets an explicit ALTER as well.
alter table public.schedule_activities add column if not exists phase text;

-- One code per project, ignoring case and stray space — the same normalised
-- uniqueness 041 used, for the same reason.
drop index if exists public.sched_act_code_uk;
create unique index sched_act_code_uk
  on public.schedule_activities (project_id, lower(btrim(code)));

create index if not exists sched_act_project_idx
  on public.schedule_activities (project_id, sort_order, planned_start);

comment on column public.schedule_activities.budget_amount is
  'BAC for the activity. Revoked from authenticated (see the column grant '
  'below) — supervisors read the schedule, never its money.';


-- ############################################################
-- ###  2. DEPENDENCIES — finish-to-start, with lag
-- ############################################################
create table if not exists public.activity_dependencies (
  id uuid primary key default gen_random_uuid(),
  predecessor_id uuid not null
    references public.schedule_activities(id) on delete cascade,
  successor_id uuid not null
    references public.schedule_activities(id) on delete cascade,

  -- Working days of lag. Negative = lead ("start 2 days before it finishes").
  lag_days int not null default 0,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),

  constraint act_dep_distinct_ck check (predecessor_id <> successor_id),
  constraint act_dep_unique_uk unique (predecessor_id, successor_id)
);

create index if not exists act_dep_succ_idx
  on public.activity_dependencies (successor_id);


-- Both ends must be on the same project, and the link must not close a loop.
create or replace function public.fn_activity_dep_check()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_p uuid; v_s uuid; v_loops boolean;
begin
  select project_id into v_p from public.schedule_activities where id = new.predecessor_id;
  select project_id into v_s from public.schedule_activities where id = new.successor_id;

  if v_p is null or v_s is null then
    raise exception 'One end of that link is not an activity.';
  end if;
  if v_p <> v_s then
    raise exception 'A dependency cannot cross projects.';
  end if;

  -- Can we already get from the successor back to the predecessor? If so this
  -- link closes a loop. Depth-capped so a pre-existing loop (impossible via
  -- this trigger, but possible via a restore) cannot hang the insert.
  with recursive reach as (
    select new.successor_id as id, 0 as depth
    union all
    select d.successor_id, r.depth + 1
    from reach r
    join public.activity_dependencies d on d.predecessor_id = r.id
    where r.depth < 500
  )
  select exists (select 1 from reach where id = new.predecessor_id) into v_loops;

  if v_loops then
    raise exception
      'That link would make a loop — the successor already leads back to the predecessor. A schedule that depends on itself has no start date.';
  end if;

  return new;
end $$;

drop trigger if exists act_dep_check on public.activity_dependencies;
create trigger act_dep_check
  before insert or update on public.activity_dependencies
  for each row execute function public.fn_activity_dep_check();


-- ############################################################
-- ###  3. LINKS FROM WORK AND MONEY
-- ############################################################
-- All three are ON DELETE SET NULL, never cascade (the 031 container-delete
-- lesson): removing an activity from the programme must not take a task, an
-- expense or a certified bill with it. The work happened; only the plan
-- changed.
alter table public.tasks
  add column if not exists activity_id uuid
  references public.schedule_activities(id) on delete set null;

alter table public.expenses
  add column if not exists activity_id uuid
  references public.schedule_activities(id) on delete set null;

alter table public.ra_bills
  add column if not exists activity_id uuid
  references public.schedule_activities(id) on delete set null;

create index if not exists tasks_activity_idx on public.tasks (activity_id);
create index if not exists expenses_activity_idx on public.expenses (activity_id);
create index if not exists ra_bills_activity_idx on public.ra_bills (activity_id);

-- 002 revoked nothing on `tasks`, but `expenses` and `ra_bills` are read
-- through role-gated policies already; adding a column to them needs no new
-- grant because neither is column-granted. `projects` is — that trap does not
-- apply here, but check it again the next time a column is added anywhere.


-- ############################################################
-- ###  4. RLS
-- ############################################################
alter table public.schedule_activities enable row level security;
alter table public.activity_dependencies enable row level security;

-- Everyone on the project reads the programme, supervisors included. The money
-- column is closed off by the GRANT below, not by this policy — RLS is per row,
-- and the row is not the secret.
drop policy if exists sched_act_read on public.schedule_activities;
create policy sched_act_read on public.schedule_activities
  for select to authenticated
  using (public.is_member(project_id));

drop policy if exists sched_act_insert on public.schedule_activities;
create policy sched_act_insert on public.schedule_activities
  for insert to authenticated
  with check (
    public.my_role() in ('founder', 'pm') and public.is_member(project_id)
  );

-- Founder/PM only. A supervisor's progress update goes through
-- fn_set_activity_progress — see the header for why that is not pedantry.
drop policy if exists sched_act_update on public.schedule_activities;
create policy sched_act_update on public.schedule_activities
  for update to authenticated
  using (public.my_role() in ('founder', 'pm') and public.is_member(project_id))
  with check (public.my_role() in ('founder', 'pm') and public.is_member(project_id));

-- No DELETE policy — removal goes through fn_delete_record's new branch.

drop policy if exists act_dep_read on public.activity_dependencies;
create policy act_dep_read on public.activity_dependencies
  for select to authenticated
  using (exists (
    select 1 from public.schedule_activities a
    where a.id = predecessor_id and public.is_member(a.project_id)
  ));

drop policy if exists act_dep_insert on public.activity_dependencies;
create policy act_dep_insert on public.activity_dependencies
  for insert to authenticated
  with check (
    public.my_role() in ('founder', 'pm')
    and exists (
      select 1 from public.schedule_activities a
      where a.id = predecessor_id and public.is_member(a.project_id)
    )
  );

-- A link is a fact about sequence with nothing hanging off it, so it is
-- ordinary DELETE rather than a trip through fn_delete_record.
drop policy if exists act_dep_delete on public.activity_dependencies;
create policy act_dep_delete on public.activity_dependencies
  for delete to authenticated
  using (
    public.my_role() in ('founder', 'pm')
    and exists (
      select 1 from public.schedule_activities a
      where a.id = predecessor_id and public.is_member(a.project_id)
    )
  );


-- ############################################################
-- ###  5. COLUMN PRIVACY — the money column
-- ############################################################
-- The 010 pattern. SELECT is revoked wholesale and granted back column by
-- column; `budget_amount` is simply not on the list, so `select *` from a
-- supervisor's session fails on that column rather than returning it.
--
-- INSERT and UPDATE still carry budget_amount, because the RLS policies above
-- already restrict both to founder/PM. Writing a column you cannot read back
-- is fine; PostgREST's `returning` needs the SELECT grant it does not have.
--
-- NOTE FOR FUTURE MIGRATIONS: any column added to schedule_activities is
-- invisible until it is named here. Two statements, never one (the 027 lesson).
revoke select on public.schedule_activities from authenticated;
grant select (
  id, project_id, code, name,
  planned_start, planned_end,
  planned_qty, qty_unit,
  pct_complete, actual_start, actual_end,
  notes, sort_order, phase,
  created_by, created_at, updated_at
) on public.schedule_activities to authenticated;

grant insert, update on public.schedule_activities to authenticated;
grant select, insert, delete on public.activity_dependencies to authenticated;


-- ############################################################
-- ###  6. AUDIT
-- ############################################################
drop trigger if exists audit_schedule_activities on public.schedule_activities;
create trigger audit_schedule_activities
  after insert or update or delete on public.schedule_activities
  for each row execute function public.fn_audit();

drop trigger if exists audit_activity_dependencies on public.activity_dependencies;
create trigger audit_activity_dependencies
  after insert or update or delete on public.activity_dependencies
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  7. PROGRESS — the supervisor's one write
-- ############################################################
create or replace function public.fn_set_activity_progress(
  p_id           uuid,
  p_pct          numeric,
  p_actual_start date default null,
  p_actual_end   date default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_pct is null or p_pct < 0 or p_pct > 100 then
    raise exception 'Progress must be between 0 and 100.';
  end if;

  select project_id into v_project
  from public.schedule_activities where id = p_id;
  if v_project is null then
    raise exception 'That activity no longer exists.';
  end if;

  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot update progress.' using errcode = '42501';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  update public.schedule_activities
     set pct_complete = p_pct,
         -- A null argument leaves the stored date alone rather than clearing
         -- it: the progress slider must not be able to erase a start date
         -- somebody entered on another screen.
         actual_start = coalesce(p_actual_start, actual_start,
                                 case when p_pct > 0 then (now() at time zone 'Asia/Kolkata')::date end),
         actual_end   = case
                          when p_actual_end is not null then p_actual_end
                          when p_pct >= 100 then coalesce(actual_end, (now() at time zone 'Asia/Kolkata')::date)
                          -- Reopening a finished activity clears its finish
                          -- date, or the Gantt would show it both done and not.
                          else null
                        end,
         updated_at = now()
   where id = p_id;
end $$;

revoke all on function public.fn_set_activity_progress(uuid, numeric, date, date)
  from public, anon;
grant execute on function public.fn_set_activity_progress(uuid, numeric, date, date)
  to authenticated;


-- ############################################################
-- ###  8. CRITICAL PATH — forward and backward pass
-- ############################################################
-- Plain CPM over finish-to-start links, in calendar days.
--
-- Duration is planned_end − planned_start + 1, so a one-day activity has
-- duration 1 rather than 0. Both passes are depth-capped; the cycle trigger
-- should make that unreachable, and a cap costs nothing to be sure.
--
-- Runs as invoker: it exposes dates and float, never money, so a supervisor is
-- entitled to all of it.
create or replace function public.fn_activity_float(p_project uuid)
returns table (
  activity_id  uuid,
  early_start  date,
  early_finish date,
  late_start   date,
  late_finish  date,
  total_float  int,
  is_critical  boolean
)
language sql
stable
security invoker
set search_path = public
-- One flat WITH RECURSIVE list rather than recursive CTEs nested inside
-- ordinary ones. Postgres accepts the nested form, but a `with recursive`
-- buried two levels down is the kind of thing that reads fine and fails on a
-- version bump; a single list where non-recursive and recursive CTEs sit side
-- by side is plainer and provably legal.
as $$
  with recursive
  acts as (
    select id, planned_start, planned_end,
           (planned_end - planned_start) as span
    from public.schedule_activities
    where project_id = p_project
  ),
  deps as (
    select d.predecessor_id, d.successor_id, d.lag_days
    from public.activity_dependencies d
    join acts p on p.id = d.predecessor_id
    join acts s on s.id = d.successor_id
  ),
  -- ---------- forward pass: earliest each activity can start ----------
  fwd_walk as (
    select a.id, a.planned_start as es, a.planned_start + a.span as ef, 0 as depth
    from acts a
    where not exists (select 1 from deps d where d.successor_id = a.id)
    union all
    select a.id,
           greatest(a.planned_start, w.ef + 1 + d.lag_days),
           greatest(a.planned_start, w.ef + 1 + d.lag_days) + a.span,
           w.depth + 1
    from fwd_walk w
    join deps d on d.predecessor_id = w.id
    join acts a on a.id = d.successor_id
    where w.depth < 500
  ),
  -- A successor with several predecessors starts after the LAST of them.
  fwd as (select id, max(es) as es, max(ef) as ef from fwd_walk group by id),

  finish as (select max(ef) as project_finish from fwd),

  -- ---------- backward pass: latest it can run without moving the end ------
  bwd_walk as (
    select a.id, f.project_finish as lf, f.project_finish - a.span as ls, 0 as depth
    from acts a, finish f
    where not exists (select 1 from deps d where d.predecessor_id = a.id)
    union all
    select a.id,
           w.ls - 1 - d.lag_days,
           w.ls - 1 - d.lag_days - a.span,
           w.depth + 1
    from bwd_walk w
    join deps d on d.successor_id = w.id
    join acts a on a.id = d.predecessor_id
    where w.depth < 500
  ),
  -- A predecessor with several successors must finish before the EARLIEST.
  bwd as (select id, min(lf) as lf, min(ls) as ls from bwd_walk group by id)

  select
    a.id,
    f.es, f.ef, b.ls, b.lf,
    (b.ls - f.es)::int,
    (b.ls - f.es) <= 0
  from acts a
  join fwd f on f.id = a.id
  join bwd b on b.id = a.id;
$$;

revoke all on function public.fn_activity_float(uuid) from public, anon;
grant execute on function public.fn_activity_float(uuid) to authenticated;


-- ############################################################
-- ###  9. EVM PER ACTIVITY
-- ############################################################
-- Owner-run, because it reads budget_amount, which §5 revoked. The WHERE
-- clause IS the access control (the 010 → 038 pattern): losing it is a silent
-- full-table leak of every project's cost performance, so it is the first
-- thing to check when editing this function.
create or replace function public.fn_activity_evm(
  p_project   uuid,
  p_data_date date default null
)
returns table (
  activity_id   uuid,
  code          text,
  name          text,
  planned_start date,
  planned_end   date,
  pct_complete  numeric,
  bac           numeric,
  planned_pct   numeric,
  pv            numeric,
  ev            numeric,
  ac            numeric,
  sv            numeric,
  cv            numeric,
  spi           numeric,
  cpi           numeric,
  eac           numeric,
  etc           numeric,
  vac           numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select coalesce(p_data_date, (now() at time zone 'Asia/Kolkata')::date) as dd
  ),
  acts as (
    select a.*
    from public.schedule_activities a, params
    where a.project_id = p_project
      -- The gate. Cost performance is founder/PM/accounts, same as every other
      -- money surface; a supervisor matches no arm and receives zero rows.
      and public.is_member(a.project_id)
      and public.my_role() in ('founder', 'pm', 'accounts')
  ),
  -- Actual cost: site expenses plus certified contractor bills, both tied to
  -- the activity and both dated on or before the data date. Same definition of
  -- contractor cost as v_project_pnl (038) — net certified plus retention,
  -- because retention is owed whether or not it has been paid.
  spend as (
    select e.activity_id, sum(e.amount + e.gst_amount)::numeric(14,2) as amt
    from public.expenses e, params
    where e.activity_id is not null
      and e.voided_at is null
      and e.expense_date <= params.dd
    group by e.activity_id
  ),
  bills as (
    select b.activity_id,
           sum(b.net_certified + b.retention_amount)::numeric(14,2) as amt
    from public.ra_bills b, params
    where b.activity_id is not null
      and b.status::text = 'certified'
      and b.period_to <= params.dd
    group by b.activity_id
  ),
  calc as (
    select
      a.id, a.code, a.name, a.planned_start, a.planned_end, a.pct_complete,
      a.budget_amount as bac,
      -- Straight-line by duration. Nothing here knows about resource curves,
      -- and pretending otherwise would be false precision.
      case
        when params.dd >= a.planned_end then 1.0
        when params.dd <  a.planned_start then 0.0
        else (params.dd - a.planned_start + 1)::numeric
             / nullif((a.planned_end - a.planned_start + 1), 0)
      end as planned_frac,
      (coalesce(s.amt, 0) + coalesce(bl.amt, 0))::numeric(14,2) as ac
    from acts a
    cross join params
    left join spend s  on s.activity_id  = a.id
    left join bills bl on bl.activity_id = a.id
  ),
  ev_pv as (
    select
      c.*,
      round(c.planned_frac * c.bac, 2)         as pv,
      round(c.pct_complete / 100.0 * c.bac, 2) as ev
    from calc c
  )
  -- EVERY reference below is table-qualified on purpose. This function's
  -- RETURNS TABLE names — bac, pv, ev, ac, code, name — are also column names
  -- in the CTEs above, and a bare mention of one is ambiguous between the
  -- output parameter and the column. `e.pv` can only ever be the column.
  select
    e.id, e.code, e.name, e.planned_start, e.planned_end, e.pct_complete,
    e.bac,
    round(e.planned_frac * 100, 1),
    e.pv,
    e.ev,
    e.ac,
    (e.ev - e.pv)::numeric(14,2),
    (e.ev - e.ac)::numeric(14,2),
    -- Every ratio below is null rather than infinite when its denominator is
    -- zero. See the header: "infinitely ahead of a plan that expected nothing"
    -- is not a finding.
    case when e.pv > 0 then round(e.ev / e.pv, 3) end,
    case when e.ac > 0 then round(e.ev / e.ac, 3) end,
    case when e.ac > 0 and e.ev > 0 then round(e.bac * e.ac / e.ev, 2) end,
    case when e.ac > 0 and e.ev > 0 then round(e.bac * e.ac / e.ev - e.ac, 2) end,
    case when e.ac > 0 and e.ev > 0 then round(e.bac - e.bac * e.ac / e.ev, 2) end
  from ev_pv e
  order by e.planned_start, e.code;
$$;

revoke all on function public.fn_activity_evm(uuid, date) from public, anon;
grant execute on function public.fn_activity_evm(uuid, date) to authenticated;


-- ############################################################
-- ### 10. EVM ROLLED UP PER PROJECT
-- ############################################################
-- Indices are computed from the SUMS, never averaged from the per-activity
-- indices. Averaging ratios weights a ₹5,000 activity the same as a ₹50 lakh
-- one and produces a number that looks reasonable and is wrong.
create or replace function public.fn_project_evm(
  p_project   uuid,
  p_data_date date default null
)
returns table (
  data_date       date,
  activity_count  int,
  bac             numeric,
  pv              numeric,
  ev              numeric,
  ac              numeric,
  sv              numeric,
  cv              numeric,
  spi             numeric,
  cpi             numeric,
  eac             numeric,
  etc             numeric,
  vac             numeric,
  pct_complete    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with dd as (
    select coalesce(p_data_date, (now() at time zone 'Asia/Kolkata')::date) as d
  ),
  a as (
    select * from public.fn_activity_evm(p_project, (select d from dd))
  ),
  t as (
    -- Qualified for the same reason as fn_activity_evm's final select: bare
    -- `sum(bac)` would be ambiguous between this function's output parameter
    -- and the column of CTE `a`.
    select
      count(*)::int                          as n,
      coalesce(sum(a.bac), 0)::numeric(14,2) as bac,
      coalesce(sum(a.pv),  0)::numeric(14,2) as pv,
      coalesce(sum(a.ev),  0)::numeric(14,2) as ev,
      coalesce(sum(a.ac),  0)::numeric(14,2) as ac
    from a
  )
  select
    (select d from dd),
    t.n, t.bac, t.pv, t.ev, t.ac,
    (t.ev - t.pv)::numeric(14,2),
    (t.ev - t.ac)::numeric(14,2),
    case when t.pv > 0 then round(t.ev / t.pv, 3) end,
    case when t.ac > 0 then round(t.ev / t.ac, 3) end,
    case when t.ac > 0 and t.ev > 0 then round(t.bac * t.ac / t.ev, 2) end,
    case when t.ac > 0 and t.ev > 0 then round(t.bac * t.ac / t.ev - t.ac, 2) end,
    case when t.ac > 0 and t.ev > 0 then round(t.bac - t.bac * t.ac / t.ev, 2) end,
    -- Physical progress weighted by budget, which is what EV/BAC means. An
    -- unweighted average of pct_complete would let a trivial activity at 100%
    -- offset the slab at 10%.
    case when t.bac > 0 then round(t.ev * 100.0 / t.bac, 1) end
  from t;
$$;

revoke all on function public.fn_project_evm(uuid, date) from public, anon;
grant execute on function public.fn_project_evm(uuid, date) to authenticated;


-- ############################################################
-- ### 11. HARD DELETE — schedule_activities branch
-- ############################################################
-- An activity is a planning record with no money of its own, so it is
-- mechanism 1: delete, founder/PM, blocked with a message naming what is in
-- the way. Tasks, expenses and bills point at it with ON DELETE SET NULL, but
-- silently detaching a certified bill from the activity it was measured
-- against is exactly the sort of quiet damage the block exists to prevent.
create or replace function public.fn_delete_activity(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid; v_name text; v_n int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may remove an activity.'
      using errcode = '42501';
  end if;

  select project_id, name into v_project, v_name
  from public.schedule_activities where id = p_id;
  if v_project is null then
    raise exception 'That activity no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  select count(*) into v_n from public.expenses
  where activity_id = p_id and voided_at is null;
  if v_n > 0 then
    raise exception
      '"%" has % live expense(s) booked against it. Move or void them first — detaching them silently would lose what the money was spent on.',
      v_name, v_n;
  end if;

  select count(*) into v_n from public.ra_bills
  where activity_id = p_id and status::text = 'certified';
  if v_n > 0 then
    raise exception
      '"%" has % certified contractor bill(s) against it. Those measured this activity; it stays.',
      v_name, v_n;
  end if;

  -- Tasks are allowed to detach: a task is a day's instruction, and losing its
  -- link to a deleted plan line costs nothing.
  delete from public.schedule_activities where id = p_id;
end $$;

revoke all on function public.fn_delete_activity(uuid) from public, anon;
grant execute on function public.fn_delete_activity(uuid) to authenticated;


-- ############################################################
-- ### 11b. RE-TAGGING COST TO AN ACTIVITY
-- ############################################################
-- An expense booked against the wrong activity is a reporting mistake, not a
-- money mistake: no total on the ledger, the P&L or the dashboard moves when
-- the tag changes. Only earned value moves, and only to become correct.
--
-- Voiding and re-entering would be the wrong remedy — it puts a VOID on the
-- record and a second row in the ledger for what was a filing error, and the
-- audit log would suggest something was wrong with the payment.
--
-- So: a narrow RPC rather than a broader UPDATE policy. `exp_update` already
-- lets a founder (or the row's author) write ANY column including `amount`;
-- routing a re-tag through a function that writes exactly `activity_id` means
-- the screen offering it cannot become a back door to editing a figure.
--
-- The guard that matters is same-project. Tagging a Whitefield expense to an
-- Indiranagar activity would quietly move cost between two projects' EVM while
-- both P&Ls stayed right, which is the sort of discrepancy that takes a day to
-- find.
create or replace function public.fn_retag_expense(
  p_expense_id  uuid,
  p_activity_id uuid
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid; v_act_project uuid; v_voided timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot change an activity tag.'
      using errcode = '42501';
  end if;

  select project_id, voided_at into v_project, v_voided
  from public.expenses where id = p_expense_id;
  if v_project is null then
    raise exception 'That expense no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_voided is not null then
    raise exception
      'That expense is void. It counts for nothing, so its activity tag makes no difference.';
  end if;

  if p_activity_id is not null then
    select project_id into v_act_project
    from public.schedule_activities where id = p_activity_id;
    if v_act_project is null then
      raise exception 'That activity no longer exists.';
    end if;
    if v_act_project <> v_project then
      raise exception 'That activity belongs to a different project.';
    end if;
  end if;

  update public.expenses
     set activity_id = p_activity_id
   where id = p_expense_id;
end $$;

revoke all on function public.fn_retag_expense(uuid, uuid) from public, anon;
grant execute on function public.fn_retag_expense(uuid, uuid) to authenticated;


-- The bill list reads v_ra_bill_totals, never the table, so the new column has
-- to reach the screen through the view. Reproduced whole from 032 with
-- `b.activity_id` appended and NOTHING else changed — `create or replace view`
-- cannot add a column, so it is drop-then-create, and the coalesce(stored,
-- live) pattern below is load-bearing: a certified bill must never restate
-- itself because somebody edited a measurement afterwards.
--
-- Nothing in SQL depends on this view (checked), so the cascade takes nothing
-- with it.
drop view if exists public.v_ra_bill_totals cascade;
create view public.v_ra_bill_totals with (security_invoker = true) as
with line_sum as (
  select l.bill_id, sum(l.amount) as gross_live, count(*)::int as line_count
  from public.ra_bill_lines l
  group by l.bill_id
),
prior as (
  select
    b.id as bill_id,
    coalesce((
      select sum(p.gross_work_value)
      from public.ra_bills p
      where p.project_id = b.project_id
        and p.status::text = 'certified'
        and p.id <> b.id
        and (
          (b.vendor_id is not null and p.vendor_id = b.vendor_id)
          or (b.vendor_id is null
              and lower(btrim(coalesce(p.contractor_name, ''))) =
                  lower(btrim(coalesce(b.contractor_name, ''))))
        )
        and p.certified_at < coalesce(b.certified_at, now())
    ), 0)::numeric(14,2) as previously_certified_live
  from public.ra_bills b
)
select
  b.id,
  b.bill_no,
  b.project_id,
  b.vendor_id,
  v.name as vendor_name,
  b.contractor_name,
  b.contractor_bill_no,
  b.period_from,
  b.period_to,
  b.claimed_amount,
  b.retention_pct,
  b.status,
  b.notes,
  b.certified_at,
  b.certified_by,
  b.rejected_at,
  b.reject_reason,
  b.cancelled_at,
  b.cancel_reason,
  b.created_at,
  b.activity_id,
  coalesce(s.line_count, 0) as line_count,

  -- Stored when certified, live preview otherwise.
  coalesce(b.gross_work_value, s.gross_live, 0)::numeric(14,2) as gross_work_value,
  coalesce(b.less_previously_certified, pr.previously_certified_live, 0)::numeric(14,2)
    as less_previously_certified,
  coalesce(
    b.net_certified + b.retention_amount,
    coalesce(s.gross_live, 0) - coalesce(pr.previously_certified_live, 0)
  )::numeric(14,2) as value_this_bill,
  coalesce(
    b.retention_amount,
    round((coalesce(s.gross_live, 0) - coalesce(pr.previously_certified_live, 0))
          * b.retention_pct / 100, 2)
  )::numeric(14,2) as retention_amount,
  coalesce(
    b.net_certified,
    (coalesce(s.gross_live, 0) - coalesce(pr.previously_certified_live, 0))
      - round((coalesce(s.gross_live, 0) - coalesce(pr.previously_certified_live, 0))
              * b.retention_pct / 100, 2)
  )::numeric(14,2) as net_certified,

  (b.gross_work_value is not null) as is_frozen
from public.ra_bills b
left join line_sum s on s.bill_id = b.id
left join prior    pr on pr.bill_id = b.id
left join public.vendors v on v.id = b.vendor_id;

grant select on public.v_ra_bill_totals to authenticated;

comment on view public.v_ra_bill_totals is
  'Preview figures for bills still in review; for certified bills the stored '
  'snapshot always wins, so a certified bill cannot restate itself when a line '
  'is edited. Carries activity_id since 042.';


-- Same for a contractor bill. Certification freezes the bill's VALUE (032);
-- the activity tag is not a value, and a certified bill measured against the
-- wrong line is exactly the thing that needs correcting.
create or replace function public.fn_retag_ra_bill(
  p_bill_id     uuid,
  p_activity_id uuid
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid; v_act_project uuid; v_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot change an activity tag.'
      using errcode = '42501';
  end if;

  select project_id, status::text into v_project, v_status
  from public.ra_bills where id = p_bill_id;
  if v_project is null then
    raise exception 'That bill no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_status = 'cancelled' then
    raise exception 'That bill is cancelled — its activity tag changes nothing.';
  end if;

  if p_activity_id is not null then
    select project_id into v_act_project
    from public.schedule_activities where id = p_activity_id;
    if v_act_project is null then
      raise exception 'That activity no longer exists.';
    end if;
    if v_act_project <> v_project then
      raise exception 'That activity belongs to a different project.';
    end if;
  end if;

  update public.ra_bills
     set activity_id = p_activity_id
   where id = p_bill_id;
end $$;

revoke all on function public.fn_retag_ra_bill(uuid, uuid) from public, anon;
grant execute on function public.fn_retag_ra_bill(uuid, uuid) to authenticated;


-- ############################################################
-- ### 12. BUILD PARAMETERS ON THE PROJECT
-- ############################################################
-- Floors and plot area are what the programme is generated from, so they live
-- on the project rather than being typed into the generator and forgotten.
-- `start_date` and `target_end_date` already exist (001).
alter table public.projects
  add column if not exists floors int check (floors > 0 and floors <= 12);
alter table public.projects
  add column if not exists plot_area_sqft numeric(12,2) check (plot_area_sqft > 0);

-- 010 revoked SELECT on projects and granted an explicit column list, so a new
-- column is invisible until it is named here. Two statements, never one — the
-- same trap 020 and 027 hit.
grant select (floors, plot_area_sqft) on public.projects to authenticated;


-- ############################################################
-- ### 13. THE TEMPLATE — a MICRO schedule
-- ############################################################
-- A standard Bengaluru luxury residential build broken down to the level a
-- site engineer actually works at: not "slab", but staging, shuttering, beam
-- steel, slab steel, conduits, pre-pour check, pour, cure, deshutter. A G+1
-- comes out at roughly 120 activities and a G+2 at about 140.
--
-- That granularity is the point. A macro programme with "Superstructure —
-- 90 days" cannot be marked 40% complete honestly, cannot say which trade is
-- holding the job up, and cannot carry a meaningful budget. At this level each
-- line is a day or a week of one crew doing one thing, which is what a
-- supervisor can report on truthfully and what earned value needs to mean
-- anything.
--
-- A FUNCTION rather than a table, deliberately: this is the firm's method, not
-- the firm's data. A table would invite someone to edit it mid-project and
-- change what "generate" means between two projects that ought to be
-- comparable. Departing from the method is done by editing the GENERATED
-- schedule, which is ordinary rows the moment it exists.
--
-- `kind` is what each duration scales with:
--   'area'  — groundworks and per-floor structure, driven by the footprint
--   'built' — finishes and services, driven by total built-up area
--   'fixed' — mobilisation, testing and handover, roughly constant
--
-- `par` marks an activity that runs ALONGSIDE the one before it rather than
-- after it: plumbing beside electrical, external plaster beside internal,
-- masonry curing beside the next lift. Those carry float and never sit on the
-- critical path, which is exactly right.
--
-- `phase` is purely for reading — the screen groups by it and collapses. It is
-- NOT a parent row: every activity here is a leaf, so nothing double-counts in
-- earned value.
drop function if exists public.fn_schedule_template(int);

create function public.fn_schedule_template(p_floors int)
returns table (
  seq       int,
  code      text,
  name      text,
  base_days numeric,
  kind      text,
  par       boolean,
  phase     text
)
language sql
immutable
as $$
  with floor_names as (
    select * from (values
      (1, 'Ground floor'), (2, 'First floor'),  (3, 'Second floor'),
      (4, 'Third floor'),  (5, 'Fourth floor'), (6, 'Fifth floor'),
      (7, 'Sixth floor'),  (8, 'Seventh floor'),(9, 'Eighth floor'),
      (10,'Ninth floor'),  (11,'Tenth floor'),  (12,'Eleventh floor')
    ) f(n, label)
  ),
  fixed as (
    select * from (values
      (1010, '1.1'::text, 'Site clearing and levelling'::text, 4::numeric, 'fixed'::text, false, '1 Mobilisation'::text),
      (1020, '1.2', 'Barricading and site gate', 3, 'fixed', true, '1 Mobilisation'),
      (1030, '1.3', 'Site office, store and labour accommodation', 5, 'fixed', true, '1 Mobilisation'),
      (1040, '1.4', 'Temporary water and power connection', 4, 'fixed', true, '1 Mobilisation'),
      (1050, '1.5', 'Setting out and centre line marking', 3, 'fixed', false, '1 Mobilisation'),
      (1060, '1.6', 'Soil report review and foundation confirmation', 2, 'fixed', true, '1 Mobilisation'),
      (2010, '2.1', 'Excavation for footings', 8, 'area', false, '2 Substructure'),
      (2020, '2.2', 'Anti-termite treatment to trenches', 2, 'area', false, '2 Substructure'),
      (2030, '2.3', 'PCC bed to footings', 3, 'area', false, '2 Substructure'),
      (2040, '2.4', 'Footing reinforcement', 5, 'area', false, '2 Substructure'),
      (2050, '2.5', 'Footing shuttering', 3, 'area', false, '2 Substructure'),
      (2060, '2.6', 'Footing concreting', 2, 'area', false, '2 Substructure'),
      (2070, '2.7', 'Footing curing', 5, 'area', false, '2 Substructure'),
      (2080, '2.8', 'Column starter bars and pedestal reinforcement', 4, 'area', false, '2 Substructure'),
      (2090, '2.9', 'Pedestal shuttering and concreting', 3, 'area', false, '2 Substructure'),
      (2100, '2.10', 'Backfilling and compaction', 4, 'area', false, '2 Substructure'),
      (2110, '2.11', 'Plinth beam reinforcement', 4, 'area', false, '2 Substructure'),
      (2120, '2.12', 'Plinth beam shuttering', 3, 'area', false, '2 Substructure'),
      (2130, '2.13', 'Plinth beam concreting', 2, 'area', false, '2 Substructure'),
      (2140, '2.14', 'Plinth filling and compaction', 5, 'area', false, '2 Substructure'),
      (2150, '2.15', 'Anti-termite treatment to plinth', 1, 'area', true, '2 Substructure'),
      (2160, '2.16', 'Ground floor bed concreting', 4, 'area', false, '2 Substructure'),
      (4010, '4.1', 'Parapet wall', 5, 'area', false, '4 Roof and terrace'),
      (4020, '4.2', 'Staircase headroom and mumty', 6, 'area', false, '4 Roof and terrace'),
      (4030, '4.3', 'Overhead tank platform', 4, 'area', true, '4 Roof and terrace'),
      (4040, '4.4', 'Terrace slope screed', 4, 'area', false, '4 Roof and terrace'),
      (4050, '4.5', 'Terrace waterproofing', 6, 'area', false, '4 Roof and terrace'),
      (4060, '4.6', 'Terrace ponding test', 3, 'area', false, '4 Roof and terrace'),
      (4070, '4.7', 'Weathering course and terrace tiling', 5, 'area', false, '4 Roof and terrace'),
      (5010, '5.1', 'Electrical chasing and conduiting', 10, 'built', false, '5 Services rough-in'),
      (5020, '5.2', 'Plumbing internal water lines', 8, 'built', true, '5 Services rough-in'),
      (5030, '5.3', 'Plumbing drainage and soil stacks', 8, 'built', true, '5 Services rough-in'),
      (5040, '5.4', 'Low voltage conduiting (data, CCTV, intercom)', 5, 'built', true, '5 Services rough-in'),
      (5050, '5.5', 'Electrical wiring pulling', 8, 'built', false, '5 Services rough-in'),
      (5060, '5.6', 'Distribution board and earthing', 4, 'built', true, '5 Services rough-in'),
      (5070, '5.7', 'Plumbing pressure and leak testing', 3, 'built', false, '5 Services rough-in'),
      (5080, '5.8', 'HVAC refrigerant piping and drains', 6, 'built', true, '5 Services rough-in'),
      (5090, '5.9', 'HVAC duct and grille framing', 6, 'built', true, '5 Services rough-in'),
      (5100, '5.10', 'Solar and water heater piping', 3, 'built', true, '5 Services rough-in'),
      (6010, '6.1', 'Internal wall plastering', 14, 'built', false, '6 Finishes'),
      (6020, '6.2', 'Ceiling plastering', 8, 'built', false, '6 Finishes'),
      (6030, '6.3', 'External plastering', 12, 'built', true, '6 Finishes'),
      (6040, '6.4', 'Plaster curing and rectification', 5, 'built', false, '6 Finishes'),
      (6050, '6.5', 'Wet-area waterproofing', 5, 'built', false, '6 Finishes'),
      (6060, '6.6', 'Wet-area ponding test', 3, 'built', false, '6 Finishes'),
      (6070, '6.7', 'Bathroom and utility wall tiling', 8, 'built', false, '6 Finishes'),
      (6080, '6.8', 'Floor tiling and stone flooring', 14, 'built', false, '6 Finishes'),
      (6090, '6.9', 'Staircase flooring and railing', 6, 'built', true, '6 Finishes'),
      (6100, '6.10', 'Kitchen counter and dado', 5, 'built', true, '6 Finishes'),
      (6110, '6.11', 'False ceiling framing and boarding', 8, 'built', false, '6 Finishes'),
      (6120, '6.12', 'Putty and primer, internal', 8, 'built', false, '6 Finishes'),
      (6130, '6.13', 'Door shutters and hardware', 8, 'built', false, '6 Finishes'),
      (6140, '6.14', 'Windows and glazing', 6, 'built', true, '6 Finishes'),
      (6150, '6.15', 'Wardrobes and loose carpentry', 12, 'built', false, '6 Finishes'),
      (6160, '6.16', 'Internal painting, final coats', 10, 'built', false, '6 Finishes'),
      (6170, '6.17', 'External painting and texture', 8, 'built', true, '6 Finishes'),
      (6180, '6.18', 'Electrical fixtures and switch plates', 5, 'built', false, '6 Finishes'),
      (6190, '6.19', 'Sanitary fixtures and CP fittings', 5, 'built', true, '6 Finishes'),
      (6200, '6.20', 'HVAC units and grilles', 4, 'built', true, '6 Finishes'),
      (6210, '6.21', 'Kitchen appliances and chimney', 3, 'built', true, '6 Finishes'),
      (7010, '7.1', 'Compound wall foundation and masonry', 8, 'area', false, '7 External works'),
      (7020, '7.2', 'Main gate and wicket gate', 3, 'area', true, '7 External works'),
      (7030, '7.3', 'External drainage and sump', 6, 'area', true, '7 External works'),
      (7040, '7.4', 'Septic tank or STP connection', 5, 'area', true, '7 External works'),
      (7050, '7.5', 'Driveway and paving', 6, 'area', false, '7 External works'),
      (7060, '7.6', 'Landscaping and soft works', 6, 'area', true, '7 External works'),
      (7070, '7.7', 'External lighting', 3, 'area', true, '7 External works'),
      (8010, '8.1', 'Electrical load and circuit testing', 3, 'fixed', false, '8 Testing and handover'),
      (8020, '8.2', 'Plumbing and drainage flow test', 2, 'fixed', true, '8 Testing and handover'),
      (8030, '8.3', 'HVAC commissioning', 3, 'fixed', true, '8 Testing and handover'),
      (8040, '8.4', 'Deep cleaning', 4, 'fixed', false, '8 Testing and handover'),
      (8050, '8.5', 'Snag list preparation', 3, 'fixed', false, '8 Testing and handover'),
      (8060, '8.6', 'Snag rectification', 10, 'fixed', false, '8 Testing and handover'),
      (8070, '8.7', 'Final inspection with client', 2, 'fixed', false, '8 Testing and handover'),
      (8080, '8.8', 'As-built drawings and O and M handover', 3, 'fixed', true, '8 Testing and handover'),
      (8090, '8.9', 'Handover and key transfer', 1, 'fixed', false, '8 Testing and handover')
    ) t(seq, code, name, base_days, kind, par, phase)
  ),
  per_floor as (
    -- Sequence numbers 3100–3999, so the superstructure slots between the
    -- substructure (2xxx) and the roof (4xxx) without renumbering anything.
    -- Each floor is its own phase so it collapses on its own.
    select
      3000 + f.n * 100 + s.i                        as seq,
      '3.' || f.n || '.' || s.i                     as code,
      s.label || ' — ' || fn.label                  as name,
      s.days::numeric                               as base_days,
      'area'::text                                  as kind,
      s.par                                         as par,
      '3 Superstructure — ' || fn.label              as phase
    from generate_series(1, greatest(coalesce(p_floors, 1), 1)) f(n)
    join floor_names fn on fn.n = f.n
    cross join (values
(1, 'Column marking and setting out'::text, 2, false),
      (2, 'Column reinforcement', 5, false),
      (3, 'Column shuttering', 4, false),
      (4, 'Column concreting', 2, false),
      (5, 'Column deshuttering and curing', 3, false),
      (6, 'Slab staging and props', 4, false),
      (7, 'Slab shuttering and decking', 6, false),
      (8, 'Beam reinforcement', 5, false),
      (9, 'Slab main reinforcement', 5, false),
      (10, 'Slab distribution steel and cover blocks', 3, false),
      (11, 'Electrical conduits in slab', 3, true),
      (12, 'Plumbing sleeves and cutouts', 2, true),
      (13, 'Pre-pour checks and level marking', 1, false),
      (14, 'Slab and beam concreting', 2, false),
      (15, 'Slab curing', 10, false),
      (16, 'Slab deshuttering and prop removal', 4, false),
      (17, 'Blockwork, external walls', 10, false),
      (18, 'Blockwork, internal partitions', 8, false),
      (19, 'Door and window frame fixing', 4, true),
      (20, 'Lintels and sunshades', 4, false),
      (21, 'Chasing for conduits and pipes', 4, false),
      (22, 'Masonry curing and rectification', 3, true)
    ) s(i, label, days, par)
  )
  select * from fixed
  union all
  select * from per_floor
  order by 1;
$$;

revoke all on function public.fn_schedule_template(int) from public, anon;
grant execute on function public.fn_schedule_template(int) to authenticated;


-- ############################################################
-- ### 14. GENERATE THE PROGRAMME
-- ############################################################
-- From four inputs — start, finish, floors, plot area — build the whole WBS
-- and its finish-to-start chain.
--
-- ---------- HOW DURATIONS ARE DERIVED ----------
-- Each template duration is multiplied by a size factor and then by ONE scale
-- factor that makes the chain land exactly on the requested end date.
--
-- The size factors are square roots, not ratios: a plot four times larger takes
-- roughly twice as long, not four times, because more of the work happens in
-- parallel across a bigger face. 2400 sqft (a 30x80 site) is the reference.
--
-- ---------- WHAT COMPRESSION MEANS ----------
-- `compression` is target ÷ natural. Below about 0.7 the programme is asking
-- for a build materially faster than the method suggests — the function still
-- generates it, because it is the founder's call and not the database's, but it
-- returns the number so the screen can say so before anyone commits to it.
-- Silently squashing 18 months into 10 and presenting it as a plan would be the
-- most damaging thing this module could do.
--
-- ---------- PARALLEL ACTIVITIES ----------
-- A `par` row starts on the same day as the activity before it and takes the
-- same predecessor. It does not extend the chain, so it carries float and never
-- sits on the critical path — which is exactly right for external plaster
-- running beside internal.
create or replace function public.fn_generate_schedule(
  p_project   uuid,
  p_start     date,
  p_end       date,
  p_floors    int,
  p_plot_area numeric,
  p_replace   boolean default false
)
returns table (
  activities_created int,
  links_created      int,
  natural_days       int,
  target_days        int,
  compression        numeric
)
language plpgsql security definer set search_path = public
as $$
declare
  v_area_f  numeric;
  v_built_f numeric;
  v_natural int;
  v_target  int;
  v_scale   numeric;
  v_cursor  date;
  v_days    int;
  v_start   date;
  v_finish  date;
  v_id      uuid;
  v_spine   uuid;      -- last activity on the chain
  v_pred    uuid;      -- predecessor a parallel row hangs off
  v_group   date;      -- start date a parallel row copies
  v_acts    int := 0;
  v_links   int := 0;
  v_n       int;
  r         record;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may generate a programme.'
      using errcode = '42501';
  end if;
  if not public.is_member(p_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'The finish date must be after the start date.';
  end if;
  if coalesce(p_floors, 0) < 1 or p_floors > 12 then
    raise exception 'Floors must be between 1 and 12.';
  end if;
  if coalesce(p_plot_area, 0) <= 0 then
    raise exception 'Enter the plot area in square feet.';
  end if;

  -- ---------- refuse to overwrite work silently ----------
  select count(*) into v_n
  from public.schedule_activities where project_id = p_project;

  if v_n > 0 and not p_replace then
    raise exception
      'This project already has % activit%. Generating again would duplicate the programme — replace it deliberately if that is what you want.',
      v_n, case when v_n = 1 then 'y' else 'ies' end;
  end if;

  if v_n > 0 and p_replace then
    -- Money tagged to an activity is the one thing a regenerate must never
    -- quietly detach: the expense would survive with a null activity and drop
    -- out of earned value with nothing to show why.
    select count(*) into v_n
    from public.expenses e
    join public.schedule_activities a on a.id = e.activity_id
    where a.project_id = p_project and e.voided_at is null;
    if v_n > 0 then
      raise exception
        '% expense(s) are booked against the current programme. Regenerating would detach them from the work they paid for. Move or void them first.',
        v_n;
    end if;

    select count(*) into v_n
    from public.ra_bills b
    join public.schedule_activities a on a.id = b.activity_id
    where a.project_id = p_project and b.status::text = 'certified';
    if v_n > 0 then
      raise exception
        '% certified contractor bill(s) are measured against the current programme. It stays.', v_n;
    end if;

    delete from public.schedule_activities where project_id = p_project;
  end if;

  -- ---------- size factors ----------
  -- sqrt, not a straight ratio: four times the plot is about twice the time.
  v_area_f  := greatest(0.6, sqrt(p_plot_area / 2400.0));
  v_built_f := greatest(0.8, sqrt((p_plot_area * p_floors * 0.7) / 2400.0));

  -- ---------- natural length: a dry run of the real layout ----------
  -- Summing the non-parallel durations would be close but not equal: a
  -- parallel branch that outlasts the activity it runs beside pushes the
  -- cursor on, and that overshoot is invisible to a plain sum. Walking the
  -- same algorithm at scale 1 measures what actually gets laid out.
  v_cursor := p_start;
  v_group  := null;
  v_natural := 0;

  for r in
    select * from public.fn_schedule_template(p_floors) order by seq
  loop
    v_days := greatest(1, round(
      r.base_days
      * case r.kind when 'built' then v_built_f when 'area' then v_area_f else 1 end
    ))::int;

    if r.par and v_group is not null then
      v_start := v_group;
    else
      v_start := v_cursor;
    end if;
    v_finish := v_start + (v_days - 1);

    if r.par then
      if v_finish + 1 > v_cursor then v_cursor := v_finish + 1; end if;
    else
      v_group  := v_start;
      v_cursor := v_finish + 1;
    end if;

    if (v_finish - p_start) + 1 > v_natural then
      v_natural := (v_finish - p_start) + 1;
    end if;
  end loop;

  v_target := (p_end - p_start) + 1;
  v_scale  := case when v_natural > 0 then v_target::numeric / v_natural else 1 end;

  -- ---------- lay it out for real ----------
  v_cursor := p_start;
  v_group  := null;

  for r in
    select * from public.fn_schedule_template(p_floors) order by seq
  loop
    v_days := greatest(1, round(
      r.base_days
      * case r.kind when 'built' then v_built_f when 'area' then v_area_f else 1 end
      * v_scale
    ))::int;

    if r.par and v_group is not null then
      v_start := v_group;          -- alongside the previous activity
    else
      v_start := v_cursor;
    end if;
    v_finish := v_start + (v_days - 1);

    insert into public.schedule_activities
      (project_id, code, name, planned_start, planned_end, sort_order, phase, created_by)
    values
      (p_project, r.code, r.name, v_start, v_finish, r.seq, r.phase, auth.uid())
    returning id into v_id;

    v_acts := v_acts + 1;

    if r.par then
      -- Same predecessor as the activity it runs beside; the chain does not
      -- pass through it, so it will carry float.
      if v_pred is not null then
        insert into public.activity_dependencies (predecessor_id, successor_id)
        values (v_pred, v_id);
        v_links := v_links + 1;
      end if;
      -- A long parallel branch still holds up whatever follows the group.
      if v_finish + 1 > v_cursor then
        v_cursor := v_finish + 1;
      end if;
    else
      if v_spine is not null then
        insert into public.activity_dependencies (predecessor_id, successor_id)
        values (v_spine, v_id);
        v_links := v_links + 1;
      end if;
      v_pred   := v_spine;
      v_group  := v_start;
      v_spine  := v_id;
      v_cursor := v_finish + 1;
    end if;
  end loop;

  -- ---------- land exactly on the requested date ----------
  -- Rounding every duration to whole days leaves the chain a few days either
  -- side of the target. The handover activity absorbs the difference, because
  -- a programme that says it finishes on the 14th and draws a bar to the 21st
  -- is a programme nobody trusts twice.
  if v_spine is not null then
    update public.schedule_activities
       set planned_end = greatest(planned_start, p_end)
     where id = v_spine;
  end if;

  -- ---------- remember what it was generated from ----------
  update public.projects
     set floors         = p_floors,
         plot_area_sqft = p_plot_area,
         start_date     = coalesce(start_date, p_start),
         target_end_date = coalesce(target_end_date, p_end)
   where id = p_project;

  activities_created := v_acts;
  links_created      := v_links;
  natural_days       := v_natural;
  target_days        := v_target;
  compression        := round(v_scale, 3);
  return next;
end $$;

revoke all on function public.fn_generate_schedule(uuid, date, date, int, numeric, boolean)
  from public, anon;
grant execute on function public.fn_generate_schedule(uuid, date, date, int, numeric, boolean)
  to authenticated;


-- ############################################################
-- ### 15. VERIFY
-- ############################################################
-- Expect both tables.
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('schedule_activities', 'activity_dependencies')
order by table_name;

-- Expect budget_amount to be ABSENT from this list. If it appears, the revoke
-- in §5 did not run and every supervisor can read the programme's money.
select column_name from information_schema.column_privileges
where table_schema = 'public' and table_name = 'schedule_activities'
  and grantee = 'authenticated' and privilege_type = 'SELECT'
order by column_name;

-- Expect activity_id on all three.
select table_name, column_name from information_schema.columns
where table_schema = 'public' and column_name = 'activity_id'
order by table_name;

-- Expect all nine.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_set_activity_progress', 'fn_activity_float',
                  'fn_activity_evm', 'fn_project_evm', 'fn_delete_activity',
                  'fn_schedule_template', 'fn_generate_schedule',
                  'fn_retag_expense', 'fn_retag_ra_bill')
order by proname;

-- The micro template: 76 fixed activities plus 22 per floor.
-- G+1 (2 floors) = 120, G+2 (3 floors) = 142.
select count(*) as template_rows_for_3_floors,
       count(*) filter (where par) as parallel_rows,
       count(distinct phase) as phases
from public.fn_schedule_template(3);

-- Returns nothing useful from the SQL editor: it connects as `postgres`, so
-- auth.uid() is NULL, my_role() is NULL and the §9 gate is false. That is the
-- gate working. Verify through the app with a real login.
select * from public.fn_project_evm(
  (select id from public.projects order by created_at limit 1));
