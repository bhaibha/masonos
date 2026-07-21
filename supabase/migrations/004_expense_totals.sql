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
