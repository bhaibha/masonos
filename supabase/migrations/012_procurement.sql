-- ============================================================
-- MASON OS — Migration 012: Procurement (Module 22)
--   PR -> PO -> GRN -> 3-way match, with GRN feeding stock and a matched
--   invoice feeding Open Book.
--
-- One entity carries the PR->PO lifecycle: a purchase_orders row starts life
-- as status 'requested' (a PR raised by supervisor/pm, quantities only) and
-- becomes 'approved' once pm/founder confirm rates. Fewer tables, same flow.
--
-- Money math (line totals, PO value, match variances) all in Postgres.
-- Rates are column-revoked from `authenticated` and served through a
-- role-gated view, same pattern as 006/010 — supervisors see quantities,
-- never rates.
--
-- Idempotent: enums guarded, tables if-not-exists, policies drop-then-create,
-- functions/triggers replaced.
-- ============================================================

do $$ begin
  create type po_status as enum
    ('requested', 'approved', 'rejected', 'receiving', 'received', 'closed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type match_status as enum ('pending', 'ok', 'qty_variance', 'rate_variance', 'both');
exception when duplicate_object then null; end $$;

-- Human-friendly PO numbers: PO-000001
create sequence if not exists public.po_number_seq;

-- ---------- PURCHASE ORDER (also the PR while status = 'requested') ----------
create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text not null unique default 'PO-' || lpad(nextval('public.po_number_seq')::text, 6, '0'),
  project_id uuid not null references public.projects(id) on delete cascade,
  vendor_id uuid references public.vendors(id),
  status po_status not null default 'requested',
  need_by date,
  notes text,
  raised_by uuid not null default auth.uid() references public.profiles(id),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists po_project_idx on public.purchase_orders (project_id, created_at desc);

create table if not exists public.po_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  material_id uuid not null references public.materials(id),
  qty_ordered numeric(12,2) not null check (qty_ordered > 0),
  rate numeric(14,2) check (rate >= 0),                     -- null until approved
  line_total numeric(14,2) generated always as
    (round(coalesce(rate,0) * qty_ordered, 2)) stored,      -- money math in PG
  created_at timestamptz not null default now()
);
create index if not exists po_lines_po_idx on public.po_lines (po_id);

-- ---------- GOODS RECEIPT ----------
create table if not exists public.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  received_date date not null default current_date,
  note text,
  challan_photo text,
  received_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.grn_lines (
  id uuid primary key default gen_random_uuid(),
  grn_id uuid not null references public.goods_receipts(id) on delete cascade,
  po_line_id uuid not null references public.po_lines(id),
  qty_received numeric(12,2) not null check (qty_received > 0)
);
create index if not exists grn_lines_grn_idx on public.grn_lines (grn_id);

-- Each GRN line posts a material_inward row (single source of truth for stock).
-- SECURITY DEFINER so the receiver's role (which may lack rate visibility)
-- can still write the inward row with the PO's rate.
create or replace function public.fn_grn_to_inward()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_material uuid;
  v_vendor uuid;
  v_rate numeric(14,2);
  v_date date;
  v_by uuid;
begin
  select po.project_id, pl.material_id, po.vendor_id, pl.rate, g.received_date, g.received_by
    into v_project, v_material, v_vendor, v_rate, v_date, v_by
  from public.po_lines pl
  join public.purchase_orders po on po.id = pl.po_id
  join public.goods_receipts g on g.id = new.grn_id
  where pl.id = new.po_line_id;

  insert into public.material_inward
    (project_id, material_id, inward_date, qty, vendor_id, rate, remarks, created_by)
  values
    (v_project, v_material, v_date, new.qty_received, v_vendor, v_rate,
     'Auto from GRN', v_by);

  return new;
end $$;

drop trigger if exists grn_line_to_inward on public.grn_lines;
create trigger grn_line_to_inward after insert on public.grn_lines
  for each row execute function public.fn_grn_to_inward();

-- ---------- VENDOR INVOICE (the 3rd leg) ----------
create table if not exists public.po_invoices (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  invoice_no text,
  invoice_date date not null default current_date,
  gst_amount numeric(14,2) not null default 0 check (gst_amount >= 0),
  approved boolean not null default false,
  approved_by uuid references public.profiles(id),
  expense_id uuid references public.expenses(id),      -- set when posted to Open Book
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.po_invoices(id) on delete cascade,
  po_line_id uuid not null references public.po_lines(id),
  qty_invoiced numeric(12,2) not null check (qty_invoiced > 0),
  rate_invoiced numeric(14,2) not null check (rate_invoiced >= 0),
  line_total numeric(14,2) generated always as
    (round(rate_invoiced * qty_invoiced, 2)) stored
);
create index if not exists invoice_lines_inv_idx on public.invoice_lines (invoice_id);

