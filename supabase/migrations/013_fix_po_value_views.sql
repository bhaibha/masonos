-- ============================================================
-- MASON OS — Migration 013: fix procurement views vs revoked columns
--
-- 012 revoked po_lines.rate / line_total from `authenticated`, but left
-- v_po_totals and v_po_match as security_invoker reading those columns. All
-- app users share the `authenticated` role, so those views failed to read
-- line_total for EVERYONE — the PO value never showed, even for founders.
--
-- Fix, mirroring v_po_lines_rated:
--   v_po_totals  — security_invoker, counts only (qty_ordered is granted)
--   v_po_value   — owner-run, gated to founder/pm/accounts, carries the value
--   v_po_match   — owner-run, gated (it exposes rates)
-- ============================================================

-- Counts for everyone (reads only granted columns).
drop view if exists public.v_po_totals;
create view public.v_po_totals with (security_invoker = true) as
select po.id as po_id, po.project_id,
       count(pl.id) as line_count,
       coalesce(sum(pl.qty_ordered), 0) as total_qty
from public.purchase_orders po
left join public.po_lines pl on pl.po_id = po.id
group by po.id, po.project_id;
grant select on public.v_po_totals to authenticated;

-- Ordered value — owner-run so it can read the revoked line_total, gated by
-- role so supervisors never get it.
create or replace view public.v_po_value as
select po.id as po_id, po.project_id,
       coalesce(sum(pl.line_total), 0)::numeric(14,2) as ordered_value
from public.purchase_orders po
left join public.po_lines pl on pl.po_id = po.id
where public.is_member(po.project_id)
  and public.my_role() in ('founder', 'pm', 'accounts')
group by po.id, po.project_id;
grant select on public.v_po_value to authenticated;

-- 3-way match exposes rates, so it's owner-run + gated too.
drop view if exists public.v_po_match;
create view public.v_po_match as
with recv as (
  select po_line_id, sum(qty_received) as qty_received
  from public.grn_lines group by po_line_id
),
inv as (
  select il.po_line_id,
         sum(il.qty_invoiced) as qty_invoiced,
         case when sum(il.qty_invoiced) > 0
              then round(sum(il.line_total) / sum(il.qty_invoiced), 2) end as rate_invoiced
  from public.invoice_lines il
  group by il.po_line_id
)
select
  pl.id as po_line_id,
  pl.po_id,
  po.project_id,
  pl.material_id,
  pl.qty_ordered,
  pl.rate as rate_ordered,
  coalesce(r.qty_received, 0) as qty_received,
  coalesce(i.qty_invoiced, 0) as qty_invoiced,
  i.rate_invoiced,
  (case
     when i.qty_invoiced is null then 'pending'
     when abs(coalesce(i.qty_invoiced,0) - coalesce(r.qty_received,0)) > 0.5
          and pl.rate is not null and i.rate_invoiced is not null
          and abs(i.rate_invoiced - pl.rate) > pl.rate * 0.02 then 'both'
     when abs(coalesce(i.qty_invoiced,0) - coalesce(r.qty_received,0)) > 0.5 then 'qty_variance'
     when pl.rate is not null and i.rate_invoiced is not null
          and abs(i.rate_invoiced - pl.rate) > pl.rate * 0.02 then 'rate_variance'
     else 'ok'
   end)::match_status as match_status
from public.po_lines pl
join public.purchase_orders po on po.id = pl.po_id
left join recv r on r.po_line_id = pl.id
left join inv i on i.po_line_id = pl.id
where public.is_member(po.project_id)
  and public.my_role() in ('founder', 'pm', 'accounts');
grant select on public.v_po_match to authenticated;
