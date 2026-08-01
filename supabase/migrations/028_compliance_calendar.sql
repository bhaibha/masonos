-- ============================================================
-- MASON OS — Migration 028: A9 Compliance / Statutory Calendar (Module 31)
--
-- Statutory deadlines that cost real money when missed: GST returns, TDS
-- payments, PF/ESI, labour licence renewals, building permits, insurance.
-- Each item has a due date, a responsible person, and — once filed — proof.
--
-- ---------- COMPANY-WIDE vs PROJECT ----------
-- `project_id` is NULLABLE and that nullability is the feature. A GST return is
-- filed by the company, not by a villa; a building permit belongs to one site.
-- RLS therefore has two arms: a null project_id is visible to every
-- founder/pm/accounts user, a non-null one additionally requires is_member().
--
-- ---------- WHY 'overdue' IS NEVER TRUSTED FROM THE COLUMN ----------
-- The status enum carries 'overdue' because the spec asks for it and because
-- pg_cron writes it nightly. But the UI reads `display_status` from
-- v_compliance_calendar, which derives overdue/due-soon from due_date at query
-- time. If the cron job is disabled, fails, or was never scheduled (pg_cron is
-- not enabled on every Supabase plan), the calendar is still correct. A
-- deadline module whose correctness depends on a background job having run is
-- exactly the module you cannot trust — the job is bookkeeping, not truth.
--
-- ---------- RECURRENCE ----------
-- Filing a recurring item generates the next occurrence server-side inside the
-- same function, so the two can never diverge. `series_id` groups the chain and
-- a UNIQUE (series_id, due_date) index makes double-filing incapable of
-- creating a duplicate — the insert is `on conflict do nothing`, not a
-- client-side "did I already do this?" check.
--
-- ---------- SUPERVISORS ----------
-- No supervisor arm in any policy. This module holds filing deadlines and
-- statutory exposure; it sits behind /money in the app, which supervisors
-- cannot reach at all.
--
-- Re-runnable: create-type guarded, create-table-if-not-exists,
-- drop-policy/trigger/constraint before create, create-or-replace on functions,
-- drop-view-then-create (never create-or-replace — CLAUDE.md).
-- ============================================================


-- ############################################################
-- ###  1. TYPES
-- ############################################################

