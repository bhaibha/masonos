-- ============================================================
-- MASON OS — Migration 044: seeded IS-referenced ITP templates
--
-- Five firm-level inspection plans, one per discipline, so a project takes
-- only the ones it needs: a job where a consultant owns the MEP applies the
-- other four and leaves that one alone. Apply several and their points sit
-- side by side in the same plan.
--
--   IS — Structural / RCC       15 points
--   IS — Masonry and plaster     9
--   IS — Waterproofing           7
--   IS — Finishes                9
--   IS — MEP services           12
--                               52
--
-- ---------- WHAT IS AND IS NOT IN HERE ----------
-- Indian Standards are copyrighted and sold by BIS. Nothing below reproduces
-- clause text, tables or limits from any standard. What each point carries is:
--
--   * the standard's NUMBER and TITLE — facts, and the normal way an ITP
--     cites its basis;
--   * an acceptance criterion written from scratch for this app, phrased as
--     "as specified" or "per drawing" wherever the actual limit lives in the
--     standard or the project specification.
--
-- That is deliberate and it is also how a real ITP reads. "Cover to
-- reinforcement as per drawing and IS 456" is the instruction a site engineer
-- works to; a transcription of the clause would be both an infringement and
-- less useful, because the binding number is on the drawing.
--
-- **The site engineer still needs the standard.** These points tell you WHAT
-- to check and WHERE the requirement comes from; the firm's own copies of the
-- codes and the project specification tell you the value to check against.
--
-- Every standard number and title below was verified against BIS listings and
-- public sources on 2026-08-11. Where a revision year is quoted it is the
-- revision current at that date. FIVE points — door and window frames, shutters
-- and hardware, false ceilings and the two HVAC points — carry NO standard
-- reference, because none was verified for them in that pass. Blank is the
-- honest state; fill them in from your own practice rather than assuming the
-- field was forgotten.
--
-- ---------- HOLD POINTS ----------
-- Nineteen of the 52 are holds, and they are the ones where the next stage
-- buries the evidence: reinforcement and formwork before a pour, deshuttering,
-- both ponding tests, the concealed-water pressure test, earthing, wall
-- junctions and plaster preparation, tiling setting-out, paint preparation.
-- Everything else is a witness or a review. A plan where everything is a hold
-- stops being a plan and becomes an obstacle, and site teams route around
-- obstacles.
-- ---------- APPLYING ----------
-- `fn_apply_itp_template` COPIES these onto a project. Editing a template here
-- never restates an inspection already signed off on a live job, and a founder
-- editing the firm's standard does not rewrite history.
--
-- Re-runnable: the template insert is `on conflict do nothing` on the
-- normalised-name index, and the points are seeded only when the template has
-- none — so a second run neither duplicates them nor overwrites edits.
-- ============================================================


-- ############################################################
-- ###  1. A SEEDED TEMPLATE HAS NO AUTHOR
-- ############################################################
-- `created_by` defaults to auth.uid(), which is NULL in the SQL editor — the
-- seed would fail the NOT NULL. It is also true: nobody in the firm wrote
-- these, they shipped with the app. Null says that.
alter table public.itp_templates alter column created_by drop not null;


-- ############################################################
-- ###  2. THE TEMPLATES
-- ############################################################