-- ---------- 3-WAY MATCH (per PO line) ----------
-- ordered vs received vs invoiced, with variance flags. Tolerances: qty within
-- 0.5 unit, rate within 2%. security_invoker so RLS still applies.
-- Drop-first (not create-or-replace): migration 013 recreates this view with an
-- extra project_id column, so on a re-run the columns differ and replace-in-place
-- would fail with "cannot drop columns from view".
drop view if exists public.v_po_match cascade;
create view public.v_po_match with (security_invoker = true) as
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
  join public.po_invoices pi on pi.id = il.invoice_id
  group by il.po_line_id
)
select
  pl.id as po_line_id,
  pl.po_id,
  pl.material_id,
  pl.qty_ordered,
  pl.rate as rate_ordered,
  coalesce(r.qty_received, 0) as qty_received,
  coalesce(i.qty_invoiced, 0) as qty_invoiced,
  i.rate_invoiced,
  (case
     when i.qty_invoiced is null then 'pending'
     when abs(coalesce(i.qty_invoiced,0) - coalesce(r.qty_received,0)) > 0.5
          and pl.rate is not null
          and i.rate_invoiced is not null
          and abs(i.rate_invoiced - pl.rate) > pl.rate * 0.02 then 'both'
     when abs(coalesce(i.qty_invoiced,0) - coalesce(r.qty_received,0)) > 0.5 then 'qty_variance'
     when pl.rate is not null and i.rate_invoiced is not null
          and abs(i.rate_invoiced - pl.rate) > pl.rate * 0.02 then 'rate_variance'
     else 'ok'
   end)::match_status as match_status
from public.po_lines pl
left join recv r on r.po_line_id = pl.id
left join inv i on i.po_line_id = pl.id;

-- ---------- PO TOTALS ----------
-- Drop-first: 013 redefines this view's columns too.
drop view if exists public.v_po_totals cascade;
create view public.v_po_totals with (security_invoker = true) as
select po.id as po_id, po.project_id,
       count(pl.id) as line_count,
       coalesce(sum(pl.qty_ordered), 0) as total_qty,
       coalesce(sum(pl.line_total), 0)::numeric(14,2) as ordered_value
from public.purchase_orders po
left join public.po_lines pl on pl.po_id = po.id
group by po.id, po.project_id;

