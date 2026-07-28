-- ============================================================
-- MASON OS — Migration 020: void / reverse for financial + stock records
--
-- Financial and stock rows are NEVER hard-deleted. They are voided: the row
-- stays, marked, and every server-side total stops counting it. That is the
-- only way an audit trail survives a correction.
--
-- Tables gaining voided_at / voided_by / void_reason:
--   expenses · petty_cash_entries · material_inward · material_issues
--   goods_receipts · po_invoices
--
-- Two BACK-LINKS are added because voiding has to cascade and there was
-- previously no way to find the child rows:
--   material_inward.grn_line_id  — fn_grn_to_inward created inward rows with
--                                  only a 'Auto from GRN' remark, so voiding a
--                                  GRN could not reverse its own stock.
--   expenses.pc_entry_id         — fn_pc_to_expense created expense rows with
--                                  no link back, so voiding a petty cash entry
--                                  left a ghost expense in the ledger.
--   Existing rows cannot be back-filled reliably; the transaction data was
--   cleared before real entry began, so there is nothing to back-fill.
--
-- Everything is voided through fn_void_record() — a SECURITY DEFINER function
-- that checks the role, demands a reason, blocks unsafe voids, and cascades.
-- No broad UPDATE policy is added: the RPC is deliberately the only path, so
-- nobody can flip voided_at by hand from the client.
--
-- Role rules (CLAUDE.md access matrix):
--   money  (expenses, petty cash, invoices)      → founder / accounts
--   stock  (inward, issues, goods receipts)      → founder / pm
--
-- Audit: every one of these tables already carries an fn_audit() trigger that
-- fires on UPDATE (001, 002, 003, 012, 018), so a void writes old_data +
-- new_data — including void_reason and who did it — with no extra plumbing.
--
-- Views/functions rewritten to exclude voided rows:
--   v_project_spend (cascade → v_portfolio_summary) · v_budget_vs_actual
--   v_petty_cash_balance · v_stock · v_po_match · v_material_inward
--   v_material_inward_rates · fn_expense_total · fn_check_stock
--   fn_receive_goods · fn_post_invoice · fn_grn_to_inward · fn_pc_to_expense
--
-- NOT in this migration: cancel/reject for PO and VO, and hard delete. Those
-- are migration 021 (Site Instructions / RFI don't exist yet — A6/A7 unbuilt —
-- so their cancel states ship with those modules).
--
-- Re-runnable: add-column-if-not-exists, drop-constraint/trigger/view before
-- create, create-or-replace on functions. Views are DROP-then-create, never
-- create-or-replace (Postgres refuses column list changes — bitten 3x).
-- ============================================================


-- ############################################################
-- ###  1. VOID COLUMNS
-- ############################################################

alter table public.expenses
  add column if not exists voided_at  timestamptz,
  add column if not exists voided_by  uuid references public.profiles(id),
  add column if not exists void_reason text;

alter table public.petty_cash_entries
  add column if not exists voided_at  timestamptz,
  add column if not exists voided_by  uuid references public.profiles(id),
  add column if not exists void_reason text;

alter table public.material_inward
  add column if not exists voided_at  timestamptz,
  add column if not exists voided_by  uuid references public.profiles(id),
  add column if not exists void_reason text;

alter table public.material_issues
  add column if not exists voided_at  timestamptz,
  add column if not exists voided_by  uuid references public.profiles(id),
  add column if not exists void_reason text;

alter table public.goods_receipts
  add column if not exists voided_at  timestamptz,
  add column if not exists voided_by  uuid references public.profiles(id),
  add column if not exists void_reason text;

alter table public.po_invoices
  add column if not exists voided_at  timestamptz,
  add column if not exists voided_by  uuid references public.profiles(id),
  add column if not exists void_reason text;

-- A void is all-or-nothing: timestamp, actor and a non-blank reason together.
-- This is what makes "mandatory reason" a database rule rather than a form rule.
do $$
declare t text;
begin
  foreach t in array array[
    'expenses','petty_cash_entries','material_inward',
    'material_issues','goods_receipts','po_invoices'
  ] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_void_ck');
    execute format($f$
      alter table public.%I add constraint %I check (
        (voided_at is null and voided_by is null and void_reason is null)
        or
        (voided_at is not null and voided_by is not null
         and coalesce(btrim(void_reason), '') <> '')
      )
    $f$, t, t || '_void_ck');
  end loop;