-- ---------------------------------------------------------------
do $$
declare v_id uuid;
begin
  insert into public.itp_templates (name, description)
  values ('IS — Structural / RCC', 'Reinforced concrete from materials through pour to deshuttering. Built around IS 456:2000.')
  on conflict (lower(btrim(name))) do nothing;

  select id into v_id from public.itp_templates
  where lower(btrim(name)) = lower(btrim('IS — Structural / RCC'));

  -- Only seed the points if this template has none. A second run must not
  -- duplicate them, and must not fight a founder who has edited the list.
  if v_id is not null and not exists (
    select 1 from public.itp_template_items where template_id = v_id
  ) then
    insert into public.itp_template_items
      (template_id, stage, description, acceptance_criteria, inspection_type,
       reference_standard, required_by_stage, sort_order)
    values
      (v_id, 'Materials', 'Cement test certificate and storage', 'Manufacturer''s test certificate held for each consignment; cement within shelf life; bags stacked clear of the ground and protected from damp.', 'review'::itp_type, 'IS 269:2015 — Ordinary Portland Cement (Specification)', 'Before first pour', 1010),
      (v_id, 'Materials', 'Reinforcement mill certificate and identification', 'Mill certificate for each lot; bar grade and diameter match the drawing; no pitting, oil or loose scale.', 'review'::itp_type, 'IS 1786:2008 — High Strength Deformed Steel Bars and Wires for Concrete Reinforcement (Specification)', 'Before cutting', 1020),
      (v_id, 'Materials', 'Aggregate grading, silt and deleterious content', 'Grading, silt content and deleterious limits within the specification for the approved source.', 'review'::itp_type, 'IS 383:2016 — Coarse and Fine Aggregate for Concrete (Specification); tests to IS 2386', 'Before first pour', 1030),
      (v_id, 'Materials', 'Concrete mix design approval', 'Trial mix and design approved for the specified grade, workability and exposure condition.', 'review'::itp_type, 'IS 10262 — Concrete Mix Proportioning (Guidelines), with IS 456:2000', 'Before first pour', 1040),
      (v_id, 'Foundation', 'Excavation level, bearing strata and dimensions', 'Founding level and strata agree with the geotechnical report and drawing; base clear of loose soil and standing water; sides safe.', 'hold'::itp_type, 'IS 456:2000 — Plain and Reinforced Concrete (Code of Practice)', 'Before PCC', 1050),
      (v_id, 'Foundation', 'Anti-termite pre-construction treatment', 'Chemical, concentration and coverage applied over the full treated area; treatment record signed and retained.', 'witness'::itp_type, 'IS 6313 (Part 2):2022 — Anti-Termite Measures in Buildings: Pre-constructional Chemical Treatment', 'Before PCC and backfill', 1060),
      (v_id, 'Substructure', 'PCC level, thickness and surface', 'Thickness and top level within tolerance; surface clean and true before reinforcement is placed.', 'witness'::itp_type, 'IS 456:2000', 'Before footing steel', 1070),
      (v_id, 'Reinforcement', 'Bar bending schedule against drawing', 'Cut lengths, bends, hooks and laps agree with the approved BBS and drawing; bending done cold, no heating.', 'review'::itp_type, 'IS 2502:1963 — Bending and Fixing of Bars for Concrete Reinforcement (Code of Practice)', 'Before fixing', 1080),
      (v_id, 'Reinforcement', 'REINFORCEMENT BEFORE CONCRETING', 'Diameter, spacing, number, laps, development length, cover blocks, chairs and cleanliness as per drawing; embedded items and sleeves in place; area free of debris and tying wire.', 'hold'::itp_type, 'IS 456:2000; seismic detailing to IS 13920:2016 where applicable', 'Before every pour', 1090),
      (v_id, 'Formwork', 'Formwork alignment, props and release agent', 'Line, level, plumb and camber within tolerance; props and bracing adequate; joints sealed against grout loss; release agent applied.', 'hold'::itp_type, 'IS 456:2000', 'Before every pour', 1100),
      (v_id, 'Concreting', 'Slump and cube sampling at the pour', 'Slump within the approved range; cubes cast, marked and cured to the required sampling frequency; batch records retained.', 'witness'::itp_type, 'IS 1199 (Part 1):2018 — Fresh Concrete: Sampling; IS 516 (Part 1):2021 — Hardened Concrete: Methods of Test', 'At every pour', 1110),
      (v_id, 'Concreting', 'Placing, compaction and construction joints', 'Free-fall height and layer thickness controlled; vibration adequate with no segregation; construction joint position and treatment as approved.', 'witness'::itp_type, 'IS 456:2000', 'During pour', 1120),
      (v_id, 'Curing', 'Curing method and duration', 'Curing begun within the specified time and continued for the full duration required for the cement type used.', 'witness'::itp_type, 'IS 456:2000', 'From pour', 1130),
      (v_id, 'Testing', 'Cube results at 7 and 28 days', '7-day and 28-day compressive strengths meet the acceptance criteria for the specified grade.', 'review'::itp_type, 'IS 516 (Part 1):2021, with the acceptance criteria of IS 456:2000', 'Before loading or the next lift', 1140),
      (v_id, 'Formwork', 'Deshuttering after minimum stripping time', 'Stripping time and strength satisfied for the member type; back-props retained where required.', 'hold'::itp_type, 'IS 456:2000', 'Before deshuttering', 1150);
  end if;
end $$;

