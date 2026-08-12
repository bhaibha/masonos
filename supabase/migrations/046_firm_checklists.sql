-- ============================================================
-- MASON OS — Migration 046: the firm's own checklists, in their own format
--
-- The founder sent the twenty "CHECKLIST FOR ON-SITE INSPECTION" sheets Your
-- Masons already uses on site. This migration puts them in the app verbatim,
-- and adds the two things the paper form has that 045 did not:
--
--   * SECTION headings inside a checklist — "PRE EXECUTION CHECKS",
--     "CHECKS DURING EXECUTION", "POST EXECUTION CHECKS", and the BEAM / SLAB
--     sub-headings on the reinforcement sheets. Without them a 30-row list is
--     a wall; with them it reads like the form the site engineer already knows.
--   * LOCATION on the inspection. Their sheet has PROJECT, DATE and LOCATION
--     in the header, and location is the one that changes between two
--     inspections of the same activity — "Block A, first floor" against
--     "Block B, ground floor".
--
-- ---------- YES / NO / N/A ----------
-- No schema change. Their sheet reads YES / NO / N/A; the `check_result` enum
-- from 045 is pass / fail / na. Every question on these sheets is phrased so
-- that YES is the compliant answer, so the mapping is exact and the LABELS
-- change in the app rather than the data. Relabelling is a screen decision;
-- re-cutting an enum that already has answers stored against it is not.
--
-- ---------- NOTHING WAS REWORDED ----------
-- All 500 questions are transcribed as written, including their own spellings,
-- their IS references and their "as per drawing" phrasing. They are the firm's
-- standard; an app that quietly improves the wording would leave the site copy
-- and the phone copy saying different things.
--
-- Additive and re-runnable. Requires 043 and 045.
-- ============================================================


-- ############################################################
-- ###  1. SECTIONS
-- ############################################################
-- Nullable everywhere: a checklist with no headings is still a checklist, and
-- 045's seeded questions have none.
alter table public.itp_template_checks add column if not exists section text;
alter table public.itp_checks          add column if not exists section text;

-- Snapshotted onto the answer alongside the question, for the same reason the
-- question is: the completed record has to read like the form that was filled.
alter table public.inspection_checks   add column if not exists section text;


-- ############################################################
-- ###  2. LOCATION ON AN INSPECTION
-- ############################################################
alter table public.inspections add column if not exists location text;


-- ############################################################
-- ###  3. CARRY BOTH THROUGH
-- ############################################################
-- `fn_apply_itp_template` and `fn_save_itp_template` re-emitted from 045 with
-- `section` added to the copied columns. Nothing else changed.
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
  insert into public.itp_checks
    (itp_item_id, question, guidance, section, sort_order, template_check_id, created_by)
  select ins.id, c.question, c.guidance, c.section, c.sort_order, c.id, auth.uid()
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
    (template_item_id, question, guidance, section, sort_order)
  select ins.id, c.question, c.guidance, c.section, c.sort_order
  from ins
  join public.itp_items i
    on i.project_id = p_project and i.sort_order = ins.sort_order
  join public.itp_checks c on c.itp_item_id = i.id;

  return v_id;
end $$;

revoke all on function public.fn_save_itp_template(uuid, text, text) from public, anon;
grant execute on function public.fn_save_itp_template(uuid, text, text) to authenticated;

-- ############################################################
-- ###  4. THE FIRM'S OWN CHECKLISTS
-- ############################################################
-- Transcribed from the twenty "CHECKLIST FOR ON-SITE INSPECTION" sheets the
-- firm already works to. Every question is theirs, verbatim including its
-- section heading; nothing was invented, reworded or reordered. Where a sheet
-- reads "as per drawing" or names an IS code, that is their wording.
--
-- Grouped into three templates by discipline, so a project applies what it
-- needs. Each sheet becomes one ITP POINT carrying its own checklist — which
-- is exactly what the paper form is: one activity, one list, one signature.
--
-- Reinforcement, formwork, excavation and masonry marking are HOLD points:
-- the next operation buries the evidence. Concreting and the finishing trades
-- are witness.
--
-- Skipped wholesale if a template of the same name already exists, so a second
-- run never duplicates and never overwrites an edit.

