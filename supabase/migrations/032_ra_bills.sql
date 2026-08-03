-- ============================================================
-- MASON OS — Migration 032: A11 Bill Certification / RA Bills (Module 33)
--
-- A contractor's running-account bill: work measured to date, less what was
-- certified on previous bills, less retention, equals what we owe them now.
--
-- ---------- THE ARITHMETIC, AND WHY IT IS SHAPED THIS WAY ----------
-- Measurement lines carry QUANTITY TO DATE, not quantity this period — that is
-- how an RA bill is written on site, and it is what makes the running account
-- self-correcting: if bill 2 under-measured a wall, bill 3 states the true
-- cumulative quantity and the difference falls out automatically. So:
--
--   gross_work_value          = Σ (qty_to_date × rate)          [cumulative]
--   less_previously_certified = Σ gross of earlier CERTIFIED bills
--                               for the same contractor on this project
--   value_this_bill           = gross_work_value − less_previously_certified
--   retention_amount          = round(value_this_bill × retention_pct / 100, 2)
--   net_certified             = value_this_bill − retention_amount
--
-- Retention is taken on THIS bill's value, not on the cumulative figure, so it
-- is never withheld twice on the same work. Migration 025 taught the general
-- lesson the hard way: a deduction applied at the wrong level still produced
-- the right payable but a statement nobody could reconcile. Every figure above
-- is computed by fn_certify_ra_bill and FROZEN on the row — the browser prints
-- what the database stored and derives nothing.
--
-- ---------- WHY THE FIGURES ARE A SNAPSHOT ----------
-- A certified bill is a commitment to pay. If it recomputed from the lines on
-- every read, editing a line months later would silently restate a bill that
-- has already been paid. Certified rows are therefore immutable in practice:
-- their totals live in columns, not in a view.
--
-- ---------- RETENTION IS RECORDED, NOT RELEASED ----------
-- This module holds retention and reports how much is held. Releasing it, and
-- bank guarantees, are A12 — deliberately not started here.
--
-- ---------- NO SUPERVISORS ----------
-- Every column on this table is money. RLS admits founder/pm/accounts only, and
-- the screen sits behind /money, which supervisors cannot reach.
--
-- Re-runnable: create-type guarded, tables if-not-exists, policies and
-- constraints dropped before create, create-or-replace on functions, views
-- dropped before create (never create-or-replace — CLAUDE.md).
-- ============================================================


-- ############################################################
-- ###  1. TYPE + SEQUENCE + TABLES
-- ############################################################