-- ---------------------------------------------------------------
do $$
declare v_id uuid;
begin
  insert into public.itp_templates (name, description)
  values ('IS — Masonry and plaster', 'Blockwork, brickwork and internal or external plaster.')
  on conflict (lower(btrim(name))) do nothing;

  select id into v_id from public.itp_templates
  where lower(btrim(name)) = lower(btrim('IS — Masonry and plaster'));

  -- Only seed the points if this template has none. A second run must not
  -- duplicate them, and must not fight a founder who has edited the list.
  if v_id is not null and not exists (
    select 1 from public.itp_template_items where template_id = v_id
  ) then
    insert into public.itp_template_items
      (template_id, stage, description, acceptance_criteria, inspection_type,
       reference_standard, required_by_stage, sort_order)
    values
      (v_id, 'Materials', 'Block or brick sample approval and test certificate', 'Dimensions, compressive strength and water absorption to the specification; approved sample retained on site.', 'review'::itp_type, 'IS 2185 (Part 1):2005 — Concrete Masonry Units: Hollow and Solid Concrete Blocks; IS 2185 (Part 3):1984 for autoclaved aerated blocks', 'Before first course', 2010),
      (v_id, 'Masonry', 'Setting out, line, level and plumb of the first course', 'Wall lines, opening positions and wall thickness per drawing; first course true and level.', 'hold'::itp_type, 'IS 2212:1991 — Brick Works (Code of Practice); IS 1905:1987 for structural masonry', 'Before building up', 2020),
      (v_id, 'Masonry', 'Mortar proportion and mixing', 'Proportion as specified and measured by box or machine; mortar used within its working time; no retempering.', 'witness'::itp_type, 'IS 2212:1991', 'During masonry', 2030),
      (v_id, 'Masonry', 'Joint thickness, bond and wetting of units', 'Joints uniform and fully filled; bond pattern as specified; units wetted appropriately for the type used.', 'witness'::itp_type, 'IS 2212:1991', 'During masonry', 2040),
      (v_id, 'Masonry', 'Lintels, sills and sunshades — bearing and level', 'Bearing length, level and reinforcement per drawing; propping retained until cured.', 'witness'::itp_type, 'IS 456:2000', 'Before plaster', 2050),
      (v_id, 'Masonry', 'Wall-to-column junctions, mesh and chases', 'Mesh lapped across junctions and chases; chases cut rather than broken; service boxes fixed before plaster.', 'hold'::itp_type, 'IS 1661 — Application of Cement and Cement-Lime Plaster Finishes (Code of Practice)', 'Before plaster', 2060),
      (v_id, 'Plaster', 'Surface preparation, hacking and dampening', 'Surface sound, cleaned, hacked where required and dampened; loose mortar removed; level dots and screeds fixed.', 'hold'::itp_type, 'IS 1661', 'Before plaster', 2070),
      (v_id, 'Plaster', 'Plaster thickness, level and finish', 'Thickness within specification; surface plumb and true; no cracks and no hollowness on tapping.', 'witness'::itp_type, 'IS 1661', 'Before putty or tiling', 2080),
      (v_id, 'Plaster', 'Plaster curing', 'Cured for the specified period; no premature drying, crazing or shrinkage cracking.', 'witness'::itp_type, 'IS 1661', 'After plaster', 2090);
  end if;
end $$;

-- ---------------------------------------------------------------
do $$
declare v_id uuid;
begin
  insert into public.itp_templates (name, description)
  values ('IS — Waterproofing', 'Wet areas, terraces and below-ground damp-proofing, including the ponding tests.')
  on conflict (lower(btrim(name))) do nothing;

  select id into v_id from public.itp_templates
  where lower(btrim(name)) = lower(btrim('IS — Waterproofing'));

  -- Only seed the points if this template has none. A second run must not
  -- duplicate them, and must not fight a founder who has edited the list.
  if v_id is not null and not exists (
    select 1 from public.itp_template_items where template_id = v_id
  ) then
    insert into public.itp_template_items
      (template_id, stage, description, acceptance_criteria, inspection_type,
       reference_standard, required_by_stage, sort_order)
    values
      (v_id, 'Preparation', 'Substrate preparation and falls', 'Surface sound, clean and free of laitance; falls set towards outlets; corners rounded and coving formed.', 'hold'::itp_type, 'IS 3067:1988 — General Design Details and Preparatory Work for Damp-Proofing and Water-Proofing of Buildings', 'Before treatment', 3010),
      (v_id, 'Preparation', 'Outlets, penetrations and junction detailing', 'Sleeves fixed, penetrations sealed and junctions detailed before any membrane is applied.', 'hold'::itp_type, 'IS 3067:1988', 'Before treatment', 3020),
      (v_id, 'Materials', 'Waterproofing material approval and batch record', 'Product, batch number and shelf life checked against the approved system; manufacturer''s data sheet retained.', 'review'::itp_type, 'IS 2645:2003 — Integral Waterproofing Compounds for Cement Mortar and Concrete (Specification)', 'Before treatment', 3030),
      (v_id, 'Application', 'Membrane or coating — coats, coverage and overlaps', 'Number of coats, coverage rate and lap widths per the approved system; no pinholes, blisters or debonding.', 'witness'::itp_type, 'IS 1346:1991 — Waterproofing of Roofs with Bitumen Felts (Code of Practice) for felt systems', 'During application', 3040),
      (v_id, 'Testing', 'WET-AREA PONDING TEST', 'Area ponded for the specified period with no drop in water level and no seepage to the soffit or adjacent areas.', 'hold'::itp_type, 'IS 3067:1988', 'Before screed and tiling', 3050),
      (v_id, 'Testing', 'TERRACE PONDING TEST', 'Terrace ponded for the specified period; no leakage at the soffit, the parapet junction or the outlets.', 'hold'::itp_type, 'IS 3067:1988', 'Before weathering course', 3060),
      (v_id, 'Protection', 'Protective screed over the membrane', 'Screed laid without damaging the membrane; falls to outlets maintained after screeding.', 'witness'::itp_type, 'IS 3067:1988', 'Before tiling', 3070);
  end if;
