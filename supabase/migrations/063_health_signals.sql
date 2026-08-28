-- ============================================================
-- 063 — D3 PREDICTIVE INTELLIGENCE (Module 47, trend flags)
--
-- Simple arithmetic over data the app already holds, turned into sentences a
-- founder can act on. No model, no training, no prediction.
--
-- ------------------------------------------------------------
-- WHAT THIS IS ALLOWED TO CLAIM
-- ------------------------------------------------------------
-- Every flag is an EARLY SIGNAL, not a forecast. With four active projects and
-- a few months of history there is no sample from which to forecast anything,
-- and a number presented as a prediction gets quoted as one. So:
--
--   * every flag carries `basis` — 'point_in_time' or 'trend' — and the screen
--     prints which it is;
--   * every trend flag carries `sample_n`, the number of observations behind
--     it, and REFUSES to fire below three. A slope from two points is a line
--     through two points, not a trend;
--   * every flag carries the raw number it was computed from, so the reader can
--     disagree with the threshold rather than with the app.
--
-- ------------------------------------------------------------
-- THE HISTORY PROBLEM, AND WHY THERE IS A SNAPSHOT TABLE
-- ------------------------------------------------------------
-- Three of the five requested signals have real history already:
--   * task rollover — `tasks.rolled_from` plus `planned_date`
--   * defects accumulating — `snags` / `ncrs` created and resolved dates
--   * deadlines — the three registers already have their own alert functions
--
-- Two do not. `schedule_activities.pct_complete` holds ONE current value and
-- nothing else, and EVM is derived from it, so "spend rising faster than
-- progress" and "CPI trending below 1" cannot be computed backwards. There is
-- no historical progress figure anywhere in this database to compute them from.
--
-- Two honest options: report those two as point-in-time only and say so, or
-- start recording. This migration does BOTH — the flags work today as
-- point-in-time divergence, and `project_health_snapshots` captures the numbers
-- nightly so that from tomorrow the same flags can be trended. That is 059's
-- "build the seam" applied: derive it at write time, because deriving it later
-- means it never existed.
--
-- What it does NOT do is backfill a fictional history. Until the snapshots
-- accumulate, those flags say "point in time" and the panel says why.
--
-- ------------------------------------------------------------
-- WHY THE ALERT FUNCTIONS ARE COMPOSED, NOT REWRITTEN
-- ------------------------------------------------------------
-- `fn_compliance_alert` (028), `fn_bg_alert` (033) and `fn_insurance_alert`
-- (034) already compute the deadline counts, each with its own role gate.
-- Signal 5 calls them. Re-deriving the same thresholds here would put the same
-- rule in two places, and the copy that drifts is always the newer one — the
-- 056 lesson about inheriting the gate rather than restating it.
--
-- ------------------------------------------------------------
-- WHO SEES WHAT
-- ------------------------------------------------------------
-- founder / pm — every flag on the projects they can see
-- accounts     — cost and deadline flags only, on every project
-- supervisor   — NOTHING, and ZERO ROWS rather than a row of zeros, because a
--                row of zeros reads as "the job is fine" (the 056 lesson)
--
-- Read gating is INHERITED: the money-bearing sources (`v_project_pnl`,
-- `fn_project_evm`, `budgets`) already carry their own role checks, so the
-- category filter here decides what is asked for, not what is permitted.
--
-- Run AFTER 062.
-- ============================================================


-- ############################################################
-- ###  1. TYPES
-- ############################################################
do $$ begin
  if not exists (select 1 from pg_type where typname = 'signal_category') then
    create type signal_category as enum ('cost', 'schedule', 'quality', 'deadline');
  end if;

  if not exists (select 1 from pg_type where typname = 'signal_level') then
    -- Two levels only. A five-point severity scale on a signal this crude
    -- invites precision nobody has earned.
    create type signal_level as enum ('watch', 'concern');
  end if;
end $$;


