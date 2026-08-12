-- ============================================================
-- MASON OS — Migration 047: repair after 045 aborted
--
-- 045 failed in production at its last function:
--
--   ERROR: 42P13: cannot change return type of existing function
--   HINT:  Use DROP FUNCTION fn_inspection_checks(uuid) first.
--
-- My bug. `fn_inspection_checks` was written with `create or replace`, and 046
-- widens its return type by one column — `create or replace` cannot do that.
-- 045 has been corrected in the repo for any future rebuild; this migration
-- repairs the database that already ran it.
--
-- ---------- WHAT THE ABORT LEFT BEHIND ----------
-- Two things, and the first is the dangerous one:
--
--   1. TWO arities of `fn_record_inspection`. 046's verify reported it, which
--      is exactly why that check is in every migration that re-emits a
--      function (the 035 lesson). With two overloads a PostgREST call by name
--      is ambiguous and fails at run time, so the app cannot record an
--      inspection at all until one is removed.
--
--   2. 045's seeded checklists never ran — the seed block sits AFTER the
--      statement that failed. Those 127 questions are re-seeded below, and
--      skipped per point where questions already exist, so a point the founder
--      has since edited is left alone.
--
-- Everything here is idempotent and safe to run twice.
-- ============================================================


-- ############################################################
-- ###  1. ONE ARITY OF fn_record_inspection, NOT THREE
-- ############################################################
-- Drop every earlier signature by name. The 7-argument version from 046 is the
-- live one and is deliberately NOT dropped.
--   043: (uuid, text, date, text, text[])
--   045: (uuid, text, date, text, text[], jsonb)
drop function if exists public.fn_record_inspection(uuid, text, date, text, text[]);
drop function if exists public.fn_record_inspection(uuid, text, date, text, text[], jsonb);


-- ############################################################
-- ###  2. fn_inspection_checks AT ITS 046 SHAPE
-- ############################################################
-- Drop-then-create, unconditionally, so it does not matter which of 045 or 046
-- managed to define it or with how many columns.
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
-- ###  3. BELT AND BRACES ON 045's COLUMNS
-- ############################################################
-- 046 added these; repeated here in case 045's abort took its own tables with
-- it and 046 was run against a partially-built schema.
alter table public.itp_template_checks add column if not exists section text;
alter table public.itp_checks          add column if not exists section text;
alter table public.inspection_checks   add column if not exists section text;
alter table public.inspections         add column if not exists location text;


-- ############################################################
-- ###  4. RE-SEED 045's CHECKLISTS ON THE 044 TEMPLATES
-- ############################################################
-- Identical to 045's seed. Attaches by template name + point description, so it
-- is a no-op where 044 was never run, and skips any point that already has
-- questions — a founder's edits are never overwritten.
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
drop function if exists public.fn_seed_itp_checks(text, text, text[]);


-- ############################################################
-- ###  5. VERIFY
-- ############################################################
-- Expect ONE row each. Two on fn_record_inspection means the drop above missed
-- a signature and the app still cannot record an inspection.
select proname, count(*) as arities from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_record_inspection', 'fn_inspection_checks')
group by proname
order by proname;

-- The live signature: expect the 7-argument form.
select pg_get_function_identity_arguments(oid) as signature
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'fn_record_inspection';

-- Expect 127 across 20 of the IS template points…
select count(*) as is_template_questions
from public.itp_template_checks c
join public.itp_template_items ti on ti.id = c.template_item_id
join public.itp_templates t on t.id = ti.template_id
where t.name like 'IS %';

-- …and 500 across the firm's own 20.
select count(*) as firm_questions
from public.itp_template_checks c
join public.itp_template_items ti on ti.id = c.template_item_id
join public.itp_templates t on t.id = ti.template_id
where t.name like 'Your Masons%';

-- Every template, for a final look.
select t.name, count(distinct ti.id) as points, count(c.id) as questions
from public.itp_templates t
left join public.itp_template_items ti on ti.template_id = t.id
left join public.itp_template_checks c on c.template_item_id = ti.id
group by t.name
order by t.name;
