-- ============================================================
-- MASON OS — Migration 017: flexible vendor entry
--
-- Every vendor reference keeps an optional vendor_id link PLUS a free-text
-- vendor_name. Pick a registered vendor → id set, name mirrors it. Type an
-- unknown name → id null, free text kept. "Save to vendor list" registers it
-- and back-links every record that used that name.
--
-- Columns added to: expenses, purchase_orders, material_inward.
-- po_invoices derives its vendor from the PO, so fn_post_invoice is updated to
-- copy the PO's vendor_name onto the posted expense.
--
-- Idempotent: add-column-if-not-exists, create-or-replace.
-- ============================================================

alter table public.expenses         add column if not exists vendor_name text;
alter table public.purchase_orders  add column if not exists vendor_name text;
alter table public.material_inward   add column if not exists vendor_name text;

-- ---------- UNREGISTERED VENDORS ----------
-- Distinct free-text names in use that aren't yet a registered vendor, with a
-- usage count. Owner-run but gated to money-roles (it aggregates expense data),
-- so supervisors get nothing.
create or replace view public.v_unregistered_vendors as
with used as (
  select vendor_name from public.expenses
    where vendor_id is null and coalesce(trim(vendor_name), '') <> ''
  union all
  select vendor_name from public.purchase_orders
    where vendor_id is null and coalesce(trim(vendor_name), '') <> ''
  union all
  select vendor_name from public.material_inward
    where vendor_id is null and coalesce(trim(vendor_name), '') <> ''
)
select trim(vendor_name) as vendor_name, count(*)::int as uses
from used
where not exists (
        select 1 from public.vendors v
        where lower(v.name) = lower(trim(used.vendor_name))
      )
  and public.my_role() in ('founder', 'pm', 'accounts')
group by trim(vendor_name)
order by count(*) desc, trim(vendor_name);

grant select on public.v_unregistered_vendors to authenticated;

-- ---------- REGISTER A FREE-TEXT VENDOR + BACK-LINK ----------
-- Creates the vendor (or reuses an existing name match) and links every
-- expense / PO / inward that used that free-text name. security definer so it
-- can update rows the caller doesn't own; checks role itself.
create or replace function public.fn_register_vendor(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text := trim(p_name);
begin
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'fn_register_vendor: not permitted' using errcode = '42501';
  end if;
  if coalesce(v_name, '') = '' then
    raise exception 'fn_register_vendor: empty name';
  end if;

  select id into v_id from public.vendors
   where lower(name) = lower(v_name) limit 1;
  if v_id is null then
    insert into public.vendors (name) values (v_name) returning id into v_id;
  end if;

  update public.expenses set vendor_id = v_id
   where vendor_id is null and lower(trim(vendor_name)) = lower(v_name);
  update public.purchase_orders set vendor_id = v_id
   where vendor_id is null and lower(trim(vendor_name)) = lower(v_name);
  update public.material_inward set vendor_id = v_id
   where vendor_id is null and lower(trim(vendor_name)) = lower(v_name);

  return v_id;
end $$;

revoke all on function public.fn_register_vendor(text) from public, anon;
grant execute on function public.fn_register_vendor(text) to authenticated;

-- ---------- fn_post_invoice: carry the vendor NAME onto the expense ----------
-- Same as 012, plus vendor_name so a procurement invoice for a free-text vendor
-- still shows a vendor in the ledger.
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
  where pinv.id = p_invoice and pinv.approved = false;

  if v_project is null then
    raise exception 'fn_post_invoice: invoice not found or already posted';
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
