-- ============================================================
-- MASON OS — Migration 027: A8 Snags + Defect Liability Period (Module 19)
--
-- A snag is a defect found on site: where it is, which trade owns it, a photo,
-- and a second photo proving it was fixed. The module exists to make "it's
-- done" verifiable rather than asserted.
--
-- ---------- THE FOUR-STATE LIFECYCLE, AND WHY VERIFY IS SEPARATE ----------
--   open → in_progress → resolved → verified
-- `resolved` is claimed by whoever fixed it — supervisors can do this, since
-- they're on site. `verified` is founder/PM only. The person who fixed a defect
-- should not be the one who signs it off; that separation is the whole value of
-- a snag list. Enforced in fn_verify_snag, not just the UI.
--
-- ---------- DLP ----------
-- Defect Liability Period start/end live on the project. A snag's
-- `raised_during_dlp` flag is stamped BY A TRIGGER at insert time and never
-- recomputed — whether a defect fell inside the liability window is a fact
-- about when it was found, and it must not change if the dates are later
-- edited. That is a commercial question (who pays), so it gets frozen.
--
-- ---------- THE COLUMN-GRANT TRAP (this bit is easy to miss) ----------
-- Migration 010 did `revoke select on projects` then re-granted an explicit
-- column list. Any column added to `projects` afterwards is unreadable by
-- EVERY role, founder included, until it is granted. 018 hit exactly this with
-- material_inward.vendor_name. The two DLP columns are granted below.
-- They carry no money, so every project member may read them.
--
-- ---------- REMOVAL ----------
-- A snag has no downstream effect — nothing references it, no money or stock
-- moves — so it is HARD DELETABLE under mechanism 1, and fn_delete_record
-- gains a snags branch. Raised in error, deleted. No cancel state needed.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. DLP ON THE PROJECT  (+ the grant that makes it readable)
-- ############################################################

alter table public.projects
  add column if not exists dlp_start_date date,
  add column if not exists dlp_end_date   date;

-- WITHOUT THIS GRANT the columns are invisible to everyone — see header.
grant select (dlp_start_date, dlp_end_date) on public.projects to authenticated;

alter table public.projects drop constraint if exists projects_dlp_ck;
alter table public.projects add constraint projects_dlp_ck check (
  dlp_start_date is null
  or dlp_end_date is null
  or dlp_end_date >= dlp_start_date
);

comment on column public.projects.dlp_start_date is
  'Defect Liability Period start. No money on these columns, so they are '
  'granted to every authenticated role (010 revoked the table default).';


-- ############################################################
-- ###  2. TYPES, SEQUENCE, TABLE
-- ############################################################

do $$ begin
  create type snag_severity as enum ('low', 'medium', 'high');
exception when duplicate_object then null; end $$;

do $$ begin
  create type snag_status as enum ('open', 'in_progress', 'resolved', 'verified');
exception when duplicate_object then null; end $$;

create sequence if not exists public.snag_number_seq;

create table if not exists public.snags (
  id uuid primary key default gen_random_uuid(),
  snag_number text not null unique
    default 'SNG-' || lpad(nextval('public.snag_number_seq')::text, 4, '0'),
  project_id uuid not null references public.projects(id) on delete cascade,
  raised_date date not null default current_date,

  work_area text not null,
  trade text,
  description text not null,
  severity snag_severity not null default 'medium',

  -- Photos of the defect. Camera-first: this is logged standing in front of it.
  photos text[] not null default '{}',

  -- Assigned to: a registered vendor if the trade contractor is one, free text
  -- otherwise. Same flexible pattern as 017/023/026.
  assigned_vendor_id uuid references public.vendors(id),
  assigned_to text,

  status snag_status not null default 'open',

  -- The proof it was fixed.
  resolution_note text,
  resolution_photos text[] not null default '{}',
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),

  verified_at timestamptz,
  verified_by uuid references public.profiles(id),

  -- Frozen at insert by the trigger below. Never recomputed. See header.
  raised_during_dlp boolean not null default false,

  raised_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists snag_project_idx
  on public.snags (project_id, raised_date desc);
-- What's actually outstanding, worst first.
create index if not exists snag_open_idx
  on public.snags (project_id, severity)
  where status in ('open', 'in_progress');
create index if not exists snag_dlp_idx
  on public.snags (project_id)
  where raised_during_dlp;

