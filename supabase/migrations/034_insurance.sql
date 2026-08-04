-- ============================================================
-- MASON OS — Migration 034: A13 Insurance Management (Module 30)
--
-- A register of live cover: CAR, workmen's compensation, professional
-- indemnity, third-party liability. The failure this prevents is discovering
-- on the day of an incident that the policy lapsed three weeks ago.
--
-- ---------- COMPANY-WIDE OR PER PROJECT ----------
-- `project_id` is NULLABLE, exactly as compliance_items is (028). A CAR policy
-- covers one site; professional indemnity covers the practice. RLS has the same
-- two arms: a null project_id is visible to every founder/pm/accounts user, a
-- non-null one additionally requires is_member().
--
-- ---------- EXPIRY IS DERIVED, THE SWEEP IS BOOKKEEPING ----------
-- Third module to use this split (028 compliance, 033 guarantees, now this).
-- `v_insurance_register.display_status` computes expiring/expired from
-- expiry_date in Asia/Kolkata at query time; the nightly pg_cron job only
-- persists `expired` so status-based queries agree. Cover that silently lapses
-- because a background job didn't run is precisely what this module exists to
-- prevent, so the screen never depends on it.
--
-- ---------- RENEWALS ARE A CHAIN, NOT AN EDIT ----------
-- Renewing creates a NEW policy row pointing at the old one through
-- `renewed_from`, and the old one is marked `renewed`. Editing the dates in
-- place would erase the record of what was covered last year — which is the
-- one thing you need when a claim arrives late.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. TYPES
-- ############################################################

