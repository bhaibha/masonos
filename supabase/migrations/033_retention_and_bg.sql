-- ============================================================
-- MASON OS — Migration 033: A12 Retention & Bank Guarantees (Module 34)
--
-- Two things that quietly cost money when nobody is watching: retention we are
-- holding back from contractors, and bank guarantees that expire while still
-- covering live risk.
--
-- ---------- RETENTION IS NEVER TYPED IN ----------
-- The amount held comes from A11: it is the sum of `retention_amount` on
-- CERTIFIED ra_bills, per contractor. Nothing on this screen lets anyone enter
-- "how much we hold" — that number is a consequence of what was certified, and
-- the moment it becomes editable the two figures start to disagree.
-- Releases are the only thing recorded here, and the balance is the difference.
--
-- ---------- THE SCHEDULE AND THE RELEASE ARE ONE TABLE ----------
-- "Half on completion, half after DLP" is two PLANNED rows. Releasing one flips
-- it to `released` with the actual amount and date. A separate schedule table
-- would need reconciling against the releases, and reconciliation is where
-- errors live.
--
-- ---------- BG EXPIRY, SAME SPLIT AS 028 ----------
-- A nightly pg_cron job writes `expired`, but the UI reads `display_status`
-- from `v_bg_register`, which derives expiry from `expiry_date` in
-- Asia/Kolkata at query time. The job is bookkeeping; the view is truth. A
-- guarantee that silently lapses because a cron job didn't run is exactly the
-- failure this module exists to prevent.
--
-- ---------- SCANS ----------
-- BG copies go in the existing `compliance` bucket, whose policies already
-- require founder/pm/accounts. A new bucket would need the same three rules
-- written again; the path stays `<project_id>/<uuid>` so the is_member branch
-- of that policy applies unchanged.
--
-- ---------- NO SUPERVISORS ----------
-- Every figure here is money. RLS admits founder/pm/accounts only.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. TYPES
-- ############################################################

do $$ begin
  create type retention_milestone as enum
    ('on_completion', 'after_dlp', 'interim', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type retention_state as enum ('planned', 'released', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bg_type as enum
    ('advance', 'performance', 'retention', 'mobilisation', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bg_status as enum ('active', 'expired', 'released', 'returned');
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  2. RETENTION RELEASES (the schedule AND the releases)
-- ############################################################

create table if not exists public.retention_releases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  -- Same flexible identity as ra_bills, and matched the same way, so the
  -- ledger can line releases up against what was certified.
  vendor_id uuid references public.vendors(id),
  contractor_name text,

  milestone retention_milestone not null default 'on_completion',
  status retention_state not null default 'planned',

  -- Planned amount, then the actual on release. One column: a planned figure
  -- that turns out wrong is corrected by editing it before release, not by
  -- keeping two numbers that can disagree.
  amount numeric(14,2) not null default 0,

  due_date date,
  released_date date,
  released_by uuid references public.profiles(id),
  released_at timestamptz,

  notes text,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ret_project_idx
  on public.retention_releases (project_id, status);

alter table public.retention_releases drop constraint if exists ret_payee_ck;
alter table public.retention_releases add constraint ret_payee_ck check (
  vendor_id is not null or coalesce(btrim(contractor_name), '') <> ''
);

-- Released means it actually happened, with a date and a person.
alter table public.retention_releases drop constraint if exists ret_released_ck;
alter table public.retention_releases add constraint ret_released_ck check (
  status::text <> 'released'
  or (released_date is not null and released_by is not null and amount > 0)
);


-- ############################################################
-- ###  3. BANK GUARANTEE REGISTER
-- ############################################################

create table if not exists public.bank_guarantees (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  vendor_id uuid references public.vendors(id),
  counterparty text,                       -- free text when not a listed vendor

  bg_type bg_type not null default 'performance',
  bg_number text not null,
  issuing_bank text not null,
  amount numeric(14,2) not null default 0,

  issue_date date,
  expiry_date date not null,
  -- Claim period usually runs past expiry; tracked because that, not expiry,
  -- is the last day the guarantee can actually be invoked.
  claim_expiry_date date,

  status bg_status not null default 'active',
  file_path text,                          -- scan, in the `compliance` bucket
  notes text,

  released_at timestamptz,
  released_by uuid references public.profiles(id),

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bg_project_idx
  on public.bank_guarantees (project_id, expiry_date);
create index if not exists bg_live_idx
  on public.bank_guarantees (expiry_date)
  where status in ('active', 'expired');

create unique index if not exists bg_number_uk
  on public.bank_guarantees (project_id, upper(btrim(bg_number)));

alter table public.bank_guarantees drop constraint if exists bg_party_ck;
alter table public.bank_guarantees add constraint bg_party_ck check (
  vendor_id is not null or coalesce(btrim(counterparty), '') <> ''
);

comment on column public.bank_guarantees.status is
  'Bookkeeping only. The UI reads display_status from v_bg_register, which '
  'derives expiry from expiry_date at query time so the register is correct '
  'even if the nightly sweep never ran.';


-- ############################################################
-- ###  4. RLS
-- ############################################################
alter table public.retention_releases enable row level security;
alter table public.bank_guarantees    enable row level security;

drop policy if exists ret_read on public.retention_releases;
create policy ret_read on public.retention_releases for select to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'accounts'));

drop policy if exists ret_insert on public.retention_releases;
create policy ret_insert on public.retention_releases for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'accounts'));