-- 'resolved' and 'verified' both need evidence: a note or a photo, plus who
-- and when. Enforced in the database so a status can't claim a fix that has
-- nothing behind it.
alter table public.snags drop constraint if exists snags_resolution_ck;
alter table public.snags add constraint snags_resolution_ck check (
  status::text not in ('resolved', 'verified')
  or (resolved_at is not null
      and resolved_by is not null
      and (coalesce(btrim(resolution_note), '') <> ''
           or array_length(resolution_photos, 1) >= 1))
);

alter table public.snags drop constraint if exists snags_verified_ck;
alter table public.snags add constraint snags_verified_ck check (
  status::text <> 'verified'
  or (verified_at is not null and verified_by is not null)
);


-- ############################################################
-- ###  3. FREEZE THE DLP FLAG AT INSERT
-- ############################################################
create or replace function public.fn_snag_dlp_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start date;
  v_end   date;
begin
  select dlp_start_date, dlp_end_date into v_start, v_end
  from public.projects where id = new.project_id;

  new.raised_during_dlp :=
    v_start is not null
    and v_end is not null
    and new.raised_date between v_start and v_end;

  return new;
end $$;

drop trigger if exists snag_dlp_flag on public.snags;
create trigger snag_dlp_flag
  before insert on public.snags
  for each row execute function public.fn_snag_dlp_flag();


-- ############################################################
-- ###  4. RLS
-- ############################################################
alter table public.snags enable row level security;

-- No figures on this table, so every project member reads it.
drop policy if exists snag_read on public.snags;
create policy snag_read on public.snags for select to authenticated
  using (public.is_member(project_id));

-- Supervisors raise: they're the ones walking the site finding defects.
drop policy if exists snag_insert on public.snags;
create policy snag_insert on public.snags for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'supervisor'));

-- Supervisors also progress and resolve. Verification is gated inside
-- fn_verify_snag, and the CHECK constraints above stop a client claiming a
-- resolution or verification it can't substantiate.
drop policy if exists snag_update on public.snags;
create policy snag_update on public.snags for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'supervisor'))
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm', 'supervisor'));

-- No DELETE policy — fn_delete_record is the only route (mechanism 1).


-- ############################################################
-- ###  5. AUDIT
-- ############################################################
drop trigger if exists audit_snags on public.snags;
create trigger audit_snags
  after insert or update or delete on public.snags
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  6. RESOLVE / VERIFY / REOPEN
-- ############################################################

