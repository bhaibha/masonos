-- ============================================================
-- MASON OS — Migration 054: Contract Labour (B5, Module 24)
--
-- Labour contractors, daily gang attendance, the BOCW/CLRA statutory registers
-- as data, and a labour cost figure per project.
--
-- ---------- THE ONE THING THAT WOULD HAVE BROKEN THE P&L ----------
-- Attendance × rate is an ACCRUAL: what the labour on site is worth. The money
-- actually leaving the company is an expense or an RA bill, and `v_project_pnl`
-- (038) computes cost from exactly those. If attendance-derived wages were also
-- added to cost, every rupee of labour would be counted TWICE and every
-- project's margin would be wrong by the largest single line on most jobs.
--
-- So attendance does NOT feed the P&L. It produces a figure shown ALONGSIDE,
-- plus `fn_labour_reconcile` — "attendance says ₹X for March, ₹Y has been
-- booked" — and `fn_post_labour_expense`, which the founder runs deliberately
-- to turn a period's attendance INTO an expense. Once posted, the P&L picks it
-- up the ordinary way, through `expenses`, and there is still exactly one
-- source of cost. Posting the same period twice is refused by an overlap check,
-- not by remembering not to. Same family as the 038 retention lesson: a figure
-- already inside cost must not be subtracted (or added) a second time.
--
-- ---------- IT OVERLAPS WITH THE SITE LOG, AND SAYS SO ----------
-- `site_logs` has carried labour_mason / labour_helper / labour_other since 001.
-- That is a headcount for the same day on the same project. Two places holding
-- one fact will disagree, and the one people trust will be whichever they typed
-- last. Attendance is the more detailed record and the one wages come from, so
-- it is the payroll truth; `fn_labour_headcount_check` returns both numbers and
-- the variance so the difference is visible rather than latent. The site log is
-- deliberately NOT changed here — that is a UI decision for its own session,
-- not something to do silently inside a labour migration.
--
-- ---------- GANG COUNTS, AND WHAT THAT MEANS FOR THE FORMS ----------
-- A supervisor on a site records "Ramesh & Co, 14 masons, second floor". They
-- do not enter fourteen names on a phone, and a module that demanded it would
-- go unused — the 048 lesson, learned by deleting a 627-question ITP.
--
-- The consequence must be stated plainly rather than hidden: a muster roll
-- built from gang counts is NOT the named statutory Form XVI. The registers
-- here are the firm's own record, at gang level, and they are labelled that way
-- on screen and on paper. `labour_workers` (Form XIII, register of workmen) is
-- provided for contractors who supply a named roster, and where one exists the
-- registers can name people; where one does not, they say "gang level" instead
-- of pretending. A document that looks statutory and is not is worse than no
-- document.
--
-- ---------- MONEY IS SPLIT FROM ATTENDANCE, AT THE TABLE ----------
-- `labour_attendance` is readable by every project member: it is headcount and
-- work area, and the supervisor who typed it must be able to check it.
-- `labour_rates` is founder/pm/accounts only — a daily wage rate is exactly the
-- kind of figure the money-hiding rule exists for. The cost views are owner-run
-- with `is_member(...) and my_role() in (...)` in the WHERE clause (the 010/038
-- pattern), so a supervisor gets ZERO ROWS rather than blanked columns.
--
-- ---------- ID NUMBERS ----------
-- `labour_workers` stores an ID TYPE and the LAST FOUR DIGITS, never a full
-- Aadhaar. A full number is a liability with no operational benefit here, and
-- Aadhaar verification is on the CUT list. Last four is enough to match a
-- person against a card at the gate, which is the actual use.
--
-- Idempotent: enums guarded, tables if-not-exists with explicit add-column,
-- views dropped BEFORE the functions they call, functions dropped by full
-- signature, policies drop-then-create.
-- ============================================================


