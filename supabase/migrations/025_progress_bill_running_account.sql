-- ============================================================
-- MASON OS — Migration 025: fix the progress bill's running-account structure
--
-- ---------- THE BUG ----------
-- 024 put "Less: previously billed" in with the LINE ITEMS, so the deduction
-- landed inside `subtotal` — the taxable value. Two things went wrong:
--
--   1. A GROSS figure (the previous bill's total, tax included) was deducted
--      from a NET base (the pre-tax subtotal). Mixing the two is meaningless.
--   2. The printed invoice then showed, on a real example:
--          Subtotal      2,63,110
--          GST @ 18%     5,60,790
--      18% of 2,63,110 is 47,360. The tax line could not be justified against
--      the taxable value printed directly above it. On a GST invoice that is
--      the problem — an assessing officer reads exactly those two lines.
--
-- The PAYABLE was arithmetically correct (subtotal+gst netted out to the same
-- number), and no double taxation occurred — bill 2's GST minus bill 1's GST
-- equals 18% of the incremental fee. It was the structure that was wrong,
-- not the money.
--
-- ---------- THE FIX ----------
-- A running account bill states the CUMULATIVE position, taxes it, and only
-- then deducts what was already billed:
--
--     Reimbursable cost of works to date        (cumulative, tax inclusive)
--     Management fee @ x% to date               (cumulative)
--     ------------------------------------------------------
--     Subtotal                                  (cumulative taxable value)
--     GST @ y% on the fee                       (cumulative tax)
--     Cumulative gross value
--     Less: previously billed                   (gross, matches gross)
--     ------------------------------------------------------
--     Net payable this bill
--
-- Every line is now defensible on its own. `less_previously_billed` becomes a
-- header column, and `total` is regenerated as
--     subtotal + gst_amount - less_previously_billed.
--
-- ---------- SECOND FIX: THE PERIOD TRAP ----------
-- The progress bill now always computes CUMULATIVELY from the start of the
-- project up to the chosen date, ignoring any start date. It has to: the
-- deduction subtracts everything ever billed, so if someone picked a narrow
-- window (say August only) the cost would be one month's while the deduction
-- was the whole project's, producing a large negative bill. `period_from` is
-- stored NULL on a progress bill to say plainly "cumulative to date".
-- Management-fee invoices and vendor vouchers stay period-based — they carry
-- no deduction, so a window is meaningful for them.
--
-- ---------- EXISTING ROWS ----------
-- Invoices raised under 024 keep their stored subtotal/gst and get
-- less_previously_billed = 0, so their totals do not move. A second progress
-- bill raised under 024 will still PRINT the old odd layout. Cancel and
-- re-raise it if it matters — issued invoices are immutable by design.
--
-- Re-runnable.
-- ============================================================


-- ############################################################
-- ###  1. HEADER COLUMN + REGENERATED TOTAL
-- ############################################################

alter table public.invoices
  add column if not exists less_previously_billed numeric(14,2) not null default 0;

-- A generated column can't be altered in place — drop and re-add. It moves to
-- the end of the column list; everything selects by name, so nothing breaks.
alter table public.invoices drop column if exists total;
alter table public.invoices
  add column total numeric(14,2)
  generated always as (subtotal + gst_amount - less_previously_billed) stored;

comment on column public.invoices.less_previously_billed is
  'Gross value already billed on earlier live progress invoices. Deducted '
  'AFTER tax, because it is itself a gross figure. Zero for every other type.';


-- ############################################################
-- ###  2. fn_issue_invoice — corrected progress branch
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
  v_prev     numeric(14,2) := 0;
  v_subtotal numeric(14,2) := 0;
  v_gst      numeric(14,2) := 0;
  v_vname    text;
  v_n        int;
  v_from     date;
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
  if p_to is null then
    raise exception 'A billing date is required.';
  end if;

  -- A progress bill is a RUNNING ACCOUNT: always cumulative from the start of
  -- the project. Any start date passed in is ignored, and stored as NULL.
  v_from := case when p_type = 'progress' then null else p_from end;

  if p_type <> 'progress' then
    if p_from is null then
      raise exception 'A billing period (from and to) is required.';
    end if;
    if p_to < p_from then
      raise exception 'The period ends before it starts.';
    end if;
  end if;

  -- Certified spend. fn_expense_total excludes voided expenses (020), so a
  -- reversed cost can never reach a client bill.
  select total_amount, total_with_gst
    into v_net, v_gross
  from public.fn_expense_total(p_project, v_from, p_to, null, null);

  v_net   := coalesce(v_net, 0);
  v_gross := coalesce(v_gross, 0);

  select coalesce(management_fee_pct, 0) into v_fee_pct
  from public.projects where id = p_project;

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
    (v_number, p_project, p_type::invoice_type, v_from, p_to,
     p_vendor, v_vname, coalesce(p_gst_pct, 0), p_notes)
  returning id into v_id;

  -- ---------------------------------------------------------- PROGRESS
  if p_type = 'progress' then
    v_fee := round(v_net * v_fee_pct / 100.0, 2);

    insert into public.invoice_items (invoice_id, sort, description, qty, unit, rate)
    values (v_id, 1,
            'Reimbursable cost of works executed to date (tax inclusive)',
            1, 'lot', v_gross);

    if v_fee_pct > 0 then
      insert into public.invoice_items (invoice_id, sort, description, qty, unit, rate)
      values (v_id, 2,
              'Management fee @ ' || trim(to_char(v_fee_pct, 'FM990.99')) ||
              '% on net cost to date of ' || trim(to_char(v_net, 'FM999999999.00')),
              1, 'lot', v_fee);
    end if;

    -- GST on the fee only; the reimbursed cost already bore its own tax.
    v_gst := round(v_fee * coalesce(p_gst_pct, 0) / 100.0, 2);

    -- Gross already billed on earlier live progress invoices. Deducted from
    -- the gross cumulative value below, NOT from the taxable subtotal.
    select coalesce(sum(total), 0) into v_prev
    from public.invoices
    where project_id = p_project
      and inv_type = 'progress'
      and status::text <> 'cancelled'
      and id <> v_id;

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

  -- Subtotal is the cumulative TAXABLE value, summed from the stored lines —
  -- the deduction is deliberately not in here.
  select coalesce(sum(amount), 0) into v_subtotal
  from public.invoice_items where invoice_id = v_id;

  update public.invoices
     set subtotal = v_subtotal,
         gst_amount = v_gst,
         less_previously_billed = v_prev
   where id = v_id;

  -- A cumulative bill that comes out negative means more has been billed than
  -- the project has cost — worth stopping on rather than issuing.
  if (v_subtotal + v_gst - v_prev) < 0 then
    delete from public.invoices where id = v_id;
    raise exception
      'That would produce a negative bill: cumulative value is % but % has already been billed. Check whether an earlier bill should be cancelled.',
      trim(to_char(v_subtotal + v_gst, 'FM999999999.00')),
      trim(to_char(v_prev, 'FM999999999.00'));
  end if;

  return v_id;
end $$;

revoke all on function public.fn_issue_invoice(uuid, text, date, date, uuid, numeric, text)
  from public, anon;
grant execute on function public.fn_issue_invoice(uuid, text, date, date, uuid, numeric, text)
  to authenticated;


-- ############################################################
-- ###  3. VERIFY
-- ############################################################
-- Expect: less_previously_billed present, and total generated.
select column_name, is_generated, generation_expression
from information_schema.columns
where table_schema = 'public' and table_name = 'invoices'
  and column_name in ('subtotal', 'gst_amount', 'less_previously_billed', 'total')
order by column_name;
