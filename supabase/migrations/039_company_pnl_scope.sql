-- ============================================================
-- MASON OS — Migration 039: fn_company_pnl scopes itself instead of
--                           demanding the founder
--
-- 038 gated the roll-up with `where public.is_founder()`. That was one gate too
-- many: it sums `v_project_pnl`, which ALREADY restricts rows to what the
-- caller may see (is_member + founder/pm/accounts). The extra check meant a PM
-- or accounts got a blank card rather than the total of the projects in front
-- of them — and a blank where a number belongs reads as breakage.
--
-- With the gate removed:
--   founder    → every project
--   accounts   → every project (they are allowed all money)
--   pm         → only their assigned projects
--   supervisor → zero rows, so the aggregate is NULL/0 and the card hides
--
-- Nothing widens: a caller can only total what they could already read
-- project-by-project. The dashboard needs this so its "All projects" card can
-- show a margin computed in Postgres rather than summed in the browser
-- (CLAUDE.md rule 2).
--
-- The P&L screen still shows the card it labels "Company position" to the
-- FOUNDER only — that is a presentation decision in the UI, where it belongs,
-- not an access rule.
--
-- Re-runnable: single create-or-replace, same signature as 038.
-- ============================================================

create or replace function public.fn_company_pnl()
returns table (
  project_count      int,
  active_count       int,
  revenue            numeric,
  total_cost         numeric,
  gross_margin       numeric,
  blended_margin_pct numeric,
  retention_held     numeric,
  committed_open     numeric,
  profitable_count   int,
  bleeding_count     int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::int,
    count(*) filter (where project_status::text = 'active')::int,
    sum(revenue)::numeric(14,2),
    sum(total_cost)::numeric(14,2),
    sum(gross_margin)::numeric(14,2),
    case when sum(revenue) > 0
      then round(sum(gross_margin) * 100.0 / sum(revenue), 1) end,
    sum(retention_held)::numeric(14,2),
    sum(committed_open)::numeric(14,2),
    -- Counted only where cost exists: a project with revenue and no spend is
    -- "not started", not profitable, and calling it profitable would inflate
    -- the tally people read fastest.
    count(*) filter (where gross_margin > 0 and total_cost > 0)::int,
    count(*) filter (where gross_margin < 0)::int
  from public.v_project_pnl;
$$;

revoke all on function public.fn_company_pnl() from public, anon;
grant execute on function public.fn_company_pnl() to authenticated;

comment on function public.fn_company_pnl() is
  'Totals over v_project_pnl, which already scopes rows to the caller. '
  'Founder and accounts get every project, a PM gets their own, a supervisor '
  'gets nothing. Labelling it "company" is the UI''s job.';


-- ---------- VERIFY ----------
-- From the SQL editor this returns one row of NULLs with count 0, because the
-- editor connects as `postgres` with no auth.uid() — the gate working, not
-- missing data. Verify through the app.
select * from public.fn_company_pnl();
