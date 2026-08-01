-- ============================================================
-- MASON OS — Migration 026: A7 RFI Management (Module 57)
--
-- A Request For Information raised to the design consultant or architect:
-- a question that blocks work, with a required-by date, and the answer when it
-- comes back. The point of the module is the CLOCK — an unanswered RFI past its
-- required-by date is what stops a slab getting poured.
--
-- ---------- SHAPE MIRRORS SITE INSTRUCTIONS (023) ----------
-- Same addressed-to pattern (linked vendor OR free text — an architect is
-- rarely in the vendor master), same attachments-in-site-photos approach, same
-- cancellation contract. Deliberately so: they are the same kind of object
-- travelling in opposite directions. An SI tells a contractor what to do; an
-- RFI asks a consultant what to do.
--
-- ---------- NO MONEY, SO SUPERVISORS READ IT ----------
-- An RFI carries no figures at all, so `rfi_read` is plain is_member() with no
-- role check. Supervisors are usually the ones who discover the clash, and they
-- need to see whether an answer has landed before they proceed.
-- If an answer turns out to carry cost, that goes on a VO and then an SI — this
-- table never holds an amount.
--
-- ---------- CANCELLATION ----------
-- ROADMAP required `cancelled` + reason from day one rather than retrofitted.
-- fn_cancel_document gains an 'rfis' branch, so PO, VO, SI, invoices and RFIs
-- all cancel through one function with one CHECK-enforced reason.
--
-- ---------- ENUM SAFETY ----------
-- rfi_status and rfi_category are BRAND NEW types, so 021's "unsafe use of new
-- value" trap does not apply. Comparisons still use ::text for consistency.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. TYPES, SEQUENCE, TABLE
-- ############################################################