do $$ begin
  create type compliance_category as enum (
    'gst', 'tds', 'pf', 'esi', 'labour_licence',
    'building_permit', 'insurance_renewal', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_recurrence as enum
    ('one_time', 'monthly', 'quarterly', 'annual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type compliance_status as enum ('pending', 'filed', 'overdue');
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  2. TABLE
-- ############################################################

create table if not exists public.compliance_items (
  id uuid primary key default gen_random_uuid(),

  title text not null,
  category compliance_category not null default 'other',

  -- NULL = company-wide. See header.
  project_id uuid references public.projects(id) on delete cascade,

  due_date date not null,
  recurrence compliance_recurrence not null default 'one_time',

  -- Who owes the filing. A profile, not free text — this is an internal
  -- responsibility, and an unassignable one is how deadlines get missed.
  responsible uuid references public.profiles(id),

  status compliance_status not null default 'pending',
  notes text,

  -- Proof of filing: one object in the `compliance` bucket (see section 8).
  proof_path text,
  filed_date date,
  filed_by uuid references public.profiles(id),
  filed_at timestamptz,

  -- Groups a recurring chain. Set to the row's own id by a trigger when the
  -- first occurrence is created; carried forward by fn_file_compliance.
  series_id uuid,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists compliance_due_idx
  on public.compliance_items (due_date);

create index if not exists compliance_open_idx
  on public.compliance_items (due_date)
  where status <> 'filed';

create index if not exists compliance_project_idx
  on public.compliance_items (project_id, due_date);

-- A filed item must say when it was filed. Without this, "filed" is a claim
-- the row cannot support — the same rule the snag resolution CHECK enforces.
alter table public.compliance_items drop constraint if exists compliance_filed_ck;
alter table public.compliance_items add constraint compliance_filed_ck check (
  status::text <> 'filed'
  or (filed_date is not null and filed_by is not null)
);

comment on column public.compliance_items.status is
  'Bookkeeping only. The UI reads display_status from v_compliance_calendar, '
  'which derives overdue/due-soon from due_date at query time so the calendar '
  'is correct even if the nightly sweep never ran.';


-- ############################################################
-- ###  3. SERIES ID + DUPLICATE GUARD
-- ############################################################
-- Trigger rather than a column default: a default cannot reference the row's
-- own generated id.
create or replace function public.fn_compliance_series()
returns trigger
language plpgsql
as $$
begin
  if new.series_id is null then
    new.series_id := new.id;
  end if;
  return new;
end $$;

drop trigger if exists compliance_series on public.compliance_items;
create trigger compliance_series
  before insert on public.compliance_items
  for each row execute function public.fn_compliance_series();

-- Two occurrences of the same recurring obligation can never share a due date.
-- This is what makes the "generate the next one" insert safe to retry.
create unique index if not exists compliance_series_due_uk
  on public.compliance_items (series_id, due_date);


-- ############################################################
-- ###  4. RLS
-- ############################################################
alter table public.compliance_items enable row level security;

-- Founder / PM / accounts only, and a project-scoped item additionally needs
-- membership. Supervisors match no arm of this, on purpose.
drop policy if exists compliance_read on public.compliance_items;
create policy compliance_read on public.compliance_items for select to authenticated
  using (
    public.my_role() in ('founder', 'pm', 'accounts')
    and (project_id is null or public.is_member(project_id))
  );

drop policy if exists compliance_insert on public.compliance_items;
create policy compliance_insert on public.compliance_items for insert to authenticated
  with check (
    public.my_role() in ('founder', 'pm', 'accounts')
    and (project_id is null or public.is_member(project_id))
  );

-- Editing the item is allowed; marking it FILED is not done here — that goes
-- through fn_file_compliance, because filing also has to spawn the next
-- occurrence, and two separate client writes could leave a chain broken.
-- The CHECK constraint above stops a client claiming 'filed' without evidence.
drop policy if exists compliance_update on public.compliance_items;
create policy compliance_update on public.compliance_items for update to authenticated
  using (
    public.my_role() in ('founder', 'pm', 'accounts')
    and (project_id is null or public.is_member(project_id))
  )
  with check (
    public.my_role() in ('founder', 'pm', 'accounts')
    and (project_id is null or public.is_member(project_id))
  );

-- No DELETE policy — removal goes through fn_delete_record (section 7).


-- ############################################################
-- ###  5. AUDIT
-- ############################################################
drop trigger if exists audit_compliance_items on public.compliance_items;
create trigger audit_compliance_items
  after insert or update or delete on public.compliance_items
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  6. CALENDAR VIEW — the only thing the UI reads
-- ############################################################
-- security_invoker so compliance_read still applies. Dates are evaluated in
-- Asia/Kolkata (CLAUDE.md rule 6) — a deadline at 23:00 IST must not read as
-- tomorrow because the server thinks in UTC.
drop view if exists public.v_compliance_calendar cascade;
create view public.v_compliance_calendar with (security_invoker = true) as
select
  c.id,
  c.title,
  c.category,
  c.project_id,
  p.name as project_name,
  c.due_date,
  c.recurrence,
  c.responsible,
  r.full_name as responsible_name,
  c.status,
  c.notes,
  c.proof_path,
  c.filed_date,
  c.filed_by,
  c.filed_at,
  c.series_id,
  c.created_at,
  (c.due_date - (now() at time zone 'Asia/Kolkata')::date) as days_until,
  case
    when c.status::text = 'filed' then 'filed'
    when c.due_date <  (now() at time zone 'Asia/Kolkata')::date then 'overdue'
    when c.due_date <= (now() at time zone 'Asia/Kolkata')::date + 7 then 'due_soon'
    else 'upcoming'
  end as display_status
from public.compliance_items c
left join public.projects p on p.id = c.project_id
left join public.profiles r on r.id = c.responsible;

grant select on public.v_compliance_calendar to authenticated;

comment on view public.v_compliance_calendar is
  'Derives overdue/due_soon/upcoming from due_date at query time, so the '
  'calendar is right even if the nightly pg_cron sweep never ran.';


-- ############################################################
-- ###  7. FILE AN ITEM (+ generate the next occurrence)
-- ############################################################
create or replace function public.fn_file_compliance(
  p_id    uuid,
  p_date  date,
  p_proof text default null,
  p_notes text default null
)
returns uuid                              -- id of the next occurrence, or null
language plpgsql security definer set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_role    text;
  v_row     public.compliance_items%rowtype;
  v_next    date;
  v_next_id uuid;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_row from public.compliance_items where id = p_id;
  if v_row.id is null then
    raise exception 'That compliance item no longer exists.';
  end if;

  v_role := public.my_role();
  if v_role not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot file compliance items.' using errcode = '42501';
  end if;
  if v_row.project_id is not null and not public.is_member(v_row.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_row.status::text = 'filed' then
    raise exception 'That item was already filed on %.', v_row.filed_date;
  end if;

  update public.compliance_items
     set status     = 'filed'::compliance_status,
         filed_date = coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date),
         filed_by   = v_me,
         filed_at   = now(),
         proof_path = coalesce(p_proof, proof_path),
         notes      = coalesce(nullif(btrim(p_notes), ''), notes),
         updated_at = now()
   where id = p_id;

  -- ---------- the next occurrence ----------
  -- Computed from the DUE date, never from the filing date: a GST return filed
  -- three days late does not move next month's deadline three days later.
  v_next := case v_row.recurrence::text
              when 'monthly'   then v_row.due_date + interval '1 month'
              when 'quarterly' then v_row.due_date + interval '3 months'
              when 'annual'    then v_row.due_date + interval '1 year'
              else null
            end::date;

  if v_next is null then
    return null;
  end if;

  -- on conflict: the UNIQUE (series_id, due_date) index means a retry, a double
  -- click, or a re-filed item can never produce two rows for one deadline.
  insert into public.compliance_items
    (title, category, project_id, due_date, recurrence,
     responsible, notes, series_id, created_by)
  values
    (v_row.title, v_row.category, v_row.project_id, v_next, v_row.recurrence,
     v_row.responsible, v_row.notes, v_row.series_id, v_me)
  on conflict (series_id, due_date) do nothing
  returning id into v_next_id;

  return v_next_id;
end $$;

revoke all on function public.fn_file_compliance(uuid, date, text, text) from public, anon;
grant execute on function public.fn_file_compliance(uuid, date, text, text) to authenticated;


-- ---------- reopen a filing made in error ----------
create or replace function public.fn_unfile_compliance(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_row public.compliance_items%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_row from public.compliance_items where id = p_id;
  if v_row.id is null then
    raise exception 'That compliance item no longer exists.';
  end if;
  if public.my_role() not in ('founder', 'accounts') then
    raise exception
      'Only a founder or accounts may reopen a filing — it is a statutory record.'
      using errcode = '42501';
  end if;
  if v_row.status::text <> 'filed' then
    raise exception 'That item is not filed.';
  end if;

  -- The proof is cleared with the status: a document proving a filing that is
  -- no longer claimed would be worse than none.
  update public.compliance_items
     set status     = 'pending'::compliance_status,
         filed_date = null, filed_by = null, filed_at = null,
         proof_path = null, updated_at = now()
   where id = p_id;
end $$;

revoke all on function public.fn_unfile_compliance(uuid) from public, anon;
grant execute on function public.fn_unfile_compliance(uuid) to authenticated;


-- ############################################################
-- ###  8. HARD DELETE — add a compliance_items branch
-- ############################################################
-- Identical to 027 plus compliance_items. An unfiled item has no downstream
-- effect, so it is mechanism 1. A FILED one is refused: it carries the proof of
-- a statutory filing, which is the last record anyone should be able to erase.
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
                 'documents', 'purchase_orders', 'materials', 'vendors', 'snags')
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

  -- ---------------------------------------------------- COMPLIANCE ITEM
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
      into v_n;
    if v_n > 0 then
      raise exception
        '% is linked to % record(s) — expenses, deliveries or orders. Deactivate it instead so it stops appearing in pickers.',
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
-- ###  9. DASHBOARD ALERT
-- ############################################################
-- Counts for the dashboard strip. Runs as the caller (security invoker, the
-- default for `sql` functions without the flag) so compliance_read narrows the
-- rows: a supervisor calling this gets zeroes, not an error, which is what lets
-- the dashboard call it unconditionally.
create or replace function public.fn_compliance_alert()
returns table (
  overdue_count   int,
  due_week_count  int,
  next_due_date   date,
  next_title      text
)
language sql
stable
set search_path = public
as $$
  with t as (select (now() at time zone 'Asia/Kolkata')::date as today)
  select
    (select count(*) from public.compliance_items c, t
      where c.status::text <> 'filed' and c.due_date < t.today)::int,
    (select count(*) from public.compliance_items c, t
      where c.status::text <> 'filed'
        and c.due_date >= t.today
        and c.due_date <= t.today + 7)::int,
    (select min(c.due_date) from public.compliance_items c
      where c.status::text <> 'filed'),
    (select c.title from public.compliance_items c
      where c.status::text <> 'filed'
      order by c.due_date, c.title limit 1);
$$;

revoke all on function public.fn_compliance_alert() from public, anon;
grant execute on function public.fn_compliance_alert() to authenticated;


-- ############################################################
-- ###  10. NIGHTLY SWEEP + pg_cron
-- ############################################################
-- Flips pending → overdue once the due date has passed, in IST. This is
-- bookkeeping so that status-based queries and the audit trail agree with the
-- calendar; the UI does not depend on it having run (see header).
create or replace function public.fn_compliance_sweep()
returns int
language plpgsql security definer set search_path = public
as $$
declare v_n int;
begin
  -- auth.uid() is NULL when pg_cron runs it, which is the normal path. A signed-
  -- in caller has to be one of the three roles that own this module.
  if auth.uid() is not null
     and public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot run the compliance sweep.' using errcode = '42501';
  end if;

  update public.compliance_items
     set status = 'overdue'::compliance_status,
         updated_at = now()
   where status::text = 'pending'
     and due_date < (now() at time zone 'Asia/Kolkata')::date;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_compliance_sweep() from public, anon;
grant execute on function public.fn_compliance_sweep() to authenticated;

-- pg_cron may not be enabled, and enabling it needs privileges the SQL editor
-- has but a restored/branch database may not. Every step is wrapped so the
-- migration cannot fail here — worst case the sweep is never scheduled and the
-- calendar still reads correctly.
-- Supabase documents two forms of this (plain, and `with schema pg_catalog`)
-- depending on the guide, so try both before giving up.
do $$ begin
  create extension if not exists pg_cron;
exception when others then
  begin
    execute 'create extension if not exists pg_cron with schema pg_catalog';
  exception when others then
    raise notice 'pg_cron not enabled (%). Enable it in Dashboard → Integrations → Cron, then re-run this migration. The calendar works without it.', sqlerrm;
  end;
end $$;

do $$ begin
  grant usage on schema cron to postgres;
exception when others then null; end $$;

do $$ begin
  perform cron.unschedule('mason-compliance-sweep');
exception when others then null;   -- not scheduled yet: nothing to remove
end $$;

-- 22:30 UTC = 04:00 IST, so an item flips overdue in the small hours of the day
-- AFTER its due date, not at 05:30 on the due date itself.
do $$ begin
  perform cron.schedule(
    'mason-compliance-sweep',
    '30 22 * * *',
    $cron$select public.fn_compliance_sweep();$cron$
  );
exception when others then
  raise notice 'Could not schedule the nightly sweep (%).', sqlerrm;
end $$;


-- ############################################################
-- ###  11. STORAGE — proof-of-filing bucket
-- ############################################################
-- A separate bucket because a company-wide item has no project, so the
-- `<project_id>/…` key that migration 006's policies require cannot exist for
-- it. Company-wide objects live under the literal prefix `company/`; project
-- ones keep the project-id prefix and are additionally membership-checked.
insert into storage.buckets (id, name, public)
values ('compliance', 'compliance', false)
on conflict (id) do nothing;

drop policy if exists compliance_files_read on storage.objects;
create policy compliance_files_read on storage.objects for select to authenticated
using (
  bucket_id = 'compliance'
  and public.my_role() in ('founder', 'pm', 'accounts')
  and (
    split_part(name, '/', 1) = 'company'
    or public.is_member(public.fn_storage_project(name))
  )
);

drop policy if exists compliance_files_insert on storage.objects;
create policy compliance_files_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'compliance'
  and public.my_role() in ('founder', 'pm', 'accounts')
  and (
    split_part(name, '/', 1) = 'company'
    or public.is_member(public.fn_storage_project(name))
  )
);

drop policy if exists compliance_files_delete on storage.objects;
create policy compliance_files_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'compliance'
  and (public.is_founder() or owner = auth.uid())
);


-- ############################################################
-- ###  12. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'compliance_items'
order by ordinal_position;

-- Expect all six.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_file_compliance', 'fn_unfile_compliance',
                  'fn_compliance_alert', 'fn_compliance_sweep',
                  'fn_compliance_series', 'fn_delete_record')
order by proname;

-- Expect one row if pg_cron is enabled; zero rows is survivable (see §10).
select jobname, schedule, active
from cron.job
where jobname = 'mason-compliance-sweep';
