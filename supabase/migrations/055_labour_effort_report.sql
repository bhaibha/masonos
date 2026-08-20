-- ============================================================
-- MASON OS — Migration 055: labour effort report for History
--
-- The History screen spans a date range and exports to Excel. It needed a
-- labour section, and that section needs a roll-up: days worked, mandays and
-- overtime hours per contractor per trade over the period.
--
-- ---------- WHY A FUNCTION AND NOT A BROWSER SUM ----------
-- The rows are already on screen, so adding them up in TypeScript would have
-- been three lines. Rule 2 says every quantity total is computed in Postgres
-- and the browser only displays what Postgres worked out — and a manday total
-- is exactly that kind of figure: it is what the wage register is read in, and
-- it is what somebody will compare against an invoice from the contractor. Two
-- implementations of one total eventually disagree, and the browser copy is
-- the one nobody re-checks.
--
-- ---------- WHY IT CARRIES NO MONEY ----------
-- History is readable by every project member including supervisors, and the
-- standing property of that screen — confirmed in the supervisor pass on
-- 2026-08-06 — is that its CSVs contain NO money column. So this reports
-- EFFORT: headcount, days, mandays, overtime hours. The wage side already has
-- a home at Money → Labour, gated to money roles, and duplicating it here would
-- both break that property and create a second place to look for one figure.
--
-- Read-only. No tables, no columns, no policies — one function.
-- Requires 054.
-- ============================================================

drop function if exists public.fn_labour_effort(uuid, date, date);
create function public.fn_labour_effort(
  p_project uuid,
  p_from    date,
  p_to      date
)
returns table (
  contractor_id   uuid,
  contractor_name text,
  trade           text,
  days_worked     int,
  mandays         numeric,
  ot_hours        numeric,
  peak_workers    int
)
language sql
stable
set search_path = public
as $$
  select
    a.contractor_id,
    c.name,
    a.trade,
    count(distinct a.work_date)::int,
    sum(a.workers_present)::numeric(12,2),
    sum(a.overtime_hours)::numeric(12,2),
    max(a.workers_present)::int
  from public.labour_attendance a
  join public.labour_contractors c on c.id = a.contractor_id
  where a.project_id = p_project
    and a.work_date between p_from and p_to
    -- Voided entries are excluded here, in the server, exactly as every other
    -- total in this app excludes them. A client-side filter would eventually be
    -- forgotten on one screen.
    and a.voided_at is null
    and public.is_member(a.project_id)
  group by a.contractor_id, c.name, a.trade
  order by c.name, a.trade;
$$;

revoke all on function public.fn_labour_effort(uuid, date, date) from public, anon;
grant execute on function public.fn_labour_effort(uuid, date, date) to authenticated;

comment on function public.fn_labour_effort(uuid, date, date) is
  'Labour EFFORT over a period — days, mandays, overtime hours per contractor '
  'and trade. Deliberately carries no rate and no cost: History is readable by '
  'supervisors and its exports hold no money column. Wages are fn_wage_register.';


-- ---------- verify ----------
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'fn_labour_effort'
group by p.proname;
