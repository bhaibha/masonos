-- ============================================================
-- 062 — D2 CLASH DETECTION (Module 38, manual coordination register)
--
-- Two systems occupying the same space, found by a person looking at two
-- drawings or standing in a shaft: a beam through a duct run, a soil stack
-- crossing a conduit bank, a false ceiling that will not clear the AHU.
--
-- ------------------------------------------------------------
-- THIS IS NOT BIM CLASH DETECTION AND MUST NOT LOOK LIKE IT
-- ------------------------------------------------------------
-- Navisworks resolves geometry: it knows two solids intersect, in what volume,
-- at what coordinate. This has no geometry, no models, and no coordinates. It
-- is a REGISTER — somebody noticed a conflict and wrote it down so it gets
-- chased and closed.
--
-- Everything here follows from that. There is no "clash count" that means
-- anything absolute (it counts what people found, not what exists), no
-- tolerance field, no auto-detection, and the optional drawing overlay in the
-- UI is explicitly a LOOKING AID: two images at whatever scale they happen to
-- have been exported, laid over each other. It cannot prove a clearance and the
-- screen says so. Presenting a hand-kept register with a Navisworks vocabulary
-- would imply a completeness nobody has earned.
--
-- ------------------------------------------------------------
-- WHY THE TWO SYSTEMS ARE FREE TEXT WITH A DISCIPLINE ALONGSIDE
-- ------------------------------------------------------------
-- The clash is between "600 dia duct at the 2nd floor lobby" and "PT beam
-- B-14" — specific things, not categories. So `system_a` / `system_b` are free
-- text, and `discipline_a` / `discipline_b` reuse the EXISTING
-- `drawing_discipline` enum (029) for the filter and the summary.
--
-- Reusing that enum rather than inventing a `clash_discipline` is the same
-- judgement as 043's "don't add a fifth role for one module": these are the
-- same six disciplines the drawing register already sorts by, and two enums
-- meaning the same thing drift the moment somebody adds to one.
--
-- ------------------------------------------------------------
-- HOW IT TIES INTO RFIs
-- ------------------------------------------------------------
-- Most clashes worth logging are somebody else's decision to make — the
-- structural engineer moves the beam or the services consultant reroutes the
-- duct. `fn_raise_rfi_from_clash` creates a real RFI (026) carrying the clash's
-- description and drawing references, and links it back. One act, one
-- transaction: an RFI raised outside that path and pasted in by hand is how you
-- get a clash marked "sent to the consultant" with no RFI behind it.
--
-- The link is `on delete set null` — cancelling the RFI must not delete the
-- record of the clash.
--
-- ------------------------------------------------------------
-- WHO DOES WHAT
-- ------------------------------------------------------------
-- Founder, PM and supervisor raise and resolve; VERIFICATION is founder/PM
-- only, and a supervisor cannot verify a clash they resolved themselves. Same
-- split as snags (027), for the same reason: the person who says it is fixed
-- should not also be the person who says it was checked.
--
-- No money anywhere in this table, so supervisors see all of it.
--
-- Independent of 061 — this touches projects, profiles, drawings and rfis only,
-- all from 001–029.
-- ============================================================


-- ############################################################
-- ###  1. TYPES + SEQUENCE
-- ############################################################
do $$ begin
  if not exists (select 1 from pg_type where typname = 'clash_severity') then
    -- The same three words the site already uses on snags, so nobody has to
    -- learn a second scale. Its own type rather than reusing snag_severity:
    -- these describe different things and should be able to diverge without a
    -- data migration on the other.
    create type clash_severity as enum ('low', 'medium', 'high');
  end if;

  if not exists (select 1 from pg_type where typname = 'clash_status') then
    -- open      — found, not yet dealt with
    -- resolved  — somebody says it is sorted (moved, rerouted, RFI answered)
    -- verified  — somebody else has confirmed that on site or on the drawing
    create type clash_status as enum ('open', 'resolved', 'verified');
  end if;
end $$;

create sequence if not exists public.clash_no_seq;