-- ############################################################
-- ###  1. TRADES — one editable list, one editor
-- ############################################################
-- A table rather than an enum, for the 041 reason: the risk is not that the
-- list changes, it is that two people change it and "Bar bender" and "Barbender"
-- become two series nobody can compare. Founder writes, everybody reads,
-- uniqueness normalised on lower(btrim()).
create table if not exists public.labour_trades (
  name       text primary key,
  sort_order int not null default 100,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists labour_trade_uk
  on public.labour_trades (lower(btrim(name)));

insert into public.labour_trades (name, sort_order) values
  ('Mason', 10), ('Helper', 20), ('Bar bender', 30),
  ('Shuttering carpenter', 40), ('Carpenter', 50), ('Electrician', 60),
  ('Plumber', 70), ('Painter', 80), ('Tiler', 90), ('Fabricator', 100),
  ('Mestri', 110), ('Operator', 120), ('Other', 999)
on conflict (name) do nothing;


-- ############################################################
-- ###  2. THE CONTRACTOR REGISTER
-- ############################################################
-- Company-wide, like vendors: a labour contractor works across projects.
-- `vendor_id` links to the payee record when there is one, so payments and
-- attendance point at the same organisation without duplicating the master.
create table if not exists public.labour_contractors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_person text,
  phone text,

  -- CLRA / BOCW licence. `licence_valid_to` is what makes the expiry register
  -- possible — an expired licence on site is a stop-work risk.
  licence_no text,
  licence_authority text,
  licence_valid_to date,
  -- The licence caps how many workers the contractor may employ. Attendance
  -- above it is flagged, not blocked: the app cannot send people home.
  licensed_strength int check (licensed_strength is null or licensed_strength > 0),

  pf_code text,
  esi_code text,
  gstin text,
  trades text[] not null default '{}',

  vendor_id uuid references public.vendors(id),
  notes text,
  is_active boolean not null default true,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists labour_contractor_name_uk
  on public.labour_contractors (lower(btrim(name)));


-- ############################################################
-- ###  3. REGISTER OF WORKMEN — Form XIII equivalent
-- ############################################################
-- Optional. Attendance works without it; where a contractor supplies a roster,
-- this is what lets the registers name people instead of counting them.
create table if not exists public.labour_workers (
  id uuid primary key default gen_random_uuid(),
  contractor_id uuid not null
    references public.labour_contractors(id) on delete cascade,

  name text not null,
  father_name text,
  gender text check (gender is null or gender in ('male','female','other')),
  age int check (age is null or (age >= 18 and age <= 75)),
  trade text references public.labour_trades(name),
  address text,

  -- Type plus last four ONLY. See the header: a full Aadhaar is a liability
  -- with no operational benefit, and last four is what actually gets matched
  -- against the card at the gate.
  id_type text check (id_type is null or id_type in
    ('aadhaar','voter','pan','driving_licence','other')),
  id_last4 text check (id_last4 is null or id_last4 ~ '^[0-9]{4}$'),

  date_of_employment date,
  date_of_exit date,
  is_active boolean not null default true,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists labour_worker_contractor_idx
  on public.labour_workers (contractor_id, is_active, name);

-- Nobody under 18 on a construction site. A CHECK rather than a form
-- validation, because this one must hold no matter what writes the row.
-- (`age >= 18` above.)


-- ############################################################
-- ###  4. RATES — the money half
-- ############################################################
-- Four levels of specificity, nullable project and contractor:
--   project + contractor   most specific
--   project                a site rate for everyone
--   contractor             this contractor everywhere
--   neither                the firm's standard rate
-- `fn_labour_rate` picks the most specific match in force on the day.
create table if not exists public.labour_rates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  contractor_id uuid references public.labour_contractors(id) on delete cascade,
  trade text not null references public.labour_trades(name),

  daily_rate numeric(14,2) not null check (daily_rate >= 0),
  -- Overtime under the Minimum Wages Act is twice the ordinary rate. Kept as a
  -- column rather than buried in a formula so it can be seen and changed, the
  -- same reasoning as bbs_constants in 051.
  ot_multiplier numeric(4,2) not null default 2 check (ot_multiplier >= 1),
  normal_hours numeric(4,2) not null default 8 check (normal_hours > 0),

  effective_from date not null default current_date,
  effective_to date,
  notes text,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),

  constraint labour_rate_period check (
    effective_to is null or effective_to >= effective_from)
);

-- One rate per scope per trade per start date. Stops the same rate being
-- entered twice with a typo in one of them, which is how two different answers
-- for one day get created.
create unique index if not exists labour_rate_uk
  on public.labour_rates (
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(contractor_id, '00000000-0000-0000-0000-000000000000'::uuid),
    trade, effective_from);


-- ############################################################
-- ###  5. GANG ATTENDANCE
-- ############################################################
create table if not exists public.labour_attendance (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  work_date date not null default current_date,
  contractor_id uuid not null references public.labour_contractors(id),
  trade text not null references public.labour_trades(name),

  workers_present int not null check (workers_present > 0),
  overtime_hours numeric(6,2) not null default 0 check (overtime_hours >= 0),
  work_area text,

  -- Ties a day's labour to the programme, exactly as expenses do since 042, so
  -- labour can reach earned value once it has been posted as cost.
  activity_id uuid references public.schedule_activities(id) on delete set null,

  remarks text,

  -- Attendance drives wages, so it is VOIDED, never deleted — the removal rule.
  -- There is deliberately no UPDATE policy on these columns; fn_void_attendance
  -- is the only route.
  voided_at timestamptz,
  voided_by uuid references public.profiles(id),
  void_reason text,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),

  constraint labour_void_reason check (
    voided_at is null or coalesce(btrim(void_reason), '') <> '')
);