-- Editing a PLANNED tranche is normal. The release itself goes through
-- fn_release_retention, and the CHECK above is what stops a client writing
-- status = 'released' without a date and a signatory.
drop policy if exists ret_update on public.retention_releases;
create policy ret_update on public.retention_releases for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'accounts'))
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'accounts'));

drop policy if exists bg_read on public.bank_guarantees;
create policy bg_read on public.bank_guarantees for select to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'accounts'));

drop policy if exists bg_insert on public.bank_guarantees;
create policy bg_insert on public.bank_guarantees for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'accounts'));

drop policy if exists bg_update on public.bank_guarantees;
create policy bg_update on public.bank_guarantees for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'accounts'))
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'accounts'));

-- No DELETE policies — removal goes through fn_delete_record.


-- ############################################################
-- ###  5. AUDIT
-- ############################################################
drop trigger if exists audit_retention_releases on public.retention_releases;
create trigger audit_retention_releases
  after insert or update or delete on public.retention_releases
  for each row execute function public.fn_audit();

drop trigger if exists audit_bank_guarantees on public.bank_guarantees;
create trigger audit_bank_guarantees
  after insert or update or delete on public.bank_guarantees
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  6. RETENTION LEDGER
-- ############################################################
-- Held comes from certified bills and NOWHERE else. Released and planned come
-- from this migration's table. Balance is the difference — never a stored
-- number, because a stored balance drifts the first time a bill is cancelled.
drop view if exists public.v_retention_ledger cascade;
create view public.v_retention_ledger with (security_invoker = true) as
with held as (
  select
    b.project_id,
    coalesce(b.vendor_id::text, lower(btrim(coalesce(b.contractor_name, ''))))
      as party_key,
    max(b.vendor_id::text)                                  as vendor_id_text,
    coalesce(max(v.name), max(b.contractor_name), 'Unnamed contractor')
      as contractor,
    sum(b.retention_amount)::numeric(14,2)                  as retention_held,
    count(*)::int                                           as certified_bills
  from public.ra_bills b
  left join public.vendors v on v.id = b.vendor_id
  where b.status::text = 'certified'
  group by 1, 2
),
rel as (
  select
    r.project_id,
    coalesce(r.vendor_id::text, lower(btrim(coalesce(r.contractor_name, ''))))
      as party_key,
    coalesce(sum(r.amount) filter (where r.status::text = 'released'), 0)::numeric(14,2)
      as released,
    coalesce(sum(r.amount) filter (where r.status::text = 'planned'), 0)::numeric(14,2)
      as planned,
    min(r.due_date) filter (where r.status::text = 'planned') as next_due
  from public.retention_releases r
  group by 1, 2
)
select
  h.project_id,
  h.party_key,
  h.vendor_id_text::uuid as vendor_id,
  h.contractor,
  h.certified_bills,
  h.retention_held,
  coalesce(rl.released, 0)::numeric(14,2)                  as released,
  coalesce(rl.planned, 0)::numeric(14,2)                   as planned,
  (h.retention_held - coalesce(rl.released, 0))::numeric(14,2) as balance_held,
  rl.next_due
from held h
left join rel rl
  on rl.project_id = h.project_id and rl.party_key = h.party_key;

grant select on public.v_retention_ledger to authenticated;

comment on view public.v_retention_ledger is
  'retention_held is summed from certified ra_bills, never entered. Balance = '
  'held − released, computed on read so a cancelled bill corrects it at once.';