end $$;

-- Partial indexes: every hot query now filters `voided_at is null`.
create index if not exists expenses_live_idx
  on public.expenses (project_id, expense_date) where voided_at is null;
create index if not exists inward_live_idx
  on public.material_inward (project_id, material_id) where voided_at is null;
create index if not exists issues_live_idx
  on public.material_issues (project_id, material_id) where voided_at is null;


-- ############################################################
-- ###  2. BACK-LINKS (so a void can reverse what it created)
-- ############################################################

alter table public.material_inward
  add column if not exists grn_line_id uuid references public.grn_lines(id);
create index if not exists inward_grn_line_idx
  on public.material_inward (grn_line_id) where grn_line_id is not null;

alter table public.expenses
  add column if not exists pc_entry_id uuid references public.petty_cash_entries(id);
create index if not exists expenses_pc_entry_idx
  on public.expenses (pc_entry_id) where pc_entry_id is not null;

-- 006 revoked SELECT on material_inward and re-granted an explicit column list.
-- The new columns are not in it, so without this grant no role — not even the
-- founder — could read them. (Same trap 018 hit with vendor_name.)
grant select (voided_at, voided_by, void_reason, grn_line_id)
  on public.material_inward to authenticated;


-- ---------- GRN → inward, now traceable ----------
create or replace function public.fn_grn_to_inward()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_project uuid; v_material uuid; v_vendor uuid; v_vname text;
  v_rate numeric(14,2); v_date date; v_by uuid;
begin
  select po.project_id, pl.material_id, po.vendor_id, po.vendor_name,
         pl.rate, g.received_date, g.received_by
    into v_project, v_material, v_vendor, v_vname, v_rate, v_date, v_by
  from public.po_lines pl
  join public.purchase_orders po on po.id = pl.po_id
  join public.goods_receipts g on g.id = new.grn_id
  where pl.id = new.po_line_id;

  insert into public.material_inward
    (project_id, material_id, inward_date, qty, vendor_id, vendor_name,
     rate, remarks, created_by, grn_line_id)
  values
    (v_project, v_material, v_date, new.qty_received, v_vendor, v_vname,
     v_rate, 'Auto from GRN', v_by, new.id);   -- <- the link voiding needs

  return new;
end $$;


-- ---------- petty cash spend → expense, now traceable ----------
create or replace function public.fn_pc_to_expense()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.entry_type = 'spend' then
    insert into public.expenses (project_id, expense_date, category_id, description,
                                 amount, source, receipt_path, created_by, pc_entry_id)
    select a.project_id, new.entry_date, coalesce(new.category_id, 999), new.description,
           new.amount, 'petty_cash', new.receipt_path, new.created_by, new.id
    from public.petty_cash_accounts a where a.id = new.account_id;
  end if;
  return new;
end $$;