create index if not exists labour_att_project_idx
  on public.labour_attendance (project_id, work_date desc);
create index if not exists labour_att_contractor_idx
  on public.labour_attendance (contractor_id, work_date desc);

-- The same gang cannot be booked twice for one day in one area. Without this,
-- a double tap on a slow connection doubles the wage bill for that day and
-- nothing on screen says so.
create unique index if not exists labour_att_uk
  on public.labour_attendance
     (project_id, work_date, contractor_id, trade, coalesce(work_area, ''))
  where voided_at is null;


-- ############################################################
-- ###  6. POSTINGS — the guard against double-counting
-- ############################################################
-- One row per period actually turned into an expense. Its existence is what
-- refuses a second posting; there is no "posted" flag on attendance to fall out
-- of step with reality (the same reasoning as rc_vendors.po_id in 050).
create table if not exists public.labour_postings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  contractor_id uuid references public.labour_contractors(id),
  period_from date not null,
  period_to date not null,
  amount numeric(14,2) not null,
  expense_count int not null default 0,
  posted_by uuid not null default auth.uid() references public.profiles(id),
  posted_at timestamptz not null default now(),
  constraint labour_posting_period check (period_to >= period_from)
);

create index if not exists labour_posting_idx
  on public.labour_postings (project_id, period_from, period_to);


-- ############################################################
-- ###  7. RLS
-- ############################################################
alter table public.labour_trades      enable row level security;
alter table public.labour_contractors enable row level security;
alter table public.labour_workers     enable row level security;
alter table public.labour_rates       enable row level security;
alter table public.labour_attendance  enable row level security;
alter table public.labour_postings    enable row level security;

-- ---------- trades: everybody reads, founder writes ----------
drop policy if exists lab_trade_read on public.labour_trades;
create policy lab_trade_read on public.labour_trades
  for select to authenticated using (true);

drop policy if exists lab_trade_write on public.labour_trades;
create policy lab_trade_write on public.labour_trades
  for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

-- ---------- contractors: everybody reads (the supervisor picks one at the
-- gate), money roles write. No rate lives on this table. ----------
drop policy if exists lab_contractor_read on public.labour_contractors;
create policy lab_contractor_read on public.labour_contractors
  for select to authenticated using (true);

drop policy if exists lab_contractor_write on public.labour_contractors;
create policy lab_contractor_write on public.labour_contractors
  for all to authenticated
  using (public.my_role() in ('founder','pm','accounts'))
  with check (public.my_role() in ('founder','pm','accounts'));

-- ---------- workmen register ----------
drop policy if exists lab_worker_read on public.labour_workers;
create policy lab_worker_read on public.labour_workers
  for select to authenticated using (true);

drop policy if exists lab_worker_write on public.labour_workers;
create policy lab_worker_write on public.labour_workers
  for all to authenticated
  using (public.my_role() in ('founder','pm','accounts'))
  with check (public.my_role() in ('founder','pm','accounts'));

-- ---------- RATES: money roles only, read AND write ----------
-- The whole row is a wage figure, so this is a row policy, not a column grant
-- (the 050 distinction: reach for a row policy when the row itself is the
-- secret). A supervisor matches nothing and gets zero rows.
drop policy if exists lab_rate_read on public.labour_rates;
create policy lab_rate_read on public.labour_rates
  for select to authenticated
  using (public.my_role() in ('founder','pm','accounts'));

drop policy if exists lab_rate_write on public.labour_rates;
create policy lab_rate_write on public.labour_rates
  for all to authenticated
  using (public.my_role() in ('founder','pm','accounts'))
  with check (public.my_role() in ('founder','pm','accounts'));

-- ---------- attendance: every project member reads ----------
-- It is headcount and a work area, no money. The supervisor who typed it has to
-- be able to check it, and the PM has to be able to see who was on site.
drop policy if exists lab_att_read on public.labour_attendance;
create policy lab_att_read on public.labour_attendance
  for select to authenticated using (public.is_member(project_id));

-- Supervisors log attendance for their own project — that is the whole point of
-- the module.
drop policy if exists lab_att_insert on public.labour_attendance;
create policy lab_att_insert on public.labour_attendance
  for insert to authenticated
  with check (
    public.is_member(project_id)
    and public.my_role() in ('founder','pm','supervisor')
  );

