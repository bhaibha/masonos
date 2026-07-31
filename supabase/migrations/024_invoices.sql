-- ============================================================
-- MASON OS — Migration 024: A4 Invoice Generator (Module 15)
--
-- Three documents, one table, all figures computed in Postgres:
--   1. progress        — running account bill to the client
--   2. management_fee  — fee % on certified spend
--   3. vendor_voucher  — payment voucher for a vendor's posted invoices
--
-- ---------- WHY THE AMOUNTS ARE STORED, NOT DERIVED ON READ ----------
-- Every other money figure in this app is computed live by a view, because it
-- should always reflect current data. An invoice is the opposite: it is a
-- SNAPSHOT. Once issued to a client it must never change, even though the
-- expenses behind it keep accumulating. So fn_issue_invoice computes the
-- figures server-side ONCE, at issue time, and writes them down.
-- The browser still computes nothing — it only prints what the RPC stored.
--
-- ---------- GST TREATMENT — CONFIRM WITH YOUR CA ----------
-- The progress bill is modelled as cost-plus:
--   • reimbursable cost for the period is billed GROSS (what was actually
--     spent, tax included) with NO further GST added — the tax was already
--     borne on those purchases;
--   • the management fee is billed on the NET spend, and GST applies to the
--     fee only.
-- That avoids charging tax on tax. It is a common structure for a cost-plus
-- contract, but it is a TAX POSITION, not a technical one. Have it confirmed
-- before the first real bill goes to a client. Changing it later means a new
-- migration, not a code edit, because issued invoices are immutable.
--
-- ---------- NUMBERING ----------
-- A separate series per type, as required: INV-P-0001 / INV-M-0001 /
-- INV-V-0001. Assigned inside the RPC because the prefix depends on the type.
--
-- ---------- REMOVAL ----------
-- An invoice is a workflow document: it CANCELS, never deletes, and the PDF
-- prints a VOID watermark once cancelled. fn_cancel_document gains an
-- 'invoices' branch so PO, VO, SI and invoices share one cancellation path.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. TYPES, SEQUENCES, TABLES
-- ############################################################

do $$ begin
  create type invoice_type as enum ('progress', 'management_fee', 'vendor_voucher');
exception when duplicate_object then null; end $$;

do $$ begin
  create type invoice_status as enum ('issued', 'cancelled');
exception when duplicate_object then null; end $$;

create sequence if not exists public.invoice_p_seq;
create sequence if not exists public.invoice_m_seq;
create sequence if not exists public.invoice_v_seq;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  project_id uuid not null references public.projects(id) on delete cascade,
  inv_type invoice_type not null,
  status invoice_status not null default 'issued',

  invoice_date date not null default current_date,
  period_from date,
  period_to date,

  -- vendor voucher only
  vendor_id uuid references public.vendors(id),
  vendor_name text,

  -- Snapshot figures, written once by fn_issue_invoice. Never recomputed.
  subtotal   numeric(14,2) not null default 0,
  gst_pct    numeric(5,2)  not null default 0,
  gst_amount numeric(14,2) not null default 0,
  total      numeric(14,2) generated always as (subtotal + gst_amount) stored,

  notes text,

  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancel_reason text,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists invoices_project_idx
  on public.invoices (project_id, invoice_date desc);

create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  sort int not null default 0,
  description text not null,
  qty  numeric(12,2) not null default 1,
  unit text,
  rate numeric(14,2) not null default 0,
  amount numeric(14,2) generated always as (round(qty * rate, 2)) stored
);
create index if not exists invoice_items_inv_idx on public.invoice_items (invoice_id, sort);

-- Same cancellation contract as PO / VO / SI (021, 023).
alter table public.invoices drop constraint if exists invoices_cancel_ck;
alter table public.invoices add constraint invoices_cancel_ck check (
  status::text <> 'cancelled'
  or (cancelled_at is not null
      and cancelled_by is not null
      and coalesce(btrim(cancel_reason), '') <> '')
);


-- ############################################################
-- ###  2. RLS — founder / accounts only, on both tables
-- ############################################################
alter table public.invoices      enable row level security;
alter table public.invoice_items enable row level security;