-- ############################################################
-- ###  7. RELEASE A TRANCHE
-- ############################################################
create or replace function public.fn_release_retention(
  p_id     uuid,
  p_amount numeric,
  p_date   date default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_row     public.retention_releases%rowtype;
  v_me      uuid := auth.uid();
  v_key     text;
  v_held    numeric(14,2);
  v_already numeric(14,2);
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_row from public.retention_releases where id = p_id;
  if v_row.id is null then
    raise exception 'That retention entry no longer exists.';
  end if;
  if not public.is_member(v_row.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'accounts') then
    raise exception
      'Only a founder or accounts may release retention — it moves money out.'
      using errcode = '42501';
  end if;
  if v_row.status::text = 'released' then
    raise exception 'That tranche was already released on %.', v_row.released_date;
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'A release needs an amount.';
  end if;

  v_key := coalesce(v_row.vendor_id::text,
                    lower(btrim(coalesce(v_row.contractor_name, ''))));

  -- What we are actually holding for this contractor, from certified bills.
  select coalesce(sum(b.retention_amount), 0) into v_held
  from public.ra_bills b
  where b.project_id = v_row.project_id
    and b.status::text = 'certified'
    and coalesce(b.vendor_id::text, lower(btrim(coalesce(b.contractor_name, ''))))
        = v_key;

  select coalesce(sum(r.amount), 0) into v_already
  from public.retention_releases r
  where r.project_id = v_row.project_id
    and r.status::text = 'released'
    and r.id <> p_id
    and coalesce(r.vendor_id::text, lower(btrim(coalesce(r.contractor_name, ''))))
        = v_key;

  if v_already + p_amount > v_held then
    raise exception
      'That would release % against % held (% already released). Retention cannot go negative.',
      p_amount, v_held, v_already;
  end if;

  update public.retention_releases
     set status        = 'released'::retention_state,
         amount        = p_amount,
         released_date = coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date),
         released_by   = v_me,
         released_at   = now(),
         updated_at    = now()
   where id = p_id;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values ('retention_releases', 'RELEASE', p_id::text,
          jsonb_build_object('planned_amount', v_row.amount),
          jsonb_build_object('amount', p_amount, 'by', v_me, 'at', now()));
end $$;

revoke all on function public.fn_release_retention(uuid, numeric, date) from public, anon;
grant execute on function public.fn_release_retention(uuid, numeric, date) to authenticated;


-- ############################################################
-- ###  8. BG REGISTER VIEW + STATUS
-- ############################################################
drop view if exists public.v_bg_register cascade;
create view public.v_bg_register with (security_invoker = true) as
select
  g.id,
  g.project_id,
  g.vendor_id,
  coalesce(v.name, g.counterparty, '—') as counterparty_name,
  g.bg_type,
  g.bg_number,
  g.issuing_bank,
  g.amount,
  g.issue_date,
  g.expiry_date,
  g.claim_expiry_date,
  g.status,
  g.file_path,
  g.notes,
  g.released_at,
  g.created_at,
  (g.expiry_date - (now() at time zone 'Asia/Kolkata')::date) as days_to_expiry,
  case
    when g.status::text in ('released', 'returned') then g.status::text
    when g.expiry_date <  (now() at time zone 'Asia/Kolkata')::date then 'expired'
    when g.expiry_date <= (now() at time zone 'Asia/Kolkata')::date + 30 then 'expiring'
    else 'active'
  end as display_status
from public.bank_guarantees g
left join public.vendors v on v.id = g.vendor_id;

grant select on public.v_bg_register to authenticated;


