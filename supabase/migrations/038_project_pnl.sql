-- ============================================================
-- MASON OS — Migration 038: B6 Company P&L & Project Profitability (Module 29)
--
-- What each project earns, what it costs, and what that leaves. The most
-- sensitive screen in the app: it is the whole business on one page.
--
-- ---------- RETENTION IS NOT A COST. THIS IS DELIBERATE. ----------
-- The brief said "revenue − cost − retention held = margin". That would count
-- the retained money twice. Retention is a slice of a contractor's certified
-- bill that we have not PAID yet — the work is done, the liability exists, and
-- the full certified value is already inside total cost. Subtracting it again
-- would flatter the margin of any project holding retention and then quietly
-- worsen it as tranches are released, which is precisely backwards.
--
-- So: margin = revenue − total cost. `retention_held` is carried alongside as a
-- CASH-FLOW memo — "of this cost, ₹X is owed but not yet paid" — and the screen
-- labels it that way. If your CA wants it deducted for a cash-position view,
-- that is a different report, not this one.
--
-- ---------- WHAT COUNTS AS COST ----------
--   expenses (voided excluded)   — the general ledger: materials, labour,
--                                  petty cash (mirrored in), and vendor
--                                  invoices posted from the 3-way match
--   + certified RA bills         — contractor work certified but NOT posted to
--                                  Open Book (032 deliberately doesn't post,
--                                  to avoid double-counting the procurement
--                                  path), so P&L must add it here
--
-- Those two are disjoint by construction. If a contractor is ever paid through
-- BOTH an expense and an RA bill, this figure double-counts them — the fix is
-- to stop doing that, not to net it out here.
--
-- ---------- REVENUE ----------
-- Contract value + APPROVED variations only. Pending VOs are shown separately
-- so nobody plans around money the client hasn't agreed to.
--
-- ---------- PROJECTION ----------
-- projected cost = actual + budget still unspent + open commitments (approved
-- POs not yet invoiced). It is a forecast, not a fact, and is NULL when a
-- project has no budget — an honest blank beats a confident wrong number.
--
-- ---------- ACCESS ----------
-- These views are owner-run, NOT security_invoker, because they read
-- `projects.contract_value`, which migration 010 revoked from `authenticated`.
-- That makes the WHERE clause the access control, exactly as
-- v_project_commercials and v_project_contract already do:
--   founder / pm / accounts, and is_member() for the project.
-- Supervisors match no arm and see nothing. The company roll-up is a separate
-- function gated to the founder alone.
--
-- No new tables, so no new RLS policies or audit triggers — every figure here
-- is derived from tables that already have both.
--
-- Re-runnable: views dropped before create (never create-or-replace —
-- CLAUDE.md), create-or-replace on the function.
-- ============================================================


-- ############################################################
-- ###  1. PER-PROJECT P&L
-- ############################################################

