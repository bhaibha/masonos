-- ============================================================================
-- 086  M13-A  MATERIAL QUANTITY CALCULATOR
-- ============================================================================
--
-- A field tool: type a length, a breadth and a depth, get bags of cement.
-- Eight estimators — concrete, masonry, plaster, tiling, steel, paint,
-- waterproofing, excavation — plus a saved estimate that can be compared
-- against what the site actually consumed.
--
-- ---------------------------------------------------------------------------
-- WHY THE ARITHMETIC IS IN POSTGRES AND NOT IN THE BROWSER
-- ---------------------------------------------------------------------------
-- This is the 051 decision, unchanged, and it is worth restating because a
-- calculator is exactly the module where somebody would reach for a TypeScript
-- file.
--
-- The numbers this produces get turned into a purchase order. "Order 47 bags"
-- is a consequential sentence, and the factors behind it — 1.54 dry volume,
-- 1440 kg/cum, a 10 mm joint, 5% wastage — are FIRM POLICY, not physics. The
-- founder will want to argue with them, and a constant buried in a .ts file is
-- one only the person who wrote it can find.
--
-- So the constants are a TABLE (`calc_constants`), the mixes are a TABLE
-- (`calc_mixes`), the wall units are a TABLE (`masonry_units`), and every
-- function returns its WORKING alongside its answer in one jsonb — so the
-- explanation on screen is a by-product of the calculation rather than a second
-- one that could drift from it. Editing a constant restates every calculator at
-- once, which is what `fn_calc_selftest()` exists to make safe.
--
-- The screen calls these on a debounce. A TypeScript copy would be faster and
-- would be the copy nobody re-checks after somebody changes the joint to 12 mm.
--
-- ---------------------------------------------------------------------------
-- METRES ARE THE ONLY UNIT STORED
-- ---------------------------------------------------------------------------
-- The brief asks for a metres/feet toggle. That toggle is a DISPLAY concern and
-- it stops at the edge of the app: every parameter here is named `_m` or `_mm`
-- and every stored figure is metric. A unit switch that changes what is stored
-- is how a wall gets built 3.28 times too long.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS REFUSES TO DO
-- ---------------------------------------------------------------------------
--   * It gives no nominal mix above M25 — see the note on `calc_mixes`. IS 456
--     limits nominal mixes to M20 and everything above is a design mix, which
--     is a decision for a person with a stamp. Asking for M30 returns a refusal
--     naming the reason, not a plausible ratio.
--   * It carries NO RATES AND NO MONEY, anywhere. That is why every internal
--     role including supervisors may use it: there is nothing on this screen to
--     hide. A quantity is not a cost.
--   * It does not decide dimensions. It multiplies what somebody measured.
--
-- ---------------------------------------------------------------------------
-- THE STEEL DIVISOR IS READ FROM `bbs_constants`, NOT RE-SEEDED
-- ---------------------------------------------------------------------------
-- 053 moved the firm's unit-weight divisor from 162 to 162.2 because that is
-- what their own BBS sheet prints. If this module seeded its own divisor, the
-- calculator and the bar bending schedule would disagree about the weight of a
-- 12 mm bar the moment either was edited. `fn_calc_steel` reads the 051 table.
--
-- Depends on: 001 (profiles, projects, audit), 003 (materials, material_issues,
-- material_inward), 051/053 (bbs_constants). Independent of 085.
-- ============================================================================


-- ############################################################
-- ### 1. CONSTANTS  —  one labelled row per figure
-- ############################################################

create table if not exists public.calc_constants (
  code        text primary key,
  label       text not null,
  value       numeric(12,5) not null,
  unit        text not null,
  ref         text,
  note        text,
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);

-- `on conflict do nothing` throughout: a founder who changed a factor must not
-- have it reset by a re-run. Same rule as 051.
insert into public.calc_constants (code, label, value, unit, ref, note) values
  ('dry_factor_concrete', 'Dry volume factor — concrete', 1.54, 'ratio', 'Common practice',
   'Wet concrete to dry material. Sits between 1.52 and 1.57 in the literature; 1.54 is the usual site figure.'),
  ('dry_factor_mortar', 'Dry volume factor — mortar and plaster', 1.27, 'ratio', 'Common practice',
   'Lower than concrete because there is no coarse aggregate to fill.'),
  ('cement_bag_kg', 'Cement bag weight', 50, 'kg', 'IS 269',
   'One bag. The volume of a bag is DERIVED from this and the density, so the two can never disagree.'),
  ('cement_density_kg_cum', 'Cement bulk density', 1440, 'kg/cum', 'IS 456',
   'Used to turn a cement volume into bags. 50/1440 = 0.03472 cum per bag.'),
  ('mortar_joint_mm', 'Mortar joint thickness', 10, 'mm', 'IS 2212',
   'Nominal joint for brick and block masonry. AAC laid on thin-bed adhesive uses 3 mm — change it on the form.'),
  ('wastage_concrete_pct', 'Wastage — concrete', 2.5, '%', 'Firm',
   'Spillage and over-pour. Applied to the wet volume so it reaches every component equally.'),
  ('wastage_masonry_pct', 'Wastage — masonry units', 5, '%', 'Firm',
   'Breakage in handling and cutting at openings.'),
  ('wastage_plaster_pct', 'Wastage — plaster', 10, '%', 'Firm',
   'Droppings and uneven backgrounds. Higher than concrete because a rough wall eats material.'),
  ('wastage_tile_pct', 'Wastage — tiles', 10, '%', 'Firm',
   'Cuts at edges. Raise it for diagonal or patterned laying.'),
  ('wastage_paint_pct', 'Wastage — paint', 5, '%', 'Firm',
   'Tray, roller and brush losses.'),
  ('tile_joint_mm', 'Tile joint width', 3, 'mm', 'Firm',
   'Spacer width. Included in the tile footprint so the count is not short.'),
  ('tile_adhesive_kg_sqm_mm', 'Tile adhesive consumption', 1.50, 'kg/sqm/mm', 'Manufacturer typical',
   'Per square metre PER MILLIMETRE of bed. Check the bag — it varies by brand.'),
  ('paint_coverage_sqm_l', 'Paint coverage per coat', 10, 'sqm/litre', 'Manufacturer typical',
   'Interior emulsion on a primed smooth surface. Textured or fresh plaster takes far more.'),
  ('primer_coverage_sqm_l', 'Primer coverage', 12, 'sqm/litre', 'Manufacturer typical',
   'One coat.'),
  ('wp_consumption_kg_sqm', 'Waterproofing consumption per coat', 1.50, 'kg/sqm', 'Manufacturer typical',
   'Cementitious slurry, one coat. Liquid membranes differ — read the drum.'),
  ('soil_bulking_pct', 'Soil bulking on excavation', 25, '%', 'Common practice',
   'Excavated soil occupies more than the hole it came from. Used for disposal volume only, never for the excavation figure itself.')
on conflict (code) do nothing;

alter table public.calc_constants enable row level security;


-- ############################################################
-- ### 2. MIXES  —  concrete grades and mortar ratios as DATA
-- ############################################################

create table if not exists public.calc_mixes (
  code        text primary key,
  kind        text not null check (kind in ('concrete','mortar')),
  label       text not null,
  cement      numeric(6,2) not null check (cement > 0),
  sand        numeric(6,2) not null check (sand >= 0),
  aggregate   numeric(6,2) not null default 0 check (aggregate >= 0),
  is_nominal  boolean not null default true,
  note        text,
  sort        int not null default 100
);