-- ############################################################
-- ###  2. THE TABLE
-- ############################################################
create table if not exists public.clashes (
  id uuid primary key default gen_random_uuid(),
  clash_no text not null unique
    default 'CLH-' || lpad(nextval('public.clash_no_seq')::text, 4, '0'),

  project_id uuid not null references public.projects(id) on delete cascade,

  -- ---- the two things in the same place ----
  system_a text not null,
  system_b text not null,
  discipline_a drawing_discipline not null default 'other',
  discipline_b drawing_discipline not null default 'other',

  -- "2nd floor lobby, grid C/4-5". One field on purpose: a grid reference and
  -- a room name are the same answer to the same question, and splitting them
  -- means half of them get typed into the wrong box.
  location text not null,

  description text not null,
  severity clash_severity not null default 'medium',

  -- ---- the drawings involved ----
  -- Explicit nullable FKs, not a (table, id) pair — that cannot be enforced and
  -- nothing stops it pointing at a deleted row (the 060 rule).
  drawing_a_id uuid references public.drawings(id) on delete set null,
  drawing_b_id uuid references public.drawings(id) on delete set null,
  -- Sheets that are not in the register: a consultant's PDF mailed last week,
  -- a vendor shop drawing. Refusing the clash because the drawing was never
  -- registered would mean the clash does not get logged.
  drawing_refs text[] not null default '{}',

  -- Markup, a photo of the actual conflict, a screenshot of the overlay.
  photos text[] not null default '{}',

  -- Internal owner. A consultant is not a user of this app and never will be —
  -- they get an RFI, which is what the rfi_id link is for.
  assigned_to uuid references public.profiles(id),

  status clash_status not null default 'open',

  -- ---- the RFI, when it needs one ----
  rfi_id uuid references public.rfis(id) on delete set null,

  -- ---- resolution ----
  resolution text,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  verified_at timestamptz,
  verified_by uuid references public.profiles(id),

  raised_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A clash between a thing and itself is a typo, and it is worth catching at
  -- the point somebody makes it rather than discovering it in a coordination
  -- meeting three weeks later.
  constraint clash_two_systems check (
    lower(btrim(system_a)) <> lower(btrim(system_b))),

  -- "Resolved" with no account of what was done is not a resolution.
  constraint clash_resolution check (
    status::text = 'open' or coalesce(btrim(resolution), '') <> '')
);

-- Columns added after this create block first shipped go here, one statement
-- each — `create table if not exists` will not add them (the 042 lesson).
alter table public.clashes add column if not exists drawing_refs text[]
  not null default '{}';
alter table public.clashes add column if not exists rfi_id uuid
  references public.rfis(id) on delete set null;

create index if not exists clash_project_idx
  on public.clashes (project_id, status, severity, created_at desc);
create index if not exists clash_assigned_idx
  on public.clashes (assigned_to) where assigned_to is not null;
create index if not exists clash_rfi_idx
  on public.clashes (rfi_id) where rfi_id is not null;

create or replace function public.fn_clash_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists clash_touch on public.clashes;
create trigger clash_touch before update on public.clashes
  for each row execute function public.fn_clash_touch();


-- ############################################################
-- ###  3. THE DECISION GUARD
-- ############################################################
-- An RLS UPDATE policy cannot restrict columns, so the policy that lets a
-- supervisor correct a typo in the location also lets a PATCH stamp
-- `status = 'verified'` with no verifier and no date — the hole 021 found on
-- purchase_orders, 050 on rate comparisons and 060 on approvals.
--
-- `current_user` discriminates: PostgREST connects as `authenticated`, every
-- RPC below is SECURITY DEFINER and runs as the owner.
create or replace function public.fn_clash_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' then
    if new.status is distinct from old.status
       or new.resolved_at is distinct from old.resolved_at
       or new.resolved_by is distinct from old.resolved_by
       or new.verified_at is distinct from old.verified_at
       or new.verified_by is distinct from old.verified_by
       or new.resolution is distinct from old.resolution then
      raise exception
        'Move a clash through fn_set_clash_status, not by editing the row.'
        using errcode = '42501';
    end if;

    -- The RFI link is created by fn_raise_rfi_from_clash, which writes the RFI
    -- in the same transaction. Letting the client set it by hand is how a
    -- clash ends up pointing at an RFI that says something else entirely.
    if new.rfi_id is distinct from old.rfi_id then
      raise exception
        'Raise the RFI from the clash so the two are written together.'
        using errcode = '42501';
    end if;

    if new.clash_no is distinct from old.clash_no then
      raise exception 'A clash number cannot be changed.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists clash_guard on public.clashes;