end $$;

-- ---------------------------------------------------------------
do $$
declare v_id uuid;
begin
  insert into public.itp_templates (name, description)
  values ('IS — Finishes', 'Tiling, flooring, joinery, painting and false ceilings.')
  on conflict (lower(btrim(name))) do nothing;

  select id into v_id from public.itp_templates
  where lower(btrim(name)) = lower(btrim('IS — Finishes'));

  -- Only seed the points if this template has none. A second run must not
  -- duplicate them, and must not fight a founder who has edited the list.
  if v_id is not null and not exists (
    select 1 from public.itp_template_items where template_id = v_id
  ) then
    insert into public.itp_template_items
      (template_id, stage, description, acceptance_criteria, inspection_type,
       reference_standard, required_by_stage, sort_order)
    values
      (v_id, 'Materials', 'Tile sample approval, batch and shade', 'Size, thickness, water absorption and shade match the approved sample; one batch per area wherever possible.', 'review'::itp_type, 'IS 15622:2017 — Pressed Ceramic Tiles (Specification)', 'Before laying', 4010),
      (v_id, 'Tiling', 'Setting out, levels and joint layout', 'Setting-out lines, falls in wet areas, joint width and cut-tile positions agreed before laying begins.', 'hold'::itp_type, 'IS 15622:2017', 'Before laying', 4020),
      (v_id, 'Tiling', 'Bedding, hollowness and grouting', 'Full bedding with no hollowness on tapping; joints uniform; grouting only after the bed has set.', 'witness'::itp_type, 'IS 15622:2017', 'Before grouting', 4030),
      (v_id, 'Flooring', 'In-situ cement concrete flooring — thickness and finish', 'Thickness, level and surface finish within tolerance; joints positioned per drawing.', 'witness'::itp_type, 'IS 2571:1970 — Laying In-Situ Cement Concrete Flooring (Code of Practice)', 'Before handover', 4040),
      (v_id, 'Joinery', 'Door and window frames — plumb, level and holdfasts', 'Frames plumb, square and fixed with the specified holdfasts; gaps grouted solid; protection applied.', 'witness'::itp_type, null, 'Before shutters', 4050),
      (v_id, 'Joinery', 'Shutters, hardware and operation', 'Shutters aligned with uniform gaps; hardware complete and operating freely; no sagging or binding.', 'witness'::itp_type, null, 'Before painting', 4060),
      (v_id, 'Painting', 'Surface preparation and primer', 'Surface dry, sanded and dust-free; moisture content within the paint system''s limit; primer applied evenly.', 'hold'::itp_type, 'IS 2395 (Part 2):1994 — Painting Concrete, Masonry and Plaster Surfaces: Schedules', 'Before finish coats', 4070),
      (v_id, 'Painting', 'Finish coats — number, shade and evenness', 'Coats as specified; shade matches the approved sample; no brush marks, patches, runs or missed areas.', 'witness'::itp_type, 'IS 2395 (Part 2):1994', 'Before handover', 4080),
      (v_id, 'Finishes', 'False ceiling — level, framing and access', 'Hanger and framing spacing as specified; level within tolerance; access panels at every serviceable point.', 'witness'::itp_type, null, 'Before painting', 4090);
  end if;
end $$;

