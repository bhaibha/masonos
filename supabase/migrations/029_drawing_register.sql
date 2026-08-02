-- ============================================================
-- MASON OS — Migration 029: A10 Design / Drawing Management (Module 32)
--
-- A controlled drawing register. The thing this module exists to prevent is
-- somebody building off a superseded sheet, so every rule below is aimed at one
-- guarantee: at any moment a drawing has AT MOST ONE revision that is
-- Issued For Construction, and that is the only revision a supervisor can see
-- or open.
--
-- ---------- WHY TWO TABLES ----------
-- `drawings` is the identity (number, title, discipline) and never changes.
-- `drawing_revisions` is what actually gets issued. Rev A and Rev B of
-- SD-101 are not two drawings; folding them into one table would make
-- "the current sheet" a client-side max() over rows, which is exactly the sort
-- of thing that is right until the day it isn't.
--
-- ---------- THE ONE-IFC GUARANTEE ----------
-- A partial unique index — unique (drawing_id) where status = 'ifc' — makes two
-- live revisions of the same drawing IMPOSSIBLE, not merely unlikely. The
-- supersede-then-issue swap happens inside fn_issue_revision in one
-- transaction, in that order, so the index is never violated mid-flight.
--
-- ---------- SUPERVISORS ----------
-- Founder/PM manage the register. A supervisor sees ONLY `ifc` revisions, and
-- the RLS policy is what enforces it, not a filter in the query. Two layers,
-- because the risk is physical:
--   1. row level — non-IFC revisions do not exist for a supervisor;
--   2. object level — the `drawings` storage bucket asks
--      fn_drawing_file_is_current() before letting anyone but founder/pm/
--      accounts download a file. A path is a uuid and effectively unguessable,
--      but "they can't guess it" is not an access rule.
--
-- ---------- WHY A NEW BUCKET ----------
-- The `documents` bucket's read policy is is_member + not-confidential, with no
-- notion of a revision's status, and 006's policies are load-bearing across the
-- whole vault. Extending them to understand drawings would put every existing
-- document behind a new, more complicated predicate. A separate bucket keeps
-- the blast radius at zero.
--
-- DWG, PDF and DXF are uploaded byte-for-byte by the client — a re-encoded
-- drawing is a corrupted drawing.
--
-- Re-runnable: create-type guarded, create-table-if-not-exists, drop-policy /
-- trigger / constraint before create, create-or-replace on functions,
-- drop-view-then-create (never create-or-replace — CLAUDE.md).
-- ============================================================


-- ############################################################
-- ###  1. TYPES
-- ############################################################

do $$ begin
  create type drawing_discipline as enum
    ('architectural', 'structural', 'mep', 'interior', 'landscape', 'other');
exception when duplicate_object then null; end $$;

-- wip        — being drawn or reviewed. Never visible to site.
-- ifc        — Issued For Construction. Build from this one.
-- superseded — was IFC, replaced by a later revision. Kept forever.
do $$ begin
  create type drawing_status as enum ('wip', 'ifc', 'superseded');
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  2. TABLES
-- ############################################################

create table if not exists public.drawings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  drawing_no text not null,
  title text not null,
  discipline drawing_discipline not null default 'architectural',

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A drawing number is unique WITHIN a project — two villas both having an
-- SD-101 is normal and correct.
create unique index if not exists drawings_no_uk
  on public.drawings (project_id, upper(btrim(drawing_no)));

create index if not exists drawings_project_idx
  on public.drawings (project_id, discipline);


create table if not exists public.drawing_revisions (
  id uuid primary key default gen_random_uuid(),
  drawing_id uuid not null references public.drawings(id) on delete cascade,

  -- Denormalised from the parent by a trigger. RLS on this table has to answer
  -- "which project?" on every row read; a join in a policy would be both slow
  -- and easy to get subtly wrong.
  project_id uuid not null references public.projects(id) on delete cascade,

  revision text not null,
  status drawing_status not null default 'wip',

  issued_date date,
  file_path text,
  file_type text,
  notes text,

  issued_by uuid references public.profiles(id),
  issued_at timestamptz,
  superseded_at timestamptz,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);

create unique index if not exists drawing_rev_uk
  on public.drawing_revisions (drawing_id, upper(btrim(revision)));

