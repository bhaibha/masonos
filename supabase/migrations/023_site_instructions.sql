-- ============================================================
-- MASON OS — Migration 023: A6 Site Instructions (Module 56)
--
-- A formal instruction issued to a contractor or vendor on site: what to do,
-- where, by when, and whether it carries a cost. When it does, it links to the
-- Variation Order that captures the money — the SI itself never holds an amount.
--
-- ---------- WHY THE SI HOLDS NO MONEY ----------
-- Supervisors must be able to read every SI on their project (they're the ones
-- acting on it), and CLAUDE.md's #1 rule is that supervisors see no figures.
-- So cost is a BOOLEAN (`has_cost_implication`) plus an optional FK to
-- variation_orders. The rupee value lives only on the VO, whose RLS already
-- excludes supervisors — so a supervisor sees "Cost implication: Yes" and
-- nothing more, with no column-level revoke needed on this table.
--
-- ---------- CANCELLATION ----------
-- An SI is a workflow document, so it CANCELS (mechanism 3), never voids or
-- deletes. ROADMAP recorded that A6 must ship with `cancelled` + reason built
-- in rather than retrofitted — this migration does that, reusing 021's exact
-- pattern: a CHECK constraint makes the reason a database rule, and
-- fn_cancel_document is extended to accept 'site_instructions' so there is one
-- cancellation path for PO, VO and SI alike.
--
-- ---------- ENUM SAFETY ----------
-- si_status is a BRAND NEW type, so 021's "unsafe use of new value" trap does
-- not apply (that only affects ALTER TYPE ... ADD VALUE on an existing type).
-- Comparisons are still written `status::text = '…'` for consistency with the
-- rest of the codebase.
--
-- Re-runnable: create-type guarded, create-table-if-not-exists,
-- add-column-if-not-exists, drop-policy/trigger/constraint before create,
-- create-or-replace on functions.
-- ============================================================


-- ############################################################
-- ###  1. TYPE + SEQUENCE + TABLE
-- ############################################################

do $$ begin
  create type si_status as enum ('issued', 'acknowledged', 'complete', 'cancelled');
exception when duplicate_object then null; end $$;

create sequence if not exists public.si_number_seq;