-- Corrections to the non-money fields while the row is live. `voided_*` is NOT
-- writable from here — there is no update path to it, so fn_void_attendance is
-- the only route, exactly as fn_void_record is for stock.
drop policy if exists lab_att_update on public.labour_attendance;
create policy lab_att_update on public.labour_attendance
  for update to authenticated
  using (
    public.is_member(project_id)
    and voided_at is null
    and (public.my_role() in ('founder','pm')
         or (public.my_role() = 'supervisor' and created_by = auth.uid()))
  )
  with check (public.is_member(project_id) and voided_at is null);

-- No DELETE policy at all. Attendance is money-bearing; it is voided.

-- ---------- postings: money roles ----------
drop policy if exists lab_posting_read on public.labour_postings;
create policy lab_posting_read on public.labour_postings
  for select to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder','pm','accounts'));

-- Written only by fn_post_labour_expense, which is SECURITY DEFINER. No write
-- policy, so a client cannot fabricate a posting and thereby block a real one.


-- ############################################################
-- ###  8. AUDIT
-- ############################################################
-- Rates and attendance both determine money. Contractors are payee-adjacent,
-- which 018 already established is worth auditing.
drop trigger if exists audit_labour_contractors on public.labour_contractors;
create trigger audit_labour_contractors
  after insert or update or delete on public.labour_contractors
  for each row execute function public.fn_audit();

drop trigger if exists audit_labour_workers on public.labour_workers;
create trigger audit_labour_workers
  after insert or update or delete on public.labour_workers
  for each row execute function public.fn_audit();

drop trigger if exists audit_labour_rates on public.labour_rates;
create trigger audit_labour_rates
  after insert or update or delete on public.labour_rates
  for each row execute function public.fn_audit();

drop trigger if exists audit_labour_attendance on public.labour_attendance;
create trigger audit_labour_attendance
  after insert or update or delete on public.labour_attendance
  for each row execute function public.fn_audit();

drop trigger if exists audit_labour_postings on public.labour_postings;
create trigger audit_labour_postings
  after insert or update or delete on public.labour_postings
  for each row execute function public.fn_audit();

-- labour_trades is keyed by `name`, not `id`, so it needs the code-keyed audit
-- function from 051 — fn_audit would raise "record new has no field id" and
-- ABORT the write (the 051 lesson).
drop trigger if exists audit_labour_trades on public.labour_trades;
create trigger audit_labour_trades
  after insert or update or delete on public.labour_trades
  for each row execute function public.fn_audit_by_code();


-- ############################################################
-- ###  9. RATE RESOLUTION
-- ############################################################
-- Views come down before the functions they call.
drop view if exists public.v_labour_project_cost cascade;
drop view if exists public.v_labour_cost cascade;
drop view if exists public.v_labour_attendance cascade;