create index if not exists drawing_rev_drawing_idx
  on public.drawing_revisions (drawing_id, created_at desc);

create index if not exists drawing_rev_project_idx
  on public.drawing_revisions (project_id, status);

-- ---------- THE GUARANTEE ----------
-- One live revision per drawing. Not a convention, not a check in the UI: an
-- index, so the database refuses the second one.
create unique index if not exists drawing_rev_one_ifc_uk
  on public.drawing_revisions (drawing_id)
  where status = 'ifc';

-- An issued revision must have a file and a date. "Issued For Construction"
-- with nothing to build from is a lie the row would otherwise be able to tell.
alter table public.drawing_revisions drop constraint if exists drawing_rev_issued_ck;
alter table public.drawing_revisions add constraint drawing_rev_issued_ck check (
  status::text = 'wip'
  or (coalesce(btrim(file_path), '') <> '' and issued_date is not null)
);

comment on index public.drawing_rev_one_ifc_uk is
  'At most one Issued-For-Construction revision per drawing. This index is the '
  'module: everything else is presentation.';


-- ############################################################
-- ###  3. PROJECT DENORMALISATION TRIGGER
-- ############################################################
create or replace function public.fn_drawing_rev_project()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  select d.project_id into new.project_id
  from public.drawings d where d.id = new.drawing_id;

  if new.project_id is null then
    raise exception 'That drawing no longer exists.';
  end if;
  return new;
end $$;

drop trigger if exists drawing_rev_project on public.drawing_revisions;
create trigger drawing_rev_project
  before insert on public.drawing_revisions
  for each row execute function public.fn_drawing_rev_project();


-- ############################################################
-- ###  4. RLS
-- ############################################################
alter table public.drawings          enable row level security;
alter table public.drawing_revisions enable row level security;

-- The drawing's identity is readable by every project member: a supervisor
-- needs to know SD-101 exists to ask why it hasn't been issued.
drop policy if exists drawings_read on public.drawings;
create policy drawings_read on public.drawings for select to authenticated
  using (public.is_member(project_id));

drop policy if exists drawings_write on public.drawings;
create policy drawings_write on public.drawings for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm'));

drop policy if exists drawings_update on public.drawings;
create policy drawings_update on public.drawings for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm'))
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm'));

-- ---------- the important one ----------
-- A supervisor sees IFC revisions and nothing else. Not "the UI filters to
-- IFC" — the rows are not there. WIP and superseded sheets are invisible.
drop policy if exists drawing_rev_read on public.drawing_revisions;
create policy drawing_rev_read on public.drawing_revisions for select to authenticated
  using (
    public.is_member(project_id)
    and (
      public.my_role() in ('founder', 'pm', 'accounts')
      or status::text = 'ifc'
    )
  );

drop policy if exists drawing_rev_insert on public.drawing_revisions;
create policy drawing_rev_insert on public.drawing_revisions for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm'));

-- Editing notes on a WIP revision is fine. The status flip is NOT done here —
-- it goes through fn_issue_revision, because superseding the previous revision
-- and issuing the new one have to happen together or not at all.
drop policy if exists drawing_rev_update on public.drawing_revisions;
create policy drawing_rev_update on public.drawing_revisions for update to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm'))
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm'));

-- No DELETE policy on either table — removal goes through fn_delete_record.


-- ############################################################
-- ###  5. AUDIT
-- ############################################################
drop trigger if exists audit_drawings on public.drawings;
create trigger audit_drawings
  after insert or update or delete on public.drawings
  for each row execute function public.fn_audit();