-- IS 456:2000 Table 5 gives nominal mix proportions for M5 through M20 ONLY.
-- M25 at 1:1:2 is universal site practice and is included because the firm
-- asked for it — but `is_nominal` is FALSE and the note says why, so the screen
-- can print the caveat rather than presenting it as a code figure. Nothing
-- above M25 exists here at all: a design mix is somebody's professional
-- judgement and inventing a ratio for it would be the app doing engineering it
-- is not qualified to do (the 044 rule).
insert into public.calc_mixes (code, kind, label, cement, sand, aggregate, is_nominal, note, sort) values
  ('M5',   'concrete', 'M5 — 1:5:10',   1, 5,   10, true,  'Lean concrete, blinding and levelling course.', 10),
  ('M7.5', 'concrete', 'M7.5 — 1:4:8',  1, 4,    8, true,  'Mass concrete, non-structural fill.',           20),
  ('M10',  'concrete', 'M10 — 1:3:6',   1, 3,    6, true,  'PCC bedding under footings and floors.',        30),
  ('M15',  'concrete', 'M15 — 1:2:4',   1, 2,    4, true,  'PCC, kerbs, light foundations.',                40),
  ('M20',  'concrete', 'M20 — 1:1.5:3', 1, 1.5,  3, true,  'The usual RCC grade for residential work.',     50),
  ('M25',  'concrete', 'M25 — 1:1:2',   1, 1,    2, false,
   'IS 456 Table 5 stops at M20 — M25 and above should be a DESIGN mix from a mix design report, not a nominal ratio. 1:1:2 is common site practice and is offered on that basis only.', 60),
  ('CM1:3','mortar',   'CM 1:3',  1, 3, 0, true, 'Rich. Bedding for tiles and stone, and repairs.',            10),
  ('CM1:4','mortar',   'CM 1:4',  1, 4, 0, true, 'External plaster and load-bearing masonry.',                 20),
  ('CM1:5','mortar',   'CM 1:5',  1, 5, 0, true, 'General purpose masonry and plaster.',                       30),
  ('CM1:6','mortar',   'CM 1:6',  1, 6, 0, true, 'Internal plaster and half-brick partitions. The commonest.', 40),
  ('CM1:8','mortar',   'CM 1:8',  1, 8, 0, true, 'Lean. Sub-grade masonry only.',                              50)
on conflict (code) do nothing;

alter table public.calc_mixes enable row level security;


-- ############################################################
-- ### 3. MASONRY UNITS  —  a table, because the firm uses five
-- ############################################################

-- The firm builds with solid concrete blocks (two sizes), traditional brick,
-- modular brick AND AAC. Hard-coding a "standard brick" would have been wrong
-- on four counts out of five. Dimensions are the UNIT'S OWN, with no joint —
-- the joint is a constant and is added by the calculator, so changing the joint
-- does not mean re-typing five rows.
create table if not exists public.masonry_units (
  code        text primary key,
  label       text not null,
  length_mm   numeric(8,1) not null check (length_mm > 0),
  height_mm   numeric(8,1) not null check (height_mm > 0),
  width_mm    numeric(8,1) not null check (width_mm  > 0),
  default_joint_mm numeric(5,1),
  is_active   boolean not null default true,
  note        text,
  sort        int not null default 100
);

-- THE COLUMN ORDER HERE IS length, HEIGHT, width — AND THE TRADE NAMES ARE NOT
-- CONSISTENT ABOUT WHICH IS WHICH. A block called "400×200×150" is 400 long,
-- 200 HIGH and 150 thick; a brick called "230×110×75" is 230 long, 110 THICK
-- and 75 high. Reading both the same way puts the brick's height and width the
-- wrong way round, which is a 4% error in the count and survives a re-read.
-- (It survived mine. `fn_calc_selftest()` case 5 caught it on the first run.)
-- Hence the labels below spell out L/H/W rather than repeating the trade name.
insert into public.masonry_units (code, label, length_mm, height_mm, width_mm, default_joint_mm, note, sort) values
  ('CCB400x200x200', 'Solid concrete block — 400 L × 200 H × 200 thick', 400, 200, 200, 10,
   'Full-width block for external and load-bearing walls.', 10),
  ('CCB400x200x150', 'Solid concrete block — 400 L × 200 H × 150 thick', 400, 200, 150, 10,
   'The 150 wall. Added at the firm''s request.', 20),
  ('CCB400x200x100', 'Solid concrete block — 400 L × 200 H × 100 thick', 400, 200, 100, 10,
   'Partition block.', 30),
  ('BRICK230x110x75', 'Traditional brick — 230 L × 75 H × 110 thick', 230, 75, 110, 10,
   'Table-moulded local brick, the one sold as "230×110×75". Sizes vary between kilns — measure a delivery and edit this row if yours differ.', 40),
  ('BRICK190x90x90', 'Modular brick — 190 L × 90 H × 90 thick', 190, 90, 90, 10,
   'IS 1077 modular brick. With a 10 mm joint it works to a 200×100×100 module.', 50),
  ('AAC625x240x200', 'AAC block — 625 L × 240 H × 200 thick', 625, 240, 200, 3,
   'Laid on THIN-BED ADHESIVE, not cement mortar — the 3 mm default joint reflects that, and the mortar figure this returns is adhesive volume. Check the bag for coverage.', 60),
  ('AAC625x240x100', 'AAC block — 625 L × 240 H × 100 thick', 625, 240, 100, 3,
   'AAC partition block. Thin-bed adhesive, as above.', 70)
on conflict (code) do nothing;

alter table public.masonry_units enable row level security;


-- ############################################################
-- ### 4. SAVED ESTIMATES
-- ############################################################

do $$ begin
  create type estimate_kind as enum
    ('concrete','masonry','plaster','tiling','steel','paint','waterproofing','excavation');
exception when duplicate_object then null; end $$;

create table if not exists public.material_estimates (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  kind        estimate_kind not null,
  title       text not null check (btrim(title) <> ''),
  work_area   text,
  -- The inputs AS TYPED, so the estimate can be explained and re-run by hand.
  inputs      jsonb not null default '{}'::jsonb,
  -- The working AS COMPUTED at the moment of saving.
  working     text,
  notes       text,
  created_by  uuid not null default auth.uid() references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- THE LINES ARE A FROZEN SNAPSHOT, NOT A VIEW OVER THE CALCULATOR.
-- If somebody changes the dry-volume factor next year, an estimate saved today
-- must still read as it did today — otherwise the record of what was ordered
-- silently restates itself. Same rule as the certified bill (032) and the
-- snapshotted question wording (045).
create table if not exists public.estimate_lines (
  id           uuid primary key default gen_random_uuid(),
  estimate_id  uuid not null references public.material_estimates(id) on delete cascade,
  -- Nullable: "cement" maps to a material and can be compared against issues,
  -- while "mortar volume" is an intermediate figure that never will.
  material_id  uuid references public.materials(id) on delete set null,
  item         text not null check (btrim(item) <> ''),
  qty          numeric(14,3) not null,
  unit         text not null,
  is_orderable boolean not null default false,
  sort         int not null default 100
);

alter table public.material_estimates enable row level security;
alter table public.estimate_lines     enable row level security;

create index if not exists mest_project_idx on public.material_estimates (project_id, created_at desc);
create index if not exists eline_est_idx    on public.estimate_lines (estimate_id);


-- ############################################################
-- ### 5. HELPERS
-- ############################################################

-- One bag of cement, in cubic metres. DERIVED from the two constants rather
-- than seeded as a third, so nobody can edit the density and leave the bag
-- volume saying something else.
create or replace function public.fn_calc_bag_cum()
returns numeric language sql stable set search_path = public as $$
  select (select c.value from public.calc_constants c where c.code = 'cement_bag_kg')
       / (select c.value from public.calc_constants c where c.code = 'cement_density_kg_cum');
$$;

create or replace function public.fn_calc_const(p_code text)
returns numeric language plpgsql stable set search_path = public as $$
declare v numeric;
begin
  select c.value into v from public.calc_constants c where c.code = p_code;
  if v is null then
    raise exception 'The calculator constant "%" is missing. Re-run migration 086, or add the row to calc_constants.', p_code
      using errcode = 'no_data_found';
  end if;
  return v;
end $$;

-- Cement volume -> the two numbers a site actually wants: exact bags (so the
-- arithmetic can be checked) and bags TO ORDER (because you cannot buy 0.4 of
-- a bag). Returning only the rounded figure would make every hand-check fail
-- by a fraction; returning only the exact one would have somebody order 8 bags
-- when they need 8.06.
-- The working is read by a person, so 10 mm must not print as
-- 10.00000000000000000000 and 1.5 parts must not print as 1.50. `trim_scale`
-- drops trailing zeros without rounding anything away.
create or replace function public.fn_n(v numeric)
returns text language sql immutable set search_path = public as $$
  select trim_scale(v)::text;
$$;

create or replace function public.fn_calc_cement(p_cum numeric)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'cum',        round(p_cum, 4),
    'kg',         round(p_cum * public.fn_calc_const('cement_density_kg_cum'), 2),
    'bags',       round(p_cum / public.fn_calc_bag_cum(), 2),
    'bags_order', ceil(p_cum / public.fn_calc_bag_cum())::int
  );