do $$ begin
  create type insurance_type as enum
    ('car', 'workmen_comp', 'professional_indemnity', 'third_party_liability',
     'contractors_plant', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type insurance_status as enum
    ('active', 'expired', 'renewed', 'cancelled');
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  2. TABLE
-- ############################################################

create table if not exists public.insurance_policies (
  id uuid primary key default gen_random_uuid(),

  -- NULL = company-wide cover. See header.
  project_id uuid references public.projects(id) on delete cascade,

  policy_type insurance_type not null default 'car',
  policy_number text not null,
  insurer text not null,
  broker text,

  sum_insured numeric(14,2),
  premium numeric(14,2),

  start_date date,
  expiry_date date not null,

  status insurance_status not null default 'active',
  file_path text,                       -- policy copy, in the `compliance` bucket
  notes text,

  -- The policy this one replaces. Renewals chain rather than overwrite.
  renewed_from uuid references public.insurance_policies(id),

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ins_expiry_idx
  on public.insurance_policies (expiry_date);
create index if not exists ins_live_idx
  on public.insurance_policies (expiry_date)
  where status in ('active', 'expired');
create index if not exists ins_project_idx
  on public.insurance_policies (project_id, expiry_date);
create index if not exists ins_renewed_from_idx
  on public.insurance_policies (renewed_from);

-- Two policies can share a number across insurers, but not within one insurer.
create unique index if not exists ins_number_uk
  on public.insurance_policies (upper(btrim(insurer)), upper(btrim(policy_number)));

comment on column public.insurance_policies.status is
  'Bookkeeping only. The UI reads display_status from v_insurance_register, '
  'which derives expiry from expiry_date at query time so the register is '
  'correct even if the nightly sweep never ran.';


-- ############################################################
-- ###  3. RLS
-- ############################################################
alter table public.insurance_policies enable row level security;

drop policy if exists ins_read on public.insurance_policies;
create policy ins_read on public.insurance_policies for select to authenticated
  using (
    public.my_role() in ('founder', 'pm', 'accounts')
    and (project_id is null or public.is_member(project_id))
  );

drop policy if exists ins_insert on public.insurance_policies;
create policy ins_insert on public.insurance_policies for insert to authenticated
  with check (
    public.my_role() in ('founder', 'pm', 'accounts')
    and (project_id is null or public.is_member(project_id))
  );

drop policy if exists ins_update on public.insurance_policies;
create policy ins_update on public.insurance_policies for update to authenticated
  using (
    public.my_role() in ('founder', 'pm', 'accounts')
    and (project_id is null or public.is_member(project_id))
  )
  with check (
    public.my_role() in ('founder', 'pm', 'accounts')
    and (project_id is null or public.is_member(project_id))
  );

-- No DELETE policy — removal goes through fn_delete_record.


-- ############################################################
-- ###  4. AUDIT
-- ############################################################
drop trigger if exists audit_insurance_policies on public.insurance_policies;
create trigger audit_insurance_policies
  after insert or update or delete on public.insurance_policies
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  5. REGISTER VIEW
-- ############################################################
drop view if exists public.v_insurance_register cascade;
create view public.v_insurance_register with (security_invoker = true) as
select
  i.id,
  i.project_id,
  p.name as project_name,
  i.policy_type,
  i.policy_number,
  i.insurer,
  i.broker,
  i.sum_insured,
  i.premium,
  i.start_date,
  i.expiry_date,
  i.status,
  i.file_path,
  i.notes,
  i.renewed_from,
  i.created_at,
  (i.expiry_date - (now() at time zone 'Asia/Kolkata')::date) as days_to_expiry,
  case
    when i.status::text in ('renewed', 'cancelled') then i.status::text
    when i.expiry_date <  (now() at time zone 'Asia/Kolkata')::date then 'expired'
    when i.expiry_date <= (now() at time zone 'Asia/Kolkata')::date + 30 then 'expiring'
    else 'active'
  end as display_status,
  -- True when a later policy already points at this one, so the UI can say
  -- "replaced by" rather than offering to renew it twice.
  exists (select 1 from public.insurance_policies r where r.renewed_from = i.id)
    as has_successor
from public.insurance_policies i
left join public.projects p on p.id = i.project_id;

grant select on public.v_insurance_register to authenticated;


-- ############################################################
-- ###  6. STATUS
-- ############################################################
create or replace function public.fn_set_policy_status(
  p_id     uuid,
  p_status text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_row public.insurance_policies%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_status not in ('active', 'renewed', 'cancelled') then
    raise exception
      'fn_set_policy_status handles active, renewed and cancelled. "expired" is derived from the expiry date, not set by hand.';
  end if;

  select * into v_row from public.insurance_policies where id = p_id;
  if v_row.id is null then raise exception 'That policy no longer exists.'; end if;
  if v_row.project_id is not null and not public.is_member(v_row.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501'; end if;
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot update policies.' using errcode = '42501'; end if;

  update public.insurance_policies
     set status = p_status::insurance_status, updated_at = now()
   where id = p_id;
end $$;

revoke all on function public.fn_set_policy_status(uuid, text) from public, anon;
grant execute on function public.fn_set_policy_status(uuid, text) to authenticated;


-- ############################################################
-- ###  7. DASHBOARD ALERT + NIGHTLY SWEEP
-- ############################################################
-- Invoker rights like fn_compliance_alert and fn_bg_alert: a supervisor gets
-- zeroes rather than an error, so the dashboard can call it unconditionally.
create or replace function public.fn_insurance_alert()
returns table (
  expiring_count int,
  expired_count  int,
  next_expiry    date,
  next_policy    text
)
language sql
stable
set search_path = public
as $$
  with t as (select (now() at time zone 'Asia/Kolkata')::date as today)
  select
    (select count(*) from public.insurance_policies i, t
      where i.status::text in ('active', 'expired')
        and i.expiry_date >= t.today
        and i.expiry_date <= t.today + 30)::int,
    (select count(*) from public.insurance_policies i, t
      where i.status::text in ('active', 'expired')
        and i.expiry_date < t.today)::int,
    (select min(i.expiry_date) from public.insurance_policies i
      where i.status::text in ('active', 'expired')),
    (select i.policy_number from public.insurance_policies i
      where i.status::text in ('active', 'expired')
      order by i.expiry_date, i.policy_number limit 1);
$$;

revoke all on function public.fn_insurance_alert() from public, anon;
grant execute on function public.fn_insurance_alert() to authenticated;


create or replace function public.fn_insurance_sweep()
returns int
language plpgsql security definer set search_path = public
as $$
declare v_n int;
begin
  if auth.uid() is not null
     and public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot run the insurance sweep.' using errcode = '42501';
  end if;

  update public.insurance_policies
     set status = 'expired'::insurance_status, updated_at = now()
   where status::text = 'active'
     and expiry_date < (now() at time zone 'Asia/Kolkata')::date;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_insurance_sweep() from public, anon;
grant execute on function public.fn_insurance_sweep() to authenticated;

do $$ begin
  perform cron.unschedule('mason-insurance-sweep');
exception when others then null; end $$;

-- 22:50 UTC = 04:20 IST, ten minutes after the BG sweep.
do $$ begin
  perform cron.schedule(
    'mason-insurance-sweep',
    '50 22 * * *',
    $cron$select public.fn_insurance_sweep();$cron$
  );
exception when others then
  raise notice 'Could not schedule the insurance sweep (%).', sqlerrm;
end $$;


-- ############################################################
-- ###  8. HARD DELETE — insurance_policies branch
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

  -- ------------------------------------------------- INSURANCE POLICY
  elsif p_table = 'insurance_policies' then
    select project_id, status::text into v_project, v_status
    from public.insurance_policies where id = p_id;
    if not found then raise exception 'That policy no longer exists.'; end if;
    if v_project is not null and not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;

    -- A policy that has been renewed is the previous link in a chain. Deleting
    -- it would leave the current policy claiming to replace nothing, and lose
    -- the record of what was covered when a late claim arrives.
    select count(*) into v_n
    from public.insurance_policies where renewed_from = p_id;
    if v_n > 0 then
      raise exception
        'A later policy renews this one. It stays on the register as the record of what was covered.';
    end if;
    delete from public.insurance_policies where id = p_id;

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
-- ###  9. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'insurance_policies'
order by ordinal_position;

select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_set_policy_status', 'fn_insurance_alert',
                  'fn_insurance_sweep', 'fn_delete_record')
order by proname;

-- Expect the view, then all three sweeps. Last statements in the file.
select table_name from information_schema.views
where table_schema = 'public' and table_name = 'v_insurance_register';

select jobname, schedule, active from cron.job
where jobname in ('mason-compliance-sweep', 'mason-bg-sweep',
                  'mason-insurance-sweep')
order by jobname;