drop trigger if exists audit_drawing_revisions on public.drawing_revisions;
create trigger audit_drawing_revisions
  after insert or update or delete on public.drawing_revisions
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  6. REGISTER VIEW
-- ############################################################
-- One row per drawing, carrying its current sheet. security_invoker, so a
-- supervisor's revision policy applies inside the view too — which means
-- `current_*` for them can only ever describe an IFC revision.
--
-- The final WHERE hides drawings that have never been issued from anyone who
-- only reads IFC: a bare drawing number with no sheet behind it is noise on a
-- phone at site.
drop view if exists public.v_drawing_register cascade;
create view public.v_drawing_register with (security_invoker = true) as
with current_rev as (
  select distinct on (r.drawing_id)
    r.drawing_id, r.id, r.revision, r.status, r.issued_date,
    r.file_path, r.file_type, r.notes, r.issued_at
  from public.drawing_revisions r
  where r.status::text = 'ifc'
  order by r.drawing_id, r.issued_date desc nulls last, r.created_at desc
),
latest_any as (
  select distinct on (r.drawing_id)
    r.drawing_id, r.id, r.revision, r.status, r.created_at
  from public.drawing_revisions r
  order by r.drawing_id, r.created_at desc
)
select
  d.id,
  d.project_id,
  d.drawing_no,
  d.title,
  d.discipline,
  d.created_at,
  c.id           as current_revision_id,
  c.revision     as current_revision,
  c.issued_date  as current_issued_date,
  c.file_path    as current_file_path,
  c.file_type    as current_file_type,
  c.notes        as current_notes,
  l.revision     as latest_revision,
  l.status       as latest_status,
  -- A drawn-up revision waiting to be issued. Only founder/pm/accounts can see
  -- the row it counts, so this is 0 for a supervisor by construction.
  (select count(*) from public.drawing_revisions r
    where r.drawing_id = d.id and r.status::text = 'wip')::int as wip_count,
  (select count(*) from public.drawing_revisions r
    where r.drawing_id = d.id and r.status::text = 'superseded')::int
    as superseded_count,
  (select count(*) from public.drawing_revisions r
    where r.drawing_id = d.id)::int as revision_count
from public.drawings d
left join current_rev c on c.drawing_id = d.id
left join latest_any  l on l.drawing_id = d.id
where public.my_role() in ('founder', 'pm', 'accounts')
   or c.id is not null;

grant select on public.v_drawing_register to authenticated;

comment on view public.v_drawing_register is
  'One row per drawing with its Issued-For-Construction sheet. security_invoker, '
  'so a supervisor only ever resolves current_* to an IFC revision, and drawings '
  'with nothing issued are hidden from them entirely.';