create trigger clash_guard before update on public.clashes
  for each row execute function public.fn_clash_guard();


-- ############################################################
-- ###  4. RLS
-- ############################################################
alter table public.clashes enable row level security;

-- Everyone on the project reads it. Supervisors are half the point: they are
-- the ones who find the conflict standing in the shaft. is_member() already
-- covers founder and accounts on every project.
drop policy if exists clash_read on public.clashes;
create policy clash_read on public.clashes
  for select to authenticated
  using (public.is_member(project_id));

drop policy if exists clash_insert on public.clashes;
create policy clash_insert on public.clashes
  for insert to authenticated
  with check (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'supervisor')
  );

drop policy if exists clash_update on public.clashes;
create policy clash_update on public.clashes
  for update to authenticated
  using (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'supervisor')
  )
  with check (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'supervisor')
  );

-- No DELETE policy — fn_delete_clash is the only route (mechanism 1).


-- ############################################################
-- ###  5. AUDIT
-- ############################################################
-- Keyed by `id`, so the ordinary fn_audit applies rather than 051's code-keyed
-- variant. A coordination decision is exactly the kind of thing somebody asks
-- about months later: who said this was resolved, and when.
drop trigger if exists audit_clashes on public.clashes;
create trigger audit_clashes
  after insert or update or delete on public.clashes
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  6. THE REGISTER VIEW
-- ############################################################
-- security_invoker, so clash_read decides the rows and the drawing register's
-- own policy decides whether the drawing halves resolve. Nothing here restates
-- an access rule that already exists elsewhere.
drop view if exists public.v_clashes cascade;
create view public.v_clashes with (security_invoker = true) as
select
  c.id,
  c.clash_no,
  c.project_id,
  c.system_a,
  c.system_b,
  c.discipline_a,
  c.discipline_b,
  c.location,
  c.description,
  c.severity,
  c.status,
  c.drawing_a_id,
  da.drawing_no                     as drawing_a_no,
  da.title                          as drawing_a_title,
  c.drawing_b_id,
  db.drawing_no                     as drawing_b_no,
  db.title                          as drawing_b_title,
  c.drawing_refs,
  c.photos,
  c.assigned_to,
  asg.full_name                     as assigned_to_name,
  c.rfi_id,
  r.rfi_number,
  r.status                          as rfi_status,
  r.response is not null            as rfi_answered,
  c.resolution,
  c.resolved_at,
  res.full_name                     as resolved_by_name,
  c.verified_at,
  ver.full_name                     as verified_by_name,
  c.raised_by,
  rai.full_name                     as raised_by_name,
  c.created_at,
  c.updated_at,
  -- Days an open clash has been sitting. A coordination item nobody chased is
  -- the one that gets discovered when the duct is already installed.
  case when c.status::text = 'open'
    then (current_date - c.created_at::date) end as open_days
from public.clashes c
join      public.projects p    on p.id = c.project_id
left join public.drawings da   on da.id = c.drawing_a_id
left join public.drawings db   on db.id = c.drawing_b_id
left join public.profiles asg  on asg.id = c.assigned_to
left join public.profiles res  on res.id = c.resolved_by
left join public.profiles ver  on ver.id = c.verified_by
left join public.profiles rai  on rai.id = c.raised_by
left join public.rfis r        on r.id = c.rfi_id;

grant select on public.v_clashes to authenticated;