drop view if exists public.v_project_pnl cascade;
create view public.v_project_pnl as
with cost_expenses as (
  select project_id, sum(amount + gst_amount)::numeric(14,2) as amt
  from public.expenses
  where voided_at is null
  group by project_id
),
cost_ra as (
  -- The full certified value of work, retention included: we owe it whether or
  -- not it has been paid. `net_certified + retention_amount` is this bill's
  -- value; summing gross would double-count across a running account.
  select project_id,
         sum(net_certified + retention_amount)::numeric(14,2) as amt,
         sum(retention_amount)::numeric(14,2)                 as retention
  from public.ra_bills
  where status::text = 'certified'
  group by project_id
),
released as (
  select project_id, sum(amount)::numeric(14,2) as amt
  from public.retention_releases
  where status::text = 'released'
  group by project_id
),
budget as (
  select project_id, sum(amount)::numeric(14,2) as amt
  from public.budgets
  group by project_id
),
-- Approved orders with nothing invoiced against them yet: money committed to a
-- vendor but not yet in the ledger. Ignoring it makes every forecast optimistic.
committed as (
  select po.project_id,
         sum(greatest(coalesce(v.ordered_value, 0) - coalesce(inv.invoiced, 0), 0))::numeric(14,2) as amt
  from public.purchase_orders po
  left join public.v_po_value v on v.po_id = po.id
  left join lateral (
    -- A vendor invoice carries its value on its LINES; the header holds only
    -- the GST. Voiding the header is what removes an invoice, so the join
    -- filters there rather than on the lines.
    select sum(il.line_total) as invoiced
    from public.po_invoices i
    join public.invoice_lines il on il.invoice_id = i.id
    where i.po_id = po.id and i.voided_at is null
  ) inv on true
  where po.status::text in ('approved', 'receiving', 'received')
  group by po.project_id
)
select
  p.id as project_id,
  p.name,
  p.status as project_status,

  -- ---------- revenue ----------
  coalesce(p.contract_value, 0)::numeric(14,2)      as contract_value,
  coalesce(c.variations_value, 0)::numeric(14,2)    as variations_value,
  coalesce(c.pending_value, 0)::numeric(14,2)       as pending_variations,
  coalesce(c.revised_contract_value, coalesce(p.contract_value, 0))::numeric(14,2) as revenue,

  -- ---------- cost ----------
  coalesce(ce.amt, 0)::numeric(14,2)                as expense_cost,
  coalesce(cr.amt, 0)::numeric(14,2)                as contractor_cost,
  (coalesce(ce.amt, 0) + coalesce(cr.amt, 0))::numeric(14,2) as total_cost,

  -- ---------- margin ----------
  (coalesce(c.revised_contract_value, coalesce(p.contract_value, 0))
     - coalesce(ce.amt, 0) - coalesce(cr.amt, 0))::numeric(14,2) as gross_margin,
  case
    when coalesce(c.revised_contract_value, coalesce(p.contract_value, 0)) > 0
      then round(
        (coalesce(c.revised_contract_value, coalesce(p.contract_value, 0))
          - coalesce(ce.amt, 0) - coalesce(cr.amt, 0))
        * 100.0
        / coalesce(c.revised_contract_value, coalesce(p.contract_value, 0)), 1)
  end                                               as margin_pct,

  -- ---------- cash memo, NOT a margin deduction ----------
  greatest(coalesce(cr.retention, 0) - coalesce(rl.amt, 0), 0)::numeric(14,2)
                                                    as retention_held,

  -- ---------- budget + forecast ----------
  coalesce(b.amt, 0)::numeric(14,2)                 as budget_total,
  (coalesce(b.amt, 0) - coalesce(ce.amt, 0) - coalesce(cr.amt, 0))::numeric(14,2)
                                                    as budget_remaining,
  coalesce(cm.amt, 0)::numeric(14,2)                as committed_open,

  case when coalesce(b.amt, 0) > 0 then
    (coalesce(ce.amt, 0) + coalesce(cr.amt, 0)
      + greatest(coalesce(b.amt, 0) - coalesce(ce.amt, 0) - coalesce(cr.amt, 0), 0)
      + coalesce(cm.amt, 0))::numeric(14,2)
  end                                               as projected_cost,

  case when coalesce(b.amt, 0) > 0 then
    (coalesce(c.revised_contract_value, coalesce(p.contract_value, 0))
      - (coalesce(ce.amt, 0) + coalesce(cr.amt, 0)
         + greatest(coalesce(b.amt, 0) - coalesce(ce.amt, 0) - coalesce(cr.amt, 0), 0)
         + coalesce(cm.amt, 0)))::numeric(14,2)
  end                                               as projected_margin

from public.projects p
left join public.v_project_contract c on c.project_id = p.id
left join cost_expenses ce on ce.project_id = p.id
left join cost_ra       cr on cr.project_id = p.id
left join released      rl on rl.project_id = p.id
left join budget        b  on b.project_id  = p.id
left join committed     cm on cm.project_id = p.id
where public.is_member(p.id)
  and public.my_role() in ('founder', 'pm', 'accounts');

grant select on public.v_project_pnl to authenticated;

comment on view public.v_project_pnl is
  'Owner-run: reads projects.contract_value, which 010 revoked from '
  'authenticated, so the WHERE clause IS the access control. Margin excludes '
  'retention deliberately — see the migration header.';


