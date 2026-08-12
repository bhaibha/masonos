-- ============================================================
-- MASON OS — Migration 045: checklist depth inside every ITP point
--
-- 043 gave each inspection point a single pass/fail. That is a signature, not
-- a record: "Reinforcement before concreting — passed" says nothing about
-- whether anyone actually looked at the cover blocks. This migration puts the
-- individual questions underneath, and makes the point's result a CONSEQUENCE
-- of them rather than an opinion typed next to them.
--
-- ---------- THE RESULT IS DERIVED, NOT DECLARED ----------
-- `fn_record_inspection` now computes the outcome from the answers:
--   every answer pass or n/a          → pass
--   any answer fail                   → fail, or conditional if the inspector
--                                       says so; either way an NCR per failure
-- An inspector who ticks a failure and then selects "pass" is OVERRULED by the
-- function, silently and deliberately. The sub-answers are the evidence; the
-- headline is a summary of them, and a summary that can contradict its own
-- evidence is worse than no summary.
--
-- Unanswered questions are refused outright. A checklist with blanks is not a
-- record of an inspection, it is a record of an interruption.
--
-- ---------- ONE NCR PER FAILED CHECK ----------
-- Not one lumped NCR per inspection. Three failures are three defects, each
-- with its own correction, its own re-inspection and its own closing date. The
-- NCR text names the exact question that failed, so a year later the record
-- says "cover blocks missing at the north face", not "reinforcement failed".
--
-- ---------- THE QUESTION TEXT IS SNAPSHOTTED ----------
-- `inspection_checks.question` stores the wording as it was ASKED, alongside
-- the foreign key to the live check. Edit or delete the question next month and
-- every completed inspection still reads correctly. Same argument as the
-- certified-bill snapshot in 032: a record that restates itself when its source
-- is edited is not a record.
--
-- ---------- TEMPLATES CARRY CHECKLISTS ----------
-- Checks hang off `itp_template_items` too, and `fn_apply_itp_template` copies
-- them down with their points. A standard reinforcement checklist written once
-- reaches every project after it.
--
-- Additive and re-runnable. Requires 043; the seeded checklists at the end
-- attach to 044's template points and are skipped if those points are absent.
-- ============================================================