-- ############################################################
-- ###  7. MOVING A CLASH
-- ############################################################
-- One path for every status change, so the who and the when cannot be
-- forgotten and cannot be set from the client.
drop function if exists public.fn_set_clash_status(uuid, text, text);
create function public.fn_set_clash_status(
  p_id     uuid,
  p_status text,
  p_note   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project  uuid;
  v_current  text;
  v_resolver uuid;
  v_no       text;
  v_role     text := public.my_role();
  v_me       uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if v_role not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot work on clashes.' using errcode = '42501';
  end if;
  if p_status not in ('open', 'resolved', 'verified') then
    raise exception 'Unknown status: %', p_status;
  end if;

  select project_id, status::text, resolved_by, clash_no
    into v_project, v_current, v_resolver, v_no
  from public.clashes where id = p_id;

  if v_project is null then
    raise exception 'That clash no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  -- Verification is the office confirming what site says is done. Same split
  -- as snags (027).
  if p_status = 'verified' and v_role not in ('founder', 'pm') then
    raise exception
      'Only a founder or PM verifies a clash as closed out.'
      using errcode = '42501';
  end if;

  -- And the person who resolved it does not get to confirm their own work.
  -- This bites a PM, not a supervisor, because supervisors cannot verify at
  -- all — which is exactly the case worth guarding.
  if p_status = 'verified' and v_resolver is not null and v_resolver = v_me then
    raise exception
      'You recorded the resolution on %. Somebody else confirms it.', v_no;
  end if;

  if p_status <> 'open' and coalesce(btrim(p_note), '') = ''
     and p_status = 'resolved' then
    raise exception
      'Say what was done. "Resolved" with no account of the fix tells the next person nothing.';
  end if;

  update public.clashes
  set status      = p_status::clash_status,
      resolution  = case
                      when p_status = 'open' then null
                      when p_status = 'resolved' then btrim(p_note)
                      else resolution           -- verifying keeps the account
                    end,
      resolved_at = case when p_status = 'open' then null
                         when p_status = 'resolved' then now()
                         else resolved_at end,
      resolved_by = case when p_status = 'open' then null
                         when p_status = 'resolved' then v_me
                         else resolved_by end,
      verified_at = case when p_status = 'verified' then now() else null end,
      verified_by = case when p_status = 'verified' then v_me else null end
  where id = p_id;
end $$;

revoke all on function public.fn_set_clash_status(uuid, text, text) from public, anon;
grant execute on function public.fn_set_clash_status(uuid, text, text) to authenticated;


-- ############################################################
-- ###  8. CLASH -> RFI
-- ############################################################
-- Creates the RFI and links it in ONE transaction. A clash marked "sent to the
-- consultant" with no RFI behind it is the failure this prevents.
--
-- The question is pre-composed from the clash but PASSED IN, so the person
-- asking owns the words — same reasoning as 061's editable accept text.
drop function if exists public.fn_raise_rfi_from_clash(uuid, text, text, text, uuid, date);
create function public.fn_raise_rfi_from_clash(
  p_clash        uuid,
  p_question     text,
  p_addressed_to text default null,
  p_category     text default 'design',
  p_vendor       uuid default null,
  p_required_by  date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clash public.clashes;
  v_role  text := public.my_role();
  v_me    uuid := auth.uid();
  v_rfi   uuid;
  v_refs  text;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  -- Matches rfi_insert in 026: raising a question to a consultant is founder/PM.
  if v_role not in ('founder', 'pm') then
    raise exception 'Only a founder or PM raises an RFI to a consultant.'
      using errcode = '42501';
  end if;
  if coalesce(btrim(p_question), '') = '' then
    raise exception 'An RFI needs a question.';
  end if;

  select * into v_clash from public.clashes where id = p_clash;
  if v_clash.id is null then
    raise exception 'That clash no longer exists.';
  end if;
  if not public.is_member(v_clash.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_clash.rfi_id is not null then
    raise exception
      'An RFI has already been raised from %. Open it instead of raising a second one.',
      v_clash.clash_no;
  end if;

  -- Carry the drawing references into the question automatically. The
  -- consultant's first reply is otherwise "which drawings?", and that round
  -- trip costs a week.
  select string_agg(x, ', ') into v_refs from (
    select da.drawing_no as x from public.drawings da where da.id = v_clash.drawing_a_id
    union all
    select db.drawing_no from public.drawings db where db.id = v_clash.drawing_b_id
    union all
    select unnest(v_clash.drawing_refs)
  ) s where x is not null and btrim(x) <> '';

  insert into public.rfis
    (project_id, vendor_id, addressed_to, category, question, required_by,
     attachments, raised_by)
  values
    (v_clash.project_id, p_vendor, nullif(btrim(p_addressed_to), ''),
     p_category::rfi_category,
     btrim(p_question)
       || E'\n\n' || 'Coordination clash ' || v_clash.clash_no || ': '
       || v_clash.system_a || ' vs ' || v_clash.system_b
       || ' at ' || v_clash.location
       || coalesce('. Drawings: ' || v_refs, ''),
     p_required_by,
     v_clash.photos,
     v_me)
  returning id into v_rfi;

  update public.clashes set rfi_id = v_rfi where id = p_clash;

  return v_rfi;
end $$;

revoke all on function
  public.fn_raise_rfi_from_clash(uuid, text, text, text, uuid, date) from public, anon;
grant execute on function
  public.fn_raise_rfi_from_clash(uuid, text, text, text, uuid, date) to authenticated;


-- ############################################################
-- ###  9. PROJECT SUMMARY
-- ############################################################
drop function if exists public.fn_project_clash_summary(uuid);
create function public.fn_project_clash_summary(p_project uuid)
returns table (
  open_count      int,
  resolved_count  int,
  verified_count  int,
  open_high       int,
  -- Age of the oldest open clash. A count says three; this says one of them has
  -- been open since before the slab went in.
  oldest_open_days int,
  -- Open clashes waiting on a consultant's answer. These are the ones nobody
  -- inside the firm can move, and they need chasing rather than assigning.
  awaiting_rfi    int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where c.status::text = 'open')::int,
    count(*) filter (where c.status::text = 'resolved')::int,
    count(*) filter (where c.status::text = 'verified')::int,
    count(*) filter (where c.status::text = 'open'
                       and c.severity::text = 'high')::int,
    max(current_date - c.created_at::date)
      filter (where c.status::text = 'open')::int,
    count(*) filter (where c.status::text = 'open'
                       and c.rfi_id is not null
                       and r.response is null)::int
  from public.clashes c
  left join public.rfis r on r.id = c.rfi_id
  where c.project_id = p_project
    and public.is_member(c.project_id);
$$;

revoke all on function public.fn_project_clash_summary(uuid) from public, anon;
grant execute on function public.fn_project_clash_summary(uuid) to authenticated;


-- ############################################################
-- ### 10. DELETING ONE
-- ############################################################
-- Its own function rather than a branch on fn_delete_record, following 050 and
-- 060: re-emitting a 300-line function to add ten lines is how a transcription
-- error reaches production.
--
-- Only while OPEN, and only if no RFI hangs off it. A resolved clash is a
-- record of a coordination decision; an RFI with no clash behind it is a
-- question nobody can explain.
drop function if exists public.fn_delete_clash(uuid);
create function public.fn_delete_clash(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_status  text;
  v_rfi     uuid;
  v_no      text;
  v_raiser  uuid;
  v_role    text := public.my_role();
  v_me      uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if v_role not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot remove a clash.' using errcode = '42501';
  end if;

  select project_id, status::text, rfi_id, clash_no, raised_by
    into v_project, v_status, v_rfi, v_no, v_raiser
  from public.clashes where id = p_id;

  if v_project is null then
    raise exception 'That clash no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  -- A supervisor may remove their own mistake, not somebody else's record.
  if v_role = 'supervisor' and v_raiser <> v_me then
    raise exception 'You can only remove a clash you raised yourself.'
      using errcode = '42501';
  end if;

  if v_status <> 'open' then
    raise exception
      '% has been % and is a record of a coordination decision — it is not deleted. Set it back to open first if it was logged in error.',
      v_no, v_status;
  end if;

  if v_rfi is not null then
    raise exception
      '% has an RFI raised against it. Cancel the RFI first, or leave the clash so the question has context.',
      v_no;
  end if;

  delete from public.clashes where id = p_id;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values ('clashes', 'DELETE_HARD', p_id::text,
          jsonb_build_object('deleted_by', v_me, 'deleted_at', now(),
                             'clash_no', v_no), null);
end $$;

revoke all on function public.fn_delete_clash(uuid) from public, anon;
grant execute on function public.fn_delete_clash(uuid) to authenticated;


-- ############################################################
-- ### 11. VERIFY
-- ############################################################
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_set_clash_status', 'fn_raise_rfi_from_clash',
                    'fn_project_clash_summary', 'fn_delete_clash',
                    'fn_clash_guard', 'fn_clash_touch')
group by p.proname order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('clashes', 'v_clashes')
order by table_name;