-- ---------------------------------------------------------------
do $$
declare v_id uuid;
begin
  insert into public.itp_templates (name, description)
  values ('IS — MEP services', 'Electrical, plumbing and HVAC, including the earthing and pressure tests.')
  on conflict (lower(btrim(name))) do nothing;

  select id into v_id from public.itp_templates
  where lower(btrim(name)) = lower(btrim('IS — MEP services'));

  -- Only seed the points if this template has none. A second run must not
  -- duplicate them, and must not fight a founder who has edited the list.
  if v_id is not null and not exists (
    select 1 from public.itp_template_items where template_id = v_id
  ) then
    insert into public.itp_template_items
      (template_id, stage, description, acceptance_criteria, inspection_type,
       reference_standard, required_by_stage, sort_order)
    values
      (v_id, 'Electrical', 'Conduit layout, chase depth and boxes', 'Conduit runs, bends and box positions per drawing; chase depth within the permitted limit; conduits secured before plaster.', 'hold'::itp_type, 'IS 732:2019 — Electrical Wiring Installations (Code of Practice)', 'Before plaster', 5010),
      (v_id, 'Electrical', 'Wiring — size, colour code and continuity', 'Cable sizes and colour coding per drawing; no joints inside conduit; continuity confirmed circuit by circuit.', 'witness'::itp_type, 'IS 732:2019', 'Before boards', 5020),
      (v_id, 'Electrical', 'Distribution board — layout, labelling and protection', 'Circuits labelled; ratings per the approved single-line diagram; protective devices as specified.', 'witness'::itp_type, 'IS 732:2019', 'Before energising', 5030),
      (v_id, 'Electrical', 'EARTHING — electrodes, conductors and resistance', 'Electrode type and depth and conductor sizes as designed; earth resistance measured and recorded within the specified limit.', 'hold'::itp_type, 'IS 3043 — Earthing (Code of Practice)', 'Before energising', 5040),
      (v_id, 'Electrical', 'Insulation resistance and circuit testing', 'Insulation resistance and polarity tested circuit by circuit; results recorded and retained.', 'hold'::itp_type, 'IS 732:2019', 'Before handover', 5050),
      (v_id, 'Plumbing', 'Water lines — routing, supports and access', 'Routes, sizes and supports per drawing; no unauthorised joints buried in walls or slabs.', 'witness'::itp_type, 'IS 2065:1983 — Water Supply in Buildings (Code of Practice)', 'Before concealment', 5060),
      (v_id, 'Plumbing', 'PRESSURE TEST ON CONCEALED WATER LINES', 'Lines held at the specified test pressure for the specified duration with no drop and no visible leakage.', 'hold'::itp_type, 'IS 2065:1983', 'Before plaster and tiling', 5070),
      (v_id, 'Plumbing', 'Drainage and soil stacks — gradient, jointing and access', 'Gradients, jointing and access points per drawing; stacks vented as designed.', 'witness'::itp_type, 'IS 5329:1983 — Sanitary Pipe Work Above Ground for Buildings (Code of Practice)', 'Before concealment', 5080),
      (v_id, 'Plumbing', 'Drainage flow test', 'Flow tested through traps and stacks with no leakage, backflow or loss of trap seal.', 'hold'::itp_type, 'IS 5329:1983', 'Before handover', 5090),
      (v_id, 'Plumbing', 'Sanitary fixtures — level, fixing and sealing', 'Fixtures level and securely fixed; joints sealed; traps holding their water seal; no drips at connections.', 'witness'::itp_type, 'IS 2065:1983', 'Before handover', 5100),
      (v_id, 'HVAC', 'Refrigerant piping — routing, insulation and pressure test', 'Pipe sizes, insulation and supports per drawing; nitrogen pressure test held for the specified duration without loss.', 'hold'::itp_type, null, 'Before concealment', 5110),
      (v_id, 'HVAC', 'Condensate drain lines — fall and flow test', 'Continuous fall to the drain point; water flow tested with no pooling, backflow or leakage.', 'witness'::itp_type, null, 'Before ceiling closure', 5120);
  end if;
end $$;


-- ############################################################
-- ###  3. VERIFY
-- ############################################################
-- Expect five templates and 52 points.
select t.name,
       count(i.id) as points,
       count(i.id) filter (where i.inspection_type = 'hold') as holds
from public.itp_templates t
left join public.itp_template_items i on i.template_id = t.id
where t.name like 'IS %'
group by t.name
order by min(i.sort_order);

select count(*) as total_points from public.itp_template_items;

-- The three points that deliberately carry no standard reference.
select stage, description
from public.itp_template_items
where coalesce(btrim(reference_standard), '') = ''
order by sort_order;
