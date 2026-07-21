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
