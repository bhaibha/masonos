-- ============================================================
-- 061 — D1 AI PHOTO HELPER (Module 39, basic version)
--
-- An optional second look at a site photo. Somebody taps "Analyse photo", the
-- image goes to Gemini Flash through an Edge Function, and what comes back is
-- a DESCRIPTION plus a list of things worth checking. It is stored against the
-- photo so the suggestion and the decision taken on it stay together.
--
-- ------------------------------------------------------------
-- THIS IS NOT A DEFECT MODEL, AND THE SCHEMA SAYS SO
-- ------------------------------------------------------------
-- A general vision model looking at a photo of a wall cannot tell a structural
-- crack from a plaster shrinkage crack, cannot judge cover, and cannot measure
-- anything. It is good at "there is a dark linear feature here that looks like
-- cracking" and confidently wrong about what that means.
--
-- So nothing in this table is a finding:
--
--   * the column is `concerns`, not `defects`;
--   * every concern carries `what_to_check` — an instruction to a human, not a
--     conclusion;
--   * there is NO severity column. A severity is a judgement, and a judgement
--     from a model that cannot measure is a number people would quote;
--   * `status` starts at 'suggested' and only a PERSON moves it to accepted,
--     at which point a real snag or NCR is created and carries their name.
--
-- The same principle as 058's method-statement drafter: let the model produce
-- the SHAPE, never the value that reaches a decision. There it was cover and
-- curing days; here it is crack widths and severities.
--
-- ------------------------------------------------------------
-- WHY THE ANALYSIS IS KEYED ON THE STORAGE PATH
-- ------------------------------------------------------------
-- The same photo array shape appears on `site_logs.photos`, `snags.photos` and
-- `inspection_comments.photos`, all in the `site-photos` bucket at
-- `${project_id}/${uuid}.jpg`. The photo has no row of its own anywhere — it is
-- a string inside an array — so the storage path IS its identity.
--
-- Alongside it, THREE EXPLICIT NULLABLE FKs record which record the photo was
-- attached to. Not a (table_name, record_id) pair: that cannot be enforced,
-- nothing stops it pointing at a deleted row, and no check will ever catch it
-- (the 060 rule). ON DELETE CASCADE here — unlike 060, an analysis of a photo
-- on a deleted site log is genuinely orphaned, because the photo itself goes
-- with the record.
--
-- ------------------------------------------------------------
-- ONE ANALYSIS PER PHOTO
-- ------------------------------------------------------------
-- A unique index on `photo_path`. Two reasons, and the second is the real one:
--   * a double tap costs a second API call for the same picture;
--   * two analyses of one photo that say slightly different things is a
--     disagreement nobody can resolve, and somebody will quote whichever
--     suits them.
-- Re-analysing REPLACES, through fn_reanalyse_photo, and audit_log keeps what
-- the previous one said.
--
-- Run AFTER 060.
-- ============================================================