do $$
declare v_t uuid; v_i uuid;
begin
  if exists (select 1 from public.itp_templates
             where lower(btrim(name)) = lower(btrim('Your Masons — Earthworks & substructure'))) then
    return;
  end if;

  insert into public.itp_templates (name, description)
  values ('Your Masons — Earthworks & substructure', 'The firm’s own on-site inspection checklists.')
  returning id into v_t;

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Earthwork excavation', 'Earthwork excavation', 'hold'::itp_type,
          'Before the next operation', 1010)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Soil investigation report is available on the site.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'TBM''s have been established on the site.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'All the required equipments, plant & machinery as well as the tools for excavation and disposal of earth are available on site.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Access routes and ramp for excavation and carting have been planned.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Location for storing/ disposing of the excavated earth finalized.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Is the co-ordinates marked at site has according to the latest GFC drawings and has been certified by a architect / Client representative.', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Check if the first aid kit is available on the site.', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Structural consultant has approved to go ahead with excavation.', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Is the information regarding the water table in the area available ?', 'PRE EXECUTION CHECKS', 110),
    (v_i, 'De-watering pumps of required capacity are available on site.', 'PRE EXECUTION CHECKS', 120),
    (v_i, 'Does the depth of excavation include the soling / PCC thickness ? ( Ensure excavation upto hard strata )', 'PRE EXECUTION CHECKS', 130),
    (v_i, 'Are the safety boards concerning excavation work displayed at the site ?', 'PRE EXECUTION CHECKS', 140),
    (v_i, 'If the soil is stiff and approved by Structural Consultant, then the excavation done to the size of the footing with suffecient working space.', 'PRE EXECUTION CHECKS', 150),
    (v_i, 'Check if the block level drawing / register is available on the site.', 'CHECKS DURING EXECUTION', 160),
    (v_i, 'Is step cutting being done when the depth of excavation is 2m or more, as guided by the strcutural consultant ?', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Check for a minimum distance of 600mm between the TBM and the edges of the excavation.', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Check if a minimum 600mm for footing shuttering/work space has been considered while excavation is being done.', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Ensure dumping of excavated soil atleast 1m from the excavated edges.', 'CHECKS DURING EXECUTION', 200),
    (v_i, 'Constant monitoring of the depth for excavation is being carried out to avoid over excavation.', 'CHECKS DURING EXECUTION', 210),
    (v_i, 'Proper protection against caving during excavation in loose soils has been provided. (shoring, pinning, shotcrete etc.,).', 'CHECKS DURING EXECUTION', 220),
    (v_i, 'Blasting being conducted by a licensed & experienced Contractor.', 'CHECKS DURING EXECUTION', 230),
    (v_i, 'Is the last 100 or 200mm of excavation being done manually ?', 'CHECKS DURING EXECUTION', 240),
    (v_i, 'The protection measures against caving like shoring, pinning, shotcrete, strutting are strictly as per the latest GFC drawings.', 'POST EXECUTION CHECKS', 250),
    (v_i, 'Ensure that special soil stabilization measures are taken up in critical areas like compound wall.', 'POST EXECUTION CHECKS', 260),
    (v_i, 'Safety barricading has been done at 1m from the line of excavation.', 'POST EXECUTION CHECKS', 270),
    (v_i, 'Ensure no material stocked between safety barricade and the line of excavation.', 'POST EXECUTION CHECKS', 280);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Earthwork backfilling & compaction', 'Earthwork backfilling & compaction', 'witness'::itp_type,
          'During execution', 1020)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Is the waterproofing work for footing completed ?', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Availability of suitable filling and compaction.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Ensure there is no Presence of any organic impurities & construction debris in soil & backfilling area .', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Ensure soil test reports like MDD & OMC are available ?', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Is compaction being carried out as per the prescribed procedure ?', 'CHECKS DURING EXECUTION', 70),
    (v_i, 'Ensure the compaction is done layer by layer to maximum thickness of 300 mm.', 'CHECKS DURING EXECUTION', 80),
    (v_i, 'Is the compaction test carried out at 10m c/c. for each layer ?', 'CHECKS DURING EXECUTION', 90),
    (v_i, 'Is the field density of the compacted soil as specified by the consultant ? / 95% degree of compaction?', 'CHECKS DURING EXECUTION', 100),
    (v_i, 'Check if manual compaction is being carried out in places where the compacting machines cannot be used.', 'CHECKS DURING EXECUTION', 110),
    (v_i, 'Ensure test reports are available for each layer.', 'POST EXECUTION CHECKS', 120),
    (v_i, 'Ensure the top level of filling is as per GFC.', 'POST EXECUTION CHECKS', 130);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Anti-termite treatment', 'Anti-termite treatment', 'witness'::itp_type,
          'During execution', 1030)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Check if the area to be treated is leveled & well compacted.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Ensure that all the necessary safety precaution have been taken.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'The chemicals and its method of application are conforming to the IS standard (IS 6313: Part 1,2 and 3).', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Ensure the debris and shuttering materials not lying on the site.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Are the required tools available at site?', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Is the person doing the anti termite treatment wearing face mask/ hand gloves/ gum boots and Safety goggles.', 'CHECKS DURING EXECUTION', 80),
    (v_i, 'Are the dilution & dosage as specified by the manufacaturer.', 'CHECKS DURING EXECUTION', 90),
    (v_i, 'Is the treatment being given by trained personnel ?', 'CHECKS DURING EXECUTION', 100),
    (v_i, 'For sandy soil : Preliminary Moistening is ensured?', 'CHECKS DURING EXECUTION', 110),
    (v_i, 'Is the chemical being poured along the perimeter of the building at specified intervals and depth?', 'CHECKS DURING EXECUTION', 120),
    (v_i, 'Is the treatment being given below the PCC level at specified intervals and depths as per specifications ?', 'CHECKS DURING EXECUTION', 130),
    (v_i, 'Is the treatment being given at pipe penetrations and expansion joints ?', 'CHECKS DURING EXECUTION', 140),
    (v_i, 'Are the horizontal treated areas which will receive a layer of concrete covered with a LDPE sheet.', 'CHECKS DURING EXECUTION', 150),
    (v_i, 'Check the treated area is not exposed to atmosphere for long period of time before being covered with PCC.', 'POST EXECUTION CHECKS', 160),
    (v_i, 'Has the treated areas been protected suitably before starting the successive activities ?', 'POST EXECUTION CHECKS', 170);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Concreting — PCC', 'Concreting — PCC', 'witness'::itp_type,
          'During execution', 1040)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Check for the proper marking approved by the surveyor & engineer.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Proper lighting arrangement made for concreting during night time.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Availability of all the tools for concreting on site.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Availability of sufficient manpower for concreting on site.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'If the soil is stiff and approved by Structural Consultant, then the excavation done to the size of the footing with sufficient working space.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Slush removed properly before the start of work ?', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Bull mark/ height indicators fixed properly.', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Are the safety boards concerning excavation work displayed at the site ?', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Are all the workers wearing safety gears like gloves, boots, face mask & goggles etc ?', 'CHECKS DURING EXECUTION', 110),
    (v_i, 'Uniform compaction using straight edge/ wooden runner done.', 'CHECKS DURING EXECUTION', 120),
    (v_i, 'Ensure the top level of concrete as per GFC.', 'CHECKS DURING EXECUTION', 130),
    (v_i, 'Is curing by sprinkling of water started as soon as the surface starts drying ?', 'POST EXECUTION CHECKS', 140),
    (v_i, 'Is Level of finish checked and concreted when concrete is fresh.', 'POST EXECUTION CHECKS', 150);

end $$;

