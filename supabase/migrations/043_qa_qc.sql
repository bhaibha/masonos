-- ============================================================
-- MASON OS — Migration 043: QA/QC — ITPs, hold points, inspections, NCRs
--                           (B2 / Module 17)
--
-- ---------- THERE IS NO "QA ROLE", AND THERE MUST NOT BE ----------
-- The brief asks for "founder/PM (or a QA role)" to sign off hold points.
-- `profiles.role` is a FOUR-value enum that every RLS policy in this database
-- checks, and CLAUDE.md is explicit that `designation` is a display-only job
-- title which must never become load-bearing in a policy. Adding a fifth role
-- would mean revisiting every policy written since 001 to decide where QA sits
-- — a change with a blast radius across the whole app, made for one module.
--
-- So sign-off is FOUNDER/PM. A quality engineer is given the `pm` access role
-- with the designation "Quality Engineer"; that is exactly what the Admin
-- module's designation → role mapping exists for. If QA genuinely needs to be
-- separable from PM later, that is its own migration with its own audit of
-- every policy, not a side effect of this one.
--
-- ---------- WHY SUPERVISORS CANNOT RECORD AN INSPECTION ----------
-- Not pedantry, and not distrust. An inspection record IS the approval — it is
-- the row somebody points at in two years when a slab cracks. A supervisor
-- REQUESTS one (`fn_request_inspection`), which is a real, timestamped act
-- that starts the clock and is visible to the PM. They do not sign their own
-- work off, which is the entire reason a hold point exists.
--
-- ---------- WHAT "BLOCKS" MEANS ----------
-- A hold point that has not passed blocks progress being recorded on the
-- activities that DEPEND on the one it guards — enforced inside
-- `fn_set_activity_progress`, not by hiding a button. Blocking the recording
-- rather than the work is the honest lever: the app cannot stop a mason
-- pouring concrete, but it can refuse to accept a claim of progress past an
-- unsigned hold, and it names the hold point in the refusal so the way out is
-- obvious.
--
-- There is deliberately NO override. A hold point with a bypass is a checklist,
-- and the difference between a checklist and a hold point is exactly that you
-- cannot walk past it.
--
-- ---------- TEMPLATES ----------
-- A firm that re-types "Reinforcement before concreting — IS 456" on every
-- project will eventually type it differently, and then two projects cannot be
-- compared. Templates are firm-level (no project_id), founder/PM-managed, and
-- applied to a project by `fn_apply_itp_template`, which copies rows. The copy
-- is deliberate: editing a template must never silently restate an inspection
-- that has already been signed off.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. ENUMS
-- ############################################################
do $$ begin
  create type itp_type as enum ('witness', 'hold', 'review');
exception when duplicate_object then null; end $$;