-- ############################################################
-- ###  1. TYPES
-- ############################################################
do $$ begin
  if not exists (select 1 from pg_type where typname = 'photo_source') then
    create type photo_source as enum ('site_log', 'snag', 'inspection', 'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'analysis_state') then
    -- 'suggested' is where every row starts and most rows stay. Accepting or
    -- dismissing is a human act and is recorded as one.
    create type analysis_state as enum ('suggested', 'accepted', 'dismissed');
  end if;
end $$;


-- ############################################################
-- ###  2. THE TABLE
-- ############################################################
create table if not exists public.photo_analyses (
  id uuid primary key default gen_random_uuid(),

  project_id uuid not null references public.projects(id) on delete cascade,

  -- The photo's identity: its object key in the site-photos bucket.
  photo_path text not null,
  bucket text not null default 'site-photos',

  source photo_source not null default 'other',

  -- Which record the photo hangs off. Explicit FKs, not a generic pair.
  site_log_id uuid references public.site_logs(id) on delete cascade,
  snag_id     uuid references public.snags(id)     on delete cascade,
  comment_id  uuid references public.inspection_comments(id) on delete cascade,

  -- ---- what the model said ----
  -- Plain description of what is visible. No judgement.
  description text,

  -- [{ "concern": "...", "what_to_check": "..." }, ...]
  -- Deliberately NOT { "defect": ..., "severity": ... }. See the header.
  concerns jsonb not null default '[]'::jsonb,

  -- Provenance, so "was this written by Ravi or generated in four seconds"
  -- stays answerable (the 058 rule).
  model text,
  analysed_at timestamptz not null default now(),

  -- ---- what a person did about it ----
  status analysis_state not null default 'suggested',
  acted_by uuid references public.profiles(id),
  acted_at timestamptz,
  -- Why it was dismissed. Optional: "nothing there" is a legitimate and common
  -- outcome and demanding an essay for it would just train people to type "x".
  dismiss_note text,

  -- What it became, if anything. SET NULL, not cascade: deleting the snag must
  -- not delete the record that a suggestion was raised and acted on.
  accepted_snag_id uuid references public.snags(id) on delete set null,
  accepted_ncr_id  uuid references public.ncrs(id)  on delete set null,

  requested_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A decided analysis says who decided.
  constraint pa_acted check (
    status::text = 'suggested' or (acted_by is not null and acted_at is not null))
);

-- Columns added after this create block first shipped go here, one statement
-- each — `create table if not exists` will not add them (the 042 lesson).
alter table public.photo_analyses add column if not exists dismiss_note text;
alter table public.photo_analyses add column if not exists model text;

-- One analysis per photo. See the header: the cost is a second API call, the
-- damage is two answers about one picture.
create unique index if not exists photo_analysis_path_uk
  on public.photo_analyses (photo_path);

create index if not exists photo_analysis_project_idx
  on public.photo_analyses (project_id, status, created_at desc);
create index if not exists photo_analysis_snag_idx
  on public.photo_analyses (snag_id) where snag_id is not null;
create index if not exists photo_analysis_log_idx
  on public.photo_analyses (site_log_id) where site_log_id is not null;
create index if not exists photo_analysis_comment_idx
  on public.photo_analyses (comment_id) where comment_id is not null;

create or replace function public.fn_pa_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists pa_touch on public.photo_analyses;
create trigger pa_touch before update on public.photo_analyses
  for each row execute function public.fn_pa_touch();


-- ############################################################
-- ###  3. THE DECISION GUARD
-- ############################################################
-- Same shape as 060's ca_guard, for the same reason: an RLS UPDATE policy
-- cannot restrict columns, so the policy that lets somebody correct a dismiss
-- note also lets a PATCH stamp `status = 'accepted'` with no acted_by and no
-- snag behind it. `current_user` discriminates — PostgREST is `authenticated`,
-- the RPCs are SECURITY DEFINER and run as the owner.
--
-- The analysis TEXT is also frozen from the client. It is supposed to be what
-- the model returned; letting the browser rewrite it would make the provenance
-- column a lie.
create or replace function public.fn_pa_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' then
    if new.status is distinct from old.status
       or new.acted_by is distinct from old.acted_by
       or new.acted_at is distinct from old.acted_at
       or new.accepted_snag_id is distinct from old.accepted_snag_id
       or new.accepted_ncr_id is distinct from old.accepted_ncr_id then
      raise exception
        'Accept or dismiss a suggestion through fn_accept_photo_analysis / fn_dismiss_photo_analysis, not by editing the row.'
        using errcode = '42501';
    end if;

    if new.description is distinct from old.description
       or new.concerns is distinct from old.concerns
       or new.model is distinct from old.model then
      raise exception
        'The analysis text is what the model returned and is not editable. Re-analyse the photo instead.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists pa_guard on public.photo_analyses;
create trigger pa_guard before update on public.photo_analyses
  for each row execute function public.fn_pa_guard();


-- ############################################################
-- ###  4. RLS
-- ############################################################
alter table public.photo_analyses enable row level security;

-- Founder, PM and supervisor on their own project. Supervisors ARE the audience
-- here: they are the ones standing in front of the wall with the phone. There
-- is no money anywhere in this table, so nothing to hide from them.
--
-- Accounts is deliberately excluded from WRITING — they have no reason to
-- analyse a site photo — but reads follow is_member(), which returns true for
-- accounts on every project, and a description of a wall is not a secret.
drop policy if exists pa_read on public.photo_analyses;
create policy pa_read on public.photo_analyses
  for select to authenticated
  using (public.is_member(project_id));

drop policy if exists pa_insert on public.photo_analyses;
create policy pa_insert on public.photo_analyses
  for insert to authenticated
  with check (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'supervisor')
  );