do $$
declare v_t uuid; v_i uuid;
begin
  if exists (select 1 from public.itp_templates
             where lower(btrim(name)) = lower(btrim('Your Masons — RCC'))) then
    return;
  end if;

  insert into public.itp_templates (name, description)
  values ('Your Masons — RCC', 'The firm’s own on-site inspection checklists.')
  returning id into v_t;

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Reinforcement of footing', 'Reinforcement of footing', 'hold'::itp_type,
          'Before the next operation', 2010)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Ensure PCC works are completed & place is found clean.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Are test results of reinforcement steel available at site before starting the fabrication work?', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Has the required barricading and safety measures been taken?', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Check the footing & column markings are as per drawing.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Is the reinforcement free from oil, mud, grease and other forms of contamination?', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Is the footing reinforcement done as per specification and drawing?', 'DURING & POST EXECUTION CHECKS', 80),
    (v_i, 'Check the dia , shape of bar, spacing , layers, lapping zone, lap length, development length of top & bottom mat.', 'DURING & POST EXECUTION CHECKS', 90),
    (v_i, 'Check for the suffieciency of the chairs to ensure the spacing btw top & bottom mat & the stability of reinforcement.', 'DURING & POST EXECUTION CHECKS', 100),
    (v_i, 'Check for side face reinforcement if the footing depth is more. ( if any )', 'DURING & POST EXECUTION CHECKS', 110),
    (v_i, 'Check the dowel bars provision with respective details for the further work.', 'DURING & POST EXECUTION CHECKS', 120),
    (v_i, 'Are cover blocks provided and fixed in a systematically correct manner and as per specifications?', 'DURING & POST EXECUTION CHECKS', 130),
    (v_i, 'Check for column / wall center line marking as per drawing.', 'DURING & POST EXECUTION CHECKS', 140),
    (v_i, 'Check the dia , shape of bar, spacing , rings, lapping zone, lap length, development length of column & wall reinforcement.', 'DURING & POST EXECUTION CHECKS', 150),
    (v_i, 'Check for column / wall reinforcement for support system. ( Independent of footing shuttering )', 'DURING & POST EXECUTION CHECKS', 160),
    (v_i, 'Check the top level ( excluding cover ) of the footing.', 'DURING & POST EXECUTION CHECKS', 170);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Formwork — footing', 'Formwork — footing', 'hold'::itp_type,
          'Before the next operation', 2020)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Check the PCC base where formwork is going to placed is having a even surface without any more undulations.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Availability of adequate quantity of shuttering materials ?', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Is approved form releasing agent is being used on the shuttering materials.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Are the dimensions of the formwork according to the drawings ?', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Ensure that the brown/masking tape fixing at the edges are done properly', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Shuttering materials are cleaned and no hardened concrete or slurry on the surface and edges.', 'CHECKS DURING EXECUTION', 80),
    (v_i, 'Check if the footing shuttering is fixed as per the marking on the PCC.', 'CHECKS DURING EXECUTION', 90),
    (v_i, 'Check if the corners of the shutterings are at right angles.', 'CHECKS DURING EXECUTION', 100),
    (v_i, 'Are extra supports provided for footings of height more than 900mm ?', 'CHECKS DURING EXECUTION', 110),
    (v_i, 'Check for level indicators.', 'POST EXECUTION CHECKS', 120),
    (v_i, 'Are the dowel holes covered properly ?', 'POST EXECUTION CHECKS', 130),
    (v_i, 'Is the external line of the formwork maintained using a nylon thread ?', 'POST EXECUTION CHECKS', 140),
    (v_i, 'Check that the formwork is perfectly vertical and plumb.', 'POST EXECUTION CHECKS', 150),
    (v_i, 'Check adequate supports are provided', 'POST EXECUTION CHECKS', 160),
    (v_i, 'In case footing side shuttering are not done based on soil condition, ensure that the earth trimming is done vertically and in line.', 'POST EXECUTION CHECKS', 170);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Concreting — footing', 'Concreting — footing', 'witness'::itp_type,
          'During execution', 2030)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Check for the proper marking approved by the surveyor & engineer.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Availability of tarpaulin sheet for protection ensured.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Proper lighting arrangement made for concreting during night time.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Availability of all the tools for concreting on site.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Availability of sufficient manpower for concreting on site.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Suitable vibrator, fuel and vibrator needles employed for different members of a structure.', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Checking of vibrators done before concreting.', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Are pumps of suitable capacity provided on the site ?', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Are stand by vibrators and vibrator needles available at site.', 'PRE EXECUTION CHECKS', 110),
    (v_i, 'Bull mark/ height indicators fixed properly.', 'PRE EXECUTION CHECKS', 120),
    (v_i, 'Are the shuttering and the reinforcement works completed before concreting ?', 'PRE EXECUTION CHECKS', 130),
    (v_i, 'Ensure the design Mix of concrete & Raw Materials test results ?', 'PRE EXECUTION CHECKS', 140),
    (v_i, 'Check for the construction joint locations and their treatment as per specification.', 'PRE EXECUTION CHECKS', 150),
    (v_i, 'Is the shuttering wet and clean before concreting.', 'CHECKS DURING EXECUTION', 160),
    (v_i, 'Is layer wise concreting followed with the height of a single concrete layer not exceeding 300 mm ?', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Does the concrete look homogenous without segregation, bleeding & have required workability ?', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Is the concrete placed and compacted within 3 hours of its mixing ?', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Are all the workers wearing safety gears like gloves, boots, face mask & goggles etc ?', 'CHECKS DURING EXECUTION', 200),
    (v_i, 'Ensure Uniform compaction done with suitable vibrators.', 'CHECKS DURING EXECUTION', 210),
    (v_i, 'Ensure the top level of concrete as per GFC.', 'CHECKS DURING EXECUTION', 220),
    (v_i, 'Is curing by sprinkling of water started as soon as the surface starts drying ?', 'CHECKS DURING EXECUTION', 230),
    (v_i, 'Ensure the concreting done within the fall height of 1.5m.', 'CHECKS DURING EXECUTION', 240),
    (v_i, 'Check for proper curing by ponding and / or gunny bags for minimum period of 7 days.', 'POST EXECUTION CHECKS', 250),
    (v_i, 'Level of finish checked and concreted when concrete is fresh.', 'POST EXECUTION CHECKS', 260),
    (v_i, 'Deshuttering done after the recommended stripping time.', 'POST EXECUTION CHECKS', 270),
    (v_i, 'Concrete surfaces not damaged while deshuttering ?', 'POST EXECUTION CHECKS', 280),
    (v_i, 'Check the surfaces after deshuttering for any honeycombs, straight edges & Proper levels.', 'POST EXECUTION CHECKS', 290),
    (v_i, 'Check for required number of concrete cubes casted for testing on site.', 'POST EXECUTION CHECKS', 300),
    (v_i, 'Is rough finishing done in the footing-column interface.', 'POST EXECUTION CHECKS', 310);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Reinforcement of column & wall', 'Reinforcement of column & wall', 'hold'::itp_type,
          'Before the next operation', 2040)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Are test results of reinforcement steel available at site before starting the fabrication work?', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Has the required barricading and safety measures been taken?', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Check the column markings are as per drawing.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Is the reinforcement free from oil, mud, grease and other forms of contamination?', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Check the threading of column reinforcement bars & couplers. ( if any )', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Check the proper guage of binding wire as per specification.', 'DURING & POST EXECUTION CHECKS', 80),
    (v_i, 'Check the shape & dimension of rings are as per drawing.', 'DURING & POST EXECUTION CHECKS', 90),
    (v_i, 'Check the dia, number of bars provided as per GFC drawing.', 'DURING & POST EXECUTION CHECKS', 100),
    (v_i, 'Check the lap length & lapping zone as per GFC drawing.', 'DURING & POST EXECUTION CHECKS', 110),
    (v_i, 'Check the spacing & shape of rings provided in each zone.', 'DURING & POST EXECUTION CHECKS', 120),
    (v_i, 'Check the bars are tightened properly with couplers. ( if any )', 'DURING & POST EXECUTION CHECKS', 130),
    (v_i, 'Check the additional reinforcement for cutouts ( Openings ) & other embeded items .( if any )', 'DURING & POST EXECUTION CHECKS', 140),
    (v_i, 'Check the sufficient U-bars are provided to maintain the uniform wall thickness.', 'DURING & POST EXECUTION CHECKS', 150),
    (v_i, 'Check the reinforcement work is done in the expansion joint location as per the details.', 'DURING & POST EXECUTION CHECKS', 160),
    (v_i, 'Are cover blocks provided and fixed in a systematically correct manner and as per specifications?', 'DURING & POST EXECUTION CHECKS', 170),
    (v_i, 'Check the binding wires are tightened properly & the ends of binding wires are bent inside the column / wall.', 'DURING & POST EXECUTION CHECKS', 180),
    (v_i, 'Check for supports provided for the reinforcement till the shuttering work commencement.', 'DURING & POST EXECUTION CHECKS', 190),
    (v_i, 'Check the dowel bars provision with respective details for the further work.', 'DURING & POST EXECUTION CHECKS', 200);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Formwork — column', 'Formwork — column', 'hold'::itp_type,
          'Before the next operation', 2050)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Availability of staging for proper placing of concrete and keeping the vibrator etc.,', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Are props and staging given from below perfectly vertical and rigid ?', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Availability of adequate quantity of shuttering materials ?', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Is approved form releasing agent is being used on the shuttering materials.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Are the dimensions & location of the starter marking cross verified with respect to the GFC drawings before fixing the starter.', 'STARTER', 70),
    (v_i, 'Are regid starter formwork being used for casting the starter.', 'STARTER', 80),
    (v_i, 'Ensure proper application of form releasing agent.', 'STARTER', 90),
    (v_i, 'Diagonals of the starter has been checked before concreting.', 'STARTER', 100),
    (v_i, 'Ensure proper packing against slurry leakage.', 'STARTER', 110),
    (v_i, 'Ensure external line of the starter is maintained using a nylon thread.', 'STARTER', 120),
    (v_i, 'Check if the shuttering surfaces are clean.', 'COLUMN', 130),
    (v_i, 'Are the dimensions of formwork according to specifications ?', 'COLUMN', 140),
    (v_i, 'Cover blocks have been fixed before fixing the column shuttering.', 'COLUMN', 150),
    (v_i, 'Is the foam tape provided at column junctions with proper adhesive to avoid slurry leakage ?', 'COLUMN', 160),
    (v_i, 'Check the corners of the shuttering at right angles/as per GFC', 'COLUMN', 170),
    (v_i, 'Ensure that the dowel holes are covered properly (if any).', 'COLUMN', 180),
    (v_i, 'Is the runners(as per cover size)fixed at the top end of the column box to ensure rebar alignment?', 'COLUMN', 190),
    (v_i, 'Ensure that the vertical/horizontal joints are free from slurry leakage', 'COLUMN', 200),
    (v_i, 'Ensure that the formwork is perfectly in plumb using piano wire and proper counter weight', 'COLUMN', 210),
    (v_i, 'Is the external line of the formwork maintained using a nylon thread ?', 'COLUMN', 220),
    (v_i, 'Are the inclined supports are firmly supported on the hard surface', 'COLUMN', 230),
    (v_i, 'Are required number of walers,tie rods & C-clamps provided in critical areas ?', 'COLUMN', 240),
    (v_i, 'Are the tie rod holes covered properly to avoid slurry leakage?', 'COLUMN', 250);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Concreting — column', 'Concreting — column', 'witness'::itp_type,
          'During execution', 2060)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Check for the proper marking approved by the surveyor & engineer.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Availability of tarpaulin sheet for protection ensured.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Proper lighting arrangement made for concreting during night time.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Availability of all the tools for concreting on site.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Availability of sufficient manpower & proper working platform for concreting on site.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Suitable vibrator, fuel and vibrator needles employed for different members of a structure.', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Checking of vibrators done before concreting.', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Are pumps of suitable capacity provided on the site ?', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Are stand by vibrators and vibrator needles available at site.', 'PRE EXECUTION CHECKS', 110),
    (v_i, 'Bull mark/ height indicators fixed properly.', 'PRE EXECUTION CHECKS', 120),
    (v_i, 'Are the shuttering and the reinforcement works completed before concreting ?', 'PRE EXECUTION CHECKS', 130),
    (v_i, 'Ensure the design Mix of concrete & Raw Materials test results ?', 'PRE EXECUTION CHECKS', 140),
    (v_i, 'Is rough finishing done in the footing-column interface / starters.', 'PRE EXECUTION CHECKS', 150),
    (v_i, 'Is the shuttering wet and clean before concreting.', 'CHECKS DURING EXECUTION', 160),
    (v_i, 'Is layer wise concreting followed with the height of a single concrete layer not exceeding 300 mm with proper tampping ?', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Does the concrete look homogenous without segregation, bleeding & have required workability ?', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Is the concrete placed and compacted within 3 hours of its mixing ?', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Are all the workers wearing safety gears like gloves, boots, face mask & goggles etc ?', 'CHECKS DURING EXECUTION', 200),
    (v_i, 'Ensure Uniform compaction done with suitable vibrators.', 'CHECKS DURING EXECUTION', 210),
    (v_i, 'Ensure concreting done using suitable chute arrangements.', 'CHECKS DURING EXECUTION', 220),
    (v_i, 'Ensure the top level of concrete as per GFC.', 'CHECKS DURING EXECUTION', 230),
    (v_i, 'Check for the Plumb of column immediately after casting.', 'POST EXECUTION CHECKS', 240),
    (v_i, 'Check for proper curing by proper spraying of coloured curing compound / or gunny bags for minimum period of 7 days.', 'POST EXECUTION CHECKS', 250),
    (v_i, 'Top Level of finish checked when concrete is fresh.', 'POST EXECUTION CHECKS', 260),
    (v_i, 'Deshuttering done after the recommended stripping time.', 'POST EXECUTION CHECKS', 270),
    (v_i, 'Concrete surfaces not damaged while deshuttering ?', 'POST EXECUTION CHECKS', 280),
    (v_i, 'Check the surfaces after deshuttering for any honeycombs, straight edges & Proper levels.', 'POST EXECUTION CHECKS', 290),
    (v_i, 'Check for required number of concrete cubes casted for testing on site.', 'POST EXECUTION CHECKS', 300),
    (v_i, 'Is rough finishing done in the column top surface..', 'POST EXECUTION CHECKS', 310),
    (v_i, 'Is the date of casting mentioned on surface to ensure curing period.', 'POST EXECUTION CHECKS', 320);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Formwork — RCC wall & retaining wall', 'Formwork — RCC wall & retaining wall', 'hold'::itp_type,
          'Before the next operation', 2070)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Availability of staging for proper placing of concrete and keeping the vibrator etc.,', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Are props and staging given from below perfectly vertical and rigid ?', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Availability of adequate quantity of shuttering materials ?', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Is approved form releasing agent is being used on the shuttering materials.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Are the dimensions & location of the starter marking cross verified with respect to the GFC drawings before fixing the starter.', 'STARTER', 70),
    (v_i, 'Are regid starter formwork being used for casting the starter.', 'STARTER', 80),
    (v_i, 'Ensure proper application of form releasing agent.', 'STARTER', 90),
    (v_i, 'Diagonals of the starter have been checked before concreting.', 'STARTER', 100),
    (v_i, 'Ensure proper packing against slurry leakage.', 'STARTER', 110),
    (v_i, 'Ensure external line of the starter is maintained using a nylon thread.', 'STARTER', 120),
    (v_i, 'Check if the shuttering surfaces are clean.', 'WALL', 130),
    (v_i, 'Are the dimensions of formwork according to specifications ?', 'WALL', 140),
    (v_i, 'Ensure proper sized Cover blocks are provided before fixing the wall shuttering.', 'WALL', 150),
    (v_i, 'Is the foam tape provided at wall junctions with proper adhesive to avoid slurry leakage ?', 'WALL', 160),
    (v_i, 'Ensure that the dowel holes are covered properly (if any).', 'WALL', 170),
    (v_i, 'Is the runners(as per cover size)fixed at the top end of the shuttering board to ensure rebar alignment?', 'WALL', 180),
    (v_i, 'Ensure that the vertical/horizontal joints are free from slurry leakage', 'WALL', 190),
    (v_i, 'Ensure that the formwork is perfectly in plumb using piano wire and proper counter weight', 'WALL', 200),
    (v_i, 'Is the external line of the formwork maintained using a nylon thread ?', 'WALL', 210),
    (v_i, 'Are the inclined supports are firmly supported on the hard surface', 'WALL', 220),
    (v_i, 'Are required number of walers,tie rods & C-clamps provided in required areas ?', 'WALL', 230),
    (v_i, 'Ensure end cones are provide for pvc sleeves for the tie rods.', 'WALL', 240),
    (v_i, 'Check retaining walls gugu bolts and nuts / approved system are provided.', 'WALL', 250),
    (v_i, 'Check the vertical stoppers are properly supported , packed & fixed firmly.', 'WALL', 260),
    (v_i, 'Are the tie rod holes covered properly to avoid slurry leakage?', 'WALL', 270);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Concreting — RCC wall & retaining wall', 'Concreting — RCC wall & retaining wall', 'witness'::itp_type,
          'During execution', 2080)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Check for the proper marking approved by the surveyor & engineer.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Availability of tarpaulin sheet for protection ensured.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Proper lighting arrangement made for concreting during night time.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Availability of all the tools for concreting on site.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Availability of sufficient manpower & proper working platform for concreting on site.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Suitable vibrator, fuel and vibrator needles employed for different members of a structure.', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Checking of vibrators done before concreting.', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Are pumps of suitable capacity provided on the site ?', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Are stand by vibrators and vibrator needles available at site.', 'PRE EXECUTION CHECKS', 110),
    (v_i, 'Bull mark/ height indicators fixed properly.', 'PRE EXECUTION CHECKS', 120),
    (v_i, 'Are the shuttering and the reinforcement works completed before concreting ?', 'PRE EXECUTION CHECKS', 130),
    (v_i, 'Ensure the design Mix of concrete & Raw Materials test results ?', 'PRE EXECUTION CHECKS', 140),
    (v_i, 'Check for the construction joint locations and their treatment as per specification.', 'PRE EXECUTION CHECKS', 150),
    (v_i, 'Is rough finishing done in the footing-wall interface / starters.', 'PRE EXECUTION CHECKS', 160),
    (v_i, 'Is the shuttering wet and clean before concreting.', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Is layer wise concreting followed with the height of a single concrete layer not exceeding 300 mm with proper tampping ?', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Does the concrete look homogenous without segregation, bleeding & have required workability ?', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Is the concrete placed and compacted within 3 hours of its mixing ?', 'CHECKS DURING EXECUTION', 200),
    (v_i, 'Are all the workers wearing safety gears like gloves, boots, face mask & goggles etc ?', 'CHECKS DURING EXECUTION', 210),
    (v_i, 'Ensure Uniform compaction done with suitable vibrators.', 'CHECKS DURING EXECUTION', 220),
    (v_i, 'Ensure concreting done using suitable chute arrangements.', 'CHECKS DURING EXECUTION', 230),
    (v_i, 'Ensure the top level of concrete as per GFC.', 'CHECKS DURING EXECUTION', 240),
    (v_i, 'Check for the Plumb of wall immediately after casting.', 'POST EXECUTION CHECKS', 250),
    (v_i, 'Check for proper curing by proper spraying of coloured curing compound / or gunny bags for minimum period of 7 days.', 'POST EXECUTION CHECKS', 260),
    (v_i, 'Top Level of finish checked when concrete is fresh.', 'POST EXECUTION CHECKS', 270),
    (v_i, 'Deshuttering done after the recommended stripping time.', 'POST EXECUTION CHECKS', 280),
    (v_i, 'Concrete surfaces not damaged while deshuttering ?', 'POST EXECUTION CHECKS', 290),
    (v_i, 'Check the surfaces after deshuttering for any honeycombs, straight edges & Proper levels.', 'POST EXECUTION CHECKS', 300),
    (v_i, 'Check for required number of concrete cubes casted for testing on site.', 'POST EXECUTION CHECKS', 310),
    (v_i, 'Is rough finishing done in the column top surface.', 'POST EXECUTION CHECKS', 320),
    (v_i, 'Is the date of casting mentioned on surface to ensure curing period.', 'POST EXECUTION CHECKS', 330);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Reinforcement of slab & beam', 'Reinforcement of slab & beam', 'hold'::itp_type,
          'Before the next operation', 2090)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Ensure shuttering works are completed & joints are sealed properly.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Ensure approved form releasing agent are used on shuttering.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Are test results of reinforcement steel available at site before starting the fabrication work?', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Has the required barricading and safety measures been taken?', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Check the markings are as per drawing.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Is the reinforcement free from oil, mud, grease and other forms of contamination?', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Check the dia , shape of bar, spacing , layers, lapping zone, lap length, development length of beam reinforcement.', 'BEAM', 90),
    (v_i, 'Check for the suffieciency of the chairs to ensure the spacing btw top & bottom mat & the stability of reinforcement.', 'BEAM', 100),
    (v_i, 'Check the placing of primary & secondary beam reinforcement at junctions as per GFC drawings.', 'BEAM', 110),
    (v_i, 'Check the shape, spacing & dimension of stirups are as per drawing in each zone.', 'BEAM', 120),
    (v_i, 'Check the cloumn & wall rings are provided at junctions.', 'BEAM', 130),
    (v_i, 'Check for side face reinforcement if the depth is more. ( if any )', 'BEAM', 140),
    (v_i, 'Check the additional reinforcement for cutouts ( Openings ) & other embeded items .( if any )', 'BEAM', 150),
    (v_i, 'Check the dia & sufficient spacer bars are provided to maintain the uniform reinforcement layers.', 'BEAM', 160),
    (v_i, 'Check for column / wall center line marking as per drawing.', 'BEAM', 170),
    (v_i, 'Check the dia , shape of bar, spacing , rings, lapping zone, lap length, development length of column & wall reinforcement.', 'BEAM', 180),
    (v_i, 'Are cover blocks provided and fixed in a systematically correct manner and as per specifications?', 'BEAM', 190),
    (v_i, 'Check the dowel bars provision with respective details for the further work.', 'BEAM', 200),
    (v_i, 'Check the dia , shape of bar, spacing , layers, lapping zone, lap length, development length of top & bottom reinforcement.', 'SLAB', 210),
    (v_i, 'Check for the suffieciency of the chairs to ensure the spacing btw top & bottom mat & the stability of reinforcement.', 'SLAB', 220),
    (v_i, 'Check the placing of primary & secondary slab reinforcement as per GFC drawings.', 'SLAB', 230),
    (v_i, 'Check the additional reinforcement for cutouts ( Openings ) & other embeded items .( if any )', 'SLAB', 240),
    (v_i, 'Check the reinforcement at sunken area as per details.', 'SLAB', 250),
    (v_i, 'Check the dia & sufficient spacer bars are provided to maintain the uniform reinforcement layers.', 'SLAB', 260),
    (v_i, 'Check the top level of reinforcement ( excluding cover ) of the slab.', 'SLAB', 270),
    (v_i, 'Are cover blocks provided and fixed in a systematically correct manner and as per specifications?', 'SLAB', 280),
    (v_i, 'Check the dowel bars provision with respective details for the further work.', 'SLAB', 290),
    (v_i, 'Check the service works are provided with sufficient spacing & cover.', 'SLAB', 300);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Formwork — slab & beam', 'Formwork — slab & beam', 'hold'::itp_type,
          'Before the next operation', 2100)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Check for reference level marking on all vertical members(1m from FFL)', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Is the staging placed on a hard even surface or on wooden runners if placed directly on the earth ?', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Availability of adequate quantity of shuttering materials ?', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Is approved form releasing agent is being used on the shuttering materials.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Availability of well fastened aluminium ladders to access the work area ?', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Are props and staging given from below perfectly vertical and rigid ?', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Ensure defective shuttering material is not used at site', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Shuttering materials are cleaned and no hardened concrete or slurry on the surface and edges.', 'CHECKS DURING EXECUTION', 100),
    (v_i, 'Is a minimum length of 25% of the base plate/U Jack inserted into the cuplock ?', 'CHECKS DURING EXECUTION', 110),
    (v_i, 'Are the dimensions of formwork according to specifications?', 'CHECKS DURING EXECUTION', 120),
    (v_i, 'Check if the corners of the shutterings are at right angles.', 'CHECKS DURING EXECUTION', 130),
    (v_i, 'Are the U-heads & Base Plates are not extended beyond 300 mm?', 'CHECKS DURING EXECUTION', 140),
    (v_i, 'Ensure vertical supports are provide for acro_spans at the ends', 'CHECKS DURING EXECUTION', 150),
    (v_i, 'Ensure wedges/Bolts are provided for all acrospans', 'CHECKS DURING EXECUTION', 160),
    (v_i, 'Ensure that the dowel holes are covered properly using PVC caps', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Is masking / brown tape fixing done at all the joints before application of form releasing agent', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Is the external line of the formwork maintained using a nylon thread ?', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Ensure there are no gaps visible in beam and column junctions.', 'CHECKS DURING EXECUTION', 200),
    (v_i, 'Are all the services cutouts placed in sunken areas before fixing beam side shuttering ?', 'CHECKS DURING EXECUTION', 210),
    (v_i, 'Ensure that tie-rods are provided if the beam-depth exceeds 600mm.', 'CHECKS DURING EXECUTION', 220),
    (v_i, 'Are the foam strips provided at column junctions to avoid slurry leakage ?', 'CHECKS DURING EXECUTION', 230),
    (v_i, 'Check for level of beams and slabs as per drawing', 'POST EXECUTION CHECKS', 240),
    (v_i, 'Check for the dimension and location of beams as per drawing', 'POST EXECUTION CHECKS', 250),
    (v_i, 'Check for external line of the formwork using a nylon thread', 'POST EXECUTION CHECKS', 260),
    (v_i, 'Check that the formwork is perfectly vertical and plumb.', 'POST EXECUTION CHECKS', 270),
    (v_i, 'Check for adequate supports provided and cross-bracing for props', 'POST EXECUTION CHECKS', 280),
    (v_i, 'Check the beam and column junction supports for rigidness', 'POST EXECUTION CHECKS', 290);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Concreting — slab & beam', 'Concreting — slab & beam', 'witness'::itp_type,
          'During execution', 2110)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Availability of tarpaulin sheet for protection ensured.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Availability of all the tools for concreting on site.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Suitable vibrator, fuel and vibrator needles are available.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Checking of vibrators done before concreting.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Are stand by vibrators and vibrator needles available at site.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Ensure the design Mix of concrete & Raw Materials test results ?', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Is the Mould is clean and oil has applied before concreting.', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Ensured moulds are in level prior to Casting.', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Check for the Shape,size, Cover and Spacing of reinforcement are as per drawing', 'PRE EXECUTION CHECKS', 110),
    (v_i, 'Casting Accessories fixed as specified(Lifting Anchor/GeOmega Sleeve)', 'PRE EXECUTION CHECKS', 120),
    (v_i, 'Is the mould is wet and clean before pouring concrete', 'CHECKS DURING EXECUTION', 130),
    (v_i, 'Ensure the specificd grade of concrete is poured ..', 'CHECKS DURING EXECUTION', 140),
    (v_i, 'Is the slump of the concrete meets the requirements', 'CHECKS DURING EXECUTION', 150),
    (v_i, 'Are all the workers wearing safety gears like gloves, boots, face mask & goggles etc ?', 'CHECKS DURING EXECUTION', 160),
    (v_i, 'Does the concrete look homogenous without segregation, bleeding & have required workability ?', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Ensure Uniform compaction done with suitable vibrators.', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Is the concrete placed and compacted within 3 hours of its mixing ?', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Check for required number of concrete cubes casted for testing on site.', 'CHECKS DURING EXECUTION', 200),
    (v_i, 'Is broom finish done after initial setting time.', 'CHECKS DURING EXECUTION', 210),
    (v_i, 'Is concrete finished for its true line& level?', 'CHECKS DURING EXECUTION', 220),
    (v_i, 'Is curing by moist hessian cloth started as soon as the surface starts drying ?', 'POST EXECUTION CHECKS', 230),
    (v_i, 'Deshuttering done as per the structural consultant recommendations.', 'POST EXECUTION CHECKS', 240),
    (v_i, 'Concrete surfaces not damaged while deshuttering ?', 'POST EXECUTION CHECKS', 250),
    (v_i, 'Check the surfaces after deshuttering for any honeycombs, straight edges & Proper levels.', 'POST EXECUTION CHECKS', 260),
    (v_i, 'Is marking of “Date of Casting” and “Type of Panel” done on panel ?', 'POST EXECUTION CHECKS', 270),
    (v_i, 'Ensure that panels achieved the minimum strength for lifing', 'POST EXECUTION CHECKS', 280),
    (v_i, 'Is lifting rope checked prior to lifting of panels?', 'POST EXECUTION CHECKS', 290),
    (v_i, 'Is panels properly Lifted and Stacked as per guideline and methodology?', 'POST EXECUTION CHECKS', 300);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Concreting — grade slab', 'Concreting — grade slab', 'witness'::itp_type,
          'During execution', 2120)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Check for the proper marking approved by the surveyor & engineer.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Proper lighting arrangement made for concreting during night time.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Availability of all the tools for concreting on site.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Availability of sufficient manpower for concreting on site.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Are stand by vibrators and vibrator needles available at site.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'If the soil is stiff and approved by Structural Consultant, then the excavation done to the size of the footing with sufficient working space.', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Slush removed properly before the start of work ?', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Bull mark/ height indicators fixed properly.', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Proper shuttering provided.', 'PRE EXECUTION CHECKS', 110),
    (v_i, 'Are the shuttering and the reinforcement works complete before concreting ?', 'PRE EXECUTION CHECKS', 120),
    (v_i, 'Ensure the design Mix of concrete & Raw Materials test results ?', 'PRE EXECUTION CHECKS', 130),
    (v_i, 'Are the safety boards concerning excavation work displayed at the site ?', 'PRE EXECUTION CHECKS', 140),
    (v_i, 'Does the concrete look homogenous without segregation, bleeding & have required workability ?', 'CHECKS DURING EXECUTION', 150),
    (v_i, 'Is the concrete placed and compacted within 3 hours of its mixing ?', 'CHECKS DURING EXECUTION', 160),
    (v_i, 'Are all the workers wearing safety gears like gloves, boots, face mask & goggles etc ?', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Uniform compaction using vibrators / straight edge/ wooden runner done.', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Ensure the top level of concrete as per GFC.', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Is curing by sprinkling of water started as soon as the surface starts drying ?', 'POST EXECUTION CHECKS', 200),
    (v_i, 'Is Level of finish checked and concreted when concrete is fresh.', 'POST EXECUTION CHECKS', 210),
    (v_i, 'Availability of all details regarding the expansion and construction joints. Is the surface of the pit even.', 'POST EXECUTION CHECKS', 220),
    (v_i, 'Check for the number of cubes casted as per specification.', 'POST EXECUTION CHECKS', 230);

end $$;

do $$
declare v_t uuid; v_i uuid;
begin
  if exists (select 1 from public.itp_templates
             where lower(btrim(name)) = lower(btrim('Your Masons — Masonry & plaster'))) then
    return;
  end if;

  insert into public.itp_templates (name, description)
  values ('Your Masons — Masonry & plaster', 'The firm’s own on-site inspection checklists.')
  returning id into v_t;

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Block masonry', 'Block masonry', 'hold'::itp_type,
          'Before the next operation', 3010)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'MARKING COARSE', 20),
    (v_i, 'Check the approved blocks , sand and cement are used.', 'MARKING COARSE', 30),
    (v_i, 'Check is the surface preparation has been done before the Start of work.', 'MARKING COARSE', 40),
    (v_i, 'Hacking and splatter dash works have been done & cured properly on all the concrete surfaces where the block work will be coming into Contact.', 'MARKING COARSE', 50),
    (v_i, 'Check is the water used for mortar mixing is potable?', 'MARKING COARSE', 60),
    (v_i, 'Ensure that the blocks are wetted before using them for work.', 'MARKING COARSE', 70),
    (v_i, 'Ensure the block cutting are done using proper tools.', 'MARKING COARSE', 80),
    (v_i, 'Are the dimensions of doors & other openings etc., as per drawing ?', 'MARKING COARSE', 90),
    (v_i, 'Check the dimension of the layout & wall thickness as per drawing.', 'MARKING COARSE', 100),
    (v_i, 'Check the top level & line of the marking coarse.', 'MARKING COARSE', 110),
    (v_i, 'Check the marking course has been approved & cured for a minimum of One day.', 'MARKING COARSE', 120),
    (v_i, 'Check mortar mixing is being done on MS sheets / tray.', 'CHECKS DURING EXECUTION', 130),
    (v_i, 'Is the mortar mix proportion maintained as per specifications Using measurement boxes?', 'CHECKS DURING EXECUTION', 140),
    (v_i, 'Ensure that the mortar is being consumed within 30 minutes of its mixing.', 'CHECKS DURING EXECUTION', 150),
    (v_i, 'A concrete band (1:2:4 concrete) of thickness 100mm, laid with 8mm steel rods embedded inside, after every 1m , for walls of width 100 mm.', 'CHECKS DURING EXECUTION', 160),
    (v_i, 'Are the diagonals of block masonry marking course equal?', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Are corners of the masonry walls at right angles?', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Are the erected masonry walls perfectly line , level & vertical in each course.', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Are the vertical joints of the block masonry being staggered?', 'CHECKS DURING EXECUTION', 200),
    (v_i, 'Are the sizes of the mortar joints uniform and not more than 10 mm.', 'CHECKS DURING EXECUTION', 210),
    (v_i, 'Ensure that the height of construction to be done in a day''s work is not more than 1m.', 'CHECKS DURING EXECUTION', 220),
    (v_i, 'Ensure the concrete Levelling course band is provided at 1m level to maintain the soffit gap thickness less than 20mm.', 'CHECKS DURING EXECUTION', 230),
    (v_i, 'Ensure the dimensions of the lintels used with minimum bearing of 200mm.', 'CHECKS DURING EXECUTION', 240),
    (v_i, 'Are the dimensions of all openings like windows, doors etc. as per requirement ?', 'POST EXECUTION CHECKS', 250),
    (v_i, 'Check for the verticality & top level of the work done.', 'POST EXECUTION CHECKS', 260),
    (v_i, 'Has the mortar joints curing been done for 7 days?', 'POST EXECUTION CHECKS', 270),
    (v_i, 'Check any cracks are observed.', 'POST EXECUTION CHECKS', 280),
    (v_i, 'Has the date of construction been painted on the top most Course of the masonry at the end of day''s work?', 'POST EXECUTION CHECKS', 290);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Internal wall plastering', 'Internal wall plastering', 'witness'::itp_type,
          'During execution', 3020)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Ensure approved cement , sand & potable water are used.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Hacking work for concrete surfaces has been completed as per the required standards.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'All the required GI metal mesh fixing works completed as per standards.', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Has the packing for the electrical conduits & plumbing works completed ?', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Are all the required plastering tools available ?', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Height of the switch boxes are as per requirement.', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Ensure the switch boxes, junction boxes & DB''s are in level & flushed with bull mark.', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'The button marks have been fixed are in perfect line, level, plumb and right angle.', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Distance between the button marks are not beyond 2m in both horizontal and vertical directions.', 'PRE EXECUTION CHECKS', 110),
    (v_i, 'Proper scaffolding has been erected where ever required.', 'PRE EXECUTION CHECKS', 120),
    (v_i, 'Ensure GI Corner bead fixing done in plumb & flush with bull marks.', 'PRE EXECUTION CHECKS', 130),
    (v_i, 'The surface to be plastered is wet, free from dust, oil & all forms of contaminations.', 'PRE EXECUTION CHECKS', 140),
    (v_i, 'Switch boxes are covered by dummy plates or thermocoal sheets / sand.', 'PRE EXECUTION CHECKS', 150),
    (v_i, 'Ensure Ceiling plastering has been completed.', 'PRE EXECUTION CHECKS', 160),
    (v_i, 'Mortar mixing proportion as per specification done on MS sheets using measurement batch boxes.', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Is the wall plaster started from ceiling', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Are the corners finished with special care using straight edge.', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Are PVC rings fixed at electrical junctions boxes?', 'CHECKS DURING EXECUTION', 200),
    (v_i, 'Ensure wet mortar being consumed with in 30 to 45 minutes of its preparation.', 'CHECKS DURING EXECUTION', 210),
    (v_i, 'Ensure the plastered surface is properly cut for skirting.', 'CHECKS DURING EXECUTION', 220),
    (v_i, 'Are the sill and lintel levels according to the specifications?', 'CHECKS DURING EXECUTION', 230),
    (v_i, 'Check the openings with suitable aluminium templates.', 'CHECKS DURING EXECUTION', 240),
    (v_i, 'Check the proper cut are made at joints at the end of the day work.', 'CHECKS DURING EXECUTION', 250),
    (v_i, 'Are all the switch boxes, junction boxes & DB''s in proper position & finished properly.', 'POST EXECUTION CHECKS', 260),
    (v_i, 'Check the plastered finish is as per requirement (rough, smooth etc) ?', 'POST EXECUTION CHECKS', 270),
    (v_i, 'The plastered surface is level and neat without any undulations cracks.', 'POST EXECUTION CHECKS', 280),
    (v_i, 'Check the mortar spillage cleaned thoroughly?', 'POST EXECUTION CHECKS', 290),
    (v_i, 'The button mark tiles have been removed after plastering.', 'POST EXECUTION CHECKS', 300),
    (v_i, 'Check the curing is done for minimum 7 days for plastered surface.', 'POST EXECUTION CHECKS', 310),
    (v_i, 'Has the date of plastering painted on the plastered surface ?', 'POST EXECUTION CHECKS', 320);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'Internal ceiling plastering', 'Internal ceiling plastering', 'witness'::itp_type,
          'During execution', 3030)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Ensure approved cement , sand & potable water are used.', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Hacking work for concrete surfaces has been completed as per the required standards.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Are all the required plastering tools available ?', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'The button marks have been fixed are in perfect line, level, plumb and right angle.', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Distance between the button marks are not beyond 2m in both horizontal and vertical directions.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Proper scaffolding has been erected where ever required.', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'The surface to be plastered is wet, free from dust, oil & all forms of contaminations.', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Switch boxes are covered by dummy plates or thermocoal sheets / sand.', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Mortar mixing proportion as per specification done on MS sheets using measurement batch boxes.', 'CHECKS DURING EXECUTION', 110),
    (v_i, 'Are PVC rings fixed at electrical junctions boxes?', 'CHECKS DURING EXECUTION', 120),
    (v_i, 'Ensure wet mortar being consumed with in 30 to 45 minutes of its preparation.', 'CHECKS DURING EXECUTION', 130),
    (v_i, 'Check the proper cut are made at joints at the end of the day work.', 'CHECKS DURING EXECUTION', 140),
    (v_i, 'Are all the junction boxes in proper position & finished properly.', 'POST EXECUTION CHECKS', 150),
    (v_i, 'Check the plastered finish is as per requirement (rough, smooth etc) ?', 'POST EXECUTION CHECKS', 160),
    (v_i, 'The plastered surface is level and neat without any undulations cracks.', 'POST EXECUTION CHECKS', 170),
    (v_i, 'Check the mortar spillage cleaned thoroughly?', 'POST EXECUTION CHECKS', 180),
    (v_i, 'The button mark tiles have been removed after plastering.', 'POST EXECUTION CHECKS', 190),
    (v_i, 'Check the curing is done for minimum 7 days for plastered surface.', 'POST EXECUTION CHECKS', 200),
    (v_i, 'Has the date of plastering painted on the plastered surface ?', 'POST EXECUTION CHECKS', 210);

  insert into public.itp_template_items
    (template_id, stage, description, inspection_type, required_by_stage, sort_order)
  values (v_t, 'External plastering', 'External plastering', 'witness'::itp_type,
          'During execution', 3040)
  returning id into v_i;
  insert into public.itp_template_checks (template_item_id, question, section, sort_order) values
    (v_i, 'Name, date and number of the drawing.', null, 10),
    (v_i, 'Check the availability of the latest relevant GFC drawings.', 'PRE EXECUTION CHECKS', 20),
    (v_i, 'Ensure the Cement & sand is approved to use', 'PRE EXECUTION CHECKS', 30),
    (v_i, 'Ensure the Packing of last coarse of masonry below the beam and electrical conduits & pipe setting chasings are done. If any.', 'PRE EXECUTION CHECKS', 40),
    (v_i, 'Check the Center line and alignment of windows/Ventilators is found correct, and ensure the corrections are made if any,', 'PRE EXECUTION CHECKS', 50),
    (v_i, 'Check the Hacking work for concrete surfaces has been completed', 'PRE EXECUTION CHECKS', 60),
    (v_i, 'Check all the GI metal mesh fixing works completed in the required places and sufficiently cured.', 'PRE EXECUTION CHECKS', 70),
    (v_i, 'Ensure the Distance between the button marks not beyond 2m in both horizontal and vertical directions.', 'PRE EXECUTION CHECKS', 80),
    (v_i, 'Check the button marks are in plumb, line & right angle.', 'PRE EXECUTION CHECKS', 90),
    (v_i, 'Is the Proper scaffolding and platforms made for the workforce ?', 'PRE EXECUTION CHECKS', 100),
    (v_i, 'Check the required chipping works done in case of any Bulged portions,', 'PRE EXECUTION CHECKS', 110),
    (v_i, 'Is the surface to be plastered is wet enough and free from dust, oil & all forms of contamination hich affects the bonding,', 'PRE EXECUTION CHECKS', 120),
    (v_i, 'Ensure protruded bars are cut and tie rod holes are packed properly with GP2', 'PRE EXECUTION CHECKS', 130),
    (v_i, 'Check the Mortar mixing is followed proportion as per specification (1:6) done on MS sheets / tray using measurement batch boxes.', 'CHECKS DURING EXECUTION', 140),
    (v_i, 'Check for Waterproofing chemical (Fosroc - Conplast 421 IC) added to the plastering mortar while mixing for the water resistance (125 ml / 50 KG of Cement)', 'CHECKS DURING EXECUTION', 150),
    (v_i, 'Is the1st coat of plastering properly roughened and cured for 3-5 days, before receiving next coat', 'CHECKS DURING EXECUTION', 160),
    (v_i, 'Check all the corners in line & finished properly.', 'CHECKS DURING EXECUTION', 170),
    (v_i, 'Is the plastering work done in Multiple layers with Mesh, if the thickness is more than Limit ?', 'CHECKS DURING EXECUTION', 180),
    (v_i, 'Are the plaster grooves made in the fresh mortar surface ?', 'CHECKS DURING EXECUTION', 190),
    (v_i, 'Are the grooves in the plaster are perfectly in level and plumb?', 'CHECKS DURING EXECUTION', 200),
    (v_i, 'Is the top and bottom level of all the chejjas in one floor are same and aligned in a straight line ?', 'CHECKS DURING EXECUTION', 210),
    (v_i, 'Check all the Window and other opening Jambs are finished properly to the Required size, Line, Level & Plumb and Matched with Internal plastering finishing', 'CHECKS DURING EXECUTION', 220),
    (v_i, 'Is plastering of band below sill projection done with proper finish.', 'CHECKS DURING EXECUTION', 230),
    (v_i, 'Check for the drip moulds provided & finishes properly at all openings.', 'POST EXECUTION CHECKS', 240),
    (v_i, 'Ensure the curing of the plastered surfaces done for at least 7 days.', 'POST EXECUTION CHECKS', 250),
    (v_i, 'Check all the mortar spillage been cleaned properly,', 'POST EXECUTION CHECKS', 260),
    (v_i, 'Check all the tiles pieces used for the bull marks been removed after plastering,', 'POST EXECUTION CHECKS', 270),
    (v_i, 'Check the plastered surface is in perfect level and neat without any undulations or cracks,', 'POST EXECUTION CHECKS', 280),
    (v_i, 'Check the date of plastering painted on the wall to monitor the curing,', 'POST EXECUTION CHECKS', 290),
    (v_i, 'Is the Grooves and the Bands are provided as specified by architect,', 'POST EXECUTION CHECKS', 300),
    (v_i, 'Check the work executed is in conformance with the architect''s elevation drawings.', 'POST EXECUTION CHECKS', 310);