$$;


-- ############################################################
-- ### 6. THE CALCULATORS
-- ############################################################
-- Every one returns a single jsonb:
--   { ok, inputs, lines:[{item, qty, unit, orderable}], working, warning }
-- The `working` string is built from the SAME variables as the lines, so the
-- explanation cannot describe arithmetic the function is no longer doing.

-- ---------- CONCRETE ----------
drop function if exists public.fn_calc_concrete(numeric, numeric, numeric, text, numeric);
create function public.fn_calc_concrete(
  p_length_m numeric, p_width_m numeric, p_depth_m numeric,
  p_mix text, p_wastage_pct numeric default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  m           public.calc_mixes%rowtype;
  v_waste     numeric := coalesce(p_wastage_pct, public.fn_calc_const('wastage_concrete_pct'));
  v_dry_f     numeric := public.fn_calc_const('dry_factor_concrete');
  v_wet       numeric;
  v_wet_w     numeric;
  v_dry       numeric;
  v_parts     numeric;
  v_cem_cum   numeric;
  v_sand      numeric;
  v_agg       numeric;
  v_cement    jsonb;
  v_warn      text;
begin
  if coalesce(p_length_m,0) <= 0 or coalesce(p_width_m,0) <= 0 or coalesce(p_depth_m,0) <= 0 then
    return jsonb_build_object('ok', false,
      'error', 'Length, breadth and depth must all be more than zero.');
  end if;

  select * into m from public.calc_mixes where code = p_mix and kind = 'concrete';
  if not found then
    return jsonb_build_object('ok', false,
      'error', format('No nominal mix is held for "%s". IS 456 Table 5 gives nominal proportions up to M20 only, and anything above M25 must come from a mix design report — the app will not invent a ratio for it.', p_mix));
  end if;
  if not m.is_nominal then
    v_warn := m.note;
  end if;

  v_wet     := p_length_m * p_width_m * p_depth_m;
  v_wet_w   := v_wet * (1 + v_waste / 100);
  v_dry     := v_wet_w * v_dry_f;
  v_parts   := m.cement + m.sand + m.aggregate;
  v_cem_cum := v_dry * m.cement    / v_parts;
  v_sand    := v_dry * m.sand      / v_parts;
  v_agg     := v_dry * m.aggregate / v_parts;
  v_cement  := public.fn_calc_cement(v_cem_cum);

  return jsonb_build_object(
    'ok', true,
    'warning', v_warn,
    'lines', jsonb_build_array(
      jsonb_build_object('item','Wet concrete',  'qty', round(v_wet,3),   'unit','cum','orderable',false),
      jsonb_build_object('item','Cement',        'qty', (v_cement->>'bags_order')::numeric, 'unit','bags','orderable',true),
      jsonb_build_object('item','Sand',          'qty', round(v_sand,3),  'unit','cum','orderable',true),
      jsonb_build_object('item','Coarse aggregate','qty', round(v_agg,3), 'unit','cum','orderable',true)
    ),
    'detail', jsonb_build_object(
      'wet_cum', round(v_wet,4), 'dry_cum', round(v_dry,4),
      'cement', v_cement, 'sand_cum', round(v_sand,4), 'agg_cum', round(v_agg,4),
      'mix', m.label),
    'working', format(
      E'Wet volume = %s × %s × %s = %s cum\n'
      '+ %s%% wastage = %s cum\n'
      '× %s dry factor = %s cum of dry material\n'
      '%s, parts %s + %s + %s = %s\n'
      'Cement = %s × %s/%s = %s cum = %s kg = %s bags (order %s)\n'
      'Sand = %s × %s/%s = %s cum\n'
      'Aggregate = %s × %s/%s = %s cum',
      public.fn_n(p_length_m), public.fn_n(p_width_m), public.fn_n(p_depth_m), public.fn_n(round(v_wet,3)),
      public.fn_n(v_waste), public.fn_n(round(v_wet_w,3)),
      public.fn_n(v_dry_f), public.fn_n(round(v_dry,3)),
      m.label, public.fn_n(m.cement), public.fn_n(m.sand), public.fn_n(m.aggregate), public.fn_n(v_parts),
      public.fn_n(round(v_dry,3)), public.fn_n(m.cement), public.fn_n(v_parts), public.fn_n(round(v_cem_cum,4)), v_cement->>'kg', v_cement->>'bags', v_cement->>'bags_order',
      public.fn_n(round(v_dry,3)), public.fn_n(m.sand), public.fn_n(v_parts), public.fn_n(round(v_sand,3)),
      public.fn_n(round(v_dry,3)), public.fn_n(m.aggregate), public.fn_n(v_parts), public.fn_n(round(v_agg,3)))
  );
end $$;

-- ---------- MASONRY ----------
drop function if exists public.fn_calc_masonry(numeric, numeric, text, text, numeric, numeric);
create function public.fn_calc_masonry(
  p_area_sqm numeric, p_thickness_m numeric, p_unit_code text,
  p_mortar_mix text default 'CM1:6', p_joint_mm numeric default null,
  p_wastage_pct numeric default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  u          public.masonry_units%rowtype;
  m          public.calc_mixes%rowtype;
  v_joint    numeric;
  v_waste    numeric := coalesce(p_wastage_pct, public.fn_calc_const('wastage_masonry_pct'));
  v_dry_f    numeric := public.fn_calc_const('dry_factor_mortar');
  v_wall     numeric;
  v_occupied numeric;
  v_units    numeric;
  v_units_w  int;
  v_solid    numeric;
  v_mortar   numeric;
  v_dry      numeric;
  v_parts    numeric;
  v_cem_cum  numeric;
  v_sand     numeric;
  v_cement   jsonb;
  v_wythes   numeric;
  v_warn     text;
begin
  if coalesce(p_area_sqm,0) <= 0 or coalesce(p_thickness_m,0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Wall area and thickness must both be more than zero.');
  end if;

  select * into u from public.masonry_units where code = p_unit_code;
  if not found then
    return jsonb_build_object('ok', false, 'error', format('No masonry unit is held with the code "%s".', p_unit_code));
  end if;

  select * into m from public.calc_mixes where code = p_mortar_mix and kind = 'mortar';
  if not found then
    return jsonb_build_object('ok', false, 'error', format('No mortar ratio is held for "%s".', p_mortar_mix));
  end if;

  v_joint := coalesce(p_joint_mm, u.default_joint_mm, public.fn_calc_const('mortar_joint_mm')) / 1000;

  -- COUNTED PER SQUARE METRE OF FACE × NUMBER OF WYTHES, not by dividing the
  -- wall volume by a unit volume. The volume method looks equivalent and is
  -- not: a 230 wall of 110-thick brick is two leaves with a 10 mm COLLAR JOINT
  -- between them, so the wall contains mortar the per-unit volume knows nothing
  -- about, and dividing by it over-counts the bricks by about 4%. Counting the
  -- face and multiplying by the leaves is also how a mason counts.
  --
  -- The collar joint is why the wythe count uses (thickness + joint) /
  -- (width + joint): 2 × 110 + 10 = 230 is exactly 2 leaves, and a plain
  -- thickness/width would call it 2.09 and warn about a wall that is correct.
  v_wythes := (p_thickness_m + v_joint) / ((u.width_mm / 1000) + v_joint);

  -- Reported, never clamped — the 051 rule about an impossible input.
  if abs(v_wythes - round(v_wythes)) > 0.05 or round(v_wythes) < 1 then
    v_warn := format('A %s mm wall works out at %s leaves of a %s mm unit — check the block size against the wall thickness. The count below has been rounded to %s.',
                     public.fn_n(round(p_thickness_m * 1000)), public.fn_n(round(v_wythes, 2)), public.fn_n(u.width_mm), greatest(round(v_wythes), 1));
  end if;
  v_wythes := greatest(round(v_wythes), 1);

  v_wall     := p_area_sqm * p_thickness_m;
  -- One unit's FACE, plus one joint on each of the two bedding faces.
  v_occupied := ((u.length_mm/1000) + v_joint) * ((u.height_mm/1000) + v_joint);
  v_units    := (p_area_sqm / v_occupied) * v_wythes;
  v_units_w  := ceil(v_units * (1 + v_waste / 100))::int;

  -- Mortar is what is left once the SOLID units are taken out of the wall — so
  -- it uses the un-wasted count. Broken blocks do not leave mortar behind them.
  -- Computed this way it picks up the collar joint for free.
  v_solid    := v_units * (u.length_mm/1000) * (u.height_mm/1000) * (u.width_mm/1000);
  v_mortar   := greatest(v_wall - v_solid, 0);
  v_dry      := v_mortar * v_dry_f;
  v_parts    := m.cement + m.sand;
  v_cem_cum  := v_dry * m.cement / v_parts;
  v_sand     := v_dry * m.sand   / v_parts;
  v_cement   := public.fn_calc_cement(v_cem_cum);

  return jsonb_build_object(
    'ok', true,
    'warning', v_warn,
    'lines', jsonb_build_array(
      jsonb_build_object('item', u.label, 'qty', v_units_w, 'unit','nos','orderable',true),
      jsonb_build_object('item','Cement (mortar)', 'qty', (v_cement->>'bags_order')::numeric, 'unit','bags','orderable',true),
      jsonb_build_object('item','Sand (mortar)',   'qty', round(v_sand,3), 'unit','cum','orderable',true),
      jsonb_build_object('item','Wall volume',     'qty', round(v_wall,3), 'unit','cum','orderable',false)
    ),
    'detail', jsonb_build_object(
      'wall_cum', round(v_wall,4), 'units_exact', round(v_units,1), 'units_with_wastage', v_units_w,
      'units_per_sqm', round(v_wythes / v_occupied, 2), 'wythes', v_wythes,
      'mortar_wet_cum', round(v_mortar,4), 'cement', v_cement, 'sand_cum', round(v_sand,4),
      'unit_label', u.label, 'joint_mm', v_joint * 1000),
    'working', format(
      E'One %s with a %s mm joint covers %s × %s = %s sqm of face\n'
      'A %s mm wall is %s %s of a %s mm unit\n'
      'Units = %s sqm ÷ %s × %s = %s, + %s%% wastage = %s\n'
      'Wall volume = %s sqm × %s m = %s cum\n'
      'Solid units = %s cum, so mortar = %s − %s = %s cum wet\n'
      '× %s dry factor = %s cum, %s parts %s\n'
      'Cement = %s cum = %s kg = %s bags (order %s)\n'
      'Sand = %s cum',
      u.label, public.fn_n(v_joint*1000),
        public.fn_n(round((u.length_mm/1000) + v_joint, 3)), public.fn_n(round((u.height_mm/1000) + v_joint, 3)), public.fn_n(round(v_occupied, 5)),
      public.fn_n(round(p_thickness_m*1000)), public.fn_n(v_wythes), case when v_wythes = 1 then 'leaf' else 'leaves' end, public.fn_n(u.width_mm),
      public.fn_n(p_area_sqm), public.fn_n(round(v_occupied,5)), public.fn_n(v_wythes), public.fn_n(round(v_units,1)), public.fn_n(v_waste), v_units_w,
      public.fn_n(p_area_sqm), public.fn_n(p_thickness_m), public.fn_n(round(v_wall,3)),
      public.fn_n(round(v_solid,3)), public.fn_n(round(v_wall,3)), public.fn_n(round(v_solid,3)), public.fn_n(round(v_mortar,4)),
      public.fn_n(v_dry_f), public.fn_n(round(v_dry,4)), m.label, public.fn_n(v_parts),
      public.fn_n(round(v_cem_cum,4)), v_cement->>'kg', v_cement->>'bags', v_cement->>'bags_order',
      public.fn_n(round(v_sand,3)))
  );
end $$;

-- ---------- PLASTER ----------
drop function if exists public.fn_calc_plaster(numeric, numeric, text, numeric);
create function public.fn_calc_plaster(
  p_area_sqm numeric, p_thickness_mm numeric,
  p_mortar_mix text default 'CM1:6', p_wastage_pct numeric default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  m         public.calc_mixes%rowtype;
  v_waste   numeric := coalesce(p_wastage_pct, public.fn_calc_const('wastage_plaster_pct'));
  v_dry_f   numeric := public.fn_calc_const('dry_factor_mortar');
  v_wet     numeric;
  v_wet_w   numeric;
  v_dry     numeric;
  v_parts   numeric;
  v_cem_cum numeric;
  v_sand    numeric;
  v_cement  jsonb;
begin
  if coalesce(p_area_sqm,0) <= 0 or coalesce(p_thickness_mm,0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Area and thickness must both be more than zero.');
  end if;

  select * into m from public.calc_mixes where code = p_mortar_mix and kind = 'mortar';
  if not found then
    return jsonb_build_object('ok', false, 'error', format('No mortar ratio is held for "%s".', p_mortar_mix));
  end if;

  v_wet     := p_area_sqm * (p_thickness_mm / 1000);
  v_wet_w   := v_wet * (1 + v_waste / 100);
  v_dry     := v_wet_w * v_dry_f;
  v_parts   := m.cement + m.sand;
  v_cem_cum := v_dry * m.cement / v_parts;
  v_sand    := v_dry * m.sand   / v_parts;
  v_cement  := public.fn_calc_cement(v_cem_cum);

  return jsonb_build_object(
    'ok', true,
    'lines', jsonb_build_array(
      jsonb_build_object('item','Cement','qty',(v_cement->>'bags_order')::numeric,'unit','bags','orderable',true),
      jsonb_build_object('item','Sand',  'qty', round(v_sand,3),'unit','cum','orderable',true),
      jsonb_build_object('item','Wet mortar','qty', round(v_wet,3),'unit','cum','orderable',false)
    ),
    'detail', jsonb_build_object('wet_cum', round(v_wet,4), 'dry_cum', round(v_dry,4),
                                 'cement', v_cement, 'sand_cum', round(v_sand,4)),
    'working', format(
      E'Wet volume = %s sqm × %s mm = %s cum\n'
      '+ %s%% wastage = %s cum × %s dry factor = %s cum\n'
      '%s, parts %s\n'
      'Cement = %s cum = %s kg = %s bags (order %s)\n'
      'Sand = %s cum',
      public.fn_n(p_area_sqm), public.fn_n(p_thickness_mm), public.fn_n(round(v_wet,4)),
      public.fn_n(v_waste), public.fn_n(round(v_wet_w,4)), public.fn_n(v_dry_f), public.fn_n(round(v_dry,4)),
      m.label, public.fn_n(v_parts),
      public.fn_n(round(v_cem_cum,4)), v_cement->>'kg', v_cement->>'bags', v_cement->>'bags_order',
      public.fn_n(round(v_sand,3)))
  );
end $$;

-- ---------- TILING ----------
drop function if exists public.fn_calc_tiling(numeric, numeric, numeric, numeric, numeric, numeric);
create function public.fn_calc_tiling(
  p_area_sqm numeric, p_tile_l_mm numeric, p_tile_w_mm numeric,
  p_bed_mm numeric default 6, p_joint_mm numeric default null,
  p_wastage_pct numeric default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_joint   numeric := coalesce(p_joint_mm, public.fn_calc_const('tile_joint_mm'));
  v_waste   numeric := coalesce(p_wastage_pct, public.fn_calc_const('wastage_tile_pct'));
  v_adh_rt  numeric := public.fn_calc_const('tile_adhesive_kg_sqm_mm');
  v_tile_m2 numeric;
  v_tiles   numeric;
  v_tiles_w int;
  v_adhesive numeric;
begin
  if coalesce(p_area_sqm,0) <= 0 or coalesce(p_tile_l_mm,0) <= 0 or coalesce(p_tile_w_mm,0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Area and both tile dimensions must be more than zero.');
  end if;

  -- The joint is part of the footprint, so the count is not short by the
  -- grout lines.
  v_tile_m2  := ((p_tile_l_mm + v_joint) / 1000) * ((p_tile_w_mm + v_joint) / 1000);
  v_tiles    := p_area_sqm / v_tile_m2;
  v_tiles_w  := ceil(v_tiles * (1 + v_waste / 100))::int;
  v_adhesive := p_area_sqm * coalesce(p_bed_mm, 6) * v_adh_rt;

  return jsonb_build_object(
    'ok', true,
    'lines', jsonb_build_array(
      jsonb_build_object('item', format('Tiles %s×%s mm', p_tile_l_mm, p_tile_w_mm),
                         'qty', v_tiles_w, 'unit','nos','orderable',true),
      jsonb_build_object('item','Tile adhesive','qty', ceil(v_adhesive)::int,'unit','kg','orderable',true)
    ),
    'detail', jsonb_build_object('tile_sqm', round(v_tile_m2,5), 'tiles_exact', round(v_tiles,1),
                                 'tiles_with_wastage', v_tiles_w, 'adhesive_kg', round(v_adhesive,1)),
    'working', format(
      E'One tile with a %s mm joint covers %s × %s = %s sqm\n'
      'Tiles = %s ÷ %s = %s, + %s%% wastage = %s\n'
      'Adhesive = %s sqm × %s mm bed × %s kg/sqm/mm = %s kg',
      public.fn_n(v_joint), public.fn_n(round((p_tile_l_mm + v_joint)/1000, 4)), public.fn_n(round((p_tile_w_mm + v_joint)/1000, 4)), public.fn_n(round(v_tile_m2, 5)),
      public.fn_n(p_area_sqm), public.fn_n(round(v_tile_m2,5)), public.fn_n(round(v_tiles,1)), public.fn_n(v_waste), v_tiles_w,
      public.fn_n(p_area_sqm), public.fn_n(coalesce(p_bed_mm,6)), public.fn_n(v_adh_rt), public.fn_n(round(v_adhesive,1)))
  );
end $$;

-- ---------- STEEL (manual) ----------
-- The divisor comes from `bbs_constants`, which 053 set to the firm's own
-- 162.2. Seeding a second copy here is how the calculator and the bar bending
-- schedule would come to disagree about a 12 mm bar.
drop function if exists public.fn_calc_steel(numeric, numeric, int);
create function public.fn_calc_steel(p_dia_mm numeric, p_length_m numeric, p_qty int default 1)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_div    numeric;
  v_unit_w numeric;
  v_total  numeric;
  v_len    numeric;
begin
  if coalesce(p_dia_mm,0) <= 0 or coalesce(p_length_m,0) <= 0 or coalesce(p_qty,0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Diameter, length and number of bars must all be more than zero.');
  end if;

  select c.value into v_div from public.bbs_constants c where c.code = 'unit_weight_divisor';
  if v_div is null then
    return jsonb_build_object('ok', false,
      'error', 'The steel unit-weight divisor is missing from bbs_constants — run migration 051/053 first. This calculator deliberately reads the same figure the bar bending schedule uses rather than keeping its own.');
  end if;

  v_len    := p_length_m * p_qty;
  v_unit_w := (p_dia_mm * p_dia_mm) / v_div;
  v_total  := v_unit_w * v_len;

  return jsonb_build_object(
    'ok', true,
    'lines', jsonb_build_array(
      jsonb_build_object('item', format('TMT %s mm', p_dia_mm), 'qty', round(v_total,2), 'unit','kg','orderable',true),
      jsonb_build_object('item','Total length','qty', round(v_len,2), 'unit','m','orderable',false)
    ),
    'detail', jsonb_build_object('unit_weight_kg_m', round(v_unit_w,4), 'total_length_m', round(v_len,3),
                                 'total_kg', round(v_total,3), 'tonnes', round(v_total/1000, 4), 'divisor', v_div),
    'working', format(
      E'Unit weight = d² ÷ %s = %s² ÷ %s = %s kg/m\n'
      'Total length = %s m × %s bars = %s m\n'
      'Weight = %s × %s = %s kg (%s t)\n'
      'The divisor is read from the bar bending schedule''s own constants, so the two always agree.',
      public.fn_n(v_div), public.fn_n(p_dia_mm), public.fn_n(v_div), public.fn_n(round(v_unit_w,4)),
      public.fn_n(p_length_m), p_qty, public.fn_n(round(v_len,2)),
      public.fn_n(round(v_unit_w,4)), public.fn_n(round(v_len,2)), public.fn_n(round(v_total,2)), public.fn_n(round(v_total/1000,3)))
  );
end $$;

-- ---------- PAINT ----------
drop function if exists public.fn_calc_paint(numeric, int, numeric, numeric, boolean, numeric);
create function public.fn_calc_paint(
  p_area_sqm numeric, p_coats int default 2,
  p_coverage_sqm_l numeric default null, p_primer_coverage_sqm_l numeric default null,
  p_with_primer boolean default true, p_wastage_pct numeric default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_cov    numeric := coalesce(p_coverage_sqm_l, public.fn_calc_const('paint_coverage_sqm_l'));
  v_pcov   numeric := coalesce(p_primer_coverage_sqm_l, public.fn_calc_const('primer_coverage_sqm_l'));
  v_waste  numeric := coalesce(p_wastage_pct, public.fn_calc_const('wastage_paint_pct'));
  v_paint  numeric;
  v_primer numeric := 0;
  v_lines  jsonb;
begin
  if coalesce(p_area_sqm,0) <= 0 or coalesce(p_coats,0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Area and the number of coats must both be more than zero.');
  end if;
  if v_cov <= 0 or v_pcov <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Coverage must be more than zero square metres per litre.');
  end if;

  v_paint := (p_area_sqm * p_coats / v_cov) * (1 + v_waste / 100);
  if p_with_primer then
    v_primer := (p_area_sqm / v_pcov) * (1 + v_waste / 100);
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('item', format('Paint (%s coats)', p_coats), 'qty', round(v_paint,2), 'unit','litre','orderable',true));
  if p_with_primer then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('item','Primer (1 coat)','qty', round(v_primer,2), 'unit','litre','orderable',true));
  end if;

  return jsonb_build_object(
    'ok', true,
    'warning', 'Coverage is the manufacturer''s figure for a primed, smooth surface. Fresh plaster and textured finishes take substantially more — read the tin before ordering.',
    'lines', v_lines,
    'detail', jsonb_build_object('paint_l', round(v_paint,3), 'primer_l', round(v_primer,3),
                                 'coverage', v_cov, 'primer_coverage', v_pcov),
    'working', format(
      E'Paint = %s sqm × %s coats ÷ %s sqm/litre = %s litre, + %s%% wastage = %s litre%s',
      public.fn_n(p_area_sqm), p_coats, public.fn_n(v_cov), public.fn_n(round(p_area_sqm * p_coats / v_cov, 2)), public.fn_n(v_waste), public.fn_n(round(v_paint,2)),
      case when p_with_primer
        then format(E'\nPrimer = %s ÷ %s = %s litre, + %s%% = %s litre',
                    public.fn_n(p_area_sqm), public.fn_n(v_pcov), public.fn_n(round(p_area_sqm/v_pcov,2)), public.fn_n(v_waste), public.fn_n(round(v_primer,2)))
        else '' end)
  );
end $$;

-- ---------- WATERPROOFING ----------
drop function if exists public.fn_calc_waterproofing(numeric, int, numeric, numeric);
create function public.fn_calc_waterproofing(
  p_area_sqm numeric, p_coats int default 2,
  p_consumption_kg_sqm numeric default null, p_wastage_pct numeric default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_rate  numeric := coalesce(p_consumption_kg_sqm, public.fn_calc_const('wp_consumption_kg_sqm'));
  v_waste numeric := coalesce(p_wastage_pct, public.fn_calc_const('wastage_paint_pct'));
  v_kg    numeric;
begin
  if coalesce(p_area_sqm,0) <= 0 or coalesce(p_coats,0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Area and the number of coats must both be more than zero.');
  end if;

  v_kg := p_area_sqm * p_coats * v_rate * (1 + v_waste / 100);

  return jsonb_build_object(
    'ok', true,
    'warning', 'Consumption varies widely between a cementitious slurry and a liquid membrane. This uses the rate on the form — check the drum. Fillets at wall junctions and overlaps at joints are NOT included; measure those separately.',
    'lines', jsonb_build_array(
      jsonb_build_object('item', format('Waterproofing (%s coats)', p_coats), 'qty', ceil(v_kg)::int, 'unit','kg','orderable',true)
    ),
    'detail', jsonb_build_object('kg', round(v_kg,2), 'rate', v_rate, 'coats', p_coats),
    'working', format(
      E'%s sqm × %s coats × %s kg/sqm = %s kg\n+ %s%% wastage = %s kg (order %s)',
      public.fn_n(p_area_sqm), p_coats, public.fn_n(v_rate), public.fn_n(round(p_area_sqm * p_coats * v_rate, 2)),
      public.fn_n(v_waste), public.fn_n(round(v_kg,2)), ceil(v_kg)::int)
  );
end $$;

-- ---------- EXCAVATION ----------
drop function if exists public.fn_calc_excavation(numeric, numeric, numeric, int, numeric);
create function public.fn_calc_excavation(
  p_length_m numeric, p_width_m numeric, p_depth_m numeric,
  p_pits int default 1, p_bulking_pct numeric default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_bulk numeric := coalesce(p_bulking_pct, public.fn_calc_const('soil_bulking_pct'));
  v_one  numeric;
  v_cum  numeric;
  v_disp numeric;
begin
  if coalesce(p_length_m,0) <= 0 or coalesce(p_width_m,0) <= 0 or coalesce(p_depth_m,0) <= 0
     or coalesce(p_pits,0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Length, breadth, depth and the number of pits must all be more than zero.');
  end if;

  v_one  := p_length_m * p_width_m * p_depth_m;
  v_cum  := v_one * p_pits;
  v_disp := v_cum * (1 + v_bulk / 100);

  return jsonb_build_object(
    'ok', true,
    'warning', 'Measured neat, with no allowance for working space or side slope. A deep trench in loose soil needs both, and they are a decision for the person standing in it.',
    'lines', jsonb_build_array(
      jsonb_build_object('item','Excavation','qty', round(v_cum,3), 'unit','cum','orderable',false),
      jsonb_build_object('item','Soil to cart away (bulked)','qty', round(v_disp,3), 'unit','cum','orderable',false)
    ),
    'detail', jsonb_build_object('per_pit_cum', round(v_one,4), 'total_cum', round(v_cum,4),
                                 'disposal_cum', round(v_disp,4), 'bulking_pct', v_bulk),
    'working', format(
      E'One pit = %s × %s × %s = %s cum\n'
      '× %s = %s cum excavated\n'
      'Loose soil bulks by %s%%, so %s cum to cart away.\n'
      'The bulking applies to the LORRY, never to the excavation measured for payment.',
      public.fn_n(p_length_m), public.fn_n(p_width_m), public.fn_n(p_depth_m), public.fn_n(round(v_one,3)),
      p_pits, public.fn_n(round(v_cum,3)),
      public.fn_n(v_bulk), public.fn_n(round(v_disp,3)))
  );
end $$;


-- ############################################################
-- ### 7. ESTIMATE vs ACTUAL
-- ############################################################

-- Estimated against what the store actually moved. Only lines carrying a
-- material_id can be compared — "mortar volume" is an intermediate figure and
-- will never appear in a stock ledger, which is exactly why `material_id` is
-- nullable and `is_orderable` exists.
--
-- Received AND issued are both returned, because they answer different
-- questions: received against estimate is "did we over-order", issued against
-- estimate is "did we over-consume". One combined figure would answer neither.
--
-- Zero rows when nothing has been estimated for the project — the 073 rule, so
-- the panel disappears rather than showing a table of noughts.
drop function if exists public.fn_estimate_vs_actual(uuid);
create function public.fn_estimate_vs_actual(p_project uuid)
returns table (
  material_id   uuid,
  material_name text,
  unit          text,
  estimated     numeric,
  received      numeric,
  issued        numeric,
  variance      numeric,
  estimates_n   int
)
language sql stable security invoker set search_path = public as $$
  with est as (
    select l.material_id, sum(l.qty) as estimated, count(distinct e.id)::int as estimates_n
    from public.estimate_lines l
    join public.material_estimates e on e.id = l.estimate_id
    where e.project_id = p_project and l.material_id is not null
    group by l.material_id
  ),
  inw as (
    select i.material_id, sum(i.qty) as received
    from public.material_inward i
    where i.project_id = p_project and i.voided_at is null
    group by i.material_id
  ),
  iss as (
    select s.material_id, sum(s.qty) as issued
    from public.material_issues s
    where s.project_id = p_project and s.voided_at is null
    group by s.material_id
  )
  select
    e.material_id,
    m.name,
    m.unit,
    round(e.estimated, 2),
    round(coalesce(inw.received, 0), 2),
    round(coalesce(iss.issued, 0), 2),
    round(coalesce(iss.issued, 0) - e.estimated, 2),
    e.estimates_n
  from est e
  join public.materials m on m.id = e.material_id
  left join inw on inw.material_id = e.material_id
  left join iss on iss.material_id = e.material_id
  order by m.name;
$$;


-- ############################################################
-- ### 8. SELF-TEST
-- ############################################################

-- Eight worked examples with answers derived by hand, run through the SAME
-- functions the screen uses. The expectation is printed alongside the result so
-- the expectation can be argued with too — a self-test whose target nobody can
-- check is a test that only proves the code agrees with itself.
--
-- This earns its place the first time somebody edits a constant: change the dry
-- factor to 1.52 and five of these go red.
drop function if exists public.fn_calc_selftest();
create function public.fn_calc_selftest()
returns table (
  case_no  int,
  scenario text,
  measure  text,
  expected numeric,
  computed numeric,
  diff     numeric,
  passed   boolean
)
language plpgsql stable set search_path = public as $$
declare
  r jsonb;
begin
  -- 1-3: the standard 1 cum M20 worked example, no wastage.
  r := public.fn_calc_concrete(1, 1, 1, 'M20', 0);
  case_no := 1; scenario := '1 cum M20 (1:1.5:3), no wastage';
  measure := 'cement bags'; expected := 8.06;
  computed := (r->'detail'->'cement'->>'bags')::numeric;
  diff := round(computed - expected, 2); passed := abs(diff) <= 0.02; return next;

  case_no := 2; scenario := '1 cum M20 (1:1.5:3), no wastage';
  measure := 'sand cum'; expected := 0.42;
  computed := (r->'detail'->>'sand_cum')::numeric;
  diff := round(computed - expected, 3); passed := abs(diff) <= 0.005; return next;

  case_no := 3; scenario := '1 cum M20 (1:1.5:3), no wastage';
  measure := 'aggregate cum'; expected := 0.84;
  computed := (r->'detail'->>'agg_cum')::numeric;
  diff := round(computed - expected, 3); passed := abs(diff) <= 0.005; return next;

  -- 4: modular brick works to a 200×100 module on the face, so 50/sqm per leaf.
  r := public.fn_calc_masonry(10, 0.09, 'BRICK190x90x90', 'CM1:6', 10, 0);
  case_no := 4; scenario := '10 sqm of 90 mm wall, modular brick, 10 mm joint';
  measure := 'bricks'; expected := 500;
  computed := (r->'detail'->>'units_exact')::numeric;
  diff := round(computed - expected, 1); passed := abs(diff) <= 1; return next;

  -- 5: THE CASE THAT FOUND THE BUG. A 230 wall of 110-thick brick is TWO
  -- leaves. Face = 0.240 × 0.085 = 0.0204 sqm, so 49.02/sqm per leaf, ×2 ×10 =
  -- 980.4. Read as height 110 / width 75 it comes out at 1024.9, and read by
  -- the volume method it comes out at 1024.9 too — both wrong, for two
  -- different reasons that happen to cancel into the same number.
  r := public.fn_calc_masonry(10, 0.23, 'BRICK230x110x75', 'CM1:6', 10, 0);
  case_no := 5; scenario := '10 sqm of 230 mm wall, traditional brick, two leaves';
  measure := 'bricks'; expected := 980.4;
  computed := (r->'detail'->>'units_exact')::numeric;
  diff := round(computed - expected, 1); passed := abs(diff) <= 1; return next;

  -- 5b: the wythe count itself, because the collar joint is what makes a 230
  -- wall exactly two leaves rather than 2.09 of them.
  case_no := 6; scenario := '10 sqm of 230 mm wall, traditional brick';
  measure := 'leaves'; expected := 2;
  computed := (r->'detail'->>'wythes')::numeric;
  diff := round(computed - expected, 1); passed := abs(diff) <= 0.01; return next;

  -- 7: A BLOCK, not a brick — cases 4 and 5 are both bricks, and the two
  -- families read their trade names differently. Without this the block rows
  -- would be untested and the swap could come back on the other side.
  -- Face = 0.410 × 0.210 = 0.0861 sqm → 11.61/sqm, one leaf, ×10 = 116.1.
  r := public.fn_calc_masonry(10, 0.20, 'CCB400x200x200', 'CM1:6', 10, 0);
  case_no := 7; scenario := '10 sqm of 200 mm wall, solid concrete block, one leaf';
  measure := 'blocks'; expected := 116.1;
  computed := (r->'detail'->>'units_exact')::numeric;
  diff := round(computed - expected, 1); passed := abs(diff) <= 0.5; return next;

  -- 8: 100 sqm of 12 mm plaster in 1:6 — the standard ~6.3 bag answer, no wastage.
  r := public.fn_calc_plaster(100, 12, 'CM1:6', 0);
  case_no := 8; scenario := '100 sqm of 12 mm plaster, CM 1:6, no wastage';
  measure := 'cement bags'; expected := 6.27;
  computed := (r->'detail'->'cement'->>'bags')::numeric;
  diff := round(computed - expected, 2); passed := abs(diff) <= 0.05; return next;

  -- 9: steel unit weight against the firm's own divisor. 12 mm at 162.2 is
  -- 0.8878 kg/m; at the textbook 162 it is 0.8889. This case is what catches
  -- somebody re-seeding a second divisor in this module.
  r := public.fn_calc_steel(12, 1, 1);
  case_no := 9; scenario := '12 mm bar, 1 m — divisor read from bbs_constants';
  measure := 'kg/m'; expected := round(144 / (select c.value from public.bbs_constants c where c.code = 'unit_weight_divisor'), 4);
  computed := (r->'detail'->>'unit_weight_kg_m')::numeric;
  diff := round(computed - expected, 4); passed := abs(diff) <= 0.0005; return next;

  -- 10: 600×600 tile with a 3 mm joint over 100 sqm, no wastage.
  -- One tile covers 0.603 × 0.603 = 0.363609 sqm, so 275.0 tiles.
  r := public.fn_calc_tiling(100, 600, 600, 6, 3, 0);
  case_no := 10; scenario := '100 sqm of 600×600 tile, 3 mm joint, no wastage';
  measure := 'tiles'; expected := 275.0;
  computed := (r->'detail'->>'tiles_exact')::numeric;
  diff := round(computed - expected, 1); passed := abs(diff) <= 0.5; return next;

  -- 11: excavation is the one calculator where the headline figure must NOT
  -- carry the bulking. 2×1.5×1.2 × 4 pits = 14.4 cum in the ground.
  r := public.fn_calc_excavation(2, 1.5, 1.2, 4, 25);
  case_no := 11; scenario := '4 pits of 2 × 1.5 × 1.2 m, 25% bulking';
  measure := 'cum excavated'; expected := 14.4;
  computed := (r->'detail'->>'total_cum')::numeric;
  diff := round(computed - expected, 3); passed := abs(diff) <= 0.005; return next;

  case_no := 12; scenario := '4 pits of 2 × 1.5 × 1.2 m, 25% bulking';
  measure := 'cum to cart away'; expected := 18.0;
  computed := (r->'detail'->>'disposal_cum')::numeric;
  diff := round(computed - expected, 3); passed := abs(diff) <= 0.005; return next;

  return;
end $$;


-- ############################################################
-- ### 9. RLS
-- ############################################################

-- `is_internal()`, NOT `using (true)`. The 065 lesson: a policy written when
-- every account belonged to the firm becomes an open door the day a CLIENT role
-- exists. These are only mix ratios, but there is no reason for a client to
-- read the firm's wastage assumptions and no cost to closing it now.
drop policy if exists calc_const_read on public.calc_constants;
create policy calc_const_read on public.calc_constants
  for select to authenticated using (public.is_internal());

drop policy if exists calc_const_write on public.calc_constants;
create policy calc_const_write on public.calc_constants
  for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

drop policy if exists calc_mix_read on public.calc_mixes;
create policy calc_mix_read on public.calc_mixes
  for select to authenticated using (public.is_internal());

drop policy if exists calc_mix_write on public.calc_mixes;
create policy calc_mix_write on public.calc_mixes
  for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

drop policy if exists masonry_unit_read on public.masonry_units;
create policy masonry_unit_read on public.masonry_units
  for select to authenticated using (public.is_internal());

drop policy if exists masonry_unit_write on public.masonry_units;
create policy masonry_unit_write on public.masonry_units
  for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

-- Estimates: EVERY internal role on their own project, supervisors included.
-- There is no money on an estimate — it is quantities — and the supervisor is
-- the person standing in front of the wall who needs to know how many blocks to
-- order. Deliberately wider than MONEY_ROLES, and deliberately narrower than
-- "anyone": is_member() still scopes it to the project.
drop policy if exists mest_read on public.material_estimates;
create policy mest_read on public.material_estimates
  for select to authenticated using (public.is_internal() and public.is_member(project_id));

drop policy if exists mest_write on public.material_estimates;
create policy mest_write on public.material_estimates
  for all to authenticated
  using (public.is_internal() and public.is_member(project_id))
  with check (public.is_internal() and public.is_member(project_id));

drop policy if exists eline_read on public.estimate_lines;
create policy eline_read on public.estimate_lines
  for select to authenticated
  using (exists (select 1 from public.material_estimates e
                 where e.id = estimate_id
                   and public.is_internal() and public.is_member(e.project_id)));

drop policy if exists eline_write on public.estimate_lines;
create policy eline_write on public.estimate_lines
  for all to authenticated
  using (exists (select 1 from public.material_estimates e
                 where e.id = estimate_id
                   and public.is_internal() and public.is_member(e.project_id)))
  with check (exists (select 1 from public.material_estimates e
                 where e.id = estimate_id
                   and public.is_internal() and public.is_member(e.project_id)));


-- ############################################################
-- ### 10. GRANTS
-- ############################################################

grant select on public.calc_constants, public.calc_mixes, public.masonry_units to authenticated;
grant insert, update, delete on public.calc_constants, public.calc_mixes, public.masonry_units to authenticated;
grant select, insert, update, delete on public.material_estimates, public.estimate_lines to authenticated;

revoke all on function public.fn_n(numeric)             from public, anon;
revoke all on function public.fn_calc_const(text)        from public, anon;
revoke all on function public.fn_calc_bag_cum()          from public, anon;
revoke all on function public.fn_calc_cement(numeric)    from public, anon;
revoke all on function public.fn_calc_concrete(numeric, numeric, numeric, text, numeric) from public, anon;
revoke all on function public.fn_calc_masonry(numeric, numeric, text, text, numeric, numeric) from public, anon;
revoke all on function public.fn_calc_plaster(numeric, numeric, text, numeric) from public, anon;
revoke all on function public.fn_calc_tiling(numeric, numeric, numeric, numeric, numeric, numeric) from public, anon;
revoke all on function public.fn_calc_steel(numeric, numeric, int) from public, anon;
revoke all on function public.fn_calc_paint(numeric, int, numeric, numeric, boolean, numeric) from public, anon;
revoke all on function public.fn_calc_waterproofing(numeric, int, numeric, numeric) from public, anon;
revoke all on function public.fn_calc_excavation(numeric, numeric, numeric, int, numeric) from public, anon;
revoke all on function public.fn_estimate_vs_actual(uuid) from public, anon;
revoke all on function public.fn_calc_selftest()          from public, anon;

grant execute on function public.fn_n(numeric)             to authenticated;
grant execute on function public.fn_calc_const(text)        to authenticated;
grant execute on function public.fn_calc_bag_cum()          to authenticated;
grant execute on function public.fn_calc_cement(numeric)    to authenticated;
grant execute on function public.fn_calc_concrete(numeric, numeric, numeric, text, numeric) to authenticated;
grant execute on function public.fn_calc_masonry(numeric, numeric, text, text, numeric, numeric) to authenticated;
grant execute on function public.fn_calc_plaster(numeric, numeric, text, numeric) to authenticated;
grant execute on function public.fn_calc_tiling(numeric, numeric, numeric, numeric, numeric, numeric) to authenticated;
grant execute on function public.fn_calc_steel(numeric, numeric, int) to authenticated;
grant execute on function public.fn_calc_paint(numeric, int, numeric, numeric, boolean, numeric) to authenticated;
grant execute on function public.fn_calc_waterproofing(numeric, int, numeric, numeric) to authenticated;
grant execute on function public.fn_calc_excavation(numeric, numeric, numeric, int, numeric) to authenticated;
grant execute on function public.fn_estimate_vs_actual(uuid) to authenticated;
grant execute on function public.fn_calc_selftest()          to authenticated;


-- ############################################################
-- ### 11. AUDIT + TOUCH
-- ############################################################

-- Code-keyed, so `fn_audit_by_code` from 051 — `fn_audit` reads NEW.id and
-- would ABORT the write on a table keyed by text.
drop trigger if exists audit_calc_constants on public.calc_constants;
create trigger audit_calc_constants
  after insert or update or delete on public.calc_constants
  for each row execute function public.fn_audit_by_code();

drop trigger if exists audit_calc_mixes on public.calc_mixes;
create trigger audit_calc_mixes
  after insert or update or delete on public.calc_mixes
  for each row execute function public.fn_audit_by_code();

drop trigger if exists audit_masonry_units on public.masonry_units;
create trigger audit_masonry_units
  after insert or update or delete on public.masonry_units
  for each row execute function public.fn_audit_by_code();

create or replace function public.fn_calc_touch_constant()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists calc_const_touch on public.calc_constants;
create trigger calc_const_touch
  before update on public.calc_constants
  for each row execute function public.fn_calc_touch_constant();


-- ############################################################
-- ### 12. VERIFY  —  expect 12 rows all passed = t, then 3|11|7|10|13|16
-- ############################################################

select * from public.fn_calc_selftest() order by case_no;

select
  (select count(*) from information_schema.tables
    where table_schema = 'public'
      and table_name in ('calc_constants','calc_mixes','masonry_units'))                as tables_3,
  (select count(*) from public.calc_mixes)                                              as mixes_11,
  (select count(*) from public.masonry_units)                                           as units_7,
  (select count(*) from pg_policies where schemaname = 'public'
     and tablename in ('calc_constants','calc_mixes','masonry_units',
                       'material_estimates','estimate_lines'))                          as policies_10,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'fn_calc%')                           as calc_fns_11,
  (select count(*) from public.calc_constants)                                          as consts_16;