drop policy if exists pa_update on public.photo_analyses;
create policy pa_update on public.photo_analyses
  for update to authenticated
  using (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'supervisor')
  )
  with check (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'supervisor')
  );

-- No DELETE policy: removal goes through fn_reanalyse_photo, which replaces.


-- ############################################################
-- ###  5. AUDIT
-- ############################################################
-- Keyed by `id`, so the ordinary fn_audit applies (not 051's code-keyed
-- variant). This is what keeps a superseded analysis readable after a
-- re-analysis has replaced it.
drop trigger if exists audit_photo_analyses on public.photo_analyses;
create trigger audit_photo_analyses
  after insert or update or delete on public.photo_analyses
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  6. ACCEPT — turn a suggestion into a real record
-- ############################################################
-- One act, one transaction: the snag (or NCR) is created AND the analysis is
-- marked accepted and linked to it. Two paths would eventually produce an
-- accepted analysis with no record behind it, which is exactly how a defect
-- gets forgotten (the 043 lesson).
--
-- The created record carries the ACTING USER as raised_by, never the model.
-- A snag is somebody's assertion that something is wrong; it does not get to
-- be nobody's.
drop function if exists public.fn_accept_photo_analysis(uuid, text, text, text, text);
create function public.fn_accept_photo_analysis(
  p_id       uuid,
  p_target   text,               -- 'snag' | 'ncr'
  p_area     text,               -- work area / location, required by both
  p_text     text default null,  -- the description to file; defaults to the model's
  p_severity text default null   -- the PERSON's judgement, never the model's
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     public.photo_analyses;
  v_role    text := public.my_role();
  v_me      uuid := auth.uid();
  v_desc    text;
  v_new     uuid;
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if v_role not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot raise a snag from a photo suggestion.'
      using errcode = '42501';
  end if;
  if p_target not in ('snag', 'ncr') then
    raise exception 'Unknown target: %', p_target;
  end if;
  -- An NCR is a formal non-conformance against a standard. A supervisor raises
  -- snags; NCRs are founder/PM, matching 043's own rule.
  if p_target = 'ncr' and v_role not in ('founder', 'pm') then
    raise exception 'Only a founder or PM raises an NCR.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_area), '') = '' then
    raise exception 'Say where it is. A defect with no location cannot be found again.';
  end if;

  select * into v_row from public.photo_analyses where id = p_id;
  if v_row.id is null then
    raise exception 'That analysis no longer exists.';
  end if;
  if not public.is_member(v_row.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_row.status::text <> 'suggested' then
    raise exception 'That suggestion has already been %.', v_row.status;
  end if;

  -- Default the filed text to the model's description, but it is EDITABLE on
  -- the way in — the person filing owns the words, because their name goes on
  -- the record.
  v_desc := coalesce(nullif(btrim(p_text), ''),
                     nullif(btrim(v_row.description), ''),
                     'Raised from a photo suggestion.');

  if p_target = 'snag' then
    insert into public.snags
      (project_id, work_area, description, severity, photos, raised_by)
    values
      (v_row.project_id, btrim(p_area), v_desc,
       coalesce(p_severity, 'medium')::snag_severity,
       array[v_row.photo_path], v_me)
    returning id into v_new;

    update public.photo_analyses
    set status = 'accepted', acted_by = v_me, acted_at = now(),
        accepted_snag_id = v_new
    where id = p_id;
  else
    insert into public.ncrs
      (project_id, area, description, severity, photos)
    values
      (v_row.project_id, btrim(p_area), v_desc,
       coalesce(p_severity, 'minor')::ncr_severity,
       array[v_row.photo_path])
    returning id into v_new;

    update public.photo_analyses
    set status = 'accepted', acted_by = v_me, acted_at = now(),
        accepted_ncr_id = v_new
    where id = p_id;
  end if;

  return v_new;
end $$;

revoke all on function public.fn_accept_photo_analysis(uuid, text, text, text, text)
  from public, anon;
grant execute on function public.fn_accept_photo_analysis(uuid, text, text, text, text)
  to authenticated;


-- ############################################################
-- ###  7. DISMISS
-- ############################################################
-- Dismissed rows are KEPT, not deleted. "The model flagged this and a person
-- looked and said no" is a more useful record than silence, and it is the only
-- way anybody will ever be able to tell whether this feature is worth its API
-- calls.
drop function if exists public.fn_dismiss_photo_analysis(uuid, text);
create function public.fn_dismiss_photo_analysis(
  p_id   uuid,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_status  text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot act on photo suggestions.'
      using errcode = '42501';
  end if;

  select project_id, status::text into v_project, v_status
  from public.photo_analyses where id = p_id;

  if v_project is null then
    raise exception 'That analysis no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_status <> 'suggested' then
    raise exception 'That suggestion has already been %.', v_status;
  end if;

  update public.photo_analyses
  set status = 'dismissed', acted_by = auth.uid(), acted_at = now(),
      dismiss_note = nullif(btrim(p_note), '')
  where id = p_id;
end $$;

revoke all on function public.fn_dismiss_photo_analysis(uuid, text) from public, anon;
grant execute on function public.fn_dismiss_photo_analysis(uuid, text) to authenticated;


-- ############################################################
-- ###  8. RE-ANALYSE — the only route to removing a row
-- ############################################################
-- Clears the existing analysis for a photo so a fresh one can be written. The
-- DELETE fires the audit trigger, so what the previous analysis said survives
-- in audit_log.old_data.
--
-- Refuses once accepted: the snag raised from it points back here, and deleting
-- the suggestion would leave that snag's origin unexplained.
drop function if exists public.fn_reanalyse_photo(text);
create function public.fn_reanalyse_photo(p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_status  text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'Your role cannot act on photo suggestions.'
      using errcode = '42501';
  end if;

  select project_id, status::text into v_project, v_status
  from public.photo_analyses where photo_path = p_path;

  if v_project is null then
    return;                        -- nothing stored yet; nothing to clear
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_status = 'accepted' then
    raise exception
      'This suggestion was accepted and a record was raised from it. Re-analysing would leave that record with no origin.';
  end if;

  delete from public.photo_analyses where photo_path = p_path;
end $$;

revoke all on function public.fn_reanalyse_photo(text) from public, anon;
grant execute on function public.fn_reanalyse_photo(text) to authenticated;


-- ############################################################
-- ###  9. HOW USEFUL IS IT, ACTUALLY
-- ############################################################
-- Accepted vs dismissed per project. An AI feature nobody can evaluate is one
-- that quietly stays switched on forever — this is the number that says whether
-- the API calls are buying anything.
drop function if exists public.fn_photo_analysis_summary(uuid);
create function public.fn_photo_analysis_summary(p_project uuid)
returns table (
  total_count     int,
  suggested_count int,
  accepted_count  int,
  dismissed_count int,
  -- Of the decided ones, the share a person agreed with. Null when nothing has
  -- been decided yet — a percentage from a sample of zero is not a percentage.
  accept_rate_pct numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::int,
    count(*) filter (where status::text = 'suggested')::int,
    count(*) filter (where status::text = 'accepted')::int,
    count(*) filter (where status::text = 'dismissed')::int,
    case when count(*) filter (where status::text <> 'suggested') > 0
      then round(
        count(*) filter (where status::text = 'accepted') * 100.0
        / count(*) filter (where status::text <> 'suggested'), 1)
    end
  from public.photo_analyses
  where project_id = p_project
    and public.is_member(project_id);
$$;

revoke all on function public.fn_photo_analysis_summary(uuid) from public, anon;
grant execute on function public.fn_photo_analysis_summary(uuid) to authenticated;


-- ############################################################
-- ### 10. VERIFY
-- ############################################################
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_accept_photo_analysis', 'fn_dismiss_photo_analysis',
                    'fn_reanalyse_photo', 'fn_photo_analysis_summary',
                    'fn_pa_guard', 'fn_pa_touch')
group by p.proname order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'photo_analyses';