-- ############################################################
-- ###  2. THE NIGHTLY SNAPSHOT
-- ############################################################
-- One row per project per day. Small, flat, and deliberately denormalised: the
-- point is to freeze what the numbers WERE, so a later change to how spend or
-- progress is computed does not silently rewrite history.
create table if not exists public.project_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  snap_date date not null default (now() at time zone 'Asia/Kolkata')::date,

  -- ---- money ----
  spend_to_date numeric(14,2),
  budget_total  numeric(14,2),
  pct_spend     numeric(6,2),

  -- ---- progress ----
  -- Weighted by activity budget, not a plain average: a plain average of
  -- percentages treats "site clearance" and "superstructure" as equals and
  -- reports a job as half done when the expensive half has not started.
  progress_pct  numeric(6,2),
  activity_count int,

  -- ---- earned value ----
  cpi numeric(8,3),
  spi numeric(8,3),

  -- ---- delivery ----
  open_tasks     int,
  rolled_14d     int,
  planned_14d    int,

  -- ---- quality ----
  open_snags     int,
  open_ncrs      int,
  opened_30d     int,
  closed_30d     int,

  captured_at timestamptz not null default now(),

  -- Re-running the sweep on the same day must correct the row, not add a
  -- second one — otherwise a manual re-run doubles a day in every trend.
  constraint health_snap_uk unique (project_id, snap_date)
);

create index if not exists health_snap_idx
  on public.project_health_snapshots (project_id, snap_date desc);

alter table public.project_health_snapshots enable row level security;

-- Read follows the money roles: the row carries spend and CPI. Supervisors are
-- excluded here rather than blanked, because every column in it is a figure
-- (the 050 distinction — reach for a row policy when the row IS the secret).
drop policy if exists health_snap_read on public.project_health_snapshots;
create policy health_snap_read on public.project_health_snapshots
  for select to authenticated
  using (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'accounts')
  );

-- No write policy at all. The sweep is SECURITY DEFINER and is the only writer;
-- a snapshot somebody can type into is not a record of anything.


-- ############################################################
-- ###  3. ACKNOWLEDGING A FLAG
-- ############################################################
-- A founder who has already dealt with a signal should not be told about it
-- every morning for a fortnight. This is the one genuinely human act in the
-- module, so it is the one thing here worth auditing: who decided this signal
-- was in hand, when, and until when.
create table if not exists public.health_flag_acks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- The flag's stable code, e.g. 'burn_vs_progress'. Text rather than an enum:
  -- new signals will be added and an enum means a migration each time.
  flag_code text not null,

  -- Snoozed until this date, then it comes back. Never "dismissed forever" —
  -- a signal that can be silenced permanently is one that will be, and the
  -- condition it describes does not go away because somebody clicked.
  snooze_until date not null,
  note text,

  acked_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),

  constraint health_ack_uk unique (project_id, flag_code)
);

alter table public.health_flag_acks enable row level security;

drop policy if exists health_ack_read on public.health_flag_acks;
create policy health_ack_read on public.health_flag_acks
  for select to authenticated
  using (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'accounts')
  );

drop policy if exists health_ack_write on public.health_flag_acks;
create policy health_ack_write on public.health_flag_acks
  for all to authenticated
  using (
    public.is_member(project_id) and public.my_role() in ('founder', 'pm')
  )
  with check (
    public.is_member(project_id) and public.my_role() in ('founder', 'pm')
  );