-- ############################################################
-- ###  1. ENUM
-- ############################################################
-- Deliberately three values. "N/A" is not a soft pass — a question that did not
-- apply to this pour is a different fact from one that was checked and found
-- good, and the pass rate must not conflate them.
do $$ begin
  create type check_result as enum ('pass', 'fail', 'na');
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  2. CHECKS ON A TEMPLATE POINT
-- ############################################################
create table if not exists public.itp_template_checks (
  id uuid primary key default gen_random_uuid(),
  template_item_id uuid not null
    references public.itp_template_items(id) on delete cascade,

  -- Phrased as something answerable pass/fail on site, not as a topic.
  question text not null,
  -- Optional one-liner shown under the question: what "good" looks like.
  guidance text,

  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists itp_tmpl_check_idx
  on public.itp_template_checks (template_item_id, sort_order);


-- ############################################################
-- ###  3. CHECKS ON A LIVE POINT
-- ############################################################
create table if not exists public.itp_checks (
  id uuid primary key default gen_random_uuid(),
  itp_item_id uuid not null
    references public.itp_items(id) on delete cascade,

  question text not null,
  guidance text,
  sort_order int not null default 100,

  -- Provenance only, exactly like itp_items.template_id.
  template_check_id uuid
    references public.itp_template_checks(id) on delete set null,

  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists itp_check_item_idx
  on public.itp_checks (itp_item_id, sort_order);


-- ############################################################
-- ###  4. THE ANSWERS
-- ############################################################
-- One row per question per inspection. This is the auditable record: what was
-- asked, what the answer was, who said so and what they photographed.
create table if not exists public.inspection_checks (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null
    references public.inspections(id) on delete cascade,

  -- SET NULL, never cascade: deleting a question from the plan must not delete
  -- the answer somebody gave to it on site.
  itp_check_id uuid references public.itp_checks(id) on delete set null,

  -- The wording AS ASKED. Survives the question being edited or removed.
  question text not null,

  result check_result not null,
  remark text,
  photos text[] not null default '{}',

  -- Set when a failure raised an NCR, so the answer and the defect point at
  -- each other.
  ncr_id uuid references public.ncrs(id) on delete set null,

  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists inspection_check_idx
  on public.inspection_checks (inspection_id, sort_order);
create index if not exists inspection_check_fail_idx
  on public.inspection_checks (itp_check_id) where result = 'fail';


-- ############################################################
-- ###  5. RLS
-- ############################################################
alter table public.itp_template_checks enable row level security;
alter table public.itp_checks          enable row level security;
alter table public.inspection_checks   enable row level security;

-- Template checks: everyone reads the firm's standard, founder/PM write.
drop policy if exists itp_tmpl_check_read on public.itp_template_checks;
create policy itp_tmpl_check_read on public.itp_template_checks
  for select to authenticated using (true);

drop policy if exists itp_tmpl_check_write on public.itp_template_checks;
create policy itp_tmpl_check_write on public.itp_template_checks
  for all to authenticated
  using (public.my_role() in ('founder', 'pm'))
  with check (public.my_role() in ('founder', 'pm'));

-- Live checks: every project member READS them — the supervisor works through
-- this list on site and needs to see it before the inspection, not during.
drop policy if exists itp_check_read on public.itp_checks;
create policy itp_check_read on public.itp_checks
  for select to authenticated
  using (exists (
    select 1 from public.itp_items i
    where i.id = itp_item_id and public.is_member(i.project_id)
  ));

drop policy if exists itp_check_write on public.itp_checks;
create policy itp_check_write on public.itp_checks
  for all to authenticated
  using (
    public.my_role() in ('founder', 'pm')
    and exists (
      select 1 from public.itp_items i
      where i.id = itp_item_id and public.is_member(i.project_id)
    )
  )
  with check (
    public.my_role() in ('founder', 'pm')
    and exists (
      select 1 from public.itp_items i
      where i.id = itp_item_id and public.is_member(i.project_id)
    )
  );

-- Answers: members read; NOBODY writes directly.
drop policy if exists inspection_check_read on public.inspection_checks;
create policy inspection_check_read on public.inspection_checks
  for select to authenticated
  using (exists (
    select 1 from public.inspections ins
    where ins.id = inspection_id and public.is_member(ins.project_id)
  ));

-- No INSERT, UPDATE or DELETE policy at all — the same rule 043 applied to
-- `inspections`. `fn_record_inspection` is the only writer, so an answer can
-- never exist without the inspection it belongs to, and a failed answer can
-- never exist without its NCR.


-- ############################################################
-- ###  6. AUDIT
-- ############################################################
drop trigger if exists audit_itp_checks on public.itp_checks;
create trigger audit_itp_checks
  after insert or update or delete on public.itp_checks
  for each row execute function public.fn_audit();

drop trigger if exists audit_inspection_checks on public.inspection_checks;
create trigger audit_inspection_checks
  after insert or update or delete on public.inspection_checks
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  7. APPLY A TEMPLATE — now carrying its checklists
-- ############################################################
-- Re-emitted from 043 with the checklist copy added. Points are matched back to
-- their template rows by template_id + sort_order, which is safe because
-- nothing else has touched them a millisecond after the insert.
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

  select count(*) into v_n
  from public.itp_items where project_id = p_project and template_id = p_template;
  if v_n > 0 then
    raise exception
      '"%" is already applied to this project — % item(s) came from it. Remove those first if you want to re-apply it.',
      v_name, v_n;
  end if;

  -- The points.
  with src as (
    select * from public.itp_template_items where template_id = p_template
  ),
  ins as (
    insert into public.itp_items
      (project_id, stage, description, acceptance_criteria, inspection_type,
       reference_standard, required_by_stage, template_id, sort_order, created_by)
    select
      p_project, s.stage, s.description, s.acceptance_criteria, s.inspection_type,
      s.reference_standard, s.required_by_stage, p_template, s.sort_order, auth.uid()
    from src s
    returning id, sort_order
  )
  -- …and their checklists, matched back by sort_order within this template.
  insert into public.itp_checks
    (itp_item_id, question, guidance, sort_order, template_check_id, created_by)
  select ins.id, c.question, c.guidance, c.sort_order, c.id, auth.uid()
  from ins
  join public.itp_template_items ti
    on ti.template_id = p_template and ti.sort_order = ins.sort_order
  join public.itp_template_checks c on c.template_item_id = ti.id;

  select count(*) into v_n
  from public.itp_items where project_id = p_project and template_id = p_template;
  return v_n;
end $$;

revoke all on function public.fn_apply_itp_template(uuid, uuid) from public, anon;
grant execute on function public.fn_apply_itp_template(uuid, uuid) to authenticated;


-- ############################################################
-- ###  8. SAVE AS TEMPLATE — now carrying its checklists
-- ############################################################
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

  with src as (
    select * from public.itp_items where project_id = p_project
  ),
  ins as (
    insert into public.itp_template_items
      (template_id, stage, description, acceptance_criteria, inspection_type,
       reference_standard, required_by_stage, sort_order)
    select
      v_id, s.stage, s.description, s.acceptance_criteria, s.inspection_type,
      s.reference_standard, s.required_by_stage, s.sort_order
    from src s
    returning id, sort_order
  )
  insert into public.itp_template_checks
    (template_item_id, question, guidance, sort_order)
  select ins.id, c.question, c.guidance, c.sort_order
  from ins
  join public.itp_items i
    on i.project_id = p_project and i.sort_order = ins.sort_order
  join public.itp_checks c on c.itp_item_id = i.id;

  return v_id;
end $$;

revoke all on function public.fn_save_itp_template(uuid, text, text) from public, anon;
grant execute on function public.fn_save_itp_template(uuid, text, text) to authenticated;


-- ############################################################
-- ###  9. RECORD AN INSPECTION — from the checklist
-- ############################################################
-- The 035 lesson: adding a parameter creates an OVERLOAD, it does not replace.
-- Drop the 043 arity first or every later call is ambiguous.
drop function if exists public.fn_record_inspection(uuid, text, date, text, text[]);

-- `p_checks` is a JSON array of
--   { "check_id": uuid|null, "question": text, "result": "pass|fail|na",
--     "remark": text|null, "photos": [text] }
-- in the order they were answered.
create or replace function public.fn_record_inspection(
  p_item    uuid,
  p_result  text,
  p_date    date    default null,
  p_remarks text    default null,
  p_photos  text[]  default '{}',
  p_checks  jsonb   default '[]'::jsonb
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_project uuid; v_desc text; v_ref text; v_type text; v_stage text;
  v_insp uuid; v_ncr uuid;
  v_expected int; v_answered int; v_fails int;
  v_final text; v_i int := 0; c jsonb;
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

  if public.my_role() not in ('founder', 'pm') then
    raise exception
      'Only a founder or PM signs off an inspection. Request one instead — it is recorded against your name and the PM can see it.'
      using errcode = '42501';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  -- ---------- the checklist must be complete ----------
  select count(*) into v_expected from public.itp_checks where itp_item_id = p_item;
  v_answered := jsonb_array_length(coalesce(p_checks, '[]'::jsonb));

  if v_expected > 0 and v_answered < v_expected then
    raise exception
      '% of % checks answered. A checklist with blanks records an interruption, not an inspection.',
      v_answered, v_expected;
  end if;

  -- ---------- derive the result from the answers ----------
  select count(*) into v_fails
  from jsonb_array_elements(coalesce(p_checks, '[]'::jsonb)) e
  where e ->> 'result' = 'fail';

  if v_answered = 0 then
    -- No checklist on this point: the inspector's own call stands.
    v_final := p_result;
  elsif v_fails > 0 then
    -- A failed check cannot sit under a clean pass. If the inspector chose
    -- "conditional" that is honoured — the next stage may proceed and the
    -- defect is still raised. Anything else becomes a fail.
    v_final := case when p_result = 'conditional' then 'conditional' else 'fail' end;
  else
    -- Every answer pass or n/a. A claimed failure with nothing failing would
    -- be a contradiction too, so the answers win in both directions.
    v_final := 'pass';
  end if;

  insert into public.inspections
    (itp_item_id, project_id, inspected_on, result, remarks, photos, inspector)
  values
    (p_item, v_project,
     coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date),
     v_final::inspection_result,
     nullif(btrim(coalesce(p_remarks, '')), ''),
     coalesce(p_photos, '{}'),
     auth.uid())
  returning id into v_insp;

  update public.itp_items
     set status = case when v_final = 'fail'
                       then 'failed'::itp_status
                       else 'passed'::itp_status end,
         signed_off_at = case when v_final = 'fail' then null else now() end,
         signed_off_by = case when v_final = 'fail' then null else auth.uid() end,
         updated_at = now()
   where id = p_item;

  -- ---------- the answers, and an NCR for each failure ----------
  for c in select * from jsonb_array_elements(coalesce(p_checks, '[]'::jsonb))
  loop
    v_i := v_i + 1;
    v_ncr := null;

    if (c ->> 'result') = 'fail' then
      -- One NCR per failed check. Three failures are three defects, each with
      -- its own correction and its own closing date; a single lumped NCR would
      -- close when the easiest of them was fixed.
      insert into public.ncrs
        (project_id, itp_item_id, inspection_id, area, description, severity,
         standard_ref, photos, raised_by)
      values
        (v_project, p_item, v_insp,
         coalesce(nullif(btrim(v_stage), ''), 'Not stated'),
         'Failed check on "' || v_desc || '": ' || coalesce(c ->> 'question', 'check')
           || case when nullif(btrim(coalesce(c ->> 'remark', '')), '') is null
                   then '' else ' — ' || btrim(c ->> 'remark') end,
         case when v_type = 'hold' then 'major'::ncr_severity
              else 'minor'::ncr_severity end,
         v_ref,
         coalesce(
           (select array_agg(value #>> '{}')
            from jsonb_array_elements(coalesce(c -> 'photos', '[]'::jsonb))),
           '{}'),
         auth.uid())
      returning id into v_ncr;
    end if;

    insert into public.inspection_checks
      (inspection_id, itp_check_id, question, result, remark, photos, ncr_id, sort_order)
    values
      (v_insp,
       nullif(c ->> 'check_id', '')::uuid,
       coalesce(nullif(btrim(coalesce(c ->> 'question', '')), ''), 'Question not recorded'),
       (c ->> 'result')::check_result,
       nullif(btrim(coalesce(c ->> 'remark', '')), ''),
       coalesce(
         (select array_agg(value #>> '{}')
          from jsonb_array_elements(coalesce(c -> 'photos', '[]'::jsonb))),
         '{}'),
       v_ncr,
       v_i * 10);
  end loop;

  -- A point with no checklist keeps 043's behaviour: one NCR for the whole
  -- inspection, since there is no individual failure to name.
  if v_answered = 0 and v_final in ('fail', 'conditional') then
    insert into public.ncrs
      (project_id, itp_item_id, inspection_id, area, description, severity,
       standard_ref, photos, raised_by)
    values
      (v_project, p_item, v_insp,
       coalesce(nullif(btrim(v_stage), ''), 'Not stated'),
       case when v_final = 'fail' then 'Failed inspection: ' else 'Conditional pass: ' end
         || v_desc
         || case when nullif(btrim(coalesce(p_remarks, '')), '') is null
                 then '' else ' — ' || btrim(p_remarks) end,
       case when v_final = 'fail' and v_type = 'hold'
            then 'major'::ncr_severity else 'minor'::ncr_severity end,
       v_ref, coalesce(p_photos, '{}'), auth.uid());
  end if;

  return v_insp;
end $$;

revoke all on function
  public.fn_record_inspection(uuid, text, date, text, text[], jsonb)
  from public, anon;
grant execute on function
  public.fn_record_inspection(uuid, text, date, text, text[], jsonb)
  to authenticated;


-- ############################################################
-- ### 10. READ AN INSPECTION'S ANSWERS
-- ############################################################
-- Drop first: `create or replace` CANNOT change a function's return type, and
-- 046 widens this one. Without the drop the second migration aborts with
-- "cannot change return type of existing function" (found in testing).
drop function if exists public.fn_inspection_checks(uuid);

create function public.fn_inspection_checks(p_inspection uuid)
returns table (
  id        uuid,
  question  text,
  result    text,
  remark    text,
  photos    text[],
  ncr_no    text
)
language sql
stable
security invoker
set search_path = public
as $$
  select ic.id, ic.question, ic.result::text, ic.remark, ic.photos, n.ncr_no
  from public.inspection_checks ic
  left join public.ncrs n on n.id = ic.ncr_id
  where ic.inspection_id = p_inspection
  order by ic.sort_order;
$$;

revoke all on function public.fn_inspection_checks(uuid) from public, anon;
grant execute on function public.fn_inspection_checks(uuid) to authenticated;


-- ############################################################
-- ### 11. SEEDED CHECKLISTS FOR THE 044 TEMPLATE POINTS
-- ############################################################
-- Attached by matching the template name and the point's description, so this
-- is a no-op on a database where 044 was never run, and skips any point whose
-- checklist already exists — a founder's edits are never overwritten.
--
-- The questions are written from scratch and phrased to be answerable
-- pass/fail while standing in front of the work. Where a numeric limit belongs
-- to a standard or the drawing, the question says "as per drawing" rather than
-- quoting a figure: the same line 044 draws, for the same reason.
create or replace function public.fn_seed_itp_checks(
  p_template text,
  p_point    text,
  p_questions text[]
)
returns int
language plpgsql
as $$
declare v_item uuid; v_n int := 0; i int;
begin
  select ti.id into v_item
  from public.itp_template_items ti
  join public.itp_templates t on t.id = ti.template_id
  where lower(btrim(t.name)) = lower(btrim(p_template))
    and lower(btrim(ti.description)) = lower(btrim(p_point))
  limit 1;

  if v_item is null then return 0; end if;
  if exists (select 1 from public.itp_template_checks where template_item_id = v_item)
    then return 0; end if;

  for i in 1 .. array_length(p_questions, 1) loop
    insert into public.itp_template_checks (template_item_id, question, sort_order)
    values (v_item, p_questions[i], i * 10);
    v_n := v_n + 1;
  end loop;

  return v_n;
end $$;


-- ---------- the seed calls ----------
do $$
declare v_total int := 0;
begin
  v_total := v_total + public.fn_seed_itp_checks('IS — Structural / RCC', 'REINFORCEMENT BEFORE CONCRETING', array['Bar diameters and numbers match the approved drawing and BBS', 'Spacing between bars is as per drawing at top, bottom and both faces', 'Lap lengths and lap positions are as specified and staggered where required', 'Cover blocks of the correct thickness are fixed at the required spacing', 'Chairs and spacers hold the top mat at the designed level', 'Development length at supports and end anchorage is as per drawing', 'Binding wire ends are turned inwards, away from the cover face', 'Embedded items, sleeves, inserts and conduits are in place and secured', 'Reinforcement is free of loose rust, oil, mud and form-release agent', 'Working area, formwork base and construction joint are clean and free of debris']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Structural / RCC', 'Formwork alignment, props and release agent', array['Line, level and plumb checked against the drawing and within tolerance', 'Slab and beam soffit levels checked, with camber where specified', 'Props are plumb, on firm bearing, and braced against lateral movement', 'Prop spacing and staging are as designed for the pour', 'Joints between panels are sealed against grout loss', 'Release agent applied evenly, with none on the reinforcement', 'Cut-outs, openings and drop positions match the drawing', 'Formwork is clean, with no debris trapped at the base']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Structural / RCC', 'Excavation level, bearing strata and dimensions', array['Founding level matches the drawing and the geotechnical report', 'Bearing strata is as described in the soil report', 'Plan dimensions and offsets are as per the foundation layout', 'Base is level, compacted and free of loose soil', 'No standing water or slush in the pit', 'Sides are stable, battered or shored as required']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Structural / RCC', 'Deshuttering after minimum stripping time', array['Minimum stripping time for this member type has elapsed', 'Cube or in-situ strength supports removal', 'Back-props are in place where the design requires them', 'Surface shows no honeycombing, cold joint or exposed reinforcement', 'Edges and corners are intact and undamaged']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Structural / RCC', 'Slump and cube sampling at the pour', array['Slump measured at the point of placing and within the approved range', 'Cubes cast at the required sampling frequency for this pour', 'Cubes marked with the date, grade and pour location', 'Cubes stored and cured as required until testing', 'Batch slips or mix records collected for the pour']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Masonry and plaster', 'Wall-to-column junctions, mesh and chases', array['Chicken mesh lapped across every wall-to-column and wall-to-beam junction', 'Mesh lap width is as specified on both sides of the junction', 'Chases are cut, not broken out, and within the permitted depth', 'Conduits and pipes in chases are secured and covered', 'Service boxes are fixed plumb and flush to the finished plaster line', 'No unfilled gap left at the wall-to-soffit junction']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Masonry and plaster', 'Surface preparation, hacking and dampening', array['Surface is sound, with loose mortar and projections removed', 'Concrete faces hacked where required for key', 'Surface cleaned of dust, oil and release agent', 'Surface dampened without free water standing on it', 'Level dots and screeds fixed to give the specified thickness', 'Grooves at dissimilar-material junctions provided as detailed']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Masonry and plaster', 'Setting out, line, level and plumb of the first course', array['Wall lines set out from the grid and match the drawing', 'Wall thickness is as per drawing at every location', 'Opening positions and sizes match the drawing', 'First course is level and true along its length', 'DPC or plinth treatment is in place below the first course']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Waterproofing', 'WET-AREA PONDING TEST', array['All outlets are plugged and the area is filled to the specified depth', 'Start level marked and start time recorded', 'Held for the full specified duration', 'No drop in water level beyond the permitted tolerance', 'Soffit below inspected — no damp patch, staining or drip', 'Adjacent rooms and the corridor face inspected for seepage', 'Photographs taken at the start and at the end of the test']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Waterproofing', 'TERRACE PONDING TEST', array['Outlets plugged and terrace flooded to the specified depth', 'Start level marked and start time recorded', 'Held for the full specified duration', 'No drop in water level beyond the permitted tolerance', 'Soffit inspected — no damp patch or drip anywhere', 'Parapet junction and skirting inspected for seepage', 'Outlet surrounds and pipe penetrations inspected', 'Photographs taken at the start and at the end of the test']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Waterproofing', 'Substrate preparation and falls', array['Surface sound, clean and free of laitance and loose material', 'Falls set towards the outlets, checked by water or level', 'No ponding depressions away from the outlets', 'Internal corners rounded and coving formed', 'Cracks and honeycombing repaired before treatment']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Waterproofing', 'Outlets, penetrations and junction detailing', array['Every pipe penetration sleeved and sealed', 'Outlets set flush and at the low point of the fall', 'Skirting height at the wall junction is as specified', 'Membrane turn-up detail at the door threshold is as detailed', 'No penetration made after the membrane was laid']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Finishes', 'Setting out, levels and joint layout', array['Setting-out lines marked and agreed before laying', 'Falls to the floor trap set in wet areas', 'Joint width uniform and as specified', 'Cut tiles positioned away from the entrance and sightlines', 'Tile layout matches the approved pattern drawing', 'Threshold and level difference with adjacent areas resolved']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Finishes', 'Bedding, hollowness and grouting', array['Full bedding under every tile, with no voids at corners', 'Tapping test carried out — no hollow sound', 'Level and lippage between adjacent tiles within tolerance', 'Joints clean and uniform before grouting', 'Grouting done only after the bed has set', 'Skirting and corner beads aligned with the floor joints']);
  v_total := v_total + public.fn_seed_itp_checks('IS — Finishes', 'Surface preparation and primer', array['Surface dry, with moisture within the paint system''s limit', 'Surface sanded smooth and free of dust', 'Cracks and dents filled and rubbed down', 'Previous coat fully cured before priming', 'Primer applied evenly with no missed patches', 'Adjacent finishes, frames and fittings masked']);
  v_total := v_total + public.fn_seed_itp_checks('IS — MEP services', 'PRESSURE TEST ON CONCEALED WATER LINES', array['All outlets capped and the line isolated', 'Gauge fitted and its reading recorded at the start', 'Test pressure raised to the specified value', 'Held for the full specified duration', 'No drop in gauge pressure beyond the permitted tolerance', 'Every visible joint inspected for weeping', 'Photograph of the gauge taken at the start and at the end']);
  v_total := v_total + public.fn_seed_itp_checks('IS — MEP services', 'EARTHING — electrodes, conductors and resistance', array['Electrode type, size and depth are as designed', 'Earth pit location matches the drawing and is accessible', 'Conductor sizes and the run to the board are as designed', 'All joints are brazed or bolted and protected against corrosion', 'Earth resistance measured, and the reading recorded', 'Reading is within the specified limit', 'Earth pit chamber, cover and watering arrangement in place']);
  v_total := v_total + public.fn_seed_itp_checks('IS — MEP services', 'Conduit layout, chase depth and boxes', array['Conduit routes and drops match the drawing', 'Chase depth within the permitted limit for the wall type', 'Conduits secured with saddles at the required spacing', 'Bends are within the permitted number per run, with no crushing', 'Junction and switch boxes are plumb and set to the finished plaster line', 'Draw wires present in every concealed run', 'No conduit run through a structural member without approval']);
  v_total := v_total + public.fn_seed_itp_checks('IS — MEP services', 'Insulation resistance and circuit testing', array['Every circuit tested and the reading recorded', 'Insulation resistance is within the specified limit on each circuit', 'Polarity confirmed at every point', 'Continuity of the protective conductor confirmed', 'RCD or RCBO tripping verified', 'Test results recorded on the sheet and retained']);
  v_total := v_total + public.fn_seed_itp_checks('IS — MEP services', 'Drainage flow test', array['Water run through every trap and appliance connection', 'Flow observed at the manhole or the discharge point', 'No leakage at any visible joint', 'No backflow or gurgling at other appliances', 'Trap seal retained after the test', 'Access covers refitted and sealed']);
  raise notice 'Seeded % checklist questions.', v_total;
end $$;

-- The helper has done its job; it is not part of the app's surface.
drop function if exists public.fn_seed_itp_checks(text, text, text[]);


-- ############################################################
-- ### 12. VERIFY
-- ############################################################
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('itp_template_checks', 'itp_checks', 'inspection_checks')
order by table_name;

-- Expect exactly ONE row: the 043 arity must not have survived (the 035 trap).
select count(*) as record_inspection_arities from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'fn_record_inspection';

-- Seeded checklists, per template point. Expect 20 points, 127 questions.
select t.name, ti.description, count(c.id) as questions
from public.itp_template_checks c
join public.itp_template_items ti on ti.id = c.template_item_id
join public.itp_templates t on t.id = ti.template_id
group by t.name, ti.description, ti.sort_order
order by t.name, ti.sort_order;

select count(*) as seeded_questions from public.itp_template_checks;

-- inspection_checks must have NO write policy — fn_record_inspection only.
select cmd, count(*) from pg_policies
where schemaname = 'public' and tablename = 'inspection_checks'
group by cmd;