do $$ begin
  create type ra_status as enum
    ('submitted', 'under_review', 'certified', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

create sequence if not exists public.ra_bill_seq;

create table if not exists public.ra_bills (
  id uuid primary key default gen_random_uuid(),
  bill_no text not null unique
    default 'RA-' || lpad(nextval('public.ra_bill_seq')::text, 4, '0'),

  project_id uuid not null references public.projects(id) on delete cascade,

  -- Linked vendor OR free text, the 017 pattern. A labour contractor is often
  -- not in the vendor master, and refusing their bill until somebody registers
  -- them is friction that ends with the bill being paid off-system.
  vendor_id uuid references public.vendors(id),
  contractor_name text,

  -- The contractor's own serial for this account ("their RA-3"), free text
  -- because every contractor numbers differently.
  contractor_bill_no text,

  period_from date,
  period_to date not null default (now() at time zone 'Asia/Kolkata')::date,

  -- What they asked for. Kept alongside what we certify, because the gap
  -- between the two is the single most useful number on the screen.
  claimed_amount numeric(14,2),

  retention_pct numeric(5,2) not null default 5,

  status ra_status not null default 'submitted',
  notes text,

  -- ---- frozen by fn_certify_ra_bill, null until then ----
  gross_work_value          numeric(14,2),
  less_previously_certified numeric(14,2),
  retention_amount          numeric(14,2),
  net_certified             numeric(14,2),

  certified_at timestamptz,
  certified_by uuid references public.profiles(id),

  rejected_at timestamptz,
  rejected_by uuid references public.profiles(id),
  reject_reason text,

  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancel_reason text,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ra_project_idx
  on public.ra_bills (project_id, period_to desc);
create index if not exists ra_open_idx
  on public.ra_bills (project_id, status)
  where status in ('submitted', 'under_review');
create index if not exists ra_contractor_idx
  on public.ra_bills (project_id, vendor_id);

-- A bill with nobody to pay is meaningless.
alter table public.ra_bills drop constraint if exists ra_payee_ck;
alter table public.ra_bills add constraint ra_payee_ck check (
  vendor_id is not null or coalesce(btrim(contractor_name), '') <> ''
);

-- Certified means all four figures exist and someone signed for them. Without
-- this a client could set status = 'certified' and leave the money null.
alter table public.ra_bills drop constraint if exists ra_certified_ck;
alter table public.ra_bills add constraint ra_certified_ck check (
  status::text <> 'certified'
  or (gross_work_value is not null
      and less_previously_certified is not null
      and retention_amount is not null
      and net_certified is not null
      and certified_at is not null
      and certified_by is not null)
);

-- A rejection without a reason is an argument waiting to happen.
alter table public.ra_bills drop constraint if exists ra_rejected_ck;
alter table public.ra_bills add constraint ra_rejected_ck check (
  status::text <> 'rejected'
  or (rejected_at is not null
      and rejected_by is not null
      and coalesce(btrim(reject_reason), '') <> '')
);

-- The 021 cancellation contract, unchanged.
alter table public.ra_bills drop constraint if exists ra_cancel_ck;
alter table public.ra_bills add constraint ra_cancel_ck check (
  status::text <> 'cancelled'
  or (cancelled_at is not null
      and cancelled_by is not null
      and coalesce(btrim(cancel_reason), '') <> '')
);


create table if not exists public.ra_bill_lines (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.ra_bills(id) on delete cascade,

  -- Denormalised from the parent by a trigger, so RLS can answer "which
  -- project?" without a join in the policy.
  project_id uuid not null references public.projects(id) on delete cascade,

  description text not null,
  unit text,

  -- CUMULATIVE to date, not this period. See the header.
  qty_to_date numeric(12,2) not null default 0,
  rate numeric(14,2) not null default 0,

  -- Postgres does the multiplication. CLAUDE.md rule 2.
  amount numeric(14,2)
    generated always as (round(qty_to_date * rate, 2)) stored,

  category_id int references public.expense_categories(id),
  sort int not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists ra_line_bill_idx on public.ra_bill_lines (bill_id, sort);
create index if not exists ra_line_project_idx on public.ra_bill_lines (project_id);

comment on column public.ra_bill_lines.qty_to_date is
  'Cumulative quantity measured to date, not this period. The running account '
  'self-corrects: a later bill restating the true quantity fixes an earlier '
  'under-measurement automatically.';


-- ############################################################
-- ###  2. PROJECT DENORMALISATION TRIGGER
-- ############################################################
create or replace function public.fn_ra_line_project()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select b.project_id into new.project_id
  from public.ra_bills b where b.id = new.bill_id;

  if new.project_id is null then
    raise exception 'That bill no longer exists.';
  end if;
  return new;
end $$;

drop trigger if exists ra_line_project on public.ra_bill_lines;
create trigger ra_line_project
  before insert on public.ra_bill_lines
  for each row execute function public.fn_ra_line_project();


-- ############################################################
-- ###  3. RLS — money, so no supervisor arm anywhere
-- ############################################################
alter table public.ra_bills      enable row level security;
alter table public.ra_bill_lines enable row level security;

drop policy if exists ra_read on public.ra_bills;
create policy ra_read on public.ra_bills for select to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'accounts'));

drop policy if exists ra_insert on public.ra_bills;
create policy ra_insert on public.ra_bills for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'accounts'));

-- Editing a bill that is still in review is normal. Certification, rejection
-- and cancellation all go through their RPCs — the CHECK constraints above are
-- what make a direct client UPDATE unable to fake them.
drop policy if exists ra_update on public.ra_bills;
create policy ra_update on public.ra_bills for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'accounts'))
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'accounts'));

drop policy if exists ra_line_read on public.ra_bill_lines;
create policy ra_line_read on public.ra_bill_lines for select to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'accounts'));

drop policy if exists ra_line_write on public.ra_bill_lines;
create policy ra_line_write on public.ra_bill_lines for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'accounts'));