-- Keyed by `id`, so the ordinary fn_audit applies rather than 051's code-keyed
-- variant.
drop trigger if exists audit_health_acks on public.health_flag_acks;
create trigger audit_health_acks
  after insert or update or delete on public.health_flag_acks
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  4. THE SWEEP
-- ############################################################
-- SECURITY DEFINER and unscoped by role: it runs as pg_cron with no auth.uid(),
-- so it must not depend on any is_member()/my_role() gate. It reads BASE TABLES
-- for exactly that reason — the owner-run views would return nothing here
-- (the 038 lesson about auth.uid() being null outside a request).
create or replace function public.fn_capture_health_snapshot()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_n int := 0;
begin
  insert into public.project_health_snapshots as s
    (project_id, snap_date, spend_to_date, budget_total, pct_spend,
     progress_pct, activity_count, cpi, spi,
     open_tasks, rolled_14d, planned_14d,
     open_snags, open_ncrs, opened_30d, closed_30d)
  select
    p.id,
    v_today,
    sp.spend,
    bu.budget,
    case when coalesce(bu.budget, 0) > 0
      then round(coalesce(sp.spend, 0) * 100.0 / bu.budget, 2) end,
    pr.progress,
    pr.n_act,
    ev.cpi,
    ev.spi,
    tk.open_tasks,
    tk.rolled_14d,
    tk.planned_14d,
    q.open_snags,
    q.open_ncrs,
    q.opened_30d,
    q.closed_30d
  from public.projects p

  -- Spend: live expenses plus certified contractor bills, the same definition
  -- v_project_pnl uses. Reading the tables directly, not the view, because the
  -- view is role-gated and this runs with no caller.
  left join lateral (
    select (coalesce((select sum(e.amount + e.gst_amount) from public.expenses e
                      where e.project_id = p.id and e.voided_at is null), 0)
          + coalesce((select sum(b.net_certified + b.retention_amount)
                      from public.ra_bills b
                      where b.project_id = p.id
                        and b.status::text = 'certified'), 0))::numeric(14,2) as spend
  ) sp on true

  left join lateral (
    select coalesce(sum(b.amount), 0)::numeric(14,2) as budget
    from public.budgets b where b.project_id = p.id
  ) bu on true

  -- Progress WEIGHTED BY ACTIVITY BUDGET. A plain average of percentages
  -- treats site clearance and superstructure as equals.
  left join lateral (
    select
      case when sum(a.budget_amount) > 0
        then round(sum(a.pct_complete * a.budget_amount)
                   / sum(a.budget_amount), 2)
        when count(*) > 0 then round(avg(a.pct_complete), 2)
      end as progress,
      count(*)::int as n_act
    from public.schedule_activities a where a.project_id = p.id
  ) pr on true

  -- EVM at today. fn_project_evm is security_invoker and would return nothing
  -- for pg_cron, so the indices are recomputed here from the same inputs.
  left join lateral (
    select
      case when ac > 0 then round(ev / ac, 3) end as cpi,
      case when pv > 0 then round(ev / pv, 3) end as spi
    from (
      select
        coalesce(sum(a.budget_amount * a.pct_complete / 100.0), 0)::numeric as ev,
        coalesce(sum(a.budget_amount * (
          case
            when v_today >= a.planned_end then 1.0
            when v_today <  a.planned_start then 0.0
            else (v_today - a.planned_start + 1)::numeric
                 / nullif((a.planned_end - a.planned_start + 1), 0)
          end)), 0)::numeric as pv,
        (coalesce((select sum(e.amount + e.gst_amount) from public.expenses e
                   where e.project_id = p.id and e.voided_at is null
                     and e.activity_id is not null), 0)
        + coalesce((select sum(b.net_certified + b.retention_amount)
                    from public.ra_bills b
                    where b.project_id = p.id and b.status::text = 'certified'
                      and b.activity_id is not null), 0))::numeric as ac
      from public.schedule_activities a where a.project_id = p.id
    ) x
  ) ev on true

  left join lateral (
    select
      count(*) filter (where t.status::text = 'pending')::int as open_tasks,
      count(*) filter (where t.rolled_from is not null
                         and t.planned_date >= v_today - 14)::int as rolled_14d,
      count(*) filter (where t.planned_date >= v_today - 14
                         and t.planned_date <= v_today)::int as planned_14d
    from public.tasks t where t.project_id = p.id
  ) tk on true

  left join lateral (
    select
      (select count(*) from public.snags g
        where g.project_id = p.id and g.status::text in ('open', 'in_progress'))::int,
      (select count(*) from public.ncrs nc
        where nc.project_id = p.id and nc.status::text = 'open')::int,
      ((select count(*) from public.snags g
         where g.project_id = p.id and g.created_at::date >= v_today - 30)
       + (select count(*) from public.ncrs nc
          where nc.project_id = p.id and nc.created_at::date >= v_today - 30))::int,
      ((select count(*) from public.snags g
         where g.project_id = p.id and g.resolved_at::date >= v_today - 30)
       + (select count(*) from public.ncrs nc
          where nc.project_id = p.id and nc.closed_at::date >= v_today - 30))::int
  ) q(open_snags, open_ncrs, opened_30d, closed_30d) on true

  where p.status::text = 'active'

  on conflict (project_id, snap_date) do update set
    spend_to_date = excluded.spend_to_date,
    budget_total  = excluded.budget_total,
    pct_spend     = excluded.pct_spend,
    progress_pct  = excluded.progress_pct,
    activity_count = excluded.activity_count,
    cpi = excluded.cpi,
    spi = excluded.spi,
    open_tasks  = excluded.open_tasks,
    rolled_14d  = excluded.rolled_14d,
    planned_14d = excluded.planned_14d,
    open_snags  = excluded.open_snags,
    open_ncrs   = excluded.open_ncrs,
    opened_30d  = excluded.opened_30d,
    closed_30d  = excluded.closed_30d,
    captured_at = now();

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_capture_health_snapshot() from public, anon;
-- Founder only from the app, for a manual "capture now". pg_cron runs it as
-- the owner and needs no grant.
grant execute on function public.fn_capture_health_snapshot() to authenticated;


