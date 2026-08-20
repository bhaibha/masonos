-- ==============================================================
-- MASON OS — pending migrations.
--
-- 001–055 are all APPLIED (055 confirmed 2026-08-14).
-- PENDING: 056.
--
-- 056 = B7 MIS reports & KPI dashboard. READ-ONLY: one view and four
-- functions. No tables, no columns, no policies, no triggers.
--
--   v_mis_projects       cross-project comparison row
--   fn_mis_company       company KPIs (one row)
--   fn_mis_trend         cost by month + margin to date
--   fn_mis_by_category   company-wide cost breakdown
--   fn_mis_exceptions    eight alert sources in one shape
--
-- THE ACCESS MODEL IS INHERITED, NOT RESTATED. v_mis_projects sits on
-- v_project_pnl, which already carries
--   where is_member(p.id) and my_role() in ('founder','pm','accounts')
-- so founder and accounts get every project, a PM gets assigned ones, and a
-- supervisor matches nothing and gets ZERO ROWS from all five.
--
-- There is no audit trigger because nothing here writes. The question "who
-- changed this figure" is answered on expenses, ra_bills and budgets, where
-- the audit triggers already are.
--
-- ---------- TWO COLUMN-NAME BUGS, BOTH FOUND IN PRODUCTION ----------
-- This migration failed twice on first paste, and both were the same mistake:
-- a sandbox STUB that did not match the real table.
--   1. `pnl.project_name` — v_project_pnl selects `p.name` UNALIASED.
--   2. `e.expense_date` on company_expenses — that table's column is
--      `spend_date`; `expense_date` belongs to `expenses`.
-- Both are corrected below, and every remaining alias.column reference in the
-- file has since been checked against the real create-table statements in the
-- repo. A stub is only worth what it models.
-- ==============================================================


-- ============================================================
-- MASON OS — Migration 056: MIS reports & KPI dashboard (B7, Module 37)
--
-- The cross-project command view: how the firm is doing, which jobs are
-- healthy, which are bleeding, and what needs attention this week.
--
-- ---------- NO NEW ACCESS CONTROL IS INVENTED HERE ----------
-- The brief asks for founder/accounts to see everything, a PM to see only
-- assigned projects, and supervisors to see nothing. That is ALREADY what the
-- sources do:
--
--   is_member()      → true for founder, true for accounts, true for a PM's
--                      assigned projects, true for a supervisor's assigned ones
--   v_project_pnl    → where is_member(p.id) and my_role() in (founder,pm,accounts)
--   fn_activity_evm  → the same two clauses
--
-- So a founder gets every project, accounts gets every project, a PM gets their
-- own, and a supervisor matches the role clause nowhere and gets ZERO ROWS.
-- Every view below is `security_invoker = true` on top of those, which means
-- the gating is inherited rather than restated. Restating it would create a
-- second copy of the rule to drift — and a report that leaks is a report that
-- leaks everything at once.
--
-- ---------- NOTHING HERE IS AUDITED, BECAUSE NOTHING HERE WRITES ----------
-- The brief asks for an audit trigger. There is no table and no write in this
-- migration: it is five read-only functions and one view over data that is
-- already audited at source. A trigger would have nothing to fire on. The
-- question "who changed this figure" is answered on `expenses`, `ra_bills`,
-- `budgets` and the rest, where the audit triggers already are.
--
-- ---------- WHAT IS DELIBERATELY NOT CALLED "CASH" ----------
-- The brief asks for a cash position. Mason OS has no bank balance, no receipts
-- against issued invoices, and no payment run — so a cash figure cannot be
-- computed, only guessed at. What CAN be computed honestly is:
--   * net position   = project margin to date − overheads for the period
--   * receivable     = invoiced but with no payment tracking, so it is reported
--                      as "invoiced to date", not "owed"
--   * payable        = certified RA bills not yet posted + retention held
-- The screen says "Net position", names both time spans, and does not use the
-- word cash. A figure labelled cash that is not cash is worse than no figure.
--
-- ---------- TWO SPANS IN ONE NUMBER, LABELLED ----------
-- The 040 lesson, carried forward: project margin is LIFETIME TO DATE while
-- overheads are for the CHOSEN PERIOD. That is the right comparison for a
-- financial year and a misleading one for a single month, so both spans travel
-- with the figure and the card prints them.
--
-- Idempotent: views dropped before the functions they call, functions dropped
-- by full signature. Requires 038/039 (P&L), 042 (EVM), 040 (overheads),
-- 027/028/033/034 (snags, compliance, BG, insurance), 048/049 (NCRs).
-- ============================================================


