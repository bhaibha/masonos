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