drop policy if exists ra_line_update on public.ra_bill_lines;
create policy ra_line_update on public.ra_bill_lines for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'accounts'))
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'accounts'));

-- Lines of an uncertified bill can be removed outright; there is nothing
-- downstream and no figure has been committed to.
drop policy if exists ra_line_delete on public.ra_bill_lines;
create policy ra_line_delete on public.ra_bill_lines for delete to authenticated
  using (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'accounts')
    and exists (select 1 from public.ra_bills b
                where b.id = bill_id
                  and b.status::text in ('submitted', 'under_review', 'rejected'))
  );

-- No DELETE policy on ra_bills — removal goes through fn_delete_record.


-- ############################################################
-- ###  4. AUDIT
-- ############################################################
drop trigger if exists audit_ra_bills on public.ra_bills;
create trigger audit_ra_bills
  after insert or update or delete on public.ra_bills
  for each row execute function public.fn_audit();

drop trigger if exists audit_ra_bill_lines on public.ra_bill_lines;
create trigger audit_ra_bill_lines
  after insert or update or delete on public.ra_bill_lines
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  5. LIVE TOTALS VIEW (for bills not yet certified)
-- ############################################################
-- Before certification there is nothing frozen, so the screen needs a preview.
-- After certification the STORED figures win — `coalesce(stored, live)` below
-- is deliberate and load-bearing: a certified bill must never restate itself
-- because somebody edited a line.
drop view if exists public.v_ra_bill_totals cascade;
create view public.v_ra_bill_totals with (security_invoker = true) as
with line_sum as (
  select l.bill_id, sum(l.amount) as gross_live, count(*)::int as line_count
  from public.ra_bill_lines l
  group by l.bill_id
),
prior as (
  select
    b.id as bill_id,
    coalesce((
      select sum(p.gross_work_value)
      from public.ra_bills p
      where p.project_id = b.project_id
        and p.status::text = 'certified'
        and p.id <> b.id
        and (
          (b.vendor_id is not null and p.vendor_id = b.vendor_id)
          or (b.vendor_id is null
              and lower(btrim(coalesce(p.contractor_name, ''))) =
                  lower(btrim(coalesce(b.contractor_name, ''))))
        )
        and p.certified_at < coalesce(b.certified_at, now())
    ), 0)::numeric(14,2) as previously_certified_live
  from public.ra_bills b
)
select
  b.id,
  b.bill_no,
  b.project_id,
  b.vendor_id,
  v.name as vendor_name,
  b.contractor_name,
  b.contractor_bill_no,
  b.period_from,
  b.period_to,
  b.claimed_amount,
  b.retention_pct,
  b.status,
  b.notes,
  b.certified_at,
  b.certified_by,
  b.rejected_at,
  b.reject_reason,
  b.cancelled_at,
  b.cancel_reason,
  b.created_at,
  coalesce(s.line_count, 0) as line_count,

  -- Stored when certified, live preview otherwise.
  coalesce(b.gross_work_value, s.gross_live, 0)::numeric(14,2) as gross_work_value,
  coalesce(b.less_previously_certified, pr.previously_certified_live, 0)::numeric(14,2)
    as less_previously_certified,
  coalesce(
    b.net_certified + b.retention_amount,
    coalesce(s.gross_live, 0) - coalesce(pr.previously_certified_live, 0)
  )::numeric(14,2) as value_this_bill,
  coalesce(
    b.retention_amount,
    round((coalesce(s.gross_live, 0) - coalesce(pr.previously_certified_live, 0))
          * b.retention_pct / 100, 2)
  )::numeric(14,2) as retention_amount,
  coalesce(
    b.net_certified,
    (coalesce(s.gross_live, 0) - coalesce(pr.previously_certified_live, 0))
      - round((coalesce(s.gross_live, 0) - coalesce(pr.previously_certified_live, 0))
              * b.retention_pct / 100, 2)
  )::numeric(14,2) as net_certified,

  (b.gross_work_value is not null) as is_frozen
from public.ra_bills b
left join line_sum s on s.bill_id = b.id
left join prior    pr on pr.bill_id = b.id
left join public.vendors v on v.id = b.vendor_id;

grant select on public.v_ra_bill_totals to authenticated;

comment on view public.v_ra_bill_totals is
  'Preview figures for bills still in review; for certified bills the stored '
  'snapshot always wins, so a certified bill cannot restate itself when a line '
  'is edited.';