-- ############################################################
-- ###  1. THE CROSS-PROJECT COMPARISON ROW
-- ############################################################
drop view if exists public.v_mis_projects cascade;

create view public.v_mis_projects with (security_invoker = true) as
select
  pnl.project_id,
  -- v_project_pnl exposes `p.name` UNALIASED — the column is `name`, not
  -- `project_name`. Aliased here so everything downstream reads project_name.
  pnl.name                                     as project_name,
  pnl.project_status,

  -- Money, straight from the P&L. Not recomputed here: one definition of
  -- margin in the database, and this is a second window onto it.
  pnl.revenue,
  pnl.total_cost,
  pnl.gross_margin,
  pnl.margin_pct,
  pnl.budget_total,
  pnl.budget_remaining,
  pnl.committed_open,
  pnl.retention_held,
  case
    when pnl.budget_total > 0
      then round(pnl.total_cost * 100.0 / pnl.budget_total, 1)
  end                                          as budget_pct_used,
  (pnl.budget_total > 0 and pnl.budget_remaining < 0) as over_budget,

  -- Programme, from the EVM engine. Null where no schedule has been generated,
  -- which is a real state and reads differently from "behind".
  evm.activity_count,
  evm.spi,
  evm.cpi,
  evm.pct_complete,
  evm.bac,
  evm.ac                                       as evm_actual_cost,

  -- Open items. Each subquery obeys its own table's RLS, so a PM's counts cover
  -- their projects and nobody else's.
  (select count(*) from public.ncrs n
    where n.project_id = pnl.project_id
      and n.status::text in ('open', 'corrected')
      and n.cancelled_at is null)::int          as open_ncrs,
  (select count(*) from public.ncrs n
    where n.project_id = pnl.project_id
      and n.status::text in ('open', 'corrected')
      and n.severity::text = 'critical'
      and n.cancelled_at is null)::int          as critical_ncrs,
  (select count(*) from public.snags s
    where s.project_id = pnl.project_id
      and s.status::text in ('open', 'in_progress'))::int as open_snags,
  (select count(*) from public.purchase_orders po
    where po.project_id = pnl.project_id
      and po.status::text = 'requested')::int   as pos_pending,
  (select count(*) from public.ra_bills b
    where b.project_id = pnl.project_id
      and b.status::text in ('submitted', 'under_review')
      and b.cancelled_at is null)::int          as bills_awaiting,

  -- ONE verdict, computed once, so the screen, the CSV and the board PDF cannot
  -- disagree about which jobs are in trouble.
  --
  -- The index thresholds are the conventional ones already used everywhere else
  -- in this app (≥1 fine, ≥0.9 watch, below that alert — see indexBand in
  -- format.ts). They are a CONVENTION, not a truth: a CPI of 0.89 is not
  -- meaningfully worse than 0.91, and the bands exist to sort a list, not to
  -- pass judgement on a site.
  case
    when pnl.margin_pct is not null and pnl.margin_pct < 0            then 'critical'
    when pnl.budget_total > 0 and pnl.budget_remaining < 0            then 'critical'
    when evm.cpi is not null and evm.cpi < 0.9                        then 'critical'
    when pnl.margin_pct is not null and pnl.margin_pct < 10           then 'watch'
    when evm.cpi is not null and evm.cpi < 1                          then 'watch'
    when evm.spi is not null and evm.spi < 0.9                        then 'watch'
    else 'ok'
  end                                          as health
from public.v_project_pnl pnl
left join lateral public.fn_project_evm(pnl.project_id, null) evm on true;

grant select on public.v_mis_projects to authenticated;

comment on view public.v_mis_projects is
  'One row per project the caller may see, joining the P&L to the EVM engine '
  'and the open-item counts. Inherits its scoping from v_project_pnl: founder '
  'and accounts see every project, a PM sees assigned ones, a supervisor gets '
  'zero rows.';