end $$;


-- ############################################################
-- ###  5. RECORD AN INSPECTION — carrying location and section
-- ############################################################
-- Re-emitted from 045 with `p_location` and the section snapshot. The 045
-- arity is dropped first, or the two become ambiguous (the 035 trap).
drop function if exists public.fn_record_inspection(uuid, text, date, text, text[], jsonb);

create or replace function public.fn_record_inspection(
  p_item     uuid,
  p_result   text,
  p_date     date    default null,
  p_remarks  text    default null,
  p_photos   text[]  default '{}',
  p_checks   jsonb   default '[]'::jsonb,
  p_location text    default null
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

  select count(*) into v_expected from public.itp_checks where itp_item_id = p_item;
  v_answered := jsonb_array_length(coalesce(p_checks, '[]'::jsonb));

  if v_expected > 0 and v_answered < v_expected then
    raise exception
      '% of % checks answered. A checklist with blanks records an interruption, not an inspection.',
      v_answered, v_expected;
  end if;

  select count(*) into v_fails
  from jsonb_array_elements(coalesce(p_checks, '[]'::jsonb)) e
  where e ->> 'result' = 'fail';

  if v_answered = 0 then
    v_final := p_result;
  elsif v_fails > 0 then
    v_final := case when p_result = 'conditional' then 'conditional' else 'fail' end;
  else
    v_final := 'pass';
  end if;

  insert into public.inspections
    (itp_item_id, project_id, inspected_on, result, remarks, photos, location, inspector)
  values
    (p_item, v_project,
     coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date),
     v_final::inspection_result,
     nullif(btrim(coalesce(p_remarks, '')), ''),
     coalesce(p_photos, '{}'),
     nullif(btrim(coalesce(p_location, '')), ''),
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

  for c in select * from jsonb_array_elements(coalesce(p_checks, '[]'::jsonb))
  loop
    v_i := v_i + 1;
    v_ncr := null;

    if (c ->> 'result') = 'fail' then
      insert into public.ncrs
        (project_id, itp_item_id, inspection_id, area, description, severity,
         standard_ref, photos, raised_by)
      values
        (v_project, p_item, v_insp,
         coalesce(nullif(btrim(coalesce(p_location, '')), ''),
                  nullif(btrim(v_stage), ''), 'Not stated'),
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
      (inspection_id, itp_check_id, question, section, result, remark, photos,
       ncr_id, sort_order)
    values
      (v_insp,
       nullif(c ->> 'check_id', '')::uuid,
       coalesce(nullif(btrim(coalesce(c ->> 'question', '')), ''), 'Question not recorded'),
       nullif(btrim(coalesce(c ->> 'section', '')), ''),
       (c ->> 'result')::check_result,
       nullif(btrim(coalesce(c ->> 'remark', '')), ''),
       coalesce(
         (select array_agg(value #>> '{}')
          from jsonb_array_elements(coalesce(c -> 'photos', '[]'::jsonb))),
         '{}'),
       v_ncr,
       v_i * 10);
  end loop;

  if v_answered = 0 and v_final in ('fail', 'conditional') then
    insert into public.ncrs
      (project_id, itp_item_id, inspection_id, area, description, severity,
       standard_ref, photos, raised_by)
    values
      (v_project, p_item, v_insp,
       coalesce(nullif(btrim(coalesce(p_location, '')), ''),
                nullif(btrim(v_stage), ''), 'Not stated'),
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
  public.fn_record_inspection(uuid, text, date, text, text[], jsonb, text)
  from public, anon;
grant execute on function
  public.fn_record_inspection(uuid, text, date, text, text[], jsonb, text)
  to authenticated;


-- Section comes back with the answers, so a completed record reads like the
-- form it was filled from.
drop function if exists public.fn_inspection_checks(uuid);
create function public.fn_inspection_checks(p_inspection uuid)
returns table (
  id        uuid,
  question  text,
  section   text,
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
  select ic.id, ic.question, ic.section, ic.result::text, ic.remark, ic.photos, n.ncr_no
  from public.inspection_checks ic
  left join public.ncrs n on n.id = ic.ncr_id
  where ic.inspection_id = p_inspection
  order by ic.sort_order;
$$;

revoke all on function public.fn_inspection_checks(uuid) from public, anon;
grant execute on function public.fn_inspection_checks(uuid) to authenticated;


-- ############################################################
-- ###  6. VERIFY
-- ############################################################
-- Expect the three firm templates, 20 points, 500 questions.
select t.name, count(distinct ti.id) as points, count(c.id) as questions
from public.itp_templates t
join public.itp_template_items ti on ti.template_id = t.id
left join public.itp_template_checks c on c.template_item_id = ti.id
where t.name like 'Your Masons%'
group by t.name
order by t.name;

select count(*) as firm_questions
from public.itp_template_checks c
join public.itp_template_items ti on ti.id = c.template_item_id
join public.itp_templates t on t.id = ti.template_id
where t.name like 'Your Masons%';

-- Expect exactly ONE arity for each (the 035 trap).
select proname, count(*) from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_record_inspection', 'fn_inspection_checks')
group by proname;