-- ############################################################
-- ###  7. ISSUE A REVISION (supersede + issue, atomically)
-- ############################################################
create or replace function public.fn_issue_revision(
  p_id     uuid,
  p_date   date default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_rev     public.drawing_revisions%rowtype;
  v_now     timestamptz := now();
  v_me      uuid := auth.uid();
  v_prev    uuid;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_rev from public.drawing_revisions where id = p_id;
  if v_rev.id is null then
    raise exception 'That revision no longer exists.';
  end if;
  if not public.is_member(v_rev.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may issue a drawing for construction.'
      using errcode = '42501';
  end if;
  if v_rev.status::text = 'ifc' then
    raise exception 'That revision is already issued for construction.';
  end if;
  if v_rev.status::text = 'superseded' then
    raise exception
      'That revision was superseded. Issue the newer one, or upload a fresh revision — a drawing cannot go backwards.';
  end if;
  if coalesce(btrim(v_rev.file_path), '') = '' then
    raise exception
      'Attach the drawing file before issuing it. An IFC revision with no sheet is worse than no revision at all.';
  end if;

  -- Order matters: vacate the unique index before filling it.
  select id into v_prev
  from public.drawing_revisions
  where drawing_id = v_rev.drawing_id and status::text = 'ifc';

  if v_prev is not null then
    update public.drawing_revisions
       set status = 'superseded'::drawing_status,
           superseded_at = v_now
     where id = v_prev;
  end if;

  update public.drawing_revisions
     set status      = 'ifc'::drawing_status,
         issued_date = coalesce(p_date, issued_date,
                                (now() at time zone 'Asia/Kolkata')::date),
         issued_by   = v_me,
         issued_at   = v_now
   where id = p_id;

  update public.drawings set updated_at = v_now where id = v_rev.drawing_id;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values ('drawing_revisions', 'ISSUE', p_id::text,
          jsonb_build_object('superseded_revision_id', v_prev),
          jsonb_build_object('issued_by', v_me, 'issued_at', v_now));
end $$;

revoke all on function public.fn_issue_revision(uuid, date) from public, anon;
grant execute on function public.fn_issue_revision(uuid, date) to authenticated;


-- ---------- pull a drawing out of construction ----------
-- Used when a sheet is withdrawn and nothing replaces it yet. Deliberately not
-- called "unissue": the revision becomes superseded, not WIP, because it WAS on
-- site and that fact is part of the record.
create or replace function public.fn_withdraw_revision(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_rev public.drawing_revisions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_rev from public.drawing_revisions where id = p_id;
  if v_rev.id is null then
    raise exception 'That revision no longer exists.';
  end if;
  if not public.is_member(v_rev.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may withdraw a drawing.'
      using errcode = '42501';
  end if;
  if v_rev.status::text <> 'ifc' then
    raise exception 'Only the current construction revision can be withdrawn.';
  end if;

  update public.drawing_revisions
     set status = 'superseded'::drawing_status, superseded_at = now()
   where id = p_id;
end $$;

revoke all on function public.fn_withdraw_revision(uuid) from public, anon;
grant execute on function public.fn_withdraw_revision(uuid) to authenticated;


-- ############################################################
-- ###  8. STORAGE — drawings bucket
-- ############################################################
insert into storage.buckets (id, name, public)
values ('drawings', 'drawings', false)
on conflict (id) do nothing;

-- Is this object the file of a revision that is currently IFC?
--
-- MUST be SECURITY DEFINER, for the same reason fn_doc_is_confidential is: run
-- as the caller, drawing_rev_read would hide a WIP row from a supervisor, the
-- EXISTS would come back false, and a policy written the other way round would
-- draw the wrong conclusion. Run as owner it sees the true status.
create or replace function public.fn_drawing_file_is_current(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.drawing_revisions r
    where r.file_path = p_path and r.status::text = 'ifc'
  )
$$;

revoke all on function public.fn_drawing_file_is_current(text) from public, anon;
grant execute on function public.fn_drawing_file_is_current(text) to authenticated;

create index if not exists drawing_rev_file_path_idx
  on public.drawing_revisions (file_path);

-- Read: project members. Anyone below founder/pm/accounts additionally has to
-- be asking for a sheet that is actually current.
drop policy if exists drawings_files_read on storage.objects;
create policy drawings_files_read on storage.objects for select to authenticated
using (
  bucket_id = 'drawings'
  and public.is_member(public.fn_storage_project(name))
  and (
    public.my_role() in ('founder', 'pm', 'accounts')
    or public.fn_drawing_file_is_current(name)
  )
);

drop policy if exists drawings_files_insert on storage.objects;
create policy drawings_files_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'drawings'
  and public.is_member(public.fn_storage_project(name))
  and public.my_role() in ('founder', 'pm')
);

drop policy if exists drawings_files_delete on storage.objects;
create policy drawings_files_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'drawings'
  and public.is_member(public.fn_storage_project(name))
  and (public.is_founder() or owner = auth.uid())
);


-- ############################################################
-- ###  9. HARD DELETE — drawings + revisions
-- ############################################################
-- Identical to 028 plus two branches. A WIP revision that was never issued has
-- no downstream effect and can go. An issued or superseded one cannot: it is
-- the record of what site was told to build, and that is the entire point of a
-- controlled register.
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

  -- ------------------------------------------------------ DRAWING REVISION
  elsif p_table = 'drawing_revisions' then
    select project_id, status::text into v_project, v_status
    from public.drawing_revisions where id = p_id;
    if v_project is null then raise exception 'That revision no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status <> 'wip' then
      raise exception
        'That revision was issued for construction. It stays on the register — supersede it with a newer revision instead.';
    end if;
    delete from public.drawing_revisions where id = p_id;

  -- ------------------------------------------------------------- DRAWING
  elsif p_table = 'drawings' then
    select project_id into v_project from public.drawings where id = p_id;
    if v_project is null then raise exception 'That drawing no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    select count(*) into v_n from public.drawing_revisions where drawing_id = p_id;
    if v_n > 0 then
      raise exception
        'This drawing has % revision(s) on the register. Delete an unissued revision first; issued ones are permanent.',
        v_n; end if;
    delete from public.drawings where id = p_id;

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
-- ###  10. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'drawing_revisions'
order by ordinal_position;

-- Expect all four.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_issue_revision', 'fn_withdraw_revision',
                  'fn_drawing_file_is_current', 'fn_delete_record')
order by proname;

-- Expect the one-IFC index to exist. This is the guarantee.
select indexname from pg_indexes
where schemaname = 'public' and indexname = 'drawing_rev_one_ifc_uk';