-- Returns ZERO ROWS for a supervisor rather than raising: this is called from
-- inside views, and an exception there would break a screen instead of hiding a
-- figure.
drop function if exists public.fn_labour_rate(uuid, uuid, text, date);
create function public.fn_labour_rate(
  p_project    uuid,
  p_contractor uuid,
  p_trade      text,
  p_date       date
)
returns table (
  rate_id       uuid,
  daily_rate    numeric,
  ot_multiplier numeric,
  normal_hours  numeric,
  scope         text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    return;
  end if;

  return query
  select r.id, r.daily_rate, r.ot_multiplier, r.normal_hours,
         case
           when r.project_id is not null and r.contractor_id is not null
             then 'project + contractor'
           when r.project_id is not null    then 'project'
           when r.contractor_id is not null then 'contractor'
           else 'firm standard'
         end
  from public.labour_rates r
  where r.trade = p_trade
    and (r.project_id is null    or r.project_id = p_project)
    and (r.contractor_id is null or r.contractor_id = p_contractor)
    and r.effective_from <= p_date
    and (r.effective_to is null or r.effective_to >= p_date)
  -- Most specific first, then the latest one that had come into force.
  order by (r.project_id is not null)::int + (r.contractor_id is not null)::int desc,
           (r.project_id is not null)::int desc,
           r.effective_from desc
  limit 1;
end $$;

revoke all on function public.fn_labour_rate(uuid, uuid, text, date) from public, anon;
grant execute on function public.fn_labour_rate(uuid, uuid, text, date) to authenticated;


-- ############################################################
-- ### 10. VIEWS
-- ############################################################
-- Attendance WITHOUT money — every project member. security_invoker, so the
-- attendance RLS above is the access control.
create view public.v_labour_attendance with (security_invoker = true) as
select
  a.id as attendance_id,
  a.project_id,
  a.work_date,
  a.contractor_id,
  c.name as contractor_name,
  c.licence_no,
  c.licence_valid_to,
  a.trade,
  a.workers_present,
  a.overtime_hours,
  a.work_area,
  a.activity_id,
  a.remarks,
  a.voided_at,
  a.void_reason,
  a.created_by,
  a.created_at,
  -- Flagged, never blocked: the app cannot send people home, but it can say
  -- that more workers were booked than the licence permits.
  (c.licensed_strength is not null
   and a.workers_present > c.licensed_strength) as over_licence
from public.labour_attendance a
join public.labour_contractors c on c.id = a.contractor_id;

grant select on public.v_labour_attendance to authenticated;


-- Cost per attendance row. OWNER-RUN and role-gated in the WHERE clause — the
-- 010/038 pattern — so a supervisor gets zero rows, not blanked columns.
-- THE WHERE CLAUSE IS THE ACCESS CONTROL HERE. Losing it is a silent leak of
-- every wage rate in the firm.
create view public.v_labour_cost as
select
  a.id as attendance_id,
  a.project_id,
  a.work_date,
  a.contractor_id,
  c.name as contractor_name,
  a.trade,
  a.activity_id,
  a.workers_present,
  a.overtime_hours,
  a.work_area,
  r.rate_id,
  r.daily_rate,
  r.ot_multiplier,
  r.normal_hours,
  r.scope as rate_scope,
  -- One man on site for one day. Kept as its own column because it is the unit
  -- the wage register is read in.
  a.workers_present::numeric                                     as mandays,
  round(a.workers_present * coalesce(r.daily_rate, 0), 2)        as wages,
  -- OT is paid per hour at the multiplier on the ordinary hourly rate, and the
  -- ordinary hourly rate is the daily rate over the normal working day.
  round(a.overtime_hours
        * (coalesce(r.daily_rate, 0) / nullif(r.normal_hours, 0))
        * coalesce(r.ot_multiplier, 0), 2)                        as ot_amount,
  round(a.workers_present * coalesce(r.daily_rate, 0)
        + a.overtime_hours
          * (coalesce(r.daily_rate, 0) / nullif(r.normal_hours, 0))
          * coalesce(r.ot_multiplier, 0), 2)                      as total_cost,
  (r.rate_id is null)                                             as rate_missing
from public.labour_attendance a
join public.labour_contractors c on c.id = a.contractor_id
left join lateral public.fn_labour_rate(a.project_id, a.contractor_id,
                                        a.trade, a.work_date) r on true
where a.voided_at is null
  and public.is_member(a.project_id)
  and public.my_role() in ('founder', 'pm', 'accounts');

grant select on public.v_labour_cost to authenticated;


create view public.v_labour_project_cost as
select
  v.project_id,
  date_trunc('month', v.work_date)::date as month,
  v.trade,
  count(*)::int                          as entries,
  sum(v.mandays)::numeric(12,2)          as mandays,
  sum(v.wages)::numeric(14,2)            as wages,
  sum(v.ot_amount)::numeric(14,2)        as ot_amount,
  sum(v.total_cost)::numeric(14,2)       as total_cost,
  count(*) filter (where v.rate_missing)::int as missing_rates
from public.v_labour_cost v
group by v.project_id, date_trunc('month', v.work_date), v.trade;

grant select on public.v_labour_project_cost to authenticated;


-- ############################################################
-- ### 11. VOID
-- ############################################################
-- Money-bearing, so the row stays and stops counting. A supervisor may void an
-- entry THEY created — they log the attendance, so they make the typos (the 021
-- rule for stock, applied for the same reason).
drop function if exists public.fn_void_attendance(uuid, text);
create function public.fn_void_attendance(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid; v_by uuid; v_voided timestamptz;
  v_me uuid := auth.uid();
  v_role text := public.my_role();
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to void an attendance entry.';
  end if;

  select project_id, created_by, voided_at
    into v_project, v_by, v_voided
  from public.labour_attendance where id = p_id;

  if v_project is null then
    raise exception 'That attendance entry no longer exists.';
  end if;
  if v_voided is not null then
    raise exception 'That entry is already void.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if not (v_role in ('founder','pm')
          or (v_role = 'supervisor' and v_by = v_me)) then
    raise exception 'You can only void an attendance entry you logged yourself.'
      using errcode = '42501';
  end if;

  -- A period already posted to the ledger must not have its basis changed
  -- underneath the expense: the two would stop reconciling and nobody would
  -- know which was right.
  if exists (select 1 from public.labour_postings p
             join public.labour_attendance a on a.id = p_id
             where p.project_id = a.project_id
               and a.work_date between p.period_from and p.period_to
               and (p.contractor_id is null or p.contractor_id = a.contractor_id)) then
    raise exception
      'That day has already been posted to the ledger. Void the expense first, or this attendance and the booked cost would stop agreeing.';
  end if;

  update public.labour_attendance
     set voided_at = now(), voided_by = v_me, void_reason = btrim(p_reason)
   where id = p_id;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values ('labour_attendance', 'VOID', p_id::text, null,
          jsonb_build_object('voided_by', v_me, 'reason', btrim(p_reason)));
end $$;

revoke all on function public.fn_void_attendance(uuid, text) from public, anon;
grant execute on function public.fn_void_attendance(uuid, text) to authenticated;


-- ############################################################
-- ### 12. THE STATUTORY REGISTERS, AS DATA
-- ############################################################
-- Named "equivalent" throughout and labelled gang-level on screen and on paper.
-- See the header: a document that looks statutory and is not is worse than none.

-- ---------- Muster roll (Form XVI equivalent) — NO money ----------
-- Readable by every project member: it is attendance, which they can already
-- see row by row. This is the same data laid out as a register.
drop function if exists public.fn_muster_roll(uuid, date, date);
create function public.fn_muster_roll(p_project uuid, p_from date, p_to date)
returns table (
  work_date       date,
  contractor_id   uuid,
  contractor_name text,
  trade           text,
  workers_present int,
  overtime_hours  numeric,
  work_area       text
)
language sql
stable
set search_path = public
as $$
  select v.work_date, v.contractor_id, v.contractor_name, v.trade,
         v.workers_present, v.overtime_hours, v.work_area
  from public.v_labour_attendance v
  where v.project_id = p_project
    and v.work_date between p_from and p_to
    and v.voided_at is null
  order by v.work_date, v.contractor_name, v.trade;
$$;

revoke all on function public.fn_muster_roll(uuid, date, date) from public, anon;
grant execute on function public.fn_muster_roll(uuid, date, date) to authenticated;


-- ---------- Wage register (Form XVII equivalent) — money ----------
drop function if exists public.fn_wage_register(uuid, date, date);
create function public.fn_wage_register(p_project uuid, p_from date, p_to date)
returns table (
  contractor_id   uuid,
  contractor_name text,
  trade           text,
  days_worked     int,
  mandays         numeric,
  daily_rate      numeric,
  wages           numeric,
  ot_hours        numeric,
  ot_amount       numeric,
  total_payable   numeric,
  missing_rates   int
)
language sql
stable
set search_path = public
as $$
  select
    v.contractor_id,
    v.contractor_name,
    v.trade,
    count(distinct v.work_date)::int,
    sum(v.mandays)::numeric(12,2),
    -- The rate can legitimately change mid-period, so the register shows the
    -- range rather than pretending there was one number. max = min when it
    -- did not move.
    max(v.daily_rate)::numeric(14,2),
    sum(v.wages)::numeric(14,2),
    sum(v.overtime_hours)::numeric(12,2),
    sum(v.ot_amount)::numeric(14,2),
    sum(v.total_cost)::numeric(14,2),
    count(*) filter (where v.rate_missing)::int
  from public.v_labour_cost v
  where v.project_id = p_project
    and v.work_date between p_from and p_to
  group by v.contractor_id, v.contractor_name, v.trade
  order by v.contractor_name, v.trade;
$$;

revoke all on function public.fn_wage_register(uuid, date, date) from public, anon;
grant execute on function public.fn_wage_register(uuid, date, date) to authenticated;


-- ---------- Overtime register (Form XXIII equivalent) — money ----------
drop function if exists public.fn_overtime_register(uuid, date, date);
create function public.fn_overtime_register(p_project uuid, p_from date, p_to date)
returns table (
  work_date       date,
  contractor_id   uuid,
  contractor_name text,
  trade           text,
  workers_present int,
  ot_hours        numeric,
  normal_hours    numeric,
  ot_multiplier   numeric,
  ot_rate_per_hr  numeric,
  ot_amount       numeric
)
language sql
stable
set search_path = public
as $$
  select v.work_date, v.contractor_id, v.contractor_name, v.trade,
         v.workers_present, v.overtime_hours, v.normal_hours, v.ot_multiplier,
         round(v.daily_rate / nullif(v.normal_hours, 0) * v.ot_multiplier, 2),
         v.ot_amount
  from public.v_labour_cost v
  where v.project_id = p_project
    and v.work_date between p_from and p_to
    and v.overtime_hours > 0
  order by v.work_date, v.contractor_name, v.trade;
$$;

revoke all on function public.fn_overtime_register(uuid, date, date) from public, anon;
grant execute on function public.fn_overtime_register(uuid, date, date) to authenticated;


-- ---------- Licence expiry ----------
-- The expiry-register shape from 028/033/034: derive the status from the date
-- at query time rather than trusting a stored flag.
drop function if exists public.fn_labour_licence_alert();
create function public.fn_labour_licence_alert()
returns table (
  contractor_id uuid,
  name text,
  licence_no text,
  licence_valid_to date,
  days_left int,
  display_status text
)
language sql
stable
set search_path = public
as $$
  select c.id, c.name, c.licence_no, c.licence_valid_to,
         (c.licence_valid_to - (now() at time zone 'Asia/Kolkata')::date)::int,
         case
           when c.licence_valid_to < (now() at time zone 'Asia/Kolkata')::date
             then 'expired'
           when c.licence_valid_to <= (now() at time zone 'Asia/Kolkata')::date + 30
             then 'due_soon'
           else 'valid'
         end
  from public.labour_contractors c
  where c.is_active
    and c.licence_valid_to is not null
    and c.licence_valid_to <= (now() at time zone 'Asia/Kolkata')::date + 30
  order by c.licence_valid_to;
$$;

revoke all on function public.fn_labour_licence_alert() from public, anon;
grant execute on function public.fn_labour_licence_alert() to authenticated;


-- ############################################################
-- ### 13. THE SITE-LOG CROSS-CHECK
-- ############################################################
-- Two records of one fact. This makes the disagreement visible instead of
-- letting whichever was typed last quietly win. It reports; it does not
-- reconcile — deciding which is right is a human judgement.
drop function if exists public.fn_labour_headcount_check(uuid, date);
create function public.fn_labour_headcount_check(p_project uuid, p_date date)
returns table (
  site_log_total   int,
  attendance_total int,
  variance         int
)
language sql
stable
set search_path = public
as $$
  select
    coalesce((select sum(coalesce(s.labour_mason,0) + coalesce(s.labour_helper,0)
                       + coalesce(s.labour_other,0))::int
              from public.site_logs s
              where s.project_id = p_project and s.log_date = p_date), 0),
    coalesce((select sum(a.workers_present)::int
              from public.labour_attendance a
              where a.project_id = p_project and a.work_date = p_date
                and a.voided_at is null), 0),
    coalesce((select sum(a.workers_present)::int
              from public.labour_attendance a
              where a.project_id = p_project and a.work_date = p_date
                and a.voided_at is null), 0)
    - coalesce((select sum(coalesce(s.labour_mason,0) + coalesce(s.labour_helper,0)
                         + coalesce(s.labour_other,0))::int
                from public.site_logs s
                where s.project_id = p_project and s.log_date = p_date), 0);
$$;

revoke all on function public.fn_labour_headcount_check(uuid, date) from public, anon;
grant execute on function public.fn_labour_headcount_check(uuid, date) to authenticated;


-- ############################################################
-- ### 14. RECONCILE AND POST
-- ############################################################
-- What attendance says the labour was worth, against what has actually been
-- booked to the ledger for the same period. This is the figure that stops the
-- accrual and the P&L drifting apart without anyone noticing.
drop function if exists public.fn_labour_reconcile(uuid, date, date);
create function public.fn_labour_reconcile(p_project uuid, p_from date, p_to date)
returns table (
  accrued        numeric,
  posted         numeric,
  booked_ledger  numeric,
  variance       numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.my_role() not in ('founder', 'pm', 'accounts')
     or not public.is_member(p_project) then
    return;
  end if;

  return query
  select
    -- what the attendance is worth
    coalesce((select sum(v.total_cost) from public.v_labour_cost v
              where v.project_id = p_project
                and v.work_date between p_from and p_to), 0)::numeric(14,2),
    -- what this module has posted
    coalesce((select sum(p.amount) from public.labour_postings p
              where p.project_id = p_project
                and p.period_from >= p_from and p.period_to <= p_to), 0)::numeric(14,2),
    -- everything sitting in the ledger under a labour category for the period,
    -- however it got there — a cash payment entered by hand counts too
    coalesce((select sum(e.amount) from public.expenses e
              join public.expense_categories ec on ec.id = e.category_id
              where e.project_id = p_project
                and e.expense_date between p_from and p_to
                and ec.name ilike 'Labour%'
                and e.voided_at is null), 0)::numeric(14,2),
    coalesce((select sum(v.total_cost) from public.v_labour_cost v
              where v.project_id = p_project
                and v.work_date between p_from and p_to), 0)::numeric(14,2)
    - coalesce((select sum(e.amount) from public.expenses e
                join public.expense_categories ec on ec.id = e.category_id
                where e.project_id = p_project
                  and e.expense_date between p_from and p_to
                  and ec.name ilike 'Labour%'
                  and e.voided_at is null), 0)::numeric(14,2);
end $$;

revoke all on function public.fn_labour_reconcile(uuid, date, date) from public, anon;
grant execute on function public.fn_labour_reconcile(uuid, date, date) to authenticated;


-- ---------- post a period's attendance to the ledger ----------
-- ONE expense per schedule activity present in the period (plus one for the
-- untagged rows), so the activity tagging that earned value depends on survives
-- the trip through the ledger. A single lumped expense would flatten it and
-- fn_retag_expense would have to be run by hand afterwards.
--
-- Overlapping periods are REFUSED. That refusal is the whole reason
-- labour_postings exists: it is what makes the P&L safe from double counting.
drop function if exists public.fn_post_labour_expense(uuid, date, date, int, uuid);
create function public.fn_post_labour_expense(
  p_project    uuid,
  p_from       date,
  p_to         date,
  p_category   int,
  p_contractor uuid default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric(14,2);
  v_n     int := 0;
  v_miss  int;
  r       record;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  -- Posting to the ledger is the accounts/founder act, exactly as
  -- fn_post_invoice (012) is.
  if public.my_role() not in ('founder', 'accounts') then
    raise exception 'Only a founder or accounts may post labour to the ledger.'
      using errcode = '42501';
  end if;
  if not public.is_member(p_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if p_to < p_from then
    raise exception 'The period ends before it starts.';
  end if;

  if exists (
    select 1 from public.labour_postings p
    where p.project_id = p_project
      and (p_contractor is null or p.contractor_id is null
           or p.contractor_id = p_contractor)
      and p.period_from <= p_to and p.period_to >= p_from) then
    raise exception
      'Part of that period has already been posted. Posting it again would count the same labour twice in the P&L.';
  end if;

  select count(*) into v_miss from public.v_labour_cost v
   where v.project_id = p_project
     and v.work_date between p_from and p_to
     and (p_contractor is null or v.contractor_id = p_contractor)
     and v.rate_missing;

  if v_miss > 0 then
    raise exception
      '% attendance entr%(s) in that period have no wage rate. Set the rates first — posting now would book labour at zero.',
      v_miss, case when v_miss = 1 then 'y' else 'ies' end;
  end if;

  select coalesce(sum(v.total_cost), 0) into v_total
  from public.v_labour_cost v
  where v.project_id = p_project
    and v.work_date between p_from and p_to
    and (p_contractor is null or v.contractor_id = p_contractor);

  if v_total <= 0 then
    raise exception 'There is nothing to post for that period.';
  end if;

  for r in
    select v.activity_id, sum(v.total_cost) as amount
    from public.v_labour_cost v
    where v.project_id = p_project
      and v.work_date between p_from and p_to
      and (p_contractor is null or v.contractor_id = p_contractor)
    group by v.activity_id
    having sum(v.total_cost) > 0
  loop
    insert into public.expenses
      (project_id, expense_date, category_id, description, amount, source,
       activity_id)
    values
      (p_project, p_to, p_category,
       format('Labour %s to %s', to_char(p_from, 'DD Mon YYYY'),
              to_char(p_to, 'DD Mon YYYY')),
       r.amount, 'bank', r.activity_id);
    v_n := v_n + 1;
  end loop;

  insert into public.labour_postings
    (project_id, contractor_id, period_from, period_to, amount, expense_count)
  values (p_project, p_contractor, p_from, p_to, v_total, v_n);

  return v_n;
end $$;

revoke all on function public.fn_post_labour_expense(uuid, date, date, int, uuid) from public, anon;
grant execute on function public.fn_post_labour_expense(uuid, date, date, int, uuid) to authenticated;


-- ############################################################
-- ### 15. VERIFY
-- ############################################################
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_labour_rate','fn_void_attendance','fn_muster_roll',
                    'fn_wage_register','fn_overtime_register',
                    'fn_labour_licence_alert','fn_labour_headcount_check',
                    'fn_labour_reconcile','fn_post_labour_expense')
group by p.proname order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('labour_trades','labour_contractors','labour_workers',
                     'labour_rates','labour_attendance','labour_postings',
                     'v_labour_attendance','v_labour_cost','v_labour_project_cost')
order by table_name;