do $$ begin
  create type rfi_status as enum ('open', 'answered', 'closed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type rfi_category as enum
    ('design', 'structural', 'mep', 'finishes', 'other');
exception when duplicate_object then null; end $$;

create sequence if not exists public.rfi_number_seq;

create table if not exists public.rfis (
  id uuid primary key default gen_random_uuid(),
  rfi_number text not null unique
    default 'RFI-' || lpad(nextval('public.rfi_number_seq')::text, 4, '0'),
  project_id uuid not null references public.projects(id) on delete cascade,
  raised_date date not null default current_date,

  -- Addressed to the consultant: linked if they happen to be in the vendor
  -- master, free text otherwise. Same pattern as 017/023 — an architect is
  -- rarely a registered vendor, and blocking an RFI on registering one would
  -- mean the question doesn't get asked.
  vendor_id uuid references public.vendors(id),
  addressed_to text,

  category rfi_category not null default 'design',
  question text not null,
  attachments text[] not null default '{}',
  required_by date,

  -- The answer, when it comes.
  response text,
  response_date date,
  responded_by uuid references public.profiles(id),

  status rfi_status not null default 'open',

  raised_by uuid not null default auth.uid() references public.profiles(id),
  closed_at timestamptz,

  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancel_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rfi_project_idx
  on public.rfis (project_id, raised_date desc);
-- The index that matters: what's still waiting, soonest deadline first.
create index if not exists rfi_open_idx
  on public.rfis (project_id, required_by)
  where status in ('open', 'answered');

alter table public.rfis drop constraint if exists rfis_cancel_ck;
alter table public.rfis add constraint rfis_cancel_ck check (
  status::text <> 'cancelled'
  or (cancelled_at is not null
      and cancelled_by is not null
      and coalesce(btrim(cancel_reason), '') <> '')
);

-- An RFI with nobody to ask is not an RFI.
alter table public.rfis drop constraint if exists rfis_addressee_ck;
alter table public.rfis add constraint rfis_addressee_ck check (
  vendor_id is not null or coalesce(btrim(addressed_to), '') <> ''
);

-- 'answered' and 'closed' both require the answer to actually be there.
-- Enforced in the database, not just the form, so the status can never claim
-- something the record doesn't contain.
alter table public.rfis drop constraint if exists rfis_answer_ck;
alter table public.rfis add constraint rfis_answer_ck check (
  status::text not in ('answered', 'closed')
  or (coalesce(btrim(response), '') <> '' and response_date is not null)
);


-- ############################################################
-- ###  2. RLS
-- ############################################################
alter table public.rfis enable row level security;

-- Every project member reads, supervisors included — they're often the ones who
-- found the problem, and they need to know whether an answer has arrived.
-- Safe: the table holds no figures.
drop policy if exists rfi_read on public.rfis;
create policy rfi_read on public.rfis for select to authenticated
  using (public.is_member(project_id));

drop policy if exists rfi_insert on public.rfis;
create policy rfi_insert on public.rfis for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm'));

-- Cancellation still has to go through fn_cancel_document — the CHECK above is
-- what enforces that, since a client UPDATE cannot set cancelled_by honestly.
drop policy if exists rfi_update on public.rfis;
create policy rfi_update on public.rfis for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm'))
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm'));

-- No DELETE policy: an RFI is cancelled, never deleted.


-- ############################################################
-- ###  3. AUDIT
-- ############################################################
drop trigger if exists audit_rfis on public.rfis;
create trigger audit_rfis
  after insert or update or delete on public.rfis
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  4. RECORDING THE ANSWER
-- ############################################################
-- Response text, date, who logged it and the status move happen in ONE
-- statement, so the record can never say "answered" while the answer is blank.
create or replace function public.fn_answer_rfi(
  p_id       uuid,
  p_response text,
  p_date     date
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_project uuid; v_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_response), '') = '' then
    raise exception 'Record what the consultant actually said — the answer cannot be blank.'
      using errcode = '22023';
  end if;

  select project_id, status::text into v_project, v_status
  from public.rfis where id = p_id;

  if v_project is null then
    raise exception 'That RFI no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may record an RFI response.'
      using errcode = '42501';
  end if;
  if v_status = 'cancelled' then
    raise exception 'That RFI was cancelled — raise a new one instead.';
  end if;

  update public.rfis
     set response      = btrim(p_response),
         response_date = coalesce(p_date, current_date),
         responded_by  = auth.uid(),
         status        = 'answered'::rfi_status,
         closed_at     = null,
         updated_at    = now()
   where id = p_id;
end $$;

revoke all on function public.fn_answer_rfi(uuid, text, date) from public, anon;
grant execute on function public.fn_answer_rfi(uuid, text, date) to authenticated;


-- ############################################################
-- ###  5. OPEN / CLOSE
-- ############################################################
create or replace function public.fn_set_rfi_status(
  p_id     uuid,
  p_status text
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_project uuid; v_status text; v_response text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_status not in ('open', 'closed') then
    raise exception
      'fn_set_rfi_status handles open and closed only — use fn_answer_rfi to answer, fn_cancel_document to cancel.';
  end if;

  select project_id, status::text, response
    into v_project, v_status, v_response
  from public.rfis where id = p_id;

  if v_project is null then
    raise exception 'That RFI no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may update an RFI.' using errcode = '42501';
  end if;
  if v_status = 'cancelled' then
    raise exception 'That RFI was cancelled — raise a new one instead.';
  end if;

  -- Closing means "answered and acted on". Closing an unanswered RFI would
  -- quietly lose the question; that is what cancel is for.
  if p_status = 'closed' and coalesce(btrim(v_response), '') = '' then
    raise exception
      'This RFI has no answer recorded. Record the response first, or cancel it with a reason if the question no longer applies.';
  end if;

  update public.rfis
     set status     = p_status::rfi_status,
         closed_at  = case when p_status = 'closed' then now() else null end,
         updated_at = now()
   where id = p_id;
end $$;

revoke all on function public.fn_set_rfi_status(uuid, text) from public, anon;
grant execute on function public.fn_set_rfi_status(uuid, text) to authenticated;


-- ############################################################
-- ###  6. CANCELLATION — extend the shared RPC
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

  -- ---------------------------------------------------------------- RFI
  elsif p_table = 'rfis' then
    select project_id, status::text into v_project, v_status
    from public.rfis where id = p_id;
    if v_project is null then raise exception 'That RFI no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may cancel an RFI.' using errcode = '42501'; end if;
    if v_status = 'cancelled' then raise exception 'That RFI is already cancelled.'; end if;
    if v_status = 'closed' then
      raise exception
        'That RFI is closed — it was answered and acted on. Cancelling it now would misrepresent the record.'; end if;

    update public.rfis
       set status = 'cancelled'::rfi_status, cancelled_at = v_now, cancelled_by = v_me,
           cancel_reason = btrim(p_reason), updated_at = v_now
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
-- ###  7. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'rfis'
order by ordinal_position;

select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_answer_rfi', 'fn_set_rfi_status', 'fn_cancel_document')
order by proname;