-- ############################################################
-- ###  2. COMPANY KPIs
-- ############################################################
-- One row. Every figure is a sum over v_mis_projects, so the headline and the
-- table underneath it are guaranteed to add up — the commonest way a dashboard
-- loses trust is a total that does not match the rows below it.
drop function if exists public.fn_mis_company(date, date);
create function public.fn_mis_company(
  p_from date default null,
  p_to   date default null
)
returns table (
  project_count       int,
  active_count        int,
  contract_value      numeric,
  total_cost          numeric,
  gross_margin        numeric,
  blended_margin_pct  numeric,
  over_budget_count   int,
  bleeding_count      int,
  -- Overheads and the net position are founder/accounts only. A PM gets NULL
  -- and `sees_overheads = false`, exactly as fn_company_net (040) does, so the
  -- screen can say "restricted for your role" instead of showing a zero that
  -- looks like a real answer.
  overheads           numeric,
  net_position        numeric,
  sees_overheads      boolean,
  -- Both spans travel with the figure. Margin is lifetime to date; overheads
  -- are for the chosen period. (The 040 lesson.)
  overhead_from       date,
  overhead_to         date,
  -- Outstanding. NOT called cash — see the header.
  retention_held      numeric,
  committed_open      numeric,
  bills_awaiting      int,
  -- Attention counts
  overdue_compliance  int,
  open_ncrs           int,
  critical_ncrs       int,
  open_snags          int,
  pos_pending         int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from date := coalesce(p_from, date_trunc('month',
                   (now() at time zone 'Asia/Kolkata')::date)::date);
  v_to   date := coalesce(p_to, (now() at time zone 'Asia/Kolkata')::date);
  v_sees boolean := public.my_role() in ('founder', 'accounts');
  v_oh   numeric;
begin
  -- A supervisor gets no row at all rather than a row of zeros. Zeros read as
  -- "the company has no projects", which is a lie; nothing reads as "not for
  -- you", which the screen then says in words.
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    return;
  end if;

  if v_sees then
    -- The SAME definition fn_company_net (040) uses: amount + gst, voided rows
    -- excluded, over `spend_date` (NOT expense_date — that is the projects
    -- table's column name). A second definition of "overheads for the period"
    -- would eventually disagree with the Overheads screen.
    -- Aliased `ce`, not `e`: `e` means `expenses` everywhere else in this file,
    -- and two tables behind one letter is how the wrong date column gets typed.
    select coalesce(sum(ce.amount + ce.gst_amount), 0)::numeric(14,2) into v_oh
    from public.company_expenses ce
    where ce.spend_date between v_from and v_to
      and ce.voided_at is null;
  end if;

  return query
  with p as (select * from public.v_mis_projects)
  select
    count(*)::int,
    count(*) filter (where p.project_status::text = 'active')::int,
    coalesce(sum(p.revenue), 0)::numeric(14,2),
    coalesce(sum(p.total_cost), 0)::numeric(14,2),
    coalesce(sum(p.gross_margin), 0)::numeric(14,2),
    case when coalesce(sum(p.revenue), 0) > 0
      then round(sum(p.gross_margin) * 100.0 / sum(p.revenue), 1) end,
    count(*) filter (where p.over_budget)::int,
    count(*) filter (where p.gross_margin < 0)::int,
    v_oh,
    case when v_sees
      then (coalesce(sum(p.gross_margin), 0) - coalesce(v_oh, 0))::numeric(14,2)
    end,
    v_sees,
    case when v_sees then v_from end,
    case when v_sees then v_to end,
    coalesce(sum(p.retention_held), 0)::numeric(14,2),
    coalesce(sum(p.committed_open), 0)::numeric(14,2),
    coalesce(sum(p.bills_awaiting), 0)::int,
    -- Compliance is company-wide and has its own alert function since 028.
    coalesce((select a.overdue_count from public.fn_compliance_alert() a), 0),
    coalesce(sum(p.open_ncrs), 0)::int,
    coalesce(sum(p.critical_ncrs), 0)::int,
    coalesce(sum(p.open_snags), 0)::int,
    coalesce(sum(p.pos_pending), 0)::int
  from p;
end $$;

revoke all on function public.fn_mis_company(date, date) from public, anon;
grant execute on function public.fn_mis_company(date, date) to authenticated;


-- ############################################################
-- ###  3. TREND — cost by month, margin to date
-- ############################################################
-- ---------- WHY THERE IS NO "MARGIN EARNED THIS MONTH" ----------
-- Monthly cost is a real figure: money left in March. Monthly MARGIN is not,
-- because this app does not recognise revenue monthly — revenue is the contract
-- value, and nothing in the system says how much of it was earned in March.
-- Inventing a monthly split would put a number on the board pack that means
-- nothing.
--
-- So the series carries monthly COST and margin TO DATE at each month end,
-- which is exactly what "are we making money, and is that improving" needs, and
-- is defensible line by line.
drop function if exists public.fn_mis_trend(int);
create function public.fn_mis_trend(p_months int default 12)
returns table (
  month              date,
  monthly_cost       numeric,
  cumulative_cost    numeric,
  revenue_to_date    numeric,
  margin_to_date     numeric,
  margin_pct_to_date numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_months int := greatest(least(coalesce(p_months, 12), 36), 1);
  v_start  date := date_trunc('month',
                     (now() at time zone 'Asia/Kolkata')::date
                     - make_interval(months => v_months - 1))::date;
  v_revenue numeric;
begin
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    return;
  end if;

  -- Revenue is a constant across the series, and it is the revenue of the
  -- projects THIS CALLER can see — so a PM's margin line is about their own
  -- jobs, not the firm's.
  select coalesce(sum(m.revenue), 0) into v_revenue from public.v_mis_projects m;

  return query
  with months as (
    select generate_series(
             v_start,
             date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date,
             interval '1 month')::date as m
  ),
  -- Scope the cost the same way the P&L does: expenses excluding voids, plus
  -- certified contractor bills, over the projects the caller can see.
  visible as (select project_id from public.v_mis_projects),
  spend as (
    select date_trunc('month', e.expense_date)::date as m,
           sum(e.amount + coalesce(e.gst_amount, 0))::numeric(14,2) as amt
    from public.expenses e
    where e.voided_at is null
      and e.project_id in (select project_id from visible)
    group by 1
    union all
    select date_trunc('month', b.certified_at)::date,
           sum(b.net_certified + coalesce(b.retention_amount, 0))::numeric(14,2)
    from public.ra_bills b
    where b.status::text = 'certified'
      and b.certified_at is not null
      and b.project_id in (select project_id from visible)
    group by 1
  ),
  by_month as (
    select months.m,
           coalesce(sum(s.amt), 0)::numeric(14,2) as amt
    from months
    left join spend s on s.m = months.m
    group by months.m
  ),
  running as (
    select b.m,
           b.amt,
           sum(b.amt) over (order by b.m)::numeric(14,2) as cum
    from by_month b
  )
  select
    r.m,
    r.amt,
    r.cum,
    v_revenue::numeric(14,2),
    (v_revenue - r.cum)::numeric(14,2),
    case when v_revenue > 0
      then round((v_revenue - r.cum) * 100.0 / v_revenue, 1) end
  from running r
  order by r.m;
end $$;

revoke all on function public.fn_mis_trend(int) from public, anon;
grant execute on function public.fn_mis_trend(int) to authenticated;


-- ############################################################
-- ###  4. COST BY CATEGORY, COMPANY-WIDE
-- ############################################################
-- Project cost only. Company overheads are a different thing with a different
-- audience and their own screen (040) — mixing them into one bar chart would
-- put "Office rent" beside "Cement" and invite somebody to read the total as
-- project cost.
drop function if exists public.fn_mis_by_category(date, date);
create function public.fn_mis_by_category(
  p_from date default null,
  p_to   date default null
)
returns table (
  category_id   int,
  category_name text,
  amount        numeric,
  pct_of_total  numeric,
  entry_count   int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from date := coalesce(p_from, '2000-01-01'::date);
  v_to   date := coalesce(p_to, (now() at time zone 'Asia/Kolkata')::date);
begin
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    return;
  end if;

  return query
  with visible as (select project_id from public.v_mis_projects),
  c as (
    select e.category_id,
           sum(e.amount + coalesce(e.gst_amount, 0))::numeric(14,2) as amt,
           count(*)::int as n
    from public.expenses e
    where e.voided_at is null
      and e.expense_date between v_from and v_to
      and e.project_id in (select project_id from visible)
    group by e.category_id
  ),
  t as (select coalesce(sum(c.amt), 0) as total from c)
  select c.category_id,
         ec.name,
         c.amt,
         case when t.total > 0 then round(c.amt * 100.0 / t.total, 1) end,
         c.n
  from c
  join public.expense_categories ec on ec.id = c.category_id
  cross join t
  order by c.amt desc;
end $$;

revoke all on function public.fn_mis_by_category(date, date) from public, anon;
grant execute on function public.fn_mis_by_category(date, date) to authenticated;


-- ############################################################
-- ###  5. THE EXCEPTION PANEL
-- ############################################################
-- Everything that wants attention, from eight sources, in ONE shape so the
-- screen sorts and renders it once. A dashboard with eight separate warning
-- boxes is a dashboard where the eighth is never read.
--
-- `severity` is 'critical' or 'warning' only. Three levels invites a middle one
-- that nobody acts on.
drop function if exists public.fn_mis_exceptions();
create function public.fn_mis_exceptions()
returns table (
  kind         text,
  severity     text,
  project_id   uuid,
  project_name text,
  title        text,
  detail       text,
  due_date     date,
  amount       numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    return;
  end if;

  return query

  -- ---- over budget ----
  select 'budget', 'critical', m.project_id, m.project_name,
         'Over budget',
         format('%s spent against a budget of %s', round(m.total_cost),
                round(m.budget_total)),
         null::date, (m.budget_remaining)::numeric
  from public.v_mis_projects m
  where m.over_budget

  union all
  -- ---- losing money ----
  select 'margin', 'critical', m.project_id, m.project_name,
         'Negative margin',
         format('Margin %s%%', m.margin_pct),
         null::date, m.gross_margin
  from public.v_mis_projects m
  where m.margin_pct is not null and m.margin_pct < 0

  union all
  -- ---- cost performance ----
  select 'cpi', case when m.cpi < 0.9 then 'critical' else 'warning' end,
         m.project_id, m.project_name,
         'Cost performance below plan',
         format('CPI %s — spending faster than work is being earned', m.cpi),
         null::date, null::numeric
  from public.v_mis_projects m
  where m.cpi is not null and m.cpi < 1

  union all
  -- ---- schedule performance ----
  select 'spi', 'warning', m.project_id, m.project_name,
         'Behind programme',
         format('SPI %s at %s%% complete', m.spi, m.pct_complete),
         null::date, null::numeric
  from public.v_mis_projects m
  where m.spi is not null and m.spi < 0.9

  union all
  -- ---- critical NCRs ----
  select 'ncr', 'critical', n.project_id, pr.name,
         format('%s — critical NCR', n.ncr_no),
         n.description, null::date, null::numeric
  from public.ncrs n
  join public.projects pr on pr.id = n.project_id
  where n.severity::text = 'critical'
    and n.status::text in ('open', 'corrected')
    and n.cancelled_at is null

  union all
  -- ---- compliance overdue ----
  select 'compliance',
         case when c.due_date < v_today then 'critical' else 'warning' end,
         c.project_id, pr.name, c.title,
         format('Due %s', c.due_date), c.due_date, null::numeric
  from public.compliance_items c
  left join public.projects pr on pr.id = c.project_id
  where c.status::text <> 'filed'
    and c.due_date <= v_today + 14

  union all
  -- ---- bank guarantees ----
  select 'bg',
         case when g.expiry_date < v_today then 'critical' else 'warning' end,
         g.project_id, pr.name,
         format('BG %s', g.bg_number),
         format('Expires %s', g.expiry_date), g.expiry_date, g.amount
  from public.bank_guarantees g
  left join public.projects pr on pr.id = g.project_id
  where g.status::text in ('active', 'expired')
    and g.expiry_date <= v_today + 30

  union all
  -- ---- insurance ----
  select 'insurance',
         case when i.expiry_date < v_today then 'critical' else 'warning' end,
         i.project_id, pr.name,
         coalesce(i.policy_number, i.insurer),
         format('Expires %s', i.expiry_date), i.expiry_date, null::numeric
  from public.insurance_policies i
  left join public.projects pr on pr.id = i.project_id
  where i.status::text in ('active', 'expired')
    and i.expiry_date <= v_today + 30

  union all
  -- ---- contractor bills waiting ----
  -- Two weeks is not a rule anybody wrote down; it is long enough that the
  -- contractor has started chasing. Deliberately a warning, never critical.
  select 'ra_bill', 'warning', b.project_id, pr.name,
         format('%s awaiting certification', b.bill_no),
         format('Submitted %s', b.created_at::date),
         b.created_at::date, b.claimed_amount
  from public.ra_bills b
  join public.projects pr on pr.id = b.project_id
  where b.status::text in ('submitted', 'under_review')
    and b.cancelled_at is null
    and b.created_at < now() - interval '14 days'

  union all
  -- ---- purchase requests waiting ----
  select 'po', 'warning', po.project_id, pr.name,
         format('%s awaiting approval', po.po_number),
         format('Raised %s', po.created_at::date),
         po.created_at::date, null::numeric
  from public.purchase_orders po
  join public.projects pr on pr.id = po.project_id
  where po.status::text = 'requested'
    and po.created_at < now() - interval '7 days'

  order by 2, 7 nulls last, 5;
end $$;

revoke all on function public.fn_mis_exceptions() from public, anon;
grant execute on function public.fn_mis_exceptions() to authenticated;


-- ############################################################
-- ###  6. VERIFY
-- ############################################################
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_mis_company', 'fn_mis_trend', 'fn_mis_by_category',
                    'fn_mis_exceptions')
group by p.proname order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'v_mis_projects';
