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
