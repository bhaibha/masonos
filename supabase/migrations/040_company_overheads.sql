-- ============================================================
-- MASON OS — Migration 040: company overheads + true net position (M29 part 2)
--
-- 038 gave every project a gross margin. That is not profit: it ignores the
-- rent, the CA, the software, the salaries of people who never set foot on a
-- site. This migration adds those, and the arithmetic that turns margin into
-- an actual net figure.
--
-- ---------- WHY A DEDICATED TABLE, NOT A PSEUDO-PROJECT ----------
-- Overheads could have been an "Office" project with expenses hanging off it.
-- That would have poisoned every existing view: portfolio spend, budget vs
-- actual, the project P&L, the dashboard cards would all have had to learn to
-- exclude one magic row. A separate table with its own categories keeps
-- `expenses` meaning exactly what it has always meant — money spent ON A SITE.
--
-- ---------- MANUAL ONLY ----------
-- No recurrence, no auto-posting, no scheduled job. Rent that posts itself is
-- rent nobody checks. `fn_duplicate_overheads` copies a month forward when
-- asked, and refuses if the target month already has rows, so a double click
-- cannot double the office rent.
--
-- ---------- VOID, NOT DELETE ----------
-- Overheads are money, so they follow mechanism 2: the row stays, marked VOID
-- with a mandatory reason, and drops out of every total. There is no DELETE
-- policy, and `voided_at` has no UPDATE path from the client — the RPC is the
-- only way in.
--
-- It gets its OWN void function rather than a branch in `fn_void_record`. That
-- dispatcher exists to route project-scoped side effects — reversing stock,
-- unwinding a mirrored expense, refusing a void that would push inventory
-- negative. A company overhead has no project, no stock and no cascade, so a
-- branch there would be routing with nowhere to route. Same contract though:
-- mandatory reason, security definer, no client-side UPDATE path.
--
-- ---------- ACCESS ----------
-- founder + accounts only, at RLS. A PM sees project margins and never the
-- overheads or the net position — knowing the firm's rent is not part of
-- running a site. Supervisors are excluded from money entirely, as always.
--
-- ---------- PERIOD ----------
-- Overheads are inherently time-based; project margins are lifetime-to-date
-- (a contract's margin is judged over its whole life, not per month). The net
-- position therefore reads: project margins TO DATE, less overheads for the
-- CHOSEN PERIOD. The screen says exactly that. Picking "this financial year"
-- makes the comparison meaningful; picking "last month" tells you how one
-- month of overhead compares with lifetime margin, which is a different and
-- narrower question.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. CATEGORIES
-- ############################################################
-- An enum, not a table: these are the firm's own cost headings, they change
-- about once a year, and a lookup table would invite someone to "just add one"
-- mid-month and quietly split a year's reporting in two.
do $$ begin
  create type overhead_category as enum (
    'gst_tax',
    'license_statutory',
    'software',
    'office_rent',
    'office_utilities',
    'non_site_salaries',
    'professional_fees',
    'bank_charges',
    'marketing',
    'insurance_non_project',
    'depreciation',
    'misc');
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  2. TABLE
-- ############################################################

create table if not exists public.company_expenses (
  id uuid primary key default gen_random_uuid(),

  spend_date date not null default (now() at time zone 'Asia/Kolkata')::date,
  category overhead_category not null default 'misc',

  amount numeric(14,2) not null default 0 check (amount >= 0),
  gst_amount numeric(14,2) not null default 0 check (gst_amount >= 0),

  -- Linked vendor OR free text, the 017 pattern. The landlord and the CA are
  -- rarely in a construction vendor master.
  vendor_id uuid references public.vendors(id),
  vendor_name text,

  description text,
  proof_path text,                      -- receipts bucket, `company/` prefix

  -- Void columns, matching every other money table since 020.
  voided_at timestamptz,
  voided_by uuid references public.profiles(id),
  void_reason text,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists company_exp_date_idx
  on public.company_expenses (spend_date desc);
create index if not exists company_exp_live_idx
  on public.company_expenses (spend_date, category)
  where voided_at is null;

-- The same CHECK that makes a reason non-negotiable on every other void.
alter table public.company_expenses drop constraint if exists company_exp_void_ck;
alter table public.company_expenses add constraint company_exp_void_ck check (
  voided_at is null
  or (voided_by is not null and coalesce(btrim(void_reason), '') <> '')
);

comment on table public.company_expenses is
  'Business overheads — rent, salaries off site, software, statutory fees. '
  'Deliberately NOT project expenses: keeping them apart is what lets every '
  'existing project view stay correct without special cases.';


-- ############################################################
-- ###  3. RLS — founder and accounts only
-- ############################################################
alter table public.company_expenses enable row level security;

drop policy if exists overhead_read on public.company_expenses;
create policy overhead_read on public.company_expenses for select to authenticated
  using (public.my_role() in ('founder', 'accounts'));

drop policy if exists overhead_insert on public.company_expenses;
create policy overhead_insert on public.company_expenses for insert to authenticated
  with check (public.my_role() in ('founder', 'accounts'));

-- Editing an unvoided row is fine. Voiding is not done here: the CHECK above
-- means a client cannot set voided_at without also supplying a signatory and a
-- reason, and fn_void_company_expense is the only thing that does.
drop policy if exists overhead_update on public.company_expenses;
create policy overhead_update on public.company_expenses for update to authenticated
  using (public.my_role() in ('founder', 'accounts'))
  with check (public.my_role() in ('founder', 'accounts'));

-- No DELETE policy at all. Money is voided, never deleted.


-- ############################################################
-- ###  4. AUDIT
-- ############################################################
drop trigger if exists audit_company_expenses on public.company_expenses;
create trigger audit_company_expenses
  after insert or update or delete on public.company_expenses
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  5. STORAGE — proofs with no project
-- ############################################################
-- Overhead proofs live in `receipts` under a literal `company/` prefix, since
-- there is no project id to key the path off.
--
-- 006's existing receipts policies already resolve correctly here — is_member()
-- returns true for a founder and for accounts regardless of the project, and
-- false for everyone else — but that is an accident of how is_member() is
-- written, not a stated rule. These policies say it out loud, so a future edit
-- to is_member() can't silently open the firm's bank charges to a supervisor.
drop policy if exists receipts_company_read on storage.objects;
create policy receipts_company_read on storage.objects for select to authenticated
using (
  bucket_id = 'receipts'
  and split_part(name, '/', 1) = 'company'
  and public.my_role() in ('founder', 'accounts')
);

drop policy if exists receipts_company_insert on storage.objects;
create policy receipts_company_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'receipts'
  and split_part(name, '/', 1) = 'company'
  and public.my_role() in ('founder', 'accounts')
);


-- ############################################################
-- ###  6. VOID
-- ############################################################
create or replace function public.fn_void_company_expense(
  p_id     uuid,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_me uuid := auth.uid(); v_found uuid;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to void an overhead.' using errcode = '22023';
  end if;
  if public.my_role() not in ('founder', 'accounts') then
    raise exception 'Only a founder or accounts may void an overhead.'
      using errcode = '42501';
  end if;

  select id into v_found
  from public.company_expenses
  where id = p_id and voided_at is null;

  if v_found is null then
    raise exception 'That overhead no longer exists, or is already void.';
  end if;

  update public.company_expenses
     set voided_at = now(), voided_by = v_me,
         void_reason = btrim(p_reason), updated_at = now()
   where id = p_id;
end $$;

revoke all on function public.fn_void_company_expense(uuid, text) from public, anon;
grant execute on function public.fn_void_company_expense(uuid, text) to authenticated;


-- ############################################################
-- ###  7. DUPLICATE A MONTH FORWARD
-- ############################################################
-- Convenience, not automation: it copies one month's live rows into another
-- month, on the same day-of-month, for you to edit. It REFUSES if the target
-- month already has rows, because the failure mode of a copy button is copying
-- twice — and two months of office rent in one month is the kind of error that
-- survives to the annual accounts.
create or replace function public.fn_duplicate_overheads(
  p_source_month date,
  p_target_month date
)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_src_start date := date_trunc('month', p_source_month)::date;
  v_tgt_start date := date_trunc('month', p_target_month)::date;
  v_n int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'accounts') then
    raise exception 'Only a founder or accounts may copy overheads.'
      using errcode = '42501';
  end if;
  if v_src_start = v_tgt_start then
    raise exception 'Source and target month are the same.';
  end if;

  select count(*) into v_n
  from public.company_expenses
  where voided_at is null
    and spend_date >= v_tgt_start
    and spend_date < (v_tgt_start + interval '1 month')::date;

  if v_n > 0 then
    raise exception
      'That month already has % overhead entr%. Copying again would double them — void what is there first if you want to start over.',
      v_n, case when v_n = 1 then 'y' else 'ies' end;
  end if;

  insert into public.company_expenses
    (spend_date, category, amount, gst_amount, vendor_id, vendor_name,
     description, created_by)
  select
    -- Same day of month, clamped to a month that may be shorter.
    least(
      v_tgt_start + (extract(day from s.spend_date)::int - 1),
      (v_tgt_start + interval '1 month' - interval '1 day')::date
    ),
    s.category, s.amount, s.gst_amount, s.vendor_id, s.vendor_name,
    s.description, auth.uid()
  from public.company_expenses s
  where s.voided_at is null
    and s.spend_date >= v_src_start
    and s.spend_date < (v_src_start + interval '1 month')::date;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_duplicate_overheads(date, date) from public, anon;
grant execute on function public.fn_duplicate_overheads(date, date) to authenticated;


-- ############################################################
-- ###  8. OVERHEADS BY CATEGORY, FOR A PERIOD
-- ############################################################
create or replace function public.fn_overhead_summary(
  p_from date,
  p_to   date
)
returns table (
  category    text,
  entry_count int,
  amount      numeric,
  gst_amount  numeric,
  total       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.category::text,
    count(*)::int,
    sum(c.amount)::numeric(14,2),
    sum(c.gst_amount)::numeric(14,2),
    sum(c.amount + c.gst_amount)::numeric(14,2)
  from public.company_expenses c
  where c.voided_at is null
    and c.spend_date between p_from and p_to
    and public.my_role() in ('founder', 'accounts')
  group by c.category
  order by sum(c.amount + c.gst_amount) desc;
$$;

revoke all on function public.fn_overhead_summary(date, date) from public, anon;
grant execute on function public.fn_overhead_summary(date, date) to authenticated;


-- ############################################################
-- ###  9. THE NET POSITION
-- ############################################################
-- Three layers, in one row, so the screen cannot present them inconsistently:
--   project_margin  — Σ gross margin over the projects the caller can see,
--                     LIFETIME to date (038's definition)
--   overheads       — the firm's costs within the chosen period
--   net_position    — the first less the second
--
-- Founder and accounts only. A PM calling this gets zero overheads and a null
-- net, because they may not see the firm's cost base — the function returns
-- the margin they are entitled to and nothing else.
create or replace function public.fn_company_net(
  p_from date,
  p_to   date
)
returns table (
  project_margin  numeric,
  overheads       numeric,
  net_position    numeric,
  overhead_count  int,
  sees_overheads  boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with margin as (
    select coalesce(sum(gross_margin), 0)::numeric(14,2) as m
    from public.v_project_pnl
  ),
  oh as (
    select
      coalesce(sum(amount + gst_amount), 0)::numeric(14,2) as t,
      count(*)::int as n
    from public.company_expenses
    where voided_at is null
      and spend_date between p_from and p_to
      and public.my_role() in ('founder', 'accounts')
  )
  select
    margin.m,
    case when public.my_role() in ('founder', 'accounts') then oh.t end,
    case when public.my_role() in ('founder', 'accounts')
      then (margin.m - oh.t)::numeric(14,2) end,
    oh.n,
    public.my_role() in ('founder', 'accounts')
  from margin, oh;
$$;

revoke all on function public.fn_company_net(date, date) from public, anon;
grant execute on function public.fn_company_net(date, date) to authenticated;


-- ############################################################
-- ###  10. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'company_expenses'
order by ordinal_position;

-- Expect all four.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_void_company_expense', 'fn_duplicate_overheads',
                  'fn_overhead_summary', 'fn_company_net')
order by proname;

-- Both return nothing useful from the SQL editor — it connects as `postgres`
-- with no auth.uid(), so my_role() is NULL and every gate above is false.
-- That is the gate working. Verify through the app.
select * from public.fn_company_net(date_trunc('year', now())::date, now()::date);