-- ---------- POST A MATCHED INVOICE TO OPEN BOOK ----------
-- Approves an invoice and writes ONE expense row for its net value, so procured
-- cost flows into the ledger and budgets. Money math stays server-side.
create or replace function public.fn_post_invoice(p_invoice uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_vendor uuid;
  v_net numeric(14,2);
  v_gst numeric(14,2);
  v_cat int;
  v_expense uuid;
  v_invno text;
begin
  if public.my_role() not in ('founder','accounts') then
    raise exception 'fn_post_invoice: only founder/accounts may post invoices'
      using errcode = '42501';
  end if;

  select po.project_id, po.vendor_id, pinv.gst_amount, pinv.invoice_no
    into v_project, v_vendor, v_gst, v_invno
  from public.po_invoices pinv
  join public.purchase_orders po on po.id = pinv.po_id
  where pinv.id = p_invoice and pinv.approved = false;

  if v_project is null then
    raise exception 'fn_post_invoice: invoice not found or already posted';
  end if;

  select coalesce(sum(line_total),0) into v_net
  from public.invoice_lines where invoice_id = p_invoice;

  -- Pick the modal material category on the invoice for the ledger line.
  select m.category_id into v_cat
  from public.invoice_lines il
  join public.po_lines pl on pl.id = il.po_line_id
  join public.materials m on m.id = pl.material_id
  where il.invoice_id = p_invoice and m.category_id is not null
  group by m.category_id order by count(*) desc limit 1;

  insert into public.expenses
    (project_id, category_id, vendor_id, description, amount, gst_amount, source, invoice_no)
  values
    (v_project, coalesce(v_cat, 999), v_vendor,
     'Procurement invoice ' || coalesce(v_invno,''), v_net, v_gst, 'credit', v_invno)
  returning id into v_expense;

  update public.po_invoices
     set approved = true, approved_by = auth.uid(), expense_id = v_expense
   where id = p_invoice;

  return v_expense;
end $$;

revoke all on function public.fn_post_invoice(uuid) from public, anon;
grant execute on function public.fn_post_invoice(uuid) to authenticated;

-- ---------- AUDIT ----------
drop trigger if exists audit_po on public.purchase_orders;
create trigger audit_po after insert or update or delete on public.purchase_orders
  for each row execute function public.fn_audit();
drop trigger if exists audit_grn on public.goods_receipts;
create trigger audit_grn after insert or update or delete on public.goods_receipts
  for each row execute function public.fn_audit();
drop trigger if exists audit_po_inv on public.po_invoices;
create trigger audit_po_inv after insert or update or delete on public.po_invoices
  for each row execute function public.fn_audit();

-- ---------- RATE PRIVACY (column-level, like 006/010) ----------
-- Supervisors see quantities but never rates. po_lines.rate + line_total are
-- revoked from authenticated; a role-gated view carries them.
revoke select on public.po_lines from authenticated;
grant select (id, po_id, material_id, qty_ordered, created_at)
  on public.po_lines to authenticated;

create or replace view public.v_po_lines_rated as
select pl.id, pl.po_id, pl.material_id, pl.qty_ordered, pl.rate, pl.line_total
from public.po_lines pl
join public.purchase_orders po on po.id = pl.po_id
where public.is_member(po.project_id)
  and public.my_role() in ('founder','pm','accounts');
grant select on public.v_po_lines_rated to authenticated;

-- ---------- RLS ----------
alter table public.purchase_orders enable row level security;
alter table public.po_lines        enable row level security;
alter table public.goods_receipts  enable row level security;
alter table public.grn_lines       enable row level security;
alter table public.po_invoices     enable row level security;
alter table public.invoice_lines   enable row level security;

-- PO: members read; supervisor/pm/founder raise; pm/founder approve/update
drop policy if exists po_read on public.purchase_orders;
create policy po_read on public.purchase_orders for select to authenticated
  using (public.is_member(project_id));
drop policy if exists po_insert on public.purchase_orders;
create policy po_insert on public.purchase_orders for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder','pm','supervisor'));
drop policy if exists po_update on public.purchase_orders;
create policy po_update on public.purchase_orders for update to authenticated
  using (public.is_member(project_id) and public.my_role() in ('founder','pm'));

-- PO lines: read gated via parent project; write by raiser roles
drop policy if exists pol_read on public.po_lines;
create policy pol_read on public.po_lines for select to authenticated
  using (exists (select 1 from public.purchase_orders po
                 where po.id = po_id and public.is_member(po.project_id)));
drop policy if exists pol_write on public.po_lines;
create policy pol_write on public.po_lines for all to authenticated
  using (exists (select 1 from public.purchase_orders po
                 where po.id = po_id and public.is_member(po.project_id)
                   and public.my_role() in ('founder','pm','supervisor')))
  with check (exists (select 1 from public.purchase_orders po
                 where po.id = po_id and public.is_member(po.project_id)
                   and public.my_role() in ('founder','pm','supervisor')));

-- GRN: members read; supervisor/pm/founder receive
drop policy if exists grn_read on public.goods_receipts;
create policy grn_read on public.goods_receipts for select to authenticated
  using (exists (select 1 from public.purchase_orders po
                 where po.id = po_id and public.is_member(po.project_id)));
drop policy if exists grn_write on public.goods_receipts;
create policy grn_write on public.goods_receipts for insert to authenticated
  with check (exists (select 1 from public.purchase_orders po
                 where po.id = po_id and public.is_member(po.project_id)
                   and public.my_role() in ('founder','pm','supervisor')));

drop policy if exists grnl_read on public.grn_lines;
create policy grnl_read on public.grn_lines for select to authenticated
  using (exists (select 1 from public.goods_receipts g
                 join public.purchase_orders po on po.id = g.po_id
                 where g.id = grn_id and public.is_member(po.project_id)));
drop policy if exists grnl_write on public.grn_lines;
create policy grnl_write on public.grn_lines for insert to authenticated
  with check (exists (select 1 from public.goods_receipts g
                 join public.purchase_orders po on po.id = g.po_id
                 where g.id = grn_id and public.is_member(po.project_id)
                   and public.my_role() in ('founder','pm','supervisor')));

-- Invoices: money surface — founder/pm/accounts read+write, supervisors excluded
drop policy if exists inv_read on public.po_invoices;
create policy inv_read on public.po_invoices for select to authenticated
  using (exists (select 1 from public.purchase_orders po
                 where po.id = po_id and public.is_member(po.project_id))
         and public.my_role() in ('founder','pm','accounts'));
drop policy if exists inv_write on public.po_invoices;
create policy inv_write on public.po_invoices for all to authenticated
  using (exists (select 1 from public.purchase_orders po
                 where po.id = po_id and public.is_member(po.project_id))
         and public.my_role() in ('founder','pm','accounts'))
  with check (exists (select 1 from public.purchase_orders po
                 where po.id = po_id and public.is_member(po.project_id))
         and public.my_role() in ('founder','pm','accounts'));

drop policy if exists invl_read on public.invoice_lines;
create policy invl_read on public.invoice_lines for select to authenticated
  using (exists (select 1 from public.po_invoices pi
                 join public.purchase_orders po on po.id = pi.po_id
                 where pi.id = invoice_id and public.is_member(po.project_id))
         and public.my_role() in ('founder','pm','accounts'));
drop policy if exists invl_write on public.invoice_lines;
create policy invl_write on public.invoice_lines for all to authenticated
  using (public.my_role() in ('founder','pm','accounts'))
  with check (public.my_role() in ('founder','pm','accounts'));