-- ############################################################
-- ###  5. THE FLAGS
-- ############################################################
-- One function, one ranked list of sentences.
--
-- security invoker, so the caller's own visibility decides which projects are
-- considered. The role check inside decides which CATEGORIES are asked for —
-- accounts gets cost and deadline, founder/pm get everything, a supervisor
-- matches nothing and receives ZERO ROWS.
drop function if exists public.fn_project_health_flags(uuid);
create function public.fn_project_health_flags(p_project uuid default null)
returns table (
  project_id   uuid,
  project_name text,
  code         text,
  category     signal_category,
  level        signal_level,
  headline     text,
  detail       text,
  metric_value numeric,
  metric_label text,
  -- 'point_in_time' or 'trend'. Printed on screen: a divergence measured once
  -- and a slope over six weeks are different claims.
  basis        text,
  -- Observations behind a trend. 1 for a point-in-time reading.
  sample_n     int,
  snoozed_until date
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_role text := public.my_role();
  v_cats text[];
begin
  -- A supervisor gets nothing at all. Not zeros — nothing. A row of zeros on a
  -- health panel reads as "the job is fine", which is a different and far more
  -- dangerous claim than "you cannot see this".
  if v_role is null or v_role = 'supervisor' then
    return;
  end if;

  v_cats := case
    when v_role = 'accounts' then array['cost', 'deadline']
    else array['cost', 'schedule', 'quality', 'deadline']
  end;

  return query
  with proj as (
    select p.id, p.name
    from public.projects p
    where p.status::text = 'active'
      and public.is_member(p.id)
      and (p_project is null or p.id = p_project)
  ),
  latest as (
    select distinct on (s.project_id) s.*
    from public.project_health_snapshots s
    join proj on proj.id = s.project_id
    order by s.project_id, s.snap_date desc
  ),
  -- Three or more snapshots in the window, or no trend is claimed.
  hist as (
    select s.project_id,
           count(*)::int as n,
           min(s.cpi) filter (where s.snap_date = (
             select min(s2.snap_date) from public.project_health_snapshots s2
             where s2.project_id = s.project_id
               and s2.snap_date >= current_date - 42)) as cpi_first,
           max(s.cpi) filter (where s.snap_date = (
             select max(s2.snap_date) from public.project_health_snapshots s2
             where s2.project_id = s.project_id)) as cpi_last
    from public.project_health_snapshots s
    join proj on proj.id = s.project_id
    where s.snap_date >= current_date - 42
      and s.cpi is not null
    group by s.project_id
  ),
  acks as (
    select a.project_id, a.flag_code, a.snooze_until
    from public.health_flag_acks a
    where a.snooze_until >= current_date
  ),

  -- ---------- 1. BURN RATE vs PROGRESS ----------
  -- Money out has outrun work done. Point-in-time until the snapshots build up
  -- — there is no historical progress figure in this database to trend against.
  f_burn as (
    select l.project_id, pr.name,
           'burn_vs_progress'::text,
           'cost'::signal_category,
           case when l.pct_spend - l.progress_pct >= 20
                then 'concern' else 'watch' end::signal_level,
           format('Spending is ahead of progress on %s', pr.name),
           format('%s%% of the budget is committed against %s%% of the work done, weighted by activity budget. A gap of %s points. Worth asking whether the budget was low or the progress figures are stale.',
                  round(l.pct_spend), round(l.progress_pct),
                  round(l.pct_spend - l.progress_pct)),
           round(l.pct_spend - l.progress_pct, 1),
           'points ahead'::text,
           'point_in_time'::text,
           1,
           null::date
    from latest l join proj pr on pr.id = l.project_id
    where l.pct_spend is not null
      and l.progress_pct is not null
      and l.budget_total > 0
      -- Below this there is not enough of either number for the gap to mean
      -- anything: 8% spent against 2% done is a mobilisation, not a warning.
      and l.progress_pct >= 5
      and l.pct_spend - l.progress_pct >= 10
  ),

  -- ---------- 2. CPI / SPI ----------
  f_cpi as (
    select l.project_id, pr.name,
           'cpi_below_one'::text,
           'cost'::signal_category,
           case when l.cpi < 0.90 then 'concern' else 'watch' end::signal_level,
           format('Cost performance below plan on %s', pr.name),
           format('CPI is %s — every rupee spent is returning %s of planned value on the tagged activities.%s',
                  l.cpi, l.cpi,
                  case when h.n >= 3 and h.cpi_last < h.cpi_first
                       then format(' It has fallen from %s over the last %s readings.', h.cpi_first, h.n)
                       else '' end),
           l.cpi,
           'CPI'::text,
           case when h.n >= 3 then 'trend' else 'point_in_time' end,
           coalesce(h.n, 1),
           null::date
    from latest l
    join proj pr on pr.id = l.project_id
    left join hist h on h.project_id = l.project_id
    where l.cpi is not null and l.cpi < 1.0
  ),
  f_spi as (
    select l.project_id, pr.name,
           'spi_below_one'::text,
           'schedule'::signal_category,
           case when l.spi < 0.90 then 'concern' else 'watch' end::signal_level,
           format('Running behind programme on %s', pr.name),
           format('SPI is %s — the work earned to date is worth %s of what the programme said would be done by now.',
                  l.spi, l.spi),
           l.spi,
           'SPI'::text,
           'point_in_time'::text,
           1,
           null::date
    from latest l join proj pr on pr.id = l.project_id
    where l.spi is not null and l.spi < 1.0
  ),

  -- ---------- 3. TASK ROLLOVER ----------
  -- Computed from `tasks` directly, not the snapshot: rollover has genuine
  -- history in planned_date, so it can be trended from day one.
  f_roll as (
    select pr.id, pr.name,
           'rollover_rising'::text,
           'schedule'::signal_category,
           case when r.recent_pct >= 40 then 'concern' else 'watch' end::signal_level,
           format('Tasks are slipping more often on %s', pr.name),
           format('%s%% of tasks planned in the last 14 days were rolled over from an earlier day, against %s%% in the 14 days before that. %s of %s tasks.',
                  round(r.recent_pct), round(r.prior_pct), r.rolled_recent, r.planned_recent),
           round(r.recent_pct, 1),
           'percent rolled'::text,
           'trend'::text,
           r.planned_recent,
           null::date
    from proj pr
    join lateral (
      select
        count(*) filter (where t.planned_date > current_date - 14)::int as planned_recent,
        count(*) filter (where t.planned_date > current_date - 14
                           and t.rolled_from is not null)::int as rolled_recent,
        case when count(*) filter (where t.planned_date > current_date - 14) > 0
          then count(*) filter (where t.planned_date > current_date - 14
                                  and t.rolled_from is not null) * 100.0
               / count(*) filter (where t.planned_date > current_date - 14)
        end as recent_pct,
        case when count(*) filter (where t.planned_date between current_date - 28 and current_date - 15) > 0
          then count(*) filter (where t.planned_date between current_date - 28 and current_date - 15
                                  and t.rolled_from is not null) * 100.0
               / count(*) filter (where t.planned_date between current_date - 28 and current_date - 15)
        end as prior_pct
      from public.tasks t where t.project_id = pr.id
    ) r on true
    -- At least ten tasks in the window, or the percentage is noise: one
    -- rollover out of two tasks is 50% and means nothing.
    where r.planned_recent >= 10
      and r.recent_pct is not null
      and r.prior_pct is not null
      and r.recent_pct > r.prior_pct + 10
      and r.recent_pct >= 20
  ),

  -- ---------- 4. DEFECTS ACCUMULATING ----------
  f_defects as (
    select l.project_id, pr.name,
           'defects_accumulating'::text,
           'quality'::signal_category,
           case when l.opened_30d >= l.closed_30d * 2 then 'concern' else 'watch' end::signal_level,
           format('Defects are being raised faster than they are closed on %s', pr.name),
           format('%s snags and NCRs opened in the last 30 days against %s closed. %s still open.',
                  l.opened_30d, l.closed_30d, l.open_snags + l.open_ncrs),
           (l.opened_30d - l.closed_30d)::numeric,
           'net new in 30 days'::text,
           'trend'::text,
           l.opened_30d,
           null::date
    from latest l join proj pr on pr.id = l.project_id
    -- Five is the floor: three opened and one closed is a normal fortnight.
    where l.opened_30d >= 5
      and l.opened_30d > l.closed_30d
  ),

  -- ---------- 5. DEADLINES ----------
  -- Composed from the three existing alert functions rather than re-derived.
  -- Each is already role-gated, so a caller who cannot see bank guarantees gets
  -- zeroes from fn_bg_alert and no flag appears — no rule restated here.
  f_budget as (
    select l.project_id, pr.name,
           'budget_exhausted'::text,
           'cost'::signal_category,
           case when l.pct_spend >= 100 then 'concern' else 'watch' end::signal_level,
           format('Budget nearly used on %s', pr.name),
           format('%s%% of the budget is committed. Progress stands at %s%%.',
                  round(l.pct_spend), round(coalesce(l.progress_pct, 0))),
           round(l.pct_spend, 1),
           'percent of budget'::text,
           'point_in_time'::text,
           1,
           null::date
    from latest l join proj pr on pr.id = l.project_id
    where l.pct_spend is not null and l.pct_spend >= 85
  )

  select * from (
    select * from f_burn
    union all select * from f_cpi
    union all select * from f_spi
    union all select * from f_roll
    union all select * from f_defects
    union all select * from f_budget
  ) all_flags(project_id, project_name, code, category, level, headline, detail,
              metric_value, metric_label, basis, sample_n, snoozed_until)
  where all_flags.category::text = any(v_cats)
    and not exists (
      select 1 from acks
      where acks.project_id = all_flags.project_id
        and acks.flag_code = all_flags.code
    )
  order by all_flags.level desc, all_flags.project_name, all_flags.code;
end $$;

revoke all on function public.fn_project_health_flags(uuid) from public, anon;
grant execute on function public.fn_project_health_flags(uuid) to authenticated;


-- ############################################################
-- ###  6. COMPANY DEADLINE SIGNALS
-- ############################################################
-- The three registers are not project-scoped in the same way, so they get their
-- own call rather than being forced into the per-project list. Each underlying
-- function carries its own role gate; this only assembles the sentences.
drop function if exists public.fn_deadline_signals();
create function public.fn_deadline_signals()
returns table (
  code     text,
  level    signal_level,
  headline text,
  detail   text,
  metric_value numeric,
  metric_label text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_role text := public.my_role();
  c record; g record; i record;
begin
  if v_role is null or v_role = 'supervisor' then
    return;
  end if;

  select * into c from public.fn_compliance_alert();
  select * into g from public.fn_bg_alert();
  select * into i from public.fn_insurance_alert();

  if coalesce(c.overdue_count, 0) > 0 then
    return query select 'compliance_overdue'::text, 'concern'::signal_level,
      'Statutory filings are overdue',
      format('%s filing(s) past their due date. Next up: %s on %s.',
             c.overdue_count, coalesce(c.next_title, '—'), coalesce(c.next_due_date::text, '—')),
      c.overdue_count::numeric, 'overdue'::text;
  elsif coalesce(c.due_week_count, 0) > 0 then
    return query select 'compliance_due'::text, 'watch'::signal_level,
      'Statutory filings due this week',
      format('%s filing(s) due within seven days. Next: %s on %s.',
             c.due_week_count, coalesce(c.next_title, '—'), coalesce(c.next_due_date::text, '—')),
      c.due_week_count::numeric, 'due in 7 days'::text;
  end if;

  if coalesce(g.expired_count, 0) > 0 then
    return query select 'bg_expired'::text, 'concern'::signal_level,
      'A bank guarantee has expired',
      format('%s guarantee(s) past expiry. Earliest: %s on %s.',
             g.expired_count, coalesce(g.next_bg_number, '—'), coalesce(g.next_expiry::text, '—')),
      g.expired_count::numeric, 'expired'::text;
  elsif coalesce(g.expiring_count, 0) > 0 then
    return query select 'bg_expiring'::text, 'watch'::signal_level,
      'Bank guarantees expiring within 30 days',
      format('%s guarantee(s). Earliest: %s on %s.',
             g.expiring_count, coalesce(g.next_bg_number, '—'), coalesce(g.next_expiry::text, '—')),
      g.expiring_count::numeric, 'expiring'::text;
  end if;

  if coalesce(i.expired_count, 0) > 0 then
    return query select 'insurance_expired'::text, 'concern'::signal_level,
      'An insurance policy has lapsed',
      format('%s policy(ies) past expiry. Earliest: %s on %s.',
             i.expired_count, coalesce(i.next_policy, '—'), coalesce(i.next_expiry::text, '—')),
      i.expired_count::numeric, 'lapsed'::text;
  elsif coalesce(i.expiring_count, 0) > 0 then
    return query select 'insurance_expiring'::text, 'watch'::signal_level,
      'Insurance expiring within 30 days',
      format('%s policy(ies). Earliest: %s on %s.',
             i.expiring_count, coalesce(i.next_policy, '—'), coalesce(i.next_expiry::text, '—')),
      i.expiring_count::numeric, 'expiring'::text;
  end if;
end $$;

revoke all on function public.fn_deadline_signals() from public, anon;
grant execute on function public.fn_deadline_signals() to authenticated;


-- ############################################################
-- ###  7. THE SERIES BEHIND A FLAG
-- ############################################################
-- So a reader can see the shape rather than take the sentence on trust.
drop function if exists public.fn_health_trend(uuid, int);
create function public.fn_health_trend(p_project uuid, p_days int default 60)
returns table (
  snap_date    date,
  pct_spend    numeric,
  progress_pct numeric,
  cpi          numeric,
  spi          numeric,
  open_snags   int,
  open_ncrs    int
)
language sql
stable
security invoker
set search_path = public
as $$
  select s.snap_date, s.pct_spend, s.progress_pct, s.cpi, s.spi,
         s.open_snags, s.open_ncrs
  from public.project_health_snapshots s
  where s.project_id = p_project
    and s.snap_date >= current_date - greatest(least(coalesce(p_days, 60), 365), 7)
  order by s.snap_date;
$$;

revoke all on function public.fn_health_trend(uuid, int) from public, anon;
grant execute on function public.fn_health_trend(uuid, int) to authenticated;


-- ############################################################
-- ###  8. SNOOZING A FLAG
-- ############################################################
-- Bounded on purpose: a signal that can be silenced forever will be, and the
-- condition it describes does not go away because somebody clicked.
drop function if exists public.fn_ack_health_flag(uuid, text, int, text);
create function public.fn_ack_health_flag(
  p_project uuid,
  p_code    text,
  p_days    int default 14,
  p_note    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM can set a signal aside.'
      using errcode = '42501';
  end if;
  if not public.is_member(p_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if coalesce(p_days, 0) < 1 or p_days > 90 then
    raise exception
      'Set a signal aside for between 1 and 90 days. There is no permanent dismissal — the condition does not go away because it was acknowledged.';
  end if;

  insert into public.health_flag_acks
    (project_id, flag_code, snooze_until, note, acked_by)
  values (p_project, p_code, current_date + p_days, nullif(btrim(p_note), ''),
          auth.uid())
  on conflict (project_id, flag_code) do update
    set snooze_until = excluded.snooze_until,
        note         = excluded.note,
        acked_by     = excluded.acked_by,
        created_at   = now();
end $$;

revoke all on function public.fn_ack_health_flag(uuid, text, int, text) from public, anon;
grant execute on function public.fn_ack_health_flag(uuid, text, int, text) to authenticated;

drop function if exists public.fn_unack_health_flag(uuid, text);
create function public.fn_unack_health_flag(p_project uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM can bring a signal back.'
      using errcode = '42501';
  end if;
  if not public.is_member(p_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  delete from public.health_flag_acks
  where project_id = p_project and flag_code = p_code;
end $$;

revoke all on function public.fn_unack_health_flag(uuid, text) from public, anon;
grant execute on function public.fn_unack_health_flag(uuid, text) to authenticated;


-- ############################################################
-- ###  9. THE NIGHTLY JOB
-- ############################################################
-- pg_cron is enabled on this project (confirmed at 028). 22:50 IST, after the
-- three existing sweeps at 22:30 / 22:40, so a day's snapshot reflects any
-- status changes those made.
--
-- The sweep is BOOKKEEPING, not truth: every flag reads the latest snapshot but
-- the deadline signals derive from live dates, and nothing on the panel breaks
-- if the job has not run — the flags simply say the snapshot is stale. Same
-- split as 028.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('mason-health-snapshot')
    where exists (select 1 from cron.job where jobname = 'mason-health-snapshot');

    perform cron.schedule(
      'mason-health-snapshot',
      '20 17 * * *',                       -- 22:50 IST = 17:20 UTC
      $job$ select public.fn_capture_health_snapshot(); $job$
    );
  else
    raise notice 'pg_cron not installed — schedule fn_capture_health_snapshot() yourself.';
  end if;
end $$;


-- ############################################################
-- ### 10. VERIFY
-- ############################################################
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_capture_health_snapshot', 'fn_project_health_flags',
                    'fn_deadline_signals', 'fn_health_trend',
                    'fn_ack_health_flag', 'fn_unack_health_flag')
group by p.proname order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('project_health_snapshots', 'health_flag_acks')
order by table_name;