create table if not exists public.site_instructions (
  id uuid primary key default gen_random_uuid(),
  si_number text not null unique
    default 'SI-' || lpad(nextval('public.si_number_seq')::text, 4, '0'),
  project_id uuid not null references public.projects(id) on delete cascade,
  issued_date date not null default current_date,

  -- Addressed to: linked vendor OR free text, the same flexible pattern as
  -- expenses/POs since 017. A labour contractor often isn't in the vendor
  -- master, and forcing registration before issuing an instruction is friction
  -- nobody on a site will tolerate.
  vendor_id uuid references public.vendors(id),
  addressed_to text,

  work_area text,
  instruction text not null,

  -- Storage paths in the site-photos bucket; every path starts `${projectId}/`
  -- so the existing storage RLS applies unchanged.
  attachments text[] not null default '{}',

  -- Money lives on the VO, not here. See header.
  has_cost_implication boolean not null default false,
  variation_id uuid references public.variation_orders(id),

  required_by date,
  status si_status not null default 'issued',

  issued_by uuid not null default auth.uid() references public.profiles(id),
  acknowledged_by uuid references public.profiles(id),
  acknowledged_at timestamptz,
  completed_at timestamptz,

  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancel_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists si_project_idx
  on public.site_instructions (project_id, issued_date desc);
create index if not exists si_open_idx
  on public.site_instructions (project_id, required_by)
  where status in ('issued', 'acknowledged');

-- Same shape as 021's purchase_orders_cancel_ck / variation_orders_cancel_ck.
alter table public.site_instructions drop constraint if exists site_instructions_cancel_ck;
alter table public.site_instructions add constraint site_instructions_cancel_ck check (
  status::text <> 'cancelled'
  or (cancelled_at is not null
      and cancelled_by is not null
      and coalesce(btrim(cancel_reason), '') <> '')
);

-- An instruction with no recipient is meaningless — one of the two must be set.
alter table public.site_instructions drop constraint if exists site_instructions_addressee_ck;
alter table public.site_instructions add constraint site_instructions_addressee_ck check (
  vendor_id is not null or coalesce(btrim(addressed_to), '') <> ''
);

comment on column public.site_instructions.has_cost_implication is
  'Boolean only. The rupee value lives on the linked variation_order, whose RLS '
  'excludes supervisors — this table is readable by every project member.';


-- ############################################################
-- ###  2. RLS
-- ############################################################
alter table public.site_instructions enable row level security;

-- Every project member reads, supervisors included: they act on the instruction.
-- Safe because the table carries no figures.
drop policy if exists si_read on public.site_instructions;
create policy si_read on public.site_instructions for select to authenticated
  using (public.is_member(project_id));

-- Founder/PM issue.
drop policy if exists si_insert on public.site_instructions;
create policy si_insert on public.site_instructions for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm'));

-- Founder/PM progress the status. Cancellation still has to go through
-- fn_cancel_document — the CHECK constraint above is what enforces that, since
-- a client UPDATE cannot set cancelled_by honestly.
drop policy if exists si_update on public.site_instructions;
create policy si_update on public.site_instructions for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm'))
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm'));

-- No DELETE policy: an SI is cancelled, never deleted (see fn_delete_record).


-- ############################################################
-- ###  3. AUDIT
-- ############################################################
drop trigger if exists audit_site_instructions on public.site_instructions;
create trigger audit_site_instructions
  after insert or update or delete on public.site_instructions
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  4. CANCELLATION — extend the shared RPC
-- ############################################################
-- Identical to 021 plus a site_instructions branch, so PO, VO and SI all
-- cancel through one function with one set of rules.
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
       set status = 'cancelled'::po_status,
           cancelled_at = v_now, cancelled_by = v_me,
           cancel_reason = btrim(p_reason), updated_at = v_now
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
    if v_role <> 'founder' then
      raise exception 'Only the founder may cancel a variation order.'
        using errcode = '42501';
    end if;
    if v_status = 'cancelled' then
      raise exception 'That variation is already cancelled.';
    end if;

    update public.variation_orders
       set status = 'cancelled'::vo_status,
           cancelled_at = v_now, cancelled_by = v_me,
           cancel_reason = btrim(p_reason), updated_at = v_now
     where id = p_id;

  -- ---------------------------------------------------- SITE INSTRUCTION
  elsif p_table = 'site_instructions' then
    select project_id, status::text into v_project, v_status
    from public.site_instructions where id = p_id;

    if v_project is null then
      raise exception 'That site instruction no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;
    if v_role not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may cancel a site instruction.'
        using errcode = '42501';
    end if;
    if v_status = 'cancelled' then
      raise exception 'That instruction is already cancelled.';
    end if;
    if v_status = 'complete' then
      raise exception
        'That instruction is already marked complete — the work was done. Cancelling it now would misrepresent the record.';
    end if;

    update public.site_instructions
       set status = 'cancelled'::si_status,
           cancelled_at = v_now, cancelled_by = v_me,
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
-- ###  5. STATUS PROGRESSION HELPER
-- ############################################################
-- NOTE ON DELETION: site_instructions is deliberately absent from
-- fn_delete_record (022). With no DELETE policy and no branch in that function,
-- an SI simply cannot be hard-deleted — it is cancelled, with a reason. The UI
-- never offers a delete action for one.
--
-- Acknowledge / complete stamp who and when. Kept as an RPC so the timestamps
-- can't drift from the status the way two separate client updates would.
create or replace function public.fn_set_si_status(
  p_id     uuid,
  p_status text
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_project uuid; v_current text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_status not in ('issued', 'acknowledged', 'complete') then
    raise exception 'fn_set_si_status: % is not a settable status (cancel uses fn_cancel_document)', p_status;
  end if;

  select project_id, status::text into v_project, v_current
  from public.site_instructions where id = p_id;

  if v_project is null then
    raise exception 'That site instruction no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may update a site instruction.'
      using errcode = '42501';
  end if;
  if v_current = 'cancelled' then
    raise exception 'That instruction was cancelled — reissue a new one instead.';
  end if;

  update public.site_instructions
     set status = p_status::si_status,
         acknowledged_by = case
           when p_status = 'acknowledged' then auth.uid()
           when p_status = 'issued' then null
           else acknowledged_by end,
         acknowledged_at = case
           when p_status = 'acknowledged' then now()
           when p_status = 'issued' then null
           else acknowledged_at end,
         completed_at = case
           when p_status = 'complete' then now()
           else null end,
         updated_at = now()
   where id = p_id;
end $$;

revoke all on function public.fn_set_si_status(uuid, text) from public, anon;
grant execute on function public.fn_set_si_status(uuid, text) to authenticated;


-- ############################################################
-- ###  6. VERIFY
-- ############################################################
-- Expect the table with its columns.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'site_instructions'
order by ordinal_position;

-- Expect: fn_cancel_document, fn_set_si_status.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_cancel_document', 'fn_set_si_status')
order by proname;