create or replace function public.fn_set_bg_status(
  p_id     uuid,
  p_status text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_row public.bank_guarantees%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_status not in ('active', 'released', 'returned') then
    raise exception
      'fn_set_bg_status handles active, released and returned. "expired" is derived from the expiry date, not set by hand.';
  end if;

  select * into v_row from public.bank_guarantees where id = p_id;
  if v_row.id is null then raise exception 'That guarantee no longer exists.'; end if;
  if not public.is_member(v_row.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501'; end if;
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot update guarantees.' using errcode = '42501'; end if;

  update public.bank_guarantees
     set status      = p_status::bg_status,
         released_at = case when p_status in ('released', 'returned')
                            then now() else null end,
         released_by = case when p_status in ('released', 'returned')
                            then auth.uid() else null end,
         updated_at  = now()
   where id = p_id;
end $$;

revoke all on function public.fn_set_bg_status(uuid, text) from public, anon;
grant execute on function public.fn_set_bg_status(uuid, text) to authenticated;


-- ############################################################
-- ###  9. DASHBOARD ALERT + NIGHTLY SWEEP
-- ############################################################
-- Invoker rights, like fn_compliance_alert: a supervisor gets zeroes rather
-- than an error, which is what lets the dashboard call it unconditionally.
create or replace function public.fn_bg_alert()
returns table (
  expiring_count int,
  expired_count  int,
  next_expiry    date,
  next_bg_number text
)
language sql
stable
set search_path = public
as $$
  with t as (select (now() at time zone 'Asia/Kolkata')::date as today)
  select
    (select count(*) from public.bank_guarantees g, t
      where g.status::text in ('active', 'expired')
        and g.expiry_date >= t.today
        and g.expiry_date <= t.today + 30)::int,
    (select count(*) from public.bank_guarantees g, t
      where g.status::text in ('active', 'expired')
        and g.expiry_date < t.today)::int,
    (select min(g.expiry_date) from public.bank_guarantees g
      where g.status::text in ('active', 'expired')),
    (select g.bg_number from public.bank_guarantees g
      where g.status::text in ('active', 'expired')
      order by g.expiry_date, g.bg_number limit 1);
$$;

revoke all on function public.fn_bg_alert() from public, anon;
grant execute on function public.fn_bg_alert() to authenticated;


create or replace function public.fn_bg_sweep()
returns int
language plpgsql security definer set search_path = public
as $$
declare v_n int;
begin
  if auth.uid() is not null
     and public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot run the guarantee sweep.' using errcode = '42501';
  end if;

  update public.bank_guarantees
     set status = 'expired'::bg_status, updated_at = now()
   where status::text = 'active'
     and expiry_date < (now() at time zone 'Asia/Kolkata')::date;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_bg_sweep() from public, anon;
grant execute on function public.fn_bg_sweep() to authenticated;

-- pg_cron is confirmed enabled on this project (028), but every step stays
-- wrapped: the register reads correctly whether or not the job ever runs.
do $$ begin
  perform cron.unschedule('mason-bg-sweep');
exception when others then null; end $$;

-- 22:40 UTC = 04:10 IST, ten minutes after the compliance sweep.
do $$ begin
  perform cron.schedule(
    'mason-bg-sweep',
    '40 22 * * *',
    $cron$select public.fn_bg_sweep();$cron$
  );
exception when others then
  raise notice 'Could not schedule the BG sweep (%).', sqlerrm;
end $$;


-- ############################################################
-- ###  10. HARD DELETE — two more branches
-- ############################################################
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
    delete from public.ra_bills where id = p_id;

  -- --------------------------------------------------- RETENTION TRANCHE
  elsif p_table = 'retention_releases' then
    select project_id, status::text into v_project, v_status
    from public.retention_releases where id = p_id;
    if v_project is null then raise exception 'That retention entry no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status = 'released' then
      raise exception
        'That tranche was released — money left the business against it. It stays on the ledger.';
    end if;
    delete from public.retention_releases where id = p_id;

  -- --------------------------------------------------- BANK GUARANTEE
  elsif p_table = 'bank_guarantees' then
    select project_id, status::text into v_project, v_status
    from public.bank_guarantees where id = p_id;
    if v_project is null then raise exception 'That guarantee no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status in ('released', 'returned') then
      raise exception
        'That guarantee was %, which is a fact about a real instrument. It stays on the register.',
        v_status;
    end if;
    delete from public.bank_guarantees where id = p_id;

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
    select (select count(*) from public.expenses          where vendor_id = p_id)
         + (select count(*) from public.material_inward   where vendor_id = p_id)
         + (select count(*) from public.purchase_orders   where vendor_id = p_id)
         + (select count(*) from public.ra_bills          where vendor_id = p_id)
         + (select count(*) from public.bank_guarantees   where vendor_id = p_id)
      into v_n;
    if v_n > 0 then
      raise exception
        '% is linked to % record(s) — expenses, deliveries, orders, bills or guarantees. Deactivate it instead so it stops appearing in pickers.',
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
-- ###  11. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'bank_guarantees'
order by ordinal_position;

select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_release_retention', 'fn_set_bg_status', 'fn_bg_alert',
                  'fn_bg_sweep', 'fn_delete_record')
order by proname;

-- Expect both views and the scheduled job. Last statements in the file.
select table_name from information_schema.views
where table_schema = 'public'
  and table_name in ('v_retention_ledger', 'v_bg_register')
order by table_name;

select jobname, schedule, active from cron.job
where jobname in ('mason-compliance-sweep', 'mason-bg-sweep')
order by jobname;