-- ############################################################
-- ###  6. CERTIFY / REJECT / STATUS
-- ############################################################
create or replace function public.fn_certify_ra_bill(
  p_id  uuid,
  p_pct numeric default null          -- override the retention % at certification
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_bill   public.ra_bills%rowtype;
  v_me     uuid := auth.uid();
  v_now    timestamptz := now();
  v_gross  numeric(14,2);
  v_prior  numeric(14,2);
  v_value  numeric(14,2);
  v_pct    numeric(5,2);
  v_ret    numeric(14,2);
  v_lines  int;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_bill from public.ra_bills where id = p_id;
  if v_bill.id is null then
    raise exception 'That bill no longer exists.';
  end if;
  if not public.is_member(v_bill.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception
      'Only a founder or PM may certify a bill. Accounts can prepare and record it, but certification is the signature that authorises payment.'
      using errcode = '42501';
  end if;
  if v_bill.status::text = 'certified' then
    raise exception 'That bill is already certified.';
  end if;
  if v_bill.status::text = 'cancelled' then
    raise exception 'That bill was cancelled. Raise a fresh one.';
  end if;

  select count(*), coalesce(sum(amount), 0)
    into v_lines, v_gross
  from public.ra_bill_lines where bill_id = p_id;

  if v_lines = 0 then
    raise exception
      'This bill has no measurement lines. Certifying nothing is not certification.';
  end if;

  -- Everything certified earlier for the same contractor on this project.
  select coalesce(sum(p.gross_work_value), 0) into v_prior
  from public.ra_bills p
  where p.project_id = v_bill.project_id
    and p.status::text = 'certified'
    and p.id <> p_id
    and (
      (v_bill.vendor_id is not null and p.vendor_id = v_bill.vendor_id)
      or (v_bill.vendor_id is null
          and lower(btrim(coalesce(p.contractor_name, ''))) =
              lower(btrim(coalesce(v_bill.contractor_name, ''))))
    );

  v_value := v_gross - v_prior;

  if v_value < 0 then
    raise exception
      'Work measured to date (%) is less than what has already been certified (%). Check the quantities — a running account cannot go backwards.',
      v_gross, v_prior;
  end if;

  v_pct := coalesce(p_pct, v_bill.retention_pct, 0);
  if v_pct < 0 or v_pct > 100 then
    raise exception 'Retention must be between 0 and 100 percent.';
  end if;

  -- Retention on THIS bill's value only, so the same work is never held twice.
  v_ret := round(v_value * v_pct / 100, 2);

  update public.ra_bills
     set status                    = 'certified'::ra_status,
         retention_pct             = v_pct,
         gross_work_value          = v_gross,
         less_previously_certified = v_prior,
         retention_amount          = v_ret,
         net_certified             = v_value - v_ret,
         certified_at              = v_now,
         certified_by              = v_me,
         rejected_at               = null,
         rejected_by               = null,
         reject_reason             = null,
         updated_at                = v_now
   where id = p_id;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values ('ra_bills', 'CERTIFY', p_id::text,
          jsonb_build_object('status', v_bill.status::text),
          jsonb_build_object('gross', v_gross, 'previously_certified', v_prior,
                             'retention', v_ret, 'net', v_value - v_ret,
                             'by', v_me, 'at', v_now));
end $$;

revoke all on function public.fn_certify_ra_bill(uuid, numeric) from public, anon;
grant execute on function public.fn_certify_ra_bill(uuid, numeric) to authenticated;


create or replace function public.fn_reject_ra_bill(
  p_id     uuid,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_bill public.ra_bills%rowtype; v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'A reason is required to reject a bill — the contractor has to know what to fix.'
      using errcode = '22023';
  end if;

  select * into v_bill from public.ra_bills where id = p_id;
  if v_bill.id is null then raise exception 'That bill no longer exists.'; end if;
  if not public.is_member(v_bill.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501'; end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may reject a bill.' using errcode = '42501'; end if;
  if v_bill.status::text = 'certified' then
    raise exception
      'That bill is already certified. Cancel it instead — rejecting it now would erase a figure that has been committed to.';
  end if;
  if v_bill.status::text = 'cancelled' then
    raise exception 'That bill was cancelled.';
  end if;

  update public.ra_bills
     set status        = 'rejected'::ra_status,
         rejected_at   = now(),
         rejected_by   = v_me,
         reject_reason = btrim(p_reason),
         updated_at    = now()
   where id = p_id;
end $$;

revoke all on function public.fn_reject_ra_bill(uuid, text) from public, anon;
grant execute on function public.fn_reject_ra_bill(uuid, text) to authenticated;


-- Moving a bill back into the review queue (including after a rejection, once
-- the contractor has corrected it). Certified bills are NOT reachable from
-- here — that is what cancellation is for.
create or replace function public.fn_set_ra_status(
  p_id     uuid,
  p_status text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_bill public.ra_bills%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_status not in ('submitted', 'under_review') then
    raise exception
      'fn_set_ra_status handles submitted and under_review only — use fn_certify_ra_bill, fn_reject_ra_bill or fn_cancel_document for the rest.';
  end if;

  select * into v_bill from public.ra_bills where id = p_id;
  if v_bill.id is null then raise exception 'That bill no longer exists.'; end if;
  if not public.is_member(v_bill.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501'; end if;
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot update bills.' using errcode = '42501'; end if;
  if v_bill.status::text = 'certified' then
    raise exception
      'That bill is certified. Cancel it if it was certified in error — it cannot quietly return to the queue.';
  end if;
  if v_bill.status::text = 'cancelled' then
    raise exception 'That bill was cancelled.';
  end if;

  update public.ra_bills
     set status        = p_status::ra_status,
         rejected_at   = null,
         rejected_by   = null,
         reject_reason = null,
         updated_at    = now()
   where id = p_id;
end $$;

revoke all on function public.fn_set_ra_status(uuid, text) from public, anon;
grant execute on function public.fn_set_ra_status(uuid, text) to authenticated;


-- ############################################################
-- ###  7. PAYABLES + RETENTION ROLL-UP
-- ############################################################
-- What we owe each contractor, and what we are holding back. Deliberately a
-- read-only rollup: certifying does NOT post to Open Book, because vendor
-- invoices already post there through the procurement path and a contractor who
-- appears in both would be counted twice. Posting can be added once there is a
-- rule for which path owns which spend.
drop view if exists public.v_ra_payables cascade;
create view public.v_ra_payables with (security_invoker = true) as
select
  b.project_id,
  b.vendor_id,
  coalesce(v.name, b.contractor_name, 'Unnamed contractor') as contractor,
  count(*)::int                                   as certified_bills,
  sum(b.gross_work_value)::numeric(14,2)          as gross_certified,
  sum(b.retention_amount)::numeric(14,2)          as retention_held,
  sum(b.net_certified)::numeric(14,2)             as net_certified,
  max(b.certified_at)                             as last_certified_at
from public.ra_bills b
left join public.vendors v on v.id = b.vendor_id
where b.status::text = 'certified'
group by b.project_id, b.vendor_id, coalesce(v.name, b.contractor_name, 'Unnamed contractor');

grant select on public.v_ra_payables to authenticated;

comment on view public.v_ra_payables is
  'Certified value, retention held and net payable per contractor. Retention '
  'RELEASE and bank guarantees are A12 — this only reports what is held.';


-- ############################################################
-- ###  8. CANCELLATION — extend the shared RPC
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

  -- ------------------------------------------------------------ RA BILL
  -- Cancelling a CERTIFIED bill is allowed and is the only way to undo one,
  -- because it withdraws a figure the business committed to. The next bill's
  -- "less previously certified" drops accordingly, so the running account
  -- self-corrects — which is exactly why the deduction is computed from
  -- certified rows rather than stored as a manual number.
  elsif p_table = 'ra_bills' then
    select project_id, status::text into v_project, v_status
    from public.ra_bills where id = p_id;
    if v_project is null then raise exception 'That bill no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may cancel a bill.' using errcode = '42501'; end if;
    if v_status = 'cancelled' then raise exception 'That bill is already cancelled.'; end if;

    update public.ra_bills
       set status = 'cancelled'::ra_status, cancelled_at = v_now, cancelled_by = v_me,
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
-- ###  9. HARD DELETE — ra_bills branch
-- ############################################################
-- A bill that was never certified committed to nothing, so it can go. Once
-- certified it is cancelled instead, like every other workflow document.
create or replace function public.fn_delete_record(
  p_table text,
  p_id    uuid
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_role text; v_project uuid; v_status text; v_n int; v_name text;
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  v_role := public.my_role();
  if v_role not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot delete records.' using errcode = '42501';
  end if;

  if p_table in ('tasks', 'site_logs', 'safety_checklists', 'incidents',
                 'documents', 'purchase_orders', 'materials', 'vendors', 'snags',
                 'drawings', 'drawing_revisions')
     and v_role not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may delete this record.'
      using errcode = '42501';
  end if;

  if p_table = 'tasks' then
    select project_id into v_project from public.tasks where id = p_id;
    if v_project is null then raise exception 'That task no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    select count(*) into v_n from public.tasks where rolled_from = p_id;
    if v_n > 0 then
      raise exception
        'This task was rolled over to a later day (% follow-on task(s)). Delete those first.', v_n; end if;
    delete from public.tasks where id = p_id;

  elsif p_table = 'site_logs' then
    select project_id into v_project from public.site_logs where id = p_id;
    if v_project is null then raise exception 'That site log no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    delete from public.site_logs where id = p_id;

  elsif p_table = 'safety_checklists' then
    select project_id into v_project from public.safety_checklists where id = p_id;
    if v_project is null then raise exception 'That checklist no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    delete from public.safety_checklists where id = p_id;

  elsif p_table = 'incidents' then
    select project_id into v_project from public.incidents where id = p_id;
    if v_project is null then raise exception 'That incident no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    delete from public.incidents where id = p_id;

  elsif p_table = 'snags' then
    select project_id, status::text into v_project, v_status
    from public.snags where id = p_id;
    if v_project is null then raise exception 'That snag no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status = 'verified' then
      raise exception
        'That snag was verified — it is the record that a defect was fixed and signed off. Reopen it if the defect has come back.';
    end if;
    delete from public.snags where id = p_id;

  elsif p_table = 'compliance_items' then
    select project_id, status::text into v_project, v_status
    from public.compliance_items where id = p_id;
    if not found then raise exception 'That compliance item no longer exists.'; end if;
    if v_project is not null and not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status = 'filed' then
      raise exception
        'That item is filed and holds the proof of a statutory filing. Reopen it first if the filing was recorded in error.';
    end if;
    delete from public.compliance_items where id = p_id;

  elsif p_table = 'drawing_revisions' then
    select project_id, status::text into v_project, v_status
    from public.drawing_revisions where id = p_id;
    if v_project is null then raise exception 'That revision no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status <> 'wip' and v_role <> 'founder' then
      raise exception
        'That revision was issued for construction. Only the founder can remove it — supersede it with a newer revision instead.';
    end if;
    delete from public.drawing_revisions where id = p_id;

  elsif p_table = 'drawings' then
    select project_id into v_project from public.drawings where id = p_id;
    if v_project is null then raise exception 'That drawing no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    select count(*) into v_n from public.drawing_revisions where drawing_id = p_id;
    if v_n > 0 and v_role <> 'founder' then
      raise exception
        'This drawing has % revision(s) on the register. Only the founder can delete a drawing that has been issued.',
        v_n;
    end if;
    delete from public.drawings where id = p_id;

  elsif p_table = 'doc_subfolders' then
    select project_id, name into v_project, v_name
    from public.doc_subfolders where id = p_id;
    if v_project is null then raise exception 'That sub-folder no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role <> 'founder' then
      raise exception 'Only the founder may remove a sub-folder.'
        using errcode = '42501';
    end if;
    delete from public.doc_subfolders where id = p_id;

  -- ------------------------------------------------------------ RA BILL
  elsif p_table = 'ra_bills' then
    select project_id, status::text into v_project, v_status
    from public.ra_bills where id = p_id;
    if v_project is null then raise exception 'That bill no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status = 'certified' then
      raise exception
        'That bill is certified — it authorised a payment. Cancel it with a reason instead; the running account will correct itself on the next bill.';
    end if;
    if v_status = 'cancelled' then
      raise exception
        'That bill is cancelled and stays on record with its reason. There is nothing further to remove.';
    end if;
    delete from public.ra_bills where id = p_id;   -- lines cascade

  elsif p_table = 'documents' then
    select project_id into v_project from public.documents where id = p_id;
    if v_project is null then raise exception 'That document no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    delete from public.documents where id = p_id;

  elsif p_table = 'purchase_orders' then
    select project_id, status::text into v_project, v_status
    from public.purchase_orders where id = p_id;
    if v_project is null then raise exception 'That request no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status <> 'requested' then
      raise exception
        'Only a draft request can be deleted. This one is % — cancel it instead, so it keeps its number and stays on record.',
        v_status; end if;
    select count(*) into v_n from public.goods_receipts where po_id = p_id;
    if v_n > 0 then
      raise exception 'This request already has goods receipts against it. Void those first.'; end if;
    select count(*) into v_n from public.po_invoices where po_id = p_id;
    if v_n > 0 then
      raise exception 'This request already has invoices against it. Void those first.'; end if;
    delete from public.purchase_orders where id = p_id;

  elsif p_table = 'materials' then
    select name into v_name from public.materials where id = p_id;
    if v_name is null then raise exception 'That material no longer exists.'; end if;
    select (select count(*) from public.material_inward where material_id = p_id)
         + (select count(*) from public.material_issues where material_id = p_id)
         + (select count(*) from public.po_lines       where material_id = p_id)
      into v_n;
    if v_n > 0 then
      raise exception
        '% is used by % record(s) — deliveries, issues or order lines. Deactivate it instead so it stops appearing in pickers.',
        v_name, v_n; end if;
    delete from public.materials where id = p_id;

  elsif p_table = 'vendors' then
    select name into v_name from public.vendors where id = p_id;
    if v_name is null then raise exception 'That vendor no longer exists.'; end if;
    select (select count(*) from public.expenses        where vendor_id = p_id)
         + (select count(*) from public.material_inward where vendor_id = p_id)
         + (select count(*) from public.purchase_orders where vendor_id = p_id)
         + (select count(*) from public.ra_bills        where vendor_id = p_id)
      into v_n;
    if v_n > 0 then
      raise exception
        '% is linked to % record(s) — expenses, deliveries, orders or bills. Deactivate it instead so it stops appearing in pickers.',
        v_name, v_n; end if;
    delete from public.vendors where id = p_id;

  elsif p_table = 'budgets' then
    select project_id into v_project from public.budgets where id = p_id;
    if v_project is null then raise exception 'That budget line no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role not in ('founder', 'accounts') then
      raise exception 'Only a founder or accounts may remove a budget line.'
        using errcode = '42501'; end if;
    delete from public.budgets where id = p_id;

  elsif p_table in ('expenses', 'petty_cash_entries', 'material_inward',
                    'material_issues', 'goods_receipts', 'po_invoices') then
    raise exception
      'A % carries money or stock and is never deleted — void it instead. The row stays on record, marked VOID, and stops counting.',
      p_table;

  elsif p_table in ('variation_orders', 'site_instructions', 'rfis', 'invoices') then
    raise exception
      'A % is a workflow document and is never deleted — cancel it instead, with a reason.',
      p_table;

  elsif p_table = 'projects' then
    raise exception
      'Projects are never deleted — every record hangs off them. Set the project to Completed or On hold on the Manage screen instead.';

  elsif p_table = 'profiles' then
    raise exception
      'People are never deleted — their name is on the records they raised. Deactivate them on the Manage screen instead.';

  else
    raise exception 'fn_delete_record: % is not a deletable table', p_table;
  end if;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values (p_table, 'DELETE_HARD', p_id::text,
          jsonb_build_object('deleted_by', v_me, 'deleted_at', now()), null);
end $$;

revoke all on function public.fn_delete_record(text, uuid) from public, anon;
grant execute on function public.fn_delete_record(text, uuid) to authenticated;


-- ############################################################
-- ###  10. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'ra_bills'
order by ordinal_position;

-- Expect all five.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_certify_ra_bill', 'fn_reject_ra_bill', 'fn_set_ra_status',
                  'fn_cancel_document', 'fn_delete_record')
order by proname;

-- Expect both views. Last statement in the file.
select table_name from information_schema.views
where table_schema = 'public'
  and table_name in ('v_ra_bill_totals', 'v_ra_payables')
order by table_name;