-- Claim a fix. Evidence, who and when land in one statement.
create or replace function public.fn_resolve_snag(
  p_id     uuid,
  p_note   text,
  p_photos text[]
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_project uuid; v_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if coalesce(btrim(p_note), '') = ''
     and coalesce(array_length(p_photos, 1), 0) = 0 then
    raise exception
      'Attach a photo of the fix, or write what was done. A snag closed with no evidence is worth nothing.'
      using errcode = '22023';
  end if;

  select project_id, status::text into v_project, v_status
  from public.snags where id = p_id;

  if v_project is null then raise exception 'That snag no longer exists.'; end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501'; end if;
  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot resolve snags.' using errcode = '42501'; end if;
  if v_status = 'verified' then
    raise exception 'That snag was already verified. Reopen it first if it has come back.';
  end if;

  update public.snags
     set status            = 'resolved'::snag_status,
         resolution_note   = nullif(btrim(p_note), ''),
         resolution_photos = coalesce(p_photos, '{}'),
         resolved_at       = now(),
         resolved_by       = auth.uid(),
         verified_at       = null,
         verified_by       = null,
         updated_at        = now()
   where id = p_id;
end $$;

revoke all on function public.fn_resolve_snag(uuid, text, text[]) from public, anon;
grant execute on function public.fn_resolve_snag(uuid, text, text[]) to authenticated;


-- Sign it off. Founder/PM only — the person who fixed it doesn't verify it.
create or replace function public.fn_verify_snag(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_project uuid; v_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select project_id, status::text into v_project, v_status
  from public.snags where id = p_id;

  if v_project is null then raise exception 'That snag no longer exists.'; end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501'; end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception
      'Only a founder or PM may verify a snag — whoever fixed it should not be the one signing it off.'
      using errcode = '42501'; end if;
  if v_status <> 'resolved' then
    raise exception
      'Only a resolved snag can be verified. This one is % — it needs a fix recorded first.', v_status;
  end if;

  update public.snags
     set status      = 'verified'::snag_status,
         verified_at = now(),
         verified_by = auth.uid(),
         updated_at  = now()
   where id = p_id;
end $$;

revoke all on function public.fn_verify_snag(uuid) from public, anon;
grant execute on function public.fn_verify_snag(uuid) to authenticated;


-- Move between open and in_progress, or reopen something that came back.
create or replace function public.fn_set_snag_status(
  p_id     uuid,
  p_status text
)
returns void
language plpgsql security definer set search_path = public as $$
declare v_project uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_status not in ('open', 'in_progress') then
    raise exception
      'fn_set_snag_status handles open and in_progress only — use fn_resolve_snag and fn_verify_snag for the rest.';
  end if;

  select project_id into v_project from public.snags where id = p_id;
  if v_project is null then raise exception 'That snag no longer exists.'; end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501'; end if;
  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot update snags.' using errcode = '42501'; end if;

  -- Reopening clears the resolution: the CHECK constraints demand evidence for
  -- resolved/verified, and a reopened snag has none that still stands.
  update public.snags
     set status            = p_status::snag_status,
         resolution_note   = null,
         resolution_photos = '{}',
         resolved_at       = null,
         resolved_by       = null,
         verified_at       = null,
         verified_by       = null,
         updated_at        = now()
   where id = p_id;
end $$;

revoke all on function public.fn_set_snag_status(uuid, text) from public, anon;
grant execute on function public.fn_set_snag_status(uuid, text) to authenticated;


-- ############################################################
-- ###  7. SUMMARY FOR PROJECT DETAIL  (counts computed in Postgres)
-- ############################################################
create or replace function public.fn_project_snag_summary(p_project uuid)
returns table (
  open_count        int,
  in_progress_count int,
  resolved_count    int,
  verified_count    int,
  open_low          int,
  open_medium       int,
  open_high         int,
  dlp_snag_count    int,
  dlp_start         date,
  dlp_end           date,
  dlp_active        boolean,
  dlp_days_left     int
)
language sql stable security invoker set search_path = public as $$
  select
    count(*) filter (where s.status::text = 'open')::int,
    count(*) filter (where s.status::text = 'in_progress')::int,
    count(*) filter (where s.status::text = 'resolved')::int,
    count(*) filter (where s.status::text = 'verified')::int,
    -- "open" for the severity breakdown means still outstanding, i.e. not yet
    -- resolved — an in-progress high-severity defect is still a live problem.
    count(*) filter (where s.status::text in ('open','in_progress')
                       and s.severity::text = 'low')::int,
    count(*) filter (where s.status::text in ('open','in_progress')
                       and s.severity::text = 'medium')::int,
    count(*) filter (where s.status::text in ('open','in_progress')
                       and s.severity::text = 'high')::int,
    count(*) filter (where s.raised_during_dlp
                       and s.status::text <> 'verified')::int,
    p.dlp_start_date,
    p.dlp_end_date,
    (p.dlp_start_date is not null and p.dlp_end_date is not null
       and current_date between p.dlp_start_date and p.dlp_end_date),
    case when p.dlp_end_date is not null
         then (p.dlp_end_date - current_date)::int end
  from public.projects p
  left join public.snags s on s.project_id = p.id
  where p.id = p_project
    and public.is_member(p.id)
  group by p.dlp_start_date, p.dlp_end_date;
$$;

revoke all on function public.fn_project_snag_summary(uuid) from public, anon;
grant execute on function public.fn_project_snag_summary(uuid) to authenticated;


-- ############################################################
-- ###  8. HARD DELETE — add a snags branch
-- ############################################################
-- Identical to 022 plus snags. A snag has no downstream effect, so it belongs
-- in mechanism 1: raised in error, deleted, no cancel state needed.
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

  -- ---------------------------------------------------------------- SNAG
  elsif p_table = 'snags' then
    select project_id, status::text into v_project, v_status
    from public.snags where id = p_id;
    if v_project is null then raise exception 'That snag no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    -- A verified snag is a signed-off record of a defect and its fix. Deleting
    -- it erases the evidence trail; reopen it instead if it has come back.
    if v_status = 'verified' then
      raise exception
        'That snag was verified — it is the record that a defect was fixed and signed off. Reopen it if the defect has come back.';
    end if;
    delete from public.snags where id = p_id;

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
-- ###  9. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'snags'
order by ordinal_position;

select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_resolve_snag', 'fn_verify_snag', 'fn_set_snag_status',
                  'fn_project_snag_summary', 'fn_snag_dlp_flag', 'fn_delete_record')
order by proname;
