-- ============================================================
-- MASON OS — Migration 015: fn_receive_goods (GRN in one call)
--
-- A goods receipt is a supervisor action, but flipping the PO's status
-- (approved → receiving → received) is an UPDATE on purchase_orders, which
-- po_update restricts to founder/pm. Rather than loosen that policy, this
-- security-definer function does the whole receipt atomically and checks the
-- receiver's membership + role itself (founder/pm/supervisor) — the same
-- pattern as rollover_tasks / fn_post_invoice.
--
-- Inserting grn_lines fires fn_grn_to_inward (012), so stock updates as a
-- side effect. Idempotent: create-or-replace.
-- ============================================================

create or replace function public.fn_receive_goods(
  p_po    uuid,
  p_date  date,
  p_note  text,
  p_lines jsonb            -- [{ "po_line_id": uuid, "qty": number }, ...]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_grn uuid;
  v_all_received boolean;
begin
  if auth.uid() is null then
    raise exception 'fn_receive_goods: not authenticated';
  end if;

  select project_id into v_project from public.purchase_orders where id = p_po;
  if v_project is null then
    raise exception 'fn_receive_goods: PO not found';
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

  -- Each row fires fn_grn_to_inward → material_inward (stock).
  insert into public.grn_lines (grn_id, po_line_id, qty_received)
  select v_grn, (e->>'po_line_id')::uuid, (e->>'qty')::numeric
  from jsonb_array_elements(p_lines) e
  where coalesce((e->>'qty')::numeric, 0) > 0
    and exists (select 1 from public.po_lines pl
                where pl.id = (e->>'po_line_id')::uuid and pl.po_id = p_po);

  -- Fully received on every line?
  select bool_and(coalesce(recv.total, 0) >= pl.qty_ordered)
    into v_all_received
  from public.po_lines pl
  left join (
    select gl.po_line_id, sum(gl.qty_received) as total
    from public.grn_lines gl
    join public.po_lines p2 on p2.id = gl.po_line_id
    where p2.po_id = p_po
    group by gl.po_line_id
  ) recv on recv.po_line_id = pl.id
  where pl.po_id = p_po;

  update public.purchase_orders
     set status = (case when coalesce(v_all_received, false) then 'received'
                        else 'receiving' end)::po_status,
         updated_at = now()
   where id = p_po and status in ('approved', 'receiving');

  return v_grn;
end $$;

revoke all on function public.fn_receive_goods(uuid, date, text, jsonb) from public, anon;
grant execute on function public.fn_receive_goods(uuid, date, text, jsonb) to authenticated;
