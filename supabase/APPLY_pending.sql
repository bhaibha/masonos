-- ==============================================================
-- MASON OS — pending migrations: 021 then 022, in that order.
-- Paste this whole file into the Supabase SQL editor and Run.
--
-- 001–020 are all APPLIED (020 confirmed 2026-07-27).
--
-- IF IT ERRORS WITH "unsafe use of new value of enum type":
--   run the single line   alter type public.vo_status add value if not exists 'cancelled';
--   on its own first, then run this file again. Everything else is written to
--   avoid that (text comparisons rather than the new enum literal), so this
--   should not happen — but that's the fix if it does.
--
-- FULLY re-runnable. Each part ends with a verification SELECT; the editor
-- shows only the LAST result, so scroll/re-run the earlier one if you want it.
-- ==============================================================


-- ============================================================
-- MASON OS — Migration 021: cancel/reject for workflow documents,
--                           plus supervisor self-void of stock
--
-- Completes the record-removal design started in 020. Three mechanisms:
--   1. hard delete   — no downstream effect            (not built yet)
--   2. void/reverse  — financial + stock rows          (migration 020)
--   3. cancel/reject — workflow documents: PO, VO      (THIS FILE)
--
-- ---------- WHY THIS MATTERS ----------
-- An approved VO immediately changes revised_contract_value through
-- v_project_contract, and until now there was NO way back: vo_status had only
-- submitted/approved/rejected, and 'rejected' is only reachable while the VO is
-- still submitted. A VO approved by mistake permanently inflated the contract
-- figure. Same shape of hole on purchase_orders: an approved PO could not be
-- cancelled.
--
-- ---------- HOW CANCELLATION IS FORCED THROUGH THE RPC ----------
-- purchase_orders has a client-writable UPDATE policy (po_update) and the app
-- calls setPoStatus() directly, so the RPC alone cannot be the guarantee.
-- A CHECK constraint is:
--
--     status = 'cancelled'  ⇒  cancelled_at, cancelled_by and a non-blank
--                              cancel_reason must ALL be present
--
-- A direct client UPDATE to 'cancelled' therefore fails the constraint.
-- fn_cancel_document is the only thing that sets all four together, and it is
-- SECURITY DEFINER so it can stamp cancelled_by = auth.uid() honestly.
-- Same pattern as 020's *_void_ck.
--
-- ---------- SUPERVISOR SELF-VOID ----------
-- Supervisors log the deliveries and issues, so they make the typos, but 020
-- restricted stock voids to founder/pm — leaving the stock register wrong until
-- someone else acted. fn_void_record now also accepts a supervisor voiding a
-- material_inward / material_issues row THEY created.
--
-- SCOPE NOTE: this is "own entries, any date" — the literal reading of the
-- instruction. To tighten it to same-day only, add to the supervisor branch:
--        and v_created::date = current_date
-- The 020 guards still apply either way: a supervisor cannot void stock that
-- has already been consumed, and cannot void a GRN-created inward row.
--
-- ---------- ENUM / TRANSACTION GOTCHA (read if this errors) ----------
-- `alter type ... add value` commits the new label, but Postgres refuses to
-- USE that label elsewhere in the same transaction ("unsafe use of new value of
-- enum type"). The Supabase SQL editor runs a script as one transaction.
-- So every comparison against 'cancelled' below is written as
--     status::text = 'cancelled'
-- rather than the enum literal. Text comparison needs no new label at parse
-- time, so the whole file runs in one go.
-- Inside plpgsql function BODIES the literal is resolved at call time, which is
-- after commit — but ::text is used there too, for consistency.
-- If you still hit that error: run the single `alter type` line on its own,
-- then run the rest.
--
-- Re-runnable: add-value-if-not-exists, add-column-if-not-exists,
-- drop-constraint before add, create-or-replace on functions, drop-then-create
-- on views (never create-or-replace — Postgres refuses column list changes).
-- ============================================================


-- ############################################################
-- ###  1. STATUS + COLUMNS
-- ############################################################

-- po_status already carries 'cancelled' (012). vo_status does not.
alter type public.vo_status add value if not exists 'cancelled';

alter table public.purchase_orders
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancelled_by  uuid references public.profiles(id),
  add column if not exists cancel_reason text;

alter table public.variation_orders
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancelled_by  uuid references public.profiles(id),
  add column if not exists cancel_reason text;

-- The reason is a DATABASE rule, not a form rule. Scoped to rows that are
-- actually cancelled, so existing rows can never violate it.
alter table public.purchase_orders drop constraint if exists purchase_orders_cancel_ck;
alter table public.purchase_orders add constraint purchase_orders_cancel_ck check (
  status::text <> 'cancelled'
  or (cancelled_at is not null
      and cancelled_by is not null
      and coalesce(btrim(cancel_reason), '') <> '')
);

alter table public.variation_orders drop constraint if exists variation_orders_cancel_ck;
alter table public.variation_orders add constraint variation_orders_cancel_ck check (
  status::text <> 'cancelled'
  or (cancelled_at is not null
      and cancelled_by is not null
      and coalesce(btrim(cancel_reason), '') <> '')
);

-- A rejection should carry its reason too. Not constrained (rejection predates
-- this migration and existing rows have none), but the UI now always sends one
-- and it lands in the same column.
comment on column public.variation_orders.cancel_reason is
  'Why the variation was cancelled or rejected. Mandatory for cancelled (CHECK).';


-- ############################################################
-- ###  2. fn_cancel_document — the only way a PO or VO is cancelled
-- ############################################################
create or replace function public.fn_cancel_document(
  p_table  text,
  p_id     uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_project uuid;
  v_status  text;
  v_now     timestamptz := now();
  v_me      uuid := auth.uid();
  v_n       int;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to cancel a document.' using errcode = '22023';
  end if;

  v_role := public.my_role();

  -- ------------------------------------------------------ PURCHASE ORDER
  if p_table = 'purchase_orders' then
    select project_id, status::text into v_project, v_status
    from public.purchase_orders where id = p_id;

    if v_project is null then
      raise exception 'That purchase order no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;
    if v_role not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may cancel a purchase order.'
        using errcode = '42501';
    end if;
    if v_status = 'cancelled' then
      raise exception 'That order is already cancelled.';
    end if;
    if v_status = 'closed' then
      raise exception 'That order is closed. Closed orders are history — nothing left to cancel.';
    end if;

    -- Stock has already moved against this order. Reversing it is the GRN's
    -- job, not the PO's — otherwise cancelling would silently strand stock.
    select count(*) into v_n
    from public.goods_receipts
    where po_id = p_id and voided_at is null;

    if v_n > 0 then
      raise exception
        'This order has % goods receipt(s) recorded. Void the receipt(s) first, then cancel the order.',
        v_n;
    end if;

    select count(*) into v_n
    from public.po_invoices
    where po_id = p_id and voided_at is null;

    if v_n > 0 then
      raise exception
        'This order has % vendor invoice(s) recorded. Void the invoice(s) first, then cancel the order.',
        v_n;
    end if;

    update public.purchase_orders
       set status        = 'cancelled'::po_status,
           cancelled_at  = v_now,
           cancelled_by  = v_me,
           cancel_reason = btrim(p_reason),
           updated_at    = v_now
     where id = p_id;

  -- ----------------------------------------------------- VARIATION ORDER
  elsif p_table = 'variation_orders' then
    select project_id, status::text into v_project, v_status
    from public.variation_orders where id = p_id;

    if v_project is null then
      raise exception 'That variation order no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;
    -- Approving a VO is founder-only (016), so un-approving must be too.
    if v_role <> 'founder' then
      raise exception 'Only the founder may cancel a variation order.'
        using errcode = '42501';
    end if;
    if v_status = 'cancelled' then
      raise exception 'That variation is already cancelled.';
    end if;

    update public.variation_orders
       set status        = 'cancelled'::vo_status,
           cancelled_at  = v_now,
           cancelled_by  = v_me,
           cancel_reason = btrim(p_reason),
           updated_at    = v_now
     where id = p_id;

  else
    raise exception 'fn_cancel_document: % is not a cancellable document', p_table;
  end if;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values (p_table, 'CANCEL', p_id::text,
          jsonb_build_object('status', v_status),
          jsonb_build_object('cancelled_by', v_me, 'cancelled_at', v_now,
                             'cancel_reason', btrim(p_reason)));
end $$;

revoke all on function public.fn_cancel_document(text, uuid, text) from public, anon;
grant execute on function public.fn_cancel_document(text, uuid, text) to authenticated;

comment on function public.fn_cancel_document(text, uuid, text) is
  'The only path to cancelling a PO or VO. Checks role, demands a reason, '
  'refuses a PO that still has live receipts or invoices, logs to audit_log.';


-- ############################################################
-- ###  3. VO REJECTION WITH A REASON
-- ############################################################
-- Rejecting a submitted VO was a bare status flip with no explanation.
create or replace function public.fn_reject_variation(
  p_id     uuid,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_project uuid; v_status text;
begin
  if public.my_role() <> 'founder' then
    raise exception 'Only the founder may reject a variation order.'
      using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to reject a variation.' using errcode = '22023';
  end if;

  select project_id, status::text into v_project, v_status
  from public.variation_orders where id = p_id;

  if v_project is null then
    raise exception 'That variation order no longer exists.';
  end if;
  if v_status <> 'submitted' then
    raise exception 'Only a submitted variation can be rejected. This one is %.', v_status;
  end if;

  update public.variation_orders
     set status        = 'rejected'::vo_status,
         approved_by   = auth.uid(),
         approved_at   = now(),
         cancel_reason = btrim(p_reason),
         updated_at    = now()
   where id = p_id;
end $$;

revoke all on function public.fn_reject_variation(uuid, text) from public, anon;
grant execute on function public.fn_reject_variation(uuid, text) to authenticated;


-- ############################################################
-- ###  4. SUPERVISOR SELF-VOID OF STOCK  (fn_void_record, revised)
-- ############################################################
-- Identical to 020 except the two stock branches also accept a supervisor
-- voiding a row they created themselves. Every other guard is unchanged.
create or replace function public.fn_void_record(
  p_table  text,
  p_id     uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_project uuid;
  v_qty     numeric(12,2);
  v_mat     uuid;
  v_link    uuid;
  v_po      uuid;
  v_now     timestamptz := now();
  v_me      uuid := auth.uid();
  v_n       int;
  v_total   numeric;
  v_all     boolean;
  v_names   text;
  v_owner   uuid;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to void a record.' using errcode = '22023';
  end if;

  v_role := public.my_role();

  -- ---------------------------------------------------------- EXPENSE
  if p_table = 'expenses' then
    if v_role not in ('founder', 'accounts') then
      raise exception 'Only a founder or accounts may void an expense.'
        using errcode = '42501';
    end if;

    select project_id, pc_entry_id into v_project, v_link
    from public.expenses where id = p_id and voided_at is null;
    if v_project is null then
      raise exception 'That expense no longer exists, or is already void.';
    end if;

    if v_link is not null then
      raise exception
        'This expense was created by a petty cash entry. Void the petty cash entry instead — that reverses both.';
    end if;

    if exists (select 1 from public.po_invoices
               where expense_id = p_id and voided_at is null) then
      raise exception
        'This expense was posted from a vendor invoice. Void the invoice instead — that reverses both.';
    end if;

    update public.expenses
       set voided_at = v_now, voided_by = v_me, void_reason = btrim(p_reason)
     where id = p_id;

  -- ---------------------------------------------------- PETTY CASH ENTRY
  elsif p_table = 'petty_cash_entries' then
    if v_role not in ('founder', 'accounts') then
      raise exception 'Only a founder or accounts may void a petty cash entry.'
        using errcode = '42501';
    end if;

    if not exists (select 1 from public.petty_cash_entries
                   where id = p_id and voided_at is null) then
      raise exception 'That petty cash entry no longer exists, or is already void.';
    end if;

    update public.petty_cash_entries
       set voided_at = v_now, voided_by = v_me, void_reason = btrim(p_reason)
     where id = p_id;

    update public.expenses
       set voided_at = v_now, voided_by = v_me,
           void_reason = 'Petty cash entry voided: ' || btrim(p_reason)
     where pc_entry_id = p_id and voided_at is null;

  -- --------------------------------------------------------- MATERIAL IN
  elsif p_table = 'material_inward' then
    select project_id, material_id, qty, grn_line_id, created_by
      into v_project, v_mat, v_qty, v_link, v_owner
    from public.material_inward where id = p_id and voided_at is null;
    if v_project is null then
      raise exception 'That delivery no longer exists, or is already void.';
    end if;

    -- 021: a supervisor may reverse their OWN delivery (they logged it, so
    -- they're the one who mistyped it). Anyone else's still needs founder/pm.
    if not (v_role in ('founder', 'pm')
            or (v_role = 'supervisor' and v_owner = v_me)) then
      raise exception
        'Only a founder or PM can void this delivery — supervisors can only void deliveries they logged themselves.'
        using errcode = '42501';
    end if;

    if v_link is not null then
      raise exception
        'This delivery came from a goods receipt. Void the goods receipt instead — that reverses the whole delivery.';
    end if;

    if public.fn_stock_on_hand(v_project, v_mat) - v_qty < 0 then
      raise exception
        'Voiding this delivery would put stock below zero (% on hand, % delivered). Void the issues that consumed it first.',
        public.fn_stock_on_hand(v_project, v_mat), v_qty;
    end if;

    update public.material_inward
       set voided_at = v_now, voided_by = v_me, void_reason = btrim(p_reason)
     where id = p_id;

  -- -------------------------------------------------------- MATERIAL OUT
  elsif p_table = 'material_issues' then
    select created_by into v_owner
    from public.material_issues where id = p_id and voided_at is null;
    if v_owner is null then
      raise exception 'That issue no longer exists, or is already void.';
    end if;

    if not (v_role in ('founder', 'pm')
            or (v_role = 'supervisor' and v_owner = v_me)) then
      raise exception
        'Only a founder or PM can void this issue — supervisors can only void issues they logged themselves.'
        using errcode = '42501';
    end if;

    -- Voiding an issue only ever returns stock, so no guard is needed.
    update public.material_issues
       set voided_at = v_now, voided_by = v_me, void_reason = btrim(p_reason)
     where id = p_id;

  -- ------------------------------------------------------- GOODS RECEIPT
  elsif p_table = 'goods_receipts' then
    if v_role not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may void a goods receipt.'
        using errcode = '42501';
    end if;

    select g.po_id, po.project_id into v_po, v_project
    from public.goods_receipts g
    join public.purchase_orders po on po.id = g.po_id
    where g.id = p_id and g.voided_at is null;
    if v_po is null then
      raise exception 'That goods receipt no longer exists, or is already void.';
    end if;

    if exists (select 1 from public.po_invoices
               where po_id = v_po and approved = true and voided_at is null) then
      raise exception
        'A vendor invoice has already been posted against this order. Void the invoice first, then the goods receipt.';
    end if;

    select count(*), string_agg(t.name, ', ' order by t.name)
      into v_n, v_names
    from (
      select m.name,
             sum(mi.qty) as reversing,
             public.fn_stock_on_hand(mi.project_id, mi.material_id) as on_hand
      from public.material_inward mi
      join public.grn_lines gl on gl.id = mi.grn_line_id
      join public.materials m on m.id = mi.material_id
      where gl.grn_id = p_id
        and mi.voided_at is null
      group by m.name, mi.project_id, mi.material_id
    ) t
    where t.on_hand - t.reversing < 0;

    if v_n > 0 then
      raise exception
        'Voiding this receipt would put % below zero stock. Void the issues that consumed the delivery first.',
        v_names;
    end if;

    update public.goods_receipts
       set voided_at = v_now, voided_by = v_me, void_reason = btrim(p_reason)
     where id = p_id;

    update public.material_inward mi
       set voided_at = v_now, voided_by = v_me,
           void_reason = 'Goods receipt voided: ' || btrim(p_reason)
      from public.grn_lines gl
     where gl.id = mi.grn_line_id
       and gl.grn_id = p_id
       and mi.voided_at is null;

    select bool_and(coalesce(recv.total, 0) >= pl.qty_ordered),
           coalesce(sum(recv.total), 0)
      into v_all, v_total
    from public.po_lines pl
    left join (
      select gl.po_line_id, sum(gl.qty_received) as total
      from public.grn_lines gl
      join public.goods_receipts g on g.id = gl.grn_id
      join public.po_lines p2 on p2.id = gl.po_line_id
      where p2.po_id = v_po and g.voided_at is null
      group by gl.po_line_id
    ) recv on recv.po_line_id = pl.id
    where pl.po_id = v_po;

    update public.purchase_orders
       set status = (case
                       when coalesce(v_all, false) then 'received'
                       when coalesce(v_total, 0) > 0 then 'receiving'
                       else 'approved'
                     end)::po_status,
           updated_at = now()
     where id = v_po
       and status::text in ('approved', 'receiving', 'received');

  -- ------------------------------------------------------ VENDOR INVOICE
  elsif p_table = 'po_invoices' then
    if v_role not in ('founder', 'accounts') then
      raise exception 'Only a founder or accounts may void a vendor invoice.'
        using errcode = '42501';
    end if;

    select expense_id into v_link
    from public.po_invoices where id = p_id and voided_at is null;
    if not found then
      raise exception 'That invoice no longer exists, or is already void.';
    end if;

    update public.po_invoices
       set voided_at = v_now, voided_by = v_me, void_reason = btrim(p_reason)
     where id = p_id;

    if v_link is not null then
      update public.expenses
         set voided_at = v_now, voided_by = v_me,
             void_reason = 'Vendor invoice voided: ' || btrim(p_reason)
       where id = v_link and voided_at is null;
    end if;

  else
    raise exception 'fn_void_record: % is not a voidable table', p_table;
  end if;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values (p_table, 'VOID', p_id::text, null,
          jsonb_build_object('voided_by', v_me, 'voided_at', v_now,
                             'void_reason', btrim(p_reason)));
end $$;


-- ############################################################
-- ###  5. CANCELLED DOCUMENTS DROP OUT OF THE NUMBERS
-- ############################################################

-- v_project_contract already filters `status = 'approved'` / `'submitted'`, so a
-- cancelled VO falls out on its own and revised_contract_value self-corrects.
-- It is recreated here anyway to add the cancelled roll-up, so the Variations
-- screen can show what was cancelled without the client summing anything.
drop view if exists public.v_project_contract cascade;
create view public.v_project_contract as
select
  p.id as project_id,
  coalesce(p.contract_value, 0)::numeric(14,2)                 as contract_value,
  coalesce(v.approved_value, 0)::numeric(14,2)                 as variations_value,
  coalesce(v.pending_value, 0)::numeric(14,2)                  as pending_value,
  coalesce(v.cancelled_value, 0)::numeric(14,2)                as cancelled_value,
  (coalesce(p.contract_value, 0) + coalesce(v.approved_value, 0))::numeric(14,2)
                                                               as revised_contract_value
from public.projects p
left join (
  select project_id,
         sum(cost_impact) filter (where status::text = 'approved')  as approved_value,
         sum(cost_impact) filter (where status::text = 'submitted') as pending_value,
         sum(cost_impact) filter (where status::text = 'cancelled') as cancelled_value
  from public.variation_orders
  group by project_id
) v on v.project_id = p.id
where public.is_member(p.id)
  and public.my_role() in ('founder', 'pm', 'accounts');
grant select on public.v_project_contract to authenticated;


-- Ordered value: a cancelled PO is not committed spend.
drop view if exists public.v_po_value cascade;
create view public.v_po_value as
select po.id as po_id, po.project_id,
       coalesce(sum(pl.line_total), 0)::numeric(14,2) as ordered_value
from public.purchase_orders po
left join public.po_lines pl on pl.po_id = po.id
where public.is_member(po.project_id)
  and public.my_role() in ('founder', 'pm', 'accounts')
  and po.status::text <> 'cancelled'                    -- <- 021
group by po.id, po.project_id;
grant select on public.v_po_value to authenticated;


-- 3-way match: nothing to match on a cancelled order.
drop view if exists public.v_po_match cascade;
create view public.v_po_match as
with recv as (
  select gl.po_line_id, sum(gl.qty_received) as qty_received
  from public.grn_lines gl
  join public.goods_receipts g on g.id = gl.grn_id
  where g.voided_at is null
  group by gl.po_line_id
),
inv as (
  select il.po_line_id,
         sum(il.qty_invoiced) as qty_invoiced,
         case when sum(il.qty_invoiced) > 0
              then round(sum(il.line_total) / sum(il.qty_invoiced), 2) end as rate_invoiced
  from public.invoice_lines il
  join public.po_invoices pi on pi.id = il.invoice_id
  where pi.voided_at is null
  group by il.po_line_id
)
select
  pl.id      as po_line_id,
  pl.po_id,
  po.project_id,
  pl.material_id,
  pl.qty_ordered,
  pl.rate    as rate_ordered,
  coalesce(r.qty_received, 0) as qty_received,
  coalesce(i.qty_invoiced, 0) as qty_invoiced,
  i.rate_invoiced,
  (case
     when i.qty_invoiced is null then 'pending'
     when abs(coalesce(i.qty_invoiced,0) - coalesce(r.qty_received,0)) > 0.5
          and pl.rate is not null and i.rate_invoiced is not null
          and abs(i.rate_invoiced - pl.rate) > pl.rate * 0.02 then 'both'
     when abs(coalesce(i.qty_invoiced,0) - coalesce(r.qty_received,0)) > 0.5
          then 'qty_variance'
     when pl.rate is not null and i.rate_invoiced is not null
          and abs(i.rate_invoiced - pl.rate) > pl.rate * 0.02 then 'rate_variance'
     else 'ok'
   end)::match_status as match_status
from public.po_lines pl
join public.purchase_orders po on po.id = pl.po_id
left join recv r on r.po_line_id = pl.id
left join inv  i on i.po_line_id = pl.id
where public.is_member(po.project_id)
  and public.my_role() in ('founder', 'pm', 'accounts')
  and po.status::text <> 'cancelled';                   -- <- 021
grant select on public.v_po_match to authenticated;


-- ############################################################
-- ###  6. NOTHING NEW HAPPENS ON A CANCELLED ORDER
-- ############################################################

create or replace function public.fn_receive_goods(
  p_po    uuid,
  p_date  date,
  p_note  text,
  p_lines jsonb
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_project uuid;
  v_status text;
  v_grn uuid;
  v_all_received boolean;
begin
  if auth.uid() is null then
    raise exception 'fn_receive_goods: not authenticated';
  end if;

  select project_id, status::text into v_project, v_status
  from public.purchase_orders where id = p_po;
  if v_project is null then
    raise exception 'fn_receive_goods: PO not found';
  end if;

  if v_status = 'cancelled' then                        -- <- 021
    raise exception 'That order was cancelled — nothing can be received against it.';
  end if;

  if not public.is_member(v_project) then
    raise exception 'fn_receive_goods: not a member' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'fn_receive_goods: role % may not receive', public.my_role()
      using errcode = '42501';
  end if;

  insert into public.goods_receipts (po_id, received_date, note, received_by)
  values (p_po, coalesce(p_date, current_date), p_note, auth.uid())
  returning id into v_grn;

  insert into public.grn_lines (grn_id, po_line_id, qty_received)
  select v_grn, (e->>'po_line_id')::uuid, (e->>'qty')::numeric
  from jsonb_array_elements(p_lines) e
  where coalesce((e->>'qty')::numeric, 0) > 0
    and exists (select 1 from public.po_lines pl
                where pl.id = (e->>'po_line_id')::uuid and pl.po_id = p_po);

  select bool_and(coalesce(recv.total, 0) >= pl.qty_ordered)
    into v_all_received
  from public.po_lines pl
  left join (
    select gl.po_line_id, sum(gl.qty_received) as total
    from public.grn_lines gl
    join public.goods_receipts g on g.id = gl.grn_id
    join public.po_lines p2 on p2.id = gl.po_line_id
    where p2.po_id = p_po
      and g.voided_at is null
    group by gl.po_line_id
  ) recv on recv.po_line_id = pl.id
  where pl.po_id = p_po;

  update public.purchase_orders
     set status = (case when coalesce(v_all_received, false) then 'received'
                        else 'receiving' end)::po_status,
         updated_at = now()
   where id = p_po and status::text in ('approved', 'receiving');

  return v_grn;
end $$;


create or replace function public.fn_post_invoice(p_invoice uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_project uuid; v_vendor uuid; v_vname text; v_net numeric(14,2);
  v_gst numeric(14,2); v_cat int; v_expense uuid; v_invno text;
begin
  if public.my_role() not in ('founder','accounts') then
    raise exception 'fn_post_invoice: only founder/accounts may post invoices'
      using errcode = '42501';
  end if;

  select po.project_id, po.vendor_id, po.vendor_name, pinv.gst_amount, pinv.invoice_no
    into v_project, v_vendor, v_vname, v_gst, v_invno
  from public.po_invoices pinv
  join public.purchase_orders po on po.id = pinv.po_id
  where pinv.id = p_invoice
    and pinv.approved = false
    and pinv.voided_at is null
    and po.status::text <> 'cancelled';                 -- <- 021

  if v_project is null then
    raise exception 'fn_post_invoice: invoice not found, already posted, void, or its order was cancelled';
  end if;

  select coalesce(sum(line_total),0) into v_net
  from public.invoice_lines where invoice_id = p_invoice;

  select m.category_id into v_cat
  from public.invoice_lines il
  join public.po_lines pl on pl.id = il.po_line_id
  join public.materials m on m.id = pl.material_id
  where il.invoice_id = p_invoice and m.category_id is not null
  group by m.category_id order by count(*) desc limit 1;

  insert into public.expenses
    (project_id, category_id, vendor_id, vendor_name, description,
     amount, gst_amount, source, invoice_no)
  values
    (v_project, coalesce(v_cat, 999), v_vendor, v_vname,
     'Procurement invoice ' || coalesce(v_invno,''), v_net, v_gst, 'credit', v_invno)
  returning id into v_expense;

  update public.po_invoices
     set approved = true, approved_by = auth.uid(), expense_id = v_expense
   where id = p_invoice;

  return v_expense;
end $$;


-- ############################################################
-- ###  7. VERIFY
-- ############################################################
-- Expect: fn_cancel_document, fn_reject_variation, fn_stock_on_hand, fn_void_record
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_cancel_document', 'fn_reject_variation',
                  'fn_stock_on_hand', 'fn_void_record')
order by proname;

-- Expect 'cancelled' present.
select enumlabel
from pg_enum
where enumtypid = 'public.vo_status'::regtype
order by enumsortorder;


-- ============================================================
-- MASON OS — Migration 022: hard delete for records with no downstream effect
--
-- Completes the three-mechanism removal design:
--   1. hard delete   — no downstream effect            (THIS FILE)
--   2. void/reverse  — financial + stock rows          (migration 020, 021)
--   3. cancel/reject — workflow documents: PO, VO      (migration 021)
--
-- ---------- WHAT IS DELIBERATELY *NOT* DELETABLE ----------
-- expenses · petty_cash_entries · material_inward · material_issues ·
-- goods_receipts · po_invoices · approved purchase_orders · variation_orders
--
-- These carry money or stock. Deleting one destroys the audit trail on a
-- figure someone will later have to explain, and GST invoices carry a statutory
-- retention requirement. They are VOIDED or CANCELLED instead — the row stays,
-- marked, and stops counting. The founder already has that power on all of them.
--
-- ---------- WHAT IS DELETABLE (founder/pm, reference-checked) ----------
--   tasks               — blocked if another task was rolled over from it
--   site_logs           — nothing references them
--   safety_checklists   — items cascade
--   incidents           — nothing references them
--   documents           — storage object removed by the caller afterwards
--   purchase_orders     — ONLY while status = 'requested' (a draft PR).
--                         Anything approved has a PO number in a vendor's hands,
--                         so it gets cancelled, not deleted.
--   materials           — blocked if any movement or PO line uses it
--   vendors             — blocked if any expense, delivery or PO references it
--   budgets             — figures, but no history: they're a plan, not a record
--
-- ---------- NOT DELETABLE, BY DECISION ----------
-- PROJECTS: every table cascades on project_id, so one click would destroy a
-- whole job's history. Archive instead (status → completed / on_hold), which
-- the Admin → Projects screen already does.
-- USERS: their name is stamped on expenses, tasks and approvals via
-- created_by / raised_by / approved_by. Deactivate instead (already built), so
-- history still says who did what.
--
-- ---------- HOW IT'S ENFORCED ----------
-- No DELETE policies are added. RLS is default-deny, so with no policy the
-- client simply cannot delete these tables — the ONLY route is
-- fn_delete_record(), which is SECURITY DEFINER and does the role check and the
-- reference checks itself. Same shape as fn_void_record / fn_cancel_document.
--
-- The one exception is `documents`, which has carried a docs_delete policy
-- since 003. It's left in place (a user removing their own upload is harmless)
-- and the RPC works alongside it.
--
-- Re-runnable: create-or-replace only.
-- ============================================================


-- ############################################################
-- ###  fn_delete_record — the only route to a hard delete
-- ############################################################
create or replace function public.fn_delete_record(
  p_table text,
  p_id    uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_project uuid;
  v_status  text;
  v_n       int;
  v_name    text;
  v_me      uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  v_role := public.my_role();

  -- Coarse gate. Each branch then applies its own rule, because they differ:
  -- site/procurement records are founder/pm, budgets are founder/accounts
  -- (matching budgets_write in 002).
  if v_role not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot delete records.' using errcode = '42501';
  end if;

  -- Site and procurement records: founder/pm. Listed explicitly rather than
  -- "everything except budgets", so the not-deletable branches below still
  -- reach an accounts user with their own, more useful message ("void it
  -- instead") rather than a role refusal.
  if p_table in ('tasks', 'site_logs', 'safety_checklists', 'incidents',
                 'documents', 'purchase_orders', 'materials', 'vendors')
     and v_role not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may delete this record.'
      using errcode = '42501';
  end if;

  -- ------------------------------------------------------------- TASK
  if p_table = 'tasks' then
    select project_id into v_project from public.tasks where id = p_id;
    if v_project is null then
      raise exception 'That task no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    -- The rollover chain is history: deleting a link would orphan the tail.
    select count(*) into v_n from public.tasks where rolled_from = p_id;
    if v_n > 0 then
      raise exception
        'This task was rolled over to a later day (% follow-on task(s)). Delete those first.', v_n;
    end if;

    delete from public.tasks where id = p_id;

  -- --------------------------------------------------------- SITE LOG
  elsif p_table = 'site_logs' then
    select project_id into v_project from public.site_logs where id = p_id;
    if v_project is null then
      raise exception 'That site log no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    delete from public.site_logs where id = p_id;

  -- ------------------------------------------------- SAFETY CHECKLIST
  elsif p_table = 'safety_checklists' then
    select project_id into v_project from public.safety_checklists where id = p_id;
    if v_project is null then
      raise exception 'That checklist no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    -- safety_checklist_items has ON DELETE CASCADE (011).
    delete from public.safety_checklists where id = p_id;

  -- ----------------------------------------------------------- INCIDENT
  elsif p_table = 'incidents' then
    select project_id into v_project from public.incidents where id = p_id;
    if v_project is null then
      raise exception 'That incident no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    delete from public.incidents where id = p_id;

  -- ----------------------------------------------------------- DOCUMENT
  elsif p_table = 'documents' then
    select project_id into v_project from public.documents where id = p_id;
    if v_project is null then
      raise exception 'That document no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    delete from public.documents where id = p_id;

  -- ------------------------------------------------- DRAFT PURCHASE REQUEST
  elsif p_table = 'purchase_orders' then
    select project_id, status::text into v_project, v_status
    from public.purchase_orders where id = p_id;

    if v_project is null then
      raise exception 'That request no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    -- Once approved it has a PO number a vendor may already hold. Cancel it.
    if v_status <> 'requested' then
      raise exception
        'Only a draft request can be deleted. This one is % — cancel it instead, so it keeps its number and stays on record.',
        v_status;
    end if;

    -- Belt and braces: a requested PO should have neither, but never assume.
    select count(*) into v_n from public.goods_receipts where po_id = p_id;
    if v_n > 0 then
      raise exception 'This request already has goods receipts against it. Void those first.';
    end if;
    select count(*) into v_n from public.po_invoices where po_id = p_id;
    if v_n > 0 then
      raise exception 'This request already has invoices against it. Void those first.';
    end if;

    -- po_lines has ON DELETE CASCADE (012).
    delete from public.purchase_orders where id = p_id;

  -- ----------------------------------------------------------- MATERIAL
  elsif p_table = 'materials' then
    select name into v_name from public.materials where id = p_id;
    if v_name is null then
      raise exception 'That material no longer exists.';
    end if;

    select (select count(*) from public.material_inward where material_id = p_id)
         + (select count(*) from public.material_issues where material_id = p_id)
         + (select count(*) from public.po_lines       where material_id = p_id)
      into v_n;

    if v_n > 0 then
      raise exception
        '% is used by % record(s) — deliveries, issues or order lines. Deactivate it instead so it stops appearing in pickers.',
        v_name, v_n;
    end if;

    delete from public.materials where id = p_id;

  -- ------------------------------------------------------------- VENDOR
  elsif p_table = 'vendors' then
    select name into v_name from public.vendors where id = p_id;
    if v_name is null then
      raise exception 'That vendor no longer exists.';
    end if;

    select (select count(*) from public.expenses         where vendor_id = p_id)
         + (select count(*) from public.material_inward  where vendor_id = p_id)
         + (select count(*) from public.purchase_orders  where vendor_id = p_id)
      into v_n;

    if v_n > 0 then
      raise exception
        '% is linked to % record(s) — expenses, deliveries or orders. Deactivate it instead so it stops appearing in pickers.',
        v_name, v_n;
    end if;

    delete from public.vendors where id = p_id;

  -- ------------------------------------------------------------- BUDGET
  elsif p_table = 'budgets' then
    select project_id into v_project from public.budgets where id = p_id;
    if v_project is null then
      raise exception 'That budget line no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;
    -- budgets_write is founder/accounts (002); keep delete consistent with it.
    if v_role not in ('founder', 'accounts') then
      raise exception 'Only a founder or accounts may remove a budget line.'
        using errcode = '42501';
    end if;

    delete from public.budgets where id = p_id;

  -- --------------------------------------------- NOT DELETABLE, ON PURPOSE
  elsif p_table in ('expenses', 'petty_cash_entries', 'material_inward',
                    'material_issues', 'goods_receipts', 'po_invoices') then
    raise exception
      'A % carries money or stock and is never deleted — void it instead. The row stays on record, marked VOID, and stops counting.',
      p_table;

  elsif p_table = 'variation_orders' then
    raise exception
      'A variation order changes the contract value and is never deleted — cancel it instead.';

  elsif p_table = 'projects' then
    raise exception
      'Projects are never deleted — every record hangs off them. Set the project to Completed or On hold on the Manage screen instead.';

  elsif p_table = 'profiles' then
    raise exception
      'People are never deleted — their name is on the records they raised. Deactivate them on the Manage screen instead.';

  else
    raise exception 'fn_delete_record: % is not a deletable table', p_table;
  end if;

  -- The per-table fn_audit() DELETE triggers already captured old_data. This
  -- row makes deletions greppable as one action, alongside VOID and CANCEL.
  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values (p_table, 'DELETE_HARD', p_id::text,
          jsonb_build_object('deleted_by', v_me, 'deleted_at', now()), null);
end $$;

revoke all on function public.fn_delete_record(text, uuid) from public, anon;
grant execute on function public.fn_delete_record(text, uuid) to authenticated;

comment on function public.fn_delete_record(text, uuid) is
  'The only route to a hard delete. Founder/PM, reference-checked, refuses '
  'money/stock rows (void those) and workflow documents (cancel those). '
  'No DELETE policies exist on these tables, so this cannot be bypassed.';


-- ############################################################
-- ###  AUDIT COVERAGE FOR THE NEWLY DELETABLE TABLES
-- ############################################################
-- A delete must leave a trail. tasks, site_logs, documents, materials, vendors
-- and purchase_orders already carry fn_audit triggers (001, 003, 012, 018);
-- the safety tables did not have full coverage.
drop trigger if exists audit_incidents_all on public.incidents;
create trigger audit_incidents_all
  after insert or update or delete on public.incidents
  for each row execute function public.fn_audit();

drop trigger if exists audit_safety_checklists_all on public.safety_checklists;
create trigger audit_safety_checklists_all
  after insert or update or delete on public.safety_checklists
  for each row execute function public.fn_audit();

drop trigger if exists audit_budgets_all on public.budgets;
create trigger audit_budgets_all
  after insert or update or delete on public.budgets
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  VERIFY
-- ############################################################
-- Expect all four removal functions.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_delete_record', 'fn_cancel_document',
                  'fn_void_record', 'fn_stock_on_hand')
order by proname;