-- ############################################################
-- ###  2. COST BREAKDOWN BY CATEGORY
-- ############################################################
-- Budget vs actual per category, plus contractor bills as their own line.
-- Ranked by overspend so the worst offender is first — a list sorted by
-- category name buries the thing you needed to see.
drop view if exists public.v_pnl_by_category cascade;
create view public.v_pnl_by_category as
with expense_rows as (
  select
    e.project_id,
    coalesce(ec.name, 'Uncategorised') as category,
    sum(e.amount + e.gst_amount)::numeric(14,2) as actual
  from public.expenses e
  left join public.expense_categories ec on ec.id = e.category_id
  where e.voided_at is null
  group by e.project_id, coalesce(ec.name, 'Uncategorised')
),
budget_rows as (
  select
    b.project_id,
    coalesce(ec.name, 'Uncategorised') as category,
    sum(b.amount)::numeric(14,2) as budget
  from public.budgets b
  left join public.expense_categories ec on ec.id = b.category_id
  group by b.project_id, coalesce(ec.name, 'Uncategorised')
),
contractor_rows as (
  -- Not a budget category: RA bills have no category_id, and inventing one
  -- would let them silently absorb an unrelated budget line.
  select
    project_id,
    'Contractor bills (RA)'::text as category,
    sum(net_certified + retention_amount)::numeric(14,2) as actual
  from public.ra_bills
  where status::text = 'certified'
  group by project_id
),
keys as (
  select project_id, category from expense_rows
  union
  select project_id, category from budget_rows
  union
  select project_id, category from contractor_rows
)
select
  k.project_id,
  k.category,
  coalesce(br.budget, 0)::numeric(14,2)                       as budget,
  coalesce(er.actual, 0) + coalesce(cr.actual, 0)             as actual,
  (coalesce(br.budget, 0) - coalesce(er.actual, 0) - coalesce(cr.actual, 0))::numeric(14,2)
                                                              as variance,
  case
    when coalesce(br.budget, 0) > 0
      then round((coalesce(er.actual, 0) + coalesce(cr.actual, 0)) * 100.0 / br.budget, 1)
  end                                                         as pct_used,
  (coalesce(br.budget, 0) > 0
    and (coalesce(er.actual, 0) + coalesce(cr.actual, 0)) > br.budget) as over_budget
from keys k
left join expense_rows   er on er.project_id = k.project_id and er.category = k.category
left join budget_rows    br on br.project_id = k.project_id and br.category = k.category
left join contractor_rows cr on cr.project_id = k.project_id and cr.category = k.category
join public.projects p on p.id = k.project_id
where public.is_member(k.project_id)
  and public.my_role() in ('founder', 'pm', 'accounts');

grant select on public.v_pnl_by_category to authenticated;


-- ############################################################
-- ###  3. COMPANY ROLL-UP — FOUNDER ONLY
-- ############################################################
-- A function rather than a view, because "founder only" is a harder line than
-- a WHERE clause on a view someone might later make security_invoker. It
-- returns one row; anyone else gets zero rows, not an error, so the screen can
-- call it and simply render nothing.
create or replace function public.fn_company_pnl()
returns table (
  project_count     int,
  active_count      int,
  revenue           numeric,
  total_cost        numeric,
  gross_margin      numeric,
  blended_margin_pct numeric,
  retention_held    numeric,
  committed_open    numeric,
  profitable_count  int,
  bleeding_count    int
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
    count(*) filter (where gross_margin > 0)::int,
    count(*) filter (where gross_margin < 0)::int
  from public.v_project_pnl
  where public.is_founder();
$$;

revoke all on function public.fn_company_pnl() from public, anon;
grant execute on function public.fn_company_pnl() to authenticated;

comment on function public.fn_company_pnl() is
  'Company totals, founder only. Returns zero rows for anyone else rather than '
  'raising, so the screen can call it unconditionally and render nothing.';


-- ############################################################
-- ###  4. VERIFY
-- ############################################################
select table_name from information_schema.views
where table_schema = 'public'
  and table_name in ('v_project_pnl', 'v_pnl_by_category')
order by table_name;

-- Per project. Margin should equal revenue − total_cost exactly.
select name, revenue, total_cost, gross_margin, margin_pct,
       retention_held, budget_total, projected_margin
from public.v_project_pnl
order by name;

-- Company. One row for a founder, zero rows for anyone else.
select * from public.fn_company_pnl();