-- ############################################################
-- ###  3. STOCK HELPER
-- ############################################################
-- Live stock for one material on one project, voided rows excluded. Used by
-- the void guard and by fn_check_stock so the two can never disagree.
create or replace function public.fn_stock_on_hand(p_project uuid, p_material uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select
    coalesce((select sum(qty) from public.material_inward
              where project_id = p_project and material_id = p_material
                and voided_at is null), 0)
  - coalesce((select sum(qty) from public.material_issues
              where project_id = p_project and material_id = p_material
                and voided_at is null), 0);
$$;
revoke all on function public.fn_stock_on_hand(uuid, uuid) from public, anon;
grant execute on function public.fn_stock_on_hand(uuid, uuid) to authenticated;


-- ############################################################
-- ###  4. fn_void_record — the single way anything gets voided
-- ############################################################
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

    -- Don't let the ledger and its source drift apart: void the source instead.
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

    -- A 'spend' mirrors into the ledger; reverse that too, or the money is
    -- removed from the petty cash balance but still counted as project spend.
    update public.expenses
       set voided_at = v_now, voided_by = v_me,
           void_reason = 'Petty cash entry voided: ' || btrim(p_reason)
     where pc_entry_id = p_id and voided_at is null;

  -- --------------------------------------------------------- MATERIAL IN
  elsif p_table = 'material_inward' then
    if v_role not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may void a delivery.'
        using errcode = '42501';
    end if;

    select project_id, material_id, qty, grn_line_id
      into v_project, v_mat, v_qty, v_link
    from public.material_inward where id = p_id and voided_at is null;
    if v_project is null then
      raise exception 'That delivery no longer exists, or is already void.';
    end if;

    if v_link is not null then
      raise exception
        'This delivery came from a goods receipt. Void the goods receipt instead — that reverses the whole delivery.';
    end if;

    -- Removing stock that has already been issued would make the register lie.
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
    if v_role not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may void an issue.'
        using errcode = '42501';
    end if;

    if not exists (select 1 from public.material_issues
                   where id = p_id and voided_at is null) then
      raise exception 'That issue no longer exists, or is already void.';
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

    -- Would reversing this receipt push any material below zero? Aggregate per
    -- material first: one GRN can carry two lines of the same material, and
    -- checking them row-by-row would pass each individually while the combined
    -- reversal still goes negative.
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

    -- Reverse the stock this receipt created.
    update public.material_inward mi
       set voided_at = v_now, voided_by = v_me,
           void_reason = 'Goods receipt voided: ' || btrim(p_reason)
      from public.grn_lines gl
     where gl.id = mi.grn_line_id
       and gl.grn_id = p_id
       and mi.voided_at is null;

    -- Walk the PO status back to what the remaining live receipts justify.
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
       and status in ('approved', 'receiving', 'received');

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

    -- If it was posted to Open Book, reverse the ledger entry as well.
    if v_link is not null then
      update public.expenses
         set voided_at = v_now, voided_by = v_me,
             void_reason = 'Vendor invoice voided: ' || btrim(p_reason)
       where id = v_link and voided_at is null;
    end if;

  else
    raise exception 'fn_void_record: % is not a voidable table', p_table;
  end if;

  -- The per-table fn_audit() UPDATE triggers already recorded old/new (incl.
  -- reason and actor). This extra row makes voids greppable as one action.
  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values (p_table, 'VOID', p_id::text, null,
          jsonb_build_object('voided_by', v_me, 'voided_at', v_now,
                             'void_reason', btrim(p_reason)));
end $$;

revoke all on function public.fn_void_record(text, uuid, text) from public, anon;
grant execute on function public.fn_void_record(text, uuid, text) to authenticated;

comment on function public.fn_void_record(text, uuid, text) is
  'The only path to voiding a financial or stock record. Checks role, demands '
  'a reason, blocks unsafe voids, cascades to derived rows, logs to audit_log.';


-- ############################################################
-- ###  5. MONEY VIEWS — voided rows stop counting
-- ############################################################

-- CASCADE: v_portfolio_summary reads v_project_spend and is recreated below.
drop view if exists public.v_project_spend cascade;

create view public.v_project_spend with (security_invoker = true) as
select
  p.id                                                          as project_id,
  p.name,
  coalesce(s.spent, 0)::numeric(14,2)                           as total_spent,
  coalesce(b.budget, 0)::numeric(14,2)                          as total_budget,
  (coalesce(b.budget, 0) - coalesce(s.spent, 0))::numeric(14,2) as remaining,
  case
    when coalesce(b.budget, 0) > 0
      then round(coalesce(s.spent, 0) * 100.0 / b.budget, 1)
  end                                                           as pct_used
from public.projects p
left join lateral (
  select sum(e.amount + e.gst_amount) as spent
  from public.expenses e
  where e.project_id = p.id
    and e.voided_at is null                     -- <- 020
) s on true
left join lateral (
  select sum(bg.amount) as budget
  from public.budgets bg
  where bg.project_id = p.id
) b on true;

comment on view public.v_project_spend is
  'Per-project spend vs budget, voided expenses excluded. remaining and '
  'pct_used computed here so the client never does money arithmetic.';

create view public.v_portfolio_summary with (security_invoker = true) as
select
  count(*)::int                                              as project_count,
  count(*) filter (where p.status = 'active')::int           as active_count,
  count(*) filter (where s.remaining < 0)::int               as over_budget_count,
  coalesce(sum(s.total_spent), 0)::numeric(14,2)             as total_spent,
  coalesce(sum(s.total_budget), 0)::numeric(14,2)            as total_budget,
  coalesce(sum(s.remaining), 0)::numeric(14,2)               as remaining,
  case
    when coalesce(sum(s.total_budget), 0) > 0
      then round(sum(s.total_spent) * 100.0 / sum(s.total_budget), 1)
  end                                                        as pct_used
from public.v_project_spend s
join public.projects p on p.id = s.project_id;

comment on view public.v_portfolio_summary is
  'Single-row roll-up across every project the caller can see. Inherits the '
  'voided-expense exclusion from v_project_spend.';


drop view if exists public.v_budget_vs_actual cascade;

create view public.v_budget_vs_actual with (security_invoker = true) as
with keys as (
  select project_id, category_id from public.budgets
  union
  select project_id, category_id from public.expenses where voided_at is null
),
actuals as (
  select project_id, category_id, sum(amount + gst_amount) as actual
  from public.expenses
  where voided_at is null                       -- <- 020
  group by project_id, category_id
)
select
  k.project_id,
  c.name                                                         as category,
  coalesce(b.amount, 0)::numeric(14,2)                           as budget,
  coalesce(a.actual, 0)::numeric(14,2)                           as actual,
  (coalesce(b.amount, 0) - coalesce(a.actual, 0))::numeric(14,2) as remaining,
  (b.id is not null)                                             as has_budget
from keys k
join public.expense_categories c on c.id = k.category_id
left join public.budgets b
  on b.project_id = k.project_id and b.category_id = k.category_id
left join actuals a
  on a.project_id = k.project_id and a.category_id = k.category_id;

comment on view public.v_budget_vs_actual is
  'Budget vs actual per category, voided expenses excluded. Includes '
  'categories with spend but no budget row (budget 0, has_budget false).';


drop view if exists public.v_petty_cash_balance cascade;

create view public.v_petty_cash_balance with (security_invoker = true) as
select a.id as account_id, a.project_id, a.holder,
       (a.imprest_amount
        + coalesce(sum(case e.entry_type when 'top_up' then e.amount
                                         when 'spend'  then -e.amount
                                         when 'return' then -e.amount end), 0)
       )::numeric(14,2) as balance
from public.petty_cash_accounts a
left join public.petty_cash_entries e
       on e.account_id = a.id
      and e.voided_at is null                   -- <- 020 (must be in the JOIN,
                                                --    not WHERE, or accounts with
                                                --    only voided entries vanish)
group by a.id;


-- ---------- fn_expense_total ----------
create or replace function public.fn_expense_total(
  p_project  uuid,
  p_from     date           default null,
  p_to       date           default null,
  p_category int            default null,
  p_source   expense_source default null
)
returns table (
  total_amount   numeric(14,2),
  total_gst      numeric(14,2),
  total_with_gst numeric(14,2),
  entry_count    bigint
)
language sql stable security invoker set search_path = public
as $$
  select
    coalesce(sum(e.amount), 0)::numeric(14,2)                as total_amount,
    coalesce(sum(e.gst_amount), 0)::numeric(14,2)            as total_gst,
    coalesce(sum(e.amount + e.gst_amount), 0)::numeric(14,2) as total_with_gst,
    count(*)                                                 as entry_count
  from public.expenses e
  where e.project_id = p_project
    and e.voided_at is null                     -- <- 020
    and (p_from     is null or e.expense_date >= p_from)
    and (p_to       is null or e.expense_date <= p_to)
    and (p_category is null or e.category_id  =  p_category)
    and (p_source   is null or e.source       =  p_source);
$$;


-- ############################################################
-- ###  6. STOCK — voided movements stop counting
-- ############################################################

drop view if exists public.v_stock cascade;

create view public.v_stock with (security_invoker = true) as
select m.id as material_id, m.name, m.unit, m.low_stock_level, x.project_id,
       coalesce(sum(x.inward), 0)                             as total_in,
       coalesce(sum(x.issued), 0)                             as total_out,
       coalesce(sum(x.inward), 0) - coalesce(sum(x.issued), 0) as in_stock,
       (coalesce(sum(x.inward), 0) - coalesce(sum(x.issued), 0))
         <= m.low_stock_level                                 as low_stock
from public.materials m
join lateral (
  select project_id, qty as inward, 0::numeric as issued
  from public.material_inward
  where material_id = m.id and voided_at is null              -- <- 020
  union all
  select project_id, 0, qty
  from public.material_issues
  where material_id = m.id and voided_at is null              -- <- 020
) x on true
group by m.id, x.project_id;


-- Issuance cannot exceed live stock. Delegates to fn_stock_on_hand so the
-- guard and the void guard can never drift apart.
create or replace function public.fn_check_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare cur numeric;
begin
  -- A void (or any update of an already-voided row) never adds consumption.
  if new.voided_at is not null then
    return new;
  end if;

  cur := public.fn_stock_on_hand(new.project_id, new.material_id)
         + coalesce((select qty from public.material_issues
                     where id = new.id and voided_at is null), 0);

  if new.qty > cur then
    raise exception 'Insufficient stock: available %, requested %', cur, new.qty;
  end if;
  return new;
end $$;


drop view if exists public.v_material_inward cascade;
create view public.v_material_inward with (security_invoker = true) as
select id, project_id, material_id, inward_date, qty,
       vendor_name, challan_no, challan_photo, remarks, created_by, created_at,
       grn_line_id, voided_at, voided_by, void_reason
from public.material_inward;
grant select on public.v_material_inward to authenticated;

drop view if exists public.v_material_inward_rates cascade;
create view public.v_material_inward_rates as
select i.id, i.project_id, i.material_id, i.inward_date, i.qty,
       i.vendor_id, i.vendor_name, i.challan_no, i.rate, i.challan_photo,
       i.remarks, i.created_by, i.created_at,
       i.grn_line_id, i.voided_at, i.voided_by, i.void_reason
from public.material_inward i
where public.is_member(i.project_id)
  and public.my_role() in ('founder', 'pm', 'accounts');
grant select on public.v_material_inward_rates to authenticated;


-- ############################################################
-- ###  7. PROCUREMENT — voided receipts/invoices stop matching
-- ############################################################

drop view if exists public.v_po_match cascade;
create view public.v_po_match as
with recv as (
  select gl.po_line_id, sum(gl.qty_received) as qty_received
  from public.grn_lines gl
  join public.goods_receipts g on g.id = gl.grn_id
  where g.voided_at is null                     -- <- 020
  group by gl.po_line_id
),
inv as (
  select il.po_line_id,
         sum(il.qty_invoiced) as qty_invoiced,
         case when sum(il.qty_invoiced) > 0
              then round(sum(il.line_total) / sum(il.qty_invoiced), 2) end as rate_invoiced
  from public.invoice_lines il
  join public.po_invoices pi on pi.id = il.invoice_id
  where pi.voided_at is null                    -- <- 020
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
  and public.my_role() in ('founder', 'pm', 'accounts');
grant select on public.v_po_match to authenticated;


-- ---------- fn_receive_goods: ignore voided receipts when closing a PO ----------
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
      and g.voided_at is null                   -- <- 020
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


-- ---------- fn_post_invoice: refuse a voided invoice ----------
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
    and pinv.voided_at is null;                 -- <- 020

  if v_project is null then
    raise exception 'fn_post_invoice: invoice not found, already posted, or void';
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
-- ###  8. RE-GRANT (DROP VIEW discards privileges)
-- ############################################################
-- Supabase's default privileges usually re-grant these automatically, but
-- relying on that is how a view silently becomes unreadable. Be explicit.
grant select on public.v_project_spend        to authenticated;
grant select on public.v_portfolio_summary    to authenticated;
grant select on public.v_budget_vs_actual     to authenticated;
grant select on public.v_petty_cash_balance   to authenticated;
grant select on public.v_stock                to authenticated;
grant select on public.v_material_inward      to authenticated;
grant select on public.v_material_inward_rates to authenticated;
grant select on public.v_po_match             to authenticated;


-- ############################################################
-- ###  9. VERIFY
-- ############################################################
-- Expect 6 rows, one per voidable table, each showing 3 columns.
select table_name, count(*) as void_columns
from information_schema.columns
where table_schema = 'public'
  and column_name in ('voided_at', 'voided_by', 'void_reason')
group by table_name
order by table_name;

-- Expect fn_void_record and fn_stock_on_hand.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_void_record', 'fn_stock_on_hand')
order by proname;