drop policy if exists inv_read on public.invoices;
create policy inv_read on public.invoices for select to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'accounts'));

-- INSERT/UPDATE go through fn_issue_invoice and fn_cancel_document, both
-- SECURITY DEFINER. No write policy exists, so RLS default-deny means the
-- client cannot forge an invoice or edit an issued one's figures.

drop policy if exists inv_items_read on public.invoice_items;
create policy inv_items_read on public.invoice_items for select to authenticated
  using (exists (select 1 from public.invoices i
                 where i.id = invoice_id
                   and public.is_member(i.project_id)
                   and public.my_role() in ('founder', 'accounts')));


-- ############################################################
-- ###  3. AUDIT
-- ############################################################
drop trigger if exists audit_invoices on public.invoices;
create trigger audit_invoices
  after insert or update or delete on public.invoices
  for each row execute function public.fn_audit();

drop trigger if exists audit_invoice_items on public.invoice_items;
create trigger audit_invoice_items
  after insert or update or delete on public.invoice_items
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  4. fn_issue_invoice — the only way an invoice is created
-- ############################################################
create or replace function public.fn_issue_invoice(
  p_project  uuid,
  p_type     text,
  p_from     date,
  p_to       date,
  p_vendor   uuid    default null,
  p_gst_pct  numeric default 18,
  p_notes    text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id       uuid;
  v_number   text;
  v_role     text;
  v_fee_pct  numeric(5,2);
  v_net      numeric(14,2);
  v_gross    numeric(14,2);
  v_fee      numeric(14,2);
  v_prev     numeric(14,2);
  v_subtotal numeric(14,2) := 0;
  v_gst      numeric(14,2) := 0;
  v_vname    text;
  v_n        int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  v_role := public.my_role();
  if v_role not in ('founder', 'accounts') then
    raise exception 'Only a founder or accounts may issue an invoice.'
      using errcode = '42501';
  end if;
  if not public.is_member(p_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if p_type not in ('progress', 'management_fee', 'vendor_voucher') then
    raise exception 'Unknown invoice type: %', p_type;
  end if;
  if p_from is null or p_to is null then
    raise exception 'A billing period (from and to) is required.';
  end if;
  if p_to < p_from then
    raise exception 'The period ends before it starts.';
  end if;

  -- Certified spend for the period. fn_expense_total already excludes voided
  -- expenses (020), so a reversed cost can never reach a client bill.
  select total_amount, total_with_gst
    into v_net, v_gross
  from public.fn_expense_total(p_project, p_from, p_to, null, null);

  v_net   := coalesce(v_net, 0);
  v_gross := coalesce(v_gross, 0);

  select coalesce(management_fee_pct, 0) into v_fee_pct
  from public.projects where id = p_project;

  -- ------------------------------------------------------------ NUMBER
  v_number := case p_type
    when 'progress'       then 'INV-P-' || lpad(nextval('public.invoice_p_seq')::text, 4, '0')
    when 'management_fee' then 'INV-M-' || lpad(nextval('public.invoice_m_seq')::text, 4, '0')
    else                       'INV-V-' || lpad(nextval('public.invoice_v_seq')::text, 4, '0')
  end;

  if p_type = 'vendor_voucher' then
    if p_vendor is null then
      raise exception 'A vendor payment voucher needs a vendor.';
    end if;
    select name into v_vname from public.vendors where id = p_vendor;
  end if;

  insert into public.invoices
    (invoice_number, project_id, inv_type, period_from, period_to,
     vendor_id, vendor_name, gst_pct, notes)
  values
    (v_number, p_project, p_type::invoice_type, p_from, p_to,
     p_vendor, v_vname, coalesce(p_gst_pct, 0), p_notes)
  returning id into v_id;

  -- ---------------------------------------------------------- PROGRESS
  -- Cost-plus running account bill. See the GST note in the file header.
  if p_type = 'progress' then
    v_fee := round(v_net * v_fee_pct / 100.0, 2);

    insert into public.invoice_items (invoice_id, sort, description, qty, unit, rate)
    values (v_id, 1,
            'Reimbursable cost of works for the period (tax inclusive)',
            1, 'lot', v_gross);

    if v_fee_pct > 0 then
      insert into public.invoice_items (invoice_id, sort, description, qty, unit, rate)
      values (v_id, 2,
              'Management fee @ ' || trim(to_char(v_fee_pct, 'FM990.99')) ||
              '% on net cost of ' || trim(to_char(v_net, 'FM999999999.00')),
              1, 'lot', v_fee);
    end if;

    -- Everything already billed on earlier, still-live progress invoices.
    select coalesce(sum(total), 0) into v_prev
    from public.invoices
    where project_id = p_project
      and inv_type = 'progress'
      and status::text <> 'cancelled'
      and id <> v_id;

    if v_prev > 0 then
      insert into public.invoice_items (invoice_id, sort, description, qty, unit, rate)
      values (v_id, 3, 'Less: previously billed on this project', 1, 'lot', -v_prev);
    end if;

    -- GST on the fee only — the reimbursable portion already bore its tax.
    v_gst := round(v_fee * coalesce(p_gst_pct, 0) / 100.0, 2);

  -- ---------------------------------------------------- MANAGEMENT FEE
  elsif p_type = 'management_fee' then
    if v_fee_pct <= 0 then
      raise exception
        'This project has no management fee percentage set. Add one on Manage → Projects first.';
    end if;
    v_fee := round(v_net * v_fee_pct / 100.0, 2);

    insert into public.invoice_items (invoice_id, sort, description, qty, unit, rate)
    values (v_id, 1,
            'Management fee @ ' || trim(to_char(v_fee_pct, 'FM990.99')) ||
            '% on certified spend of ' || trim(to_char(v_net, 'FM999999999.00')) ||
            ' for the period',
            1, 'lot', v_fee);

    v_gst := round(v_fee * coalesce(p_gst_pct, 0) / 100.0, 2);

  -- --------------------------------------------------- VENDOR VOUCHER
  -- One line per posted, non-voided vendor invoice in the period. The GST is
  -- whatever the vendor actually charged — no rate is applied on top.
  else
    insert into public.invoice_items (invoice_id, sort, description, qty, unit, rate)
    select v_id,
           row_number() over (order by pinv.invoice_date, pinv.invoice_no),
           'Invoice ' || coalesce(pinv.invoice_no, '(no number)') ||
             ' dated ' || to_char(pinv.invoice_date, 'DD Mon YYYY') ||
             ' · ' || po.po_number,
           1, 'lot',
           coalesce((select sum(il.line_total) from public.invoice_lines il
                     where il.invoice_id = pinv.id), 0)
    from public.po_invoices pinv
    join public.purchase_orders po on po.id = pinv.po_id
    where po.project_id = p_project
      and po.vendor_id = p_vendor
      and pinv.approved = true
      and pinv.voided_at is null
      and pinv.invoice_date between p_from and p_to;

    select count(*) into v_n from public.invoice_items where invoice_id = v_id;
    if v_n = 0 then
      -- Nothing to pay: remove the shell rather than leaving an empty voucher
      -- (and burning a number on nothing).
      delete from public.invoices where id = v_id;
      raise exception
        'No posted, un-voided invoices for that vendor between % and %.', p_from, p_to;
    end if;

    select coalesce(sum(pinv.gst_amount), 0) into v_gst
    from public.po_invoices pinv
    join public.purchase_orders po on po.id = pinv.po_id
    where po.project_id = p_project
      and po.vendor_id = p_vendor
      and pinv.approved = true
      and pinv.voided_at is null
      and pinv.invoice_date between p_from and p_to;
  end if;

  -- Subtotal is summed from the stored line amounts, so the header can never
  -- disagree with the lines printed underneath it.
  select coalesce(sum(amount), 0) into v_subtotal
  from public.invoice_items where invoice_id = v_id;

  update public.invoices
     set subtotal = v_subtotal, gst_amount = v_gst
   where id = v_id;

  return v_id;
end $$;

revoke all on function public.fn_issue_invoice(uuid, text, date, date, uuid, numeric, text)
  from public, anon;
grant execute on function public.fn_issue_invoice(uuid, text, date, date, uuid, numeric, text)
  to authenticated;

comment on function public.fn_issue_invoice(uuid, text, date, date, uuid, numeric, text) is
  'The only way an invoice is created. Computes every figure server-side from '
  'expenses / projects / po_invoices and writes them down as an immutable '
  'snapshot. No write policy exists on invoices, so this cannot be bypassed.';


-- ############################################################
-- ###  5. CANCELLATION — extend the shared RPC for invoices
-- ############################################################
create or replace function public.fn_cancel_document(
  p_table  text,
  p_id     uuid,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_role text; v_project uuid; v_status text;
  v_now timestamptz := now(); v_me uuid := auth.uid(); v_n int;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to cancel a document.' using errcode = '22023';
  end if;

  v_role := public.my_role();

  if p_table = 'purchase_orders' then
    select project_id, status::text into v_project, v_status
    from public.purchase_orders where id = p_id;
    if v_project is null then raise exception 'That purchase order no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may cancel a purchase order.' using errcode = '42501'; end if;
    if v_status = 'cancelled' then raise exception 'That order is already cancelled.'; end if;
    if v_status = 'closed' then
      raise exception 'That order is closed. Closed orders are history — nothing left to cancel.'; end if;

    select count(*) into v_n from public.goods_receipts
    where po_id = p_id and voided_at is null;
    if v_n > 0 then
      raise exception
        'This order has % goods receipt(s) recorded. Void the receipt(s) first, then cancel the order.', v_n; end if;

    select count(*) into v_n from public.po_invoices
    where po_id = p_id and voided_at is null;
    if v_n > 0 then
      raise exception
        'This order has % vendor invoice(s) recorded. Void the invoice(s) first, then cancel the order.', v_n; end if;

    update public.purchase_orders
       set status = 'cancelled'::po_status, cancelled_at = v_now, cancelled_by = v_me,
           cancel_reason = btrim(p_reason), updated_at = v_now
     where id = p_id;

  elsif p_table = 'variation_orders' then
    select project_id, status::text into v_project, v_status
    from public.variation_orders where id = p_id;
    if v_project is null then raise exception 'That variation order no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role <> 'founder' then
      raise exception 'Only the founder may cancel a variation order.' using errcode = '42501'; end if;
    if v_status = 'cancelled' then raise exception 'That variation is already cancelled.'; end if;

    update public.variation_orders
       set status = 'cancelled'::vo_status, cancelled_at = v_now, cancelled_by = v_me,
           cancel_reason = btrim(p_reason), updated_at = v_now
     where id = p_id;

  elsif p_table = 'site_instructions' then
    select project_id, status::text into v_project, v_status
    from public.site_instructions where id = p_id;
    if v_project is null then raise exception 'That site instruction no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may cancel a site instruction.' using errcode = '42501'; end if;
    if v_status = 'cancelled' then raise exception 'That instruction is already cancelled.'; end if;
    if v_status = 'complete' then
      raise exception
        'That instruction is already marked complete — the work was done. Cancelling it now would misrepresent the record.'; end if;

    update public.site_instructions
       set status = 'cancelled'::si_status, cancelled_at = v_now, cancelled_by = v_me,
           cancel_reason = btrim(p_reason), updated_at = v_now
     where id = p_id;

  -- ------------------------------------------------------------ INVOICE
  elsif p_table = 'invoices' then
    select project_id, status::text into v_project, v_status
    from public.invoices where id = p_id;
    if v_project is null then raise exception 'That invoice no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role not in ('founder', 'accounts') then
      raise exception 'Only a founder or accounts may cancel an invoice.' using errcode = '42501'; end if;
    if v_status = 'cancelled' then raise exception 'That invoice is already cancelled.'; end if;

    update public.invoices
       set status = 'cancelled'::invoice_status, cancelled_at = v_now,
           cancelled_by = v_me, cancel_reason = btrim(p_reason)
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


-- ############################################################
-- ###  6. VERIFY
-- ############################################################
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_issue_invoice', 'fn_cancel_document')
order by proname;

select unnest(enum_range(null::invoice_type))::text as invoice_types;