-- pending → requested → passed / failed. `requested` is the supervisor's act;
-- everything after it is the PM's.
do $$ begin
  create type itp_status as enum ('pending', 'requested', 'passed', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type inspection_result as enum ('pass', 'fail', 'conditional');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ncr_severity as enum ('minor', 'major', 'critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ncr_status as enum
    ('open', 'corrected', 'closed', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  2. TEMPLATES — the firm's standard inspection points
-- ############################################################
create table if not exists public.itp_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The 041 lesson: normalised uniqueness, because case and a trailing space are
-- how two copies of the same template actually get created.
drop index if exists public.itp_template_name_uk;
create unique index itp_template_name_uk
  on public.itp_templates (lower(btrim(name)));

create table if not exists public.itp_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null
    references public.itp_templates(id) on delete cascade,

  stage text not null,
  description text not null,
  acceptance_criteria text,
  inspection_type itp_type not null default 'witness',
  reference_standard text,
  required_by_stage text,

  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists itp_tmpl_item_idx
  on public.itp_template_items (template_id, sort_order);


-- ############################################################
-- ###  3. ITP ITEMS — the live inspection plan for one project
-- ############################################################
create table if not exists public.itp_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  -- Which piece of the programme this guards. Nullable: a plan can be written
  -- before the schedule exists, and B1's activities are ON DELETE SET NULL
  -- everywhere for the same reason — deleting a plan line must not delete the
  -- quality record attached to it.
  activity_id uuid references public.schedule_activities(id) on delete set null,

  stage text not null,
  description text not null,
  acceptance_criteria text,
  inspection_type itp_type not null default 'witness',
  reference_standard text,
  required_by_stage text,

  status itp_status not null default 'pending',

  -- Provenance, not a live link. Editing a template must never restate an
  -- inspection that has already been signed off.
  template_id uuid references public.itp_templates(id) on delete set null,

  sort_order int not null default 100,
  notes text,

  requested_at timestamptz,
  requested_by uuid references public.profiles(id),
  signed_off_at timestamptz,
  signed_off_by uuid references public.profiles(id),

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists itp_item_project_idx
  on public.itp_items (project_id, sort_order);
create index if not exists itp_item_activity_idx
  on public.itp_items (activity_id);
-- The index that makes the hold-point block cheap: open holds, per activity.
create index if not exists itp_item_open_hold_idx
  on public.itp_items (activity_id)
  where inspection_type = 'hold' and status <> 'passed';


-- ############################################################
-- ###  4. INSPECTION RECORDS
-- ############################################################
-- Append-only by design. An inspection is the row somebody points at when a
-- slab cracks; it is never edited, and a wrong one is superseded by a later
-- inspection rather than rewritten.
create table if not exists public.inspections (
  id uuid primary key default gen_random_uuid(),
  itp_item_id uuid not null references public.itp_items(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  inspected_on date not null default (now() at time zone 'Asia/Kolkata')::date,
  result inspection_result not null,
  remarks text,
  photos text[] not null default '{}',

  inspector uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists inspection_item_idx
  on public.inspections (itp_item_id, inspected_on desc);
create index if not exists inspection_project_idx
  on public.inspections (project_id, inspected_on desc);


-- ############################################################
-- ###  5. NCRs
-- ############################################################
create sequence if not exists public.ncr_number_seq;

create table if not exists public.ncrs (
  id uuid primary key default gen_random_uuid(),
  ncr_no text not null unique
    default 'NCR-' || lpad(nextval('public.ncr_number_seq')::text, 4, '0'),

  project_id uuid not null references public.projects(id) on delete cascade,

  -- Where it came from. Both nullable: an NCR can be raised on its own from
  -- site, or fall out of a failed inspection.
  itp_item_id uuid references public.itp_items(id) on delete set null,
  inspection_id uuid references public.inspections(id) on delete set null,

  area text not null,
  description text not null,
  severity ncr_severity not null default 'minor',
  standard_ref text,
  photos text[] not null default '{}',

  status ncr_status not null default 'open',

  assigned_to uuid references public.profiles(id),
  corrective_action text,
  corrected_at timestamptz,
  corrected_by uuid references public.profiles(id),

  closed_at timestamptz,
  closed_by uuid references public.profiles(id),
  reject_reason text,

  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancel_reason text,

  raised_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ncr_project_idx
  on public.ncrs (project_id, created_at desc);
create index if not exists ncr_open_idx
  on public.ncrs (project_id, severity)
  where status in ('open', 'corrected');

-- The same shape every cancellation in this database has carried since 021:
-- a cancelled row without a signatory and a reason is not a record of anything.
alter table public.ncrs drop constraint if exists ncr_cancel_ck;
alter table public.ncrs add constraint ncr_cancel_ck check (
  cancelled_at is null
  or (cancelled_by is not null and coalesce(btrim(cancel_reason), '') <> '')
);


-- ############################################################
-- ###  6. RLS
-- ############################################################
alter table public.itp_templates      enable row level security;
alter table public.itp_template_items enable row level security;
alter table public.itp_items          enable row level security;
alter table public.inspections        enable row level security;
alter table public.ncrs               enable row level security;

-- ---- templates: everyone reads (a supervisor should be able to see what the
-- ---- firm's standard is), founder/PM write.
drop policy if exists itp_tmpl_read on public.itp_templates;
create policy itp_tmpl_read on public.itp_templates
  for select to authenticated using (true);

drop policy if exists itp_tmpl_write on public.itp_templates;
create policy itp_tmpl_write on public.itp_templates
  for all to authenticated
  using (public.my_role() in ('founder', 'pm'))
  with check (public.my_role() in ('founder', 'pm'));

drop policy if exists itp_tmpl_item_read on public.itp_template_items;
create policy itp_tmpl_item_read on public.itp_template_items
  for select to authenticated using (true);

drop policy if exists itp_tmpl_item_write on public.itp_template_items;
create policy itp_tmpl_item_write on public.itp_template_items
  for all to authenticated
  using (public.my_role() in ('founder', 'pm'))
  with check (public.my_role() in ('founder', 'pm'));

-- ---- ITP items: every project member reads. Nothing here is a money figure,
-- ---- so a supervisor sees the whole plan — they are the person working to it.
drop policy if exists itp_item_read on public.itp_items;
create policy itp_item_read on public.itp_items
  for select to authenticated using (public.is_member(project_id));

drop policy if exists itp_item_insert on public.itp_items;
create policy itp_item_insert on public.itp_items
  for insert to authenticated
  with check (
    public.my_role() in ('founder', 'pm') and public.is_member(project_id)
  );

-- Founder/PM edit the plan. A supervisor changes an item's status ONLY through
-- fn_request_inspection — the same reasoning as 042's progress RPC: a policy
-- loose enough to let them set `status` would let them set it to `passed`.
drop policy if exists itp_item_update on public.itp_items;
create policy itp_item_update on public.itp_items
  for update to authenticated
  using (public.my_role() in ('founder', 'pm') and public.is_member(project_id))
  with check (public.my_role() in ('founder', 'pm') and public.is_member(project_id));

-- No DELETE policy — fn_delete_itp_item is the only path.

-- ---- inspections: members read; NOBODY inserts directly.
drop policy if exists inspection_read on public.inspections;
create policy inspection_read on public.inspections
  for select to authenticated using (public.is_member(project_id));

-- Deliberately no INSERT, UPDATE or DELETE policy at all. RLS default-deny plus
-- `fn_record_inspection` means there is exactly one way an inspection can come
-- into existence, and it is the one that also moves the ITP status and raises
-- the NCR. A second path would eventually create an inspection whose failure
-- never produced an NCR.

-- ---- NCRs: every project member reads and raises. Site people find the
-- ---- defects; a system only QA can write to gets nothing written to it.
drop policy if exists ncr_read on public.ncrs;
create policy ncr_read on public.ncrs
  for select to authenticated using (public.is_member(project_id));

drop policy if exists ncr_insert on public.ncrs;
create policy ncr_insert on public.ncrs
  for insert to authenticated
  with check (
    public.my_role() in ('founder', 'pm', 'supervisor')
    and public.is_member(project_id)
  );

-- Founder/PM may edit an NCR's descriptive fields. Every STATUS move goes
-- through fn_set_ncr_status, including the supervisor's corrective action.
drop policy if exists ncr_update on public.ncrs;
create policy ncr_update on public.ncrs
  for update to authenticated
  using (public.my_role() in ('founder', 'pm') and public.is_member(project_id))
  with check (public.my_role() in ('founder', 'pm') and public.is_member(project_id));

-- No DELETE policy. An NCR is cancelled with a reason, never deleted — the
-- record that a defect was once alleged is itself worth keeping.


-- ############################################################
-- ###  7. AUDIT
-- ############################################################
drop trigger if exists audit_itp_items on public.itp_items;
create trigger audit_itp_items
  after insert or update or delete on public.itp_items
  for each row execute function public.fn_audit();

drop trigger if exists audit_inspections on public.inspections;
create trigger audit_inspections
  after insert or update or delete on public.inspections
  for each row execute function public.fn_audit();

drop trigger if exists audit_ncrs on public.ncrs;
create trigger audit_ncrs
  after insert or update or delete on public.ncrs
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  8. APPLY A TEMPLATE TO A PROJECT
-- ############################################################
-- Copies rows, it does not link them. A template edited next year must not
-- restate an inspection signed off last year.
create or replace function public.fn_apply_itp_template(
  p_project  uuid,
  p_template uuid
)
returns int
language plpgsql security definer set search_path = public
as $$
declare v_n int; v_name text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may apply an inspection plan.'
      using errcode = '42501';
  end if;
  if not public.is_member(p_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  select name into v_name from public.itp_templates where id = p_template;
  if v_name is null then
    raise exception 'That template no longer exists.';
  end if;

  -- Applying twice would double every inspection point, and the second copy
  -- would look exactly like the first until somebody signed off the wrong one.
  select count(*) into v_n
  from public.itp_items where project_id = p_project and template_id = p_template;
  if v_n > 0 then
    raise exception
      '"%" is already applied to this project — % item(s) came from it. Remove those first if you want to re-apply it.',
      v_name, v_n;
  end if;

  insert into public.itp_items
    (project_id, stage, description, acceptance_criteria, inspection_type,
     reference_standard, required_by_stage, template_id, sort_order, created_by)
  select
    p_project, t.stage, t.description, t.acceptance_criteria, t.inspection_type,
    t.reference_standard, t.required_by_stage, p_template, t.sort_order, auth.uid()
  from public.itp_template_items t
  where t.template_id = p_template;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_apply_itp_template(uuid, uuid) from public, anon;
grant execute on function public.fn_apply_itp_template(uuid, uuid) to authenticated;


-- Save an existing project's plan back as a firm template, so a plan worked out
-- once on site becomes the standard rather than being retyped.
create or replace function public.fn_save_itp_template(
  p_project uuid,
  p_name    text,
  p_description text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_n int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may save a template.'
      using errcode = '42501';
  end if;
  if not public.is_member(p_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Give the template a name.';
  end if;

  select count(*) into v_n from public.itp_items where project_id = p_project;
  if v_n = 0 then
    raise exception 'This project has no inspection points to save.';
  end if;

  insert into public.itp_templates (name, description)
  values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
  returning id into v_id;

  insert into public.itp_template_items
    (template_id, stage, description, acceptance_criteria, inspection_type,
     reference_standard, required_by_stage, sort_order)
  select
    v_id, i.stage, i.description, i.acceptance_criteria, i.inspection_type,
    i.reference_standard, i.required_by_stage, i.sort_order
  from public.itp_items i
  where i.project_id = p_project;

  return v_id;
end $$;

revoke all on function public.fn_save_itp_template(uuid, text, text) from public, anon;
grant execute on function public.fn_save_itp_template(uuid, text, text) to authenticated;


-- ############################################################
-- ###  9. REQUEST AN INSPECTION — the supervisor's act
-- ############################################################
create or replace function public.fn_request_inspection(p_item uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid; v_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select project_id, status::text into v_project, v_status
  from public.itp_items where id = p_item;
  if v_project is null then
    raise exception 'That inspection point no longer exists.';
  end if;
  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot request an inspection.' using errcode = '42501';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_status = 'passed' then
    raise exception 'That point has already passed.';
  end if;

  update public.itp_items
     set status = 'requested'::itp_status,
         requested_at = now(),
         requested_by = auth.uid(),
         updated_at = now()
   where id = p_item;
end $$;

revoke all on function public.fn_request_inspection(uuid) from public, anon;
grant execute on function public.fn_request_inspection(uuid) to authenticated;


-- ############################################################
-- ### 10. RECORD AN INSPECTION — founder/PM only
-- ############################################################
-- One function writes the inspection, moves the ITP status and raises the NCR
-- on a fail or a conditional pass. They are one act, so they are one
-- transaction: an inspection recorded as failed without its NCR is how a defect
-- gets forgotten, and two code paths would eventually let that happen.
--
-- CONDITIONAL raises an NCR **and** passes the point. That is what conditional
-- means on site — the next stage may proceed, and something still has to be
-- put right. Treating it as a fail would stop the job; treating it as a clean
-- pass would lose the defect.
create or replace function public.fn_record_inspection(
  p_item    uuid,
  p_result  text,
  p_date    date default null,
  p_remarks text default null,
  p_photos  text[] default '{}'
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_project uuid; v_desc text; v_ref text; v_type text; v_stage text;
  v_insp uuid; v_ncr uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_result not in ('pass', 'fail', 'conditional') then
    raise exception 'Result must be pass, fail or conditional.';
  end if;

  select project_id, description, reference_standard, inspection_type::text, stage
    into v_project, v_desc, v_ref, v_type, v_stage
  from public.itp_items where id = p_item;
  if v_project is null then
    raise exception 'That inspection point no longer exists.';
  end if;

  -- The whole point of the module. A supervisor requests; they do not sign
  -- their own work off.
  if public.my_role() not in ('founder', 'pm') then
    raise exception
      'Only a founder or PM signs off an inspection. Request one instead — it is recorded against your name and the PM can see it.'
      using errcode = '42501';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  insert into public.inspections
    (itp_item_id, project_id, inspected_on, result, remarks, photos, inspector)
  values
    (p_item, v_project,
     coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date),
     p_result::inspection_result,
     nullif(btrim(coalesce(p_remarks, '')), ''),
     coalesce(p_photos, '{}'),
     auth.uid())
  returning id into v_insp;

  update public.itp_items
     set status = case when p_result = 'fail'
                       then 'failed'::itp_status
                       else 'passed'::itp_status end,
         -- A failed point has no signatory: nothing was signed off. Recording
         -- one would make the register read as though it had been.
         signed_off_at = case when p_result = 'fail' then null else now() end,
         signed_off_by = case when p_result = 'fail' then null else auth.uid() end,
         updated_at = now()
   where id = p_item;

  if p_result in ('fail', 'conditional') then
    insert into public.ncrs
      (project_id, itp_item_id, inspection_id, area, description, severity,
       standard_ref, photos, raised_by)
    values
      (v_project, p_item, v_insp,
       coalesce(nullif(btrim(v_stage), ''), 'Not stated'),
       case when p_result = 'fail' then 'Failed inspection: ' else 'Conditional pass: ' end
         || v_desc
         || case when nullif(btrim(coalesce(p_remarks, '')), '') is null
                 then '' else ' — ' || btrim(p_remarks) end,
       -- A hold point that failed stopped the job; that is major by
       -- definition. Everything else starts minor and is raised by hand.
       case when p_result = 'fail' and v_type = 'hold'
            then 'major'::ncr_severity else 'minor'::ncr_severity end,
       v_ref,
       coalesce(p_photos, '{}'),
       auth.uid())
    returning id into v_ncr;
  end if;

  return v_insp;
end $$;

revoke all on function public.fn_record_inspection(uuid, text, date, text, text[])
  from public, anon;
grant execute on function public.fn_record_inspection(uuid, text, date, text, text[])
  to authenticated;


-- ############################################################
-- ### 11. NCR STATUS
-- ############################################################
-- Its own function rather than a branch in `fn_cancel_document`: NCRs have four
-- status moves and only one of them is a cancellation, so a dispatcher call
-- would handle a quarter of the module. The same shape as `fn_set_si_status`,
-- `fn_set_rfi_status` and `fn_set_snag_status`, which coexist with that
-- dispatcher for the same reason.
--
-- Who may do what is the module's whole argument:
--   corrected           — supervisor, PM or founder. The person who fixed it
--                         says what they did.
--   closed / rejected   — founder or PM ONLY. Nobody closes their own NCR.
--   cancelled           — founder or PM, reason mandatory.
create or replace function public.fn_set_ncr_status(
  p_id     uuid,
  p_status text,
  p_note   text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid; v_status text; v_raised uuid; v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_status not in ('open', 'corrected', 'closed', 'rejected', 'cancelled') then
    raise exception 'Unknown NCR status "%".', p_status;
  end if;

  select project_id, status::text, raised_by
    into v_project, v_status, v_raised
  from public.ncrs where id = p_id;
  if v_project is null then
    raise exception 'That NCR no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_status = 'cancelled' then
    raise exception 'That NCR is cancelled.';
  end if;

  if p_status = 'corrected' then
    if public.my_role() not in ('founder', 'pm', 'supervisor') then
      raise exception 'Your role cannot record a corrective action.'
        using errcode = '42501';
    end if;
    if coalesce(btrim(coalesce(p_note, '')), '') = '' then
      raise exception
        'Say what was actually done to correct it. "Corrected" with no description closes nothing.'
        using errcode = '22023';
    end if;

    update public.ncrs
       set status = 'corrected'::ncr_status,
           corrective_action = btrim(p_note),
           corrected_at = v_now, corrected_by = auth.uid(), updated_at = v_now
     where id = p_id;

  elsif p_status in ('closed', 'rejected') then
    if public.my_role() not in ('founder', 'pm') then
      raise exception
        'Only a founder or PM closes an NCR. Record the corrective action and it goes back for re-inspection.'
        using errcode = '42501';
    end if;
    if p_status = 'closed' and v_status = 'open' then
      raise exception
        'Nothing has been recorded as corrected yet. Closing it now would leave no record of what was done.';
    end if;
    if p_status = 'rejected'
       and coalesce(btrim(coalesce(p_note, '')), '') = '' then
      raise exception 'Say why the correction was rejected.' using errcode = '22023';
    end if;

    update public.ncrs
       set status = p_status::ncr_status,
           closed_at = case when p_status = 'closed' then v_now end,
           closed_by = case when p_status = 'closed' then auth.uid() end,
           reject_reason = case when p_status = 'rejected'
                                then btrim(p_note) else reject_reason end,
           updated_at = v_now
     where id = p_id;

  elsif p_status = 'cancelled' then
    if public.my_role() not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may cancel an NCR.' using errcode = '42501';
    end if;
    if coalesce(btrim(coalesce(p_note, '')), '') = '' then
      raise exception 'A reason is required to cancel an NCR.' using errcode = '22023';
    end if;

    update public.ncrs
       set status = 'cancelled'::ncr_status,
           cancelled_at = v_now, cancelled_by = auth.uid(),
           cancel_reason = btrim(p_note), updated_at = v_now
     where id = p_id;

  else -- reopen
    if public.my_role() not in ('founder', 'pm') then
      raise exception 'Only a founder or PM may reopen an NCR.' using errcode = '42501';
    end if;
    update public.ncrs
       set status = 'open'::ncr_status,
           closed_at = null, closed_by = null, updated_at = v_now
     where id = p_id;
  end if;
end $$;

revoke all on function public.fn_set_ncr_status(uuid, text, text) from public, anon;
grant execute on function public.fn_set_ncr_status(uuid, text, text) to authenticated;


-- ############################################################
-- ### 12. WHAT IS BLOCKING AN ACTIVITY
-- ############################################################
-- A hold point blocks the activities that DEPEND on the one it guards. It does
-- not block its own activity: the work has to happen before it can be
-- inspected.
--
-- Invoker rights — this exposes stages and descriptions, never money, so a
-- supervisor is entitled to all of it and needs it most.
create or replace function public.fn_blocking_holds(p_activity uuid)
returns table (
  itp_item_id uuid,
  stage       text,
  description text,
  status      text,
  guarding    text
)
language sql
stable
security invoker
set search_path = public
as $$
  select i.id, i.stage, i.description, i.status::text, a.code || ' ' || a.name
  from public.activity_dependencies d
  join public.itp_items i on i.activity_id = d.predecessor_id
  join public.schedule_activities a on a.id = d.predecessor_id
  where d.successor_id = p_activity
    and i.inspection_type = 'hold'
    and i.status <> 'passed'
  order by i.sort_order, i.stage;
$$;

revoke all on function public.fn_blocking_holds(uuid) from public, anon;
grant execute on function public.fn_blocking_holds(uuid) to authenticated;


-- ############################################################
-- ### 13. PROGRESS, NOW WITH THE HOLD-POINT BLOCK
-- ############################################################
-- 042's function re-emitted whole with one guard added. There is deliberately
-- no override: a hold point you can walk past is a checklist, and the whole
-- difference between the two is that you cannot.
--
-- The block is on RECORDING progress, not on the work — the app cannot stop a
-- pour, but it can refuse to accept a claim of progress past an unsigned hold,
-- and it names the point so the way out is obvious rather than mysterious.
--
-- Setting progress back to 0 stays allowed: correcting a mistake must never be
-- the thing the block prevents.
create or replace function public.fn_set_activity_progress(
  p_id           uuid,
  p_pct          numeric,
  p_actual_start date default null,
  p_actual_end   date default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid; v_block record; v_current numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_pct is null or p_pct < 0 or p_pct > 100 then
    raise exception 'Progress must be between 0 and 100.';
  end if;

  select project_id, pct_complete into v_project, v_current
  from public.schedule_activities where id = p_id;
  if v_project is null then
    raise exception 'That activity no longer exists.';
  end if;

  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot update progress.' using errcode = '42501';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  -- Only when progress is going UP. Reducing it, or correcting it to zero, is
  -- always allowed.
  if p_pct > coalesce(v_current, 0) then
    select i.stage, i.description, a.code, a.name, i.status::text
      into v_block
    from public.activity_dependencies d
    join public.itp_items i on i.activity_id = d.predecessor_id
    join public.schedule_activities a on a.id = d.predecessor_id
    where d.successor_id = p_id
      and i.inspection_type = 'hold'
      and i.status <> 'passed'
    order by i.sort_order
    limit 1;

    if found then
      raise exception
        'Hold point not signed off: "%" on % %. It is % — an inspection has to pass before work past it can be recorded.',
        v_block.description, v_block.code, v_block.name, v_block.status
        using errcode = '23514';
    end if;
  end if;

  update public.schedule_activities
     set pct_complete = p_pct,
         actual_start = coalesce(p_actual_start, actual_start,
                                 case when p_pct > 0 then (now() at time zone 'Asia/Kolkata')::date end),
         actual_end   = case
                          when p_actual_end is not null then p_actual_end
                          when p_pct >= 100 then coalesce(actual_end, (now() at time zone 'Asia/Kolkata')::date)
                          else null
                        end,
         updated_at = now()
   where id = p_id;
end $$;

revoke all on function public.fn_set_activity_progress(uuid, numeric, date, date)
  from public, anon;
grant execute on function public.fn_set_activity_progress(uuid, numeric, date, date)
  to authenticated;


-- ############################################################
-- ### 14. QA SUMMARY
-- ############################################################
-- One row for the Project Detail card and the QA screen's header, so the two
-- can never disagree about how many NCRs are open.
--
-- The pass rate counts INSPECTIONS, not ITP points: a point that failed, was
-- corrected and passed is one pass and one fail, which is the honest number.
-- Counting only current status would hide every defect ever fixed.
create or replace function public.fn_qa_summary(p_project uuid)
returns table (
  open_ncrs        int,
  ncr_minor        int,
  ncr_major        int,
  ncr_critical     int,
  corrected_ncrs   int,
  closed_ncrs      int,
  itp_total        int,
  itp_passed       int,
  itp_failed       int,
  holds_pending    int,
  holds_blocking   int,
  inspections_done int,
  pass_rate        numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with n as (
    select
      count(*) filter (where status in ('open', 'corrected'))::int as open_n,
      count(*) filter (where status in ('open', 'corrected') and severity = 'minor')::int as minor_n,
      count(*) filter (where status in ('open', 'corrected') and severity = 'major')::int as major_n,
      count(*) filter (where status in ('open', 'corrected') and severity = 'critical')::int as crit_n,
      count(*) filter (where status = 'corrected')::int as corr_n,
      count(*) filter (where status = 'closed')::int as closed_n
    from public.ncrs where project_id = p_project
  ),
  i as (
    select
      count(*)::int as total_i,
      count(*) filter (where status = 'passed')::int as passed_i,
      count(*) filter (where status = 'failed')::int as failed_i,
      count(*) filter (where inspection_type = 'hold' and status <> 'passed')::int as holds_p
    from public.itp_items where project_id = p_project
  ),
  -- A hold point is BLOCKING only if something actually depends on the
  -- activity it guards. A hold on the last activity in a chain stops nothing,
  -- and reporting it as blocking would cry wolf.
  b as (
    select count(distinct i.id)::int as blocking
    from public.itp_items i
    join public.activity_dependencies d on d.predecessor_id = i.activity_id
    where i.project_id = p_project
      and i.inspection_type = 'hold'
      and i.status <> 'passed'
  ),
  ins as (
    select
      count(*)::int as done_i,
      count(*) filter (where result = 'pass')::int as pass_i
    from public.inspections where project_id = p_project
  )
  select
    n.open_n, n.minor_n, n.major_n, n.crit_n, n.corr_n, n.closed_n,
    i.total_i, i.passed_i, i.failed_i, i.holds_p, b.blocking,
    ins.done_i,
    case when ins.done_i > 0
         then round(ins.pass_i * 100.0 / ins.done_i, 1) end
  from n, i, b, ins;
$$;

revoke all on function public.fn_qa_summary(uuid) from public, anon;
grant execute on function public.fn_qa_summary(uuid) to authenticated;


-- ############################################################
-- ### 15. DELETE AN ITP POINT
-- ############################################################
-- Mechanism 1 (hard delete), founder/PM, blocked with a message naming what is
-- in the way. An inspection against a point is a record of a real event; the
-- point stays so the record still says what was inspected.
create or replace function public.fn_delete_itp_item(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid; v_desc text; v_n int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may remove an inspection point.'
      using errcode = '42501';
  end if;

  select project_id, description into v_project, v_desc
  from public.itp_items where id = p_id;
  if v_project is null then
    raise exception 'That inspection point no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  select count(*) into v_n from public.inspections where itp_item_id = p_id;
  if v_n > 0 then
    raise exception
      '"%" has % inspection(s) recorded against it. Those are a record of what was checked and when — the point stays.',
      v_desc, v_n;
  end if;

  select count(*) into v_n
  from public.ncrs where itp_item_id = p_id and status <> 'cancelled';
  if v_n > 0 then
    raise exception
      '"%" has % NCR(s) raised against it. Cancel those first.', v_desc, v_n;
  end if;

  delete from public.itp_items where id = p_id;
end $$;

revoke all on function public.fn_delete_itp_item(uuid) from public, anon;
grant execute on function public.fn_delete_itp_item(uuid) to authenticated;


-- ############################################################
-- ### 16. VERIFY
-- ############################################################
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('itp_templates', 'itp_template_items', 'itp_items',
                     'inspections', 'ncrs')
order by table_name;

-- Expect all nine.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_apply_itp_template', 'fn_save_itp_template',
                  'fn_request_inspection', 'fn_record_inspection',
                  'fn_set_ncr_status', 'fn_blocking_holds', 'fn_qa_summary',
                  'fn_delete_itp_item', 'fn_set_activity_progress')
order by proname;

-- Expect exactly one row. Two would mean 042's version survived alongside this
-- one and later calls become ambiguous (the 035 overload trap).
select count(*) as progress_fn_arities from pg_proc
where pronamespace = 'public'::regnamespace
  and proname = 'fn_set_activity_progress';

-- `inspections` must have NO insert/update/delete policy — fn_record_inspection
-- is the only way one can come into existence.
select cmd, count(*) from pg_policies
where schemaname = 'public' and tablename = 'inspections'
group by cmd;

-- Returns a row of zeros on a project with no QA data yet; that is the summary
-- working, not missing data.
select * from public.fn_qa_summary(
  (select id from public.projects order by created_at limit 1));
