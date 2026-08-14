-- ============================================================
-- MASON OS — Migration 051: Bar Bending Schedule per IS 2502 (B4, M13-C)
--
-- This module tells a bar bender how long to cut a piece of steel. Get it
-- wrong and either the bar is short — which is a structural defect nobody sees
-- again once the concrete is poured — or it is long, which is money in the
-- scrap bin. So the whole of it is arranged around being CHECKABLE rather than
-- merely correct:
--
--   1. Every constant is a row in `bbs_constants`, labelled, with its IS
--      reference and its units. Nothing is a magic number inside a function.
--      A structural engineer can read that table and audit the whole engine.
--   2. Every shape is a row in `bbs_shapes` carrying how many bends of each
--      angle it has and how many hooks. The formula is DATA, not code.
--   3. There is exactly ONE implementation of the arithmetic,
--      `fn_bbs_cutting_length`, and it returns the ANSWER AND ITS WORKING in
--      the same jsonb. The explanation on screen is therefore not a second
--      calculation that could drift from the number it explains — it is a
--      by-product of the same one.
--   4. `fn_bbs_selftest()` runs eight worked examples with known textbook
--      answers and reports pass/fail per case. It ships with the module and
--      can be re-run after anybody edits a constant.
--
-- ---------- THE RULES IMPLEMENTED ----------
-- Cutting length = Σ(straight segments) + hook allowances − bend deductions
--
--   Bend deduction   45°  = 1d      90°  = 2d      135° = 3d
--   Standard hook (180°)  = 9d per hook
--   Stirrup hook          = greater of 10d and 75 mm, per hook
--   Crank (bent-up bar)   = +0.42 × rise per crank, and 2 × 45° bends per crank
--   Unit weight           = d² / 162 kg per metre  (d in mm)
--
-- The 0.42 is (1/sin45° − 1/tan45°) = 1.414 − 1.000 = 0.414, rounded the way
-- every Indian site rounds it. It is in the constants table like everything
-- else, so a firm that prefers 0.414 changes one row.
--
-- ---------- WHAT THIS DELIBERATELY DOES NOT DO ----------
-- It does not decide HOW MANY bars a member needs, or their diameter, or where
-- the cranks go. That is design, it comes off a structural drawing, and a piece
-- of software that guessed at it would be doing engineering it is not qualified
-- to do. The schedule records what the drawing says and computes the cutting
-- lengths and weights from it — the arithmetic, which is where the errors
-- actually happen.
--
-- ---------- ACCESS ----------
-- Founder/PM author; EVERY project member reads, including supervisors. A bar
-- schedule is a site document — the person cutting the steel is exactly who
-- needs it — and it carries no rates, so there is nothing here to hide. Note
-- that the brief said "site engineer creates": under the standing designation
-- mapping "Site Engineer" is the `supervisor` access role, so an engineer who
-- must AUTHOR schedules is given a pm-mapped job title (Structural Engineer /
-- Planning Engineer). Adding a fifth role for one module would mean re-auditing
-- every policy in the database — the 043 decision, unchanged.
--
-- Idempotent: enum guarded, tables if-not-exists with explicit add-column,
-- policies drop-then-create, views drop-then-create, functions dropped by full
-- signature before create.
-- ============================================================


-- ############################################################
-- ###  1. ENUMS
-- ############################################################
do $$ begin
  create type bbs_member_type as enum
    ('footing', 'pile_cap', 'column', 'beam', 'slab', 'wall',
     'staircase', 'lintel', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  -- How the straight part of the bar is measured. Four kinds is all the
  -- catalogue needs; anything genuinely new gets a kind, not a special case
  -- buried in an if-branch.
  create type bbs_formula_kind as enum
    ('linear', 'crank', 'circular', 'spiral');
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  2. THE CONSTANTS — the auditable part
-- ############################################################
-- One row per number the engine uses. This table IS the specification: if it
-- disagrees with IS 2502 the module is wrong, and anybody can see that without
-- reading a line of SQL.
create table if not exists public.bbs_constants (
  code        text primary key,
  label       text not null,
  value       numeric(10,4) not null,
  unit        text not null,
  is_ref      text,
  note        text,
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);

insert into public.bbs_constants (code, label, value, unit, is_ref, note) values
  ('bend_45',         'Bend deduction — 45°',            1,  '× bar dia',
   'IS 2502',  'Length saved at a 45° bend, measured against the outside dimensions.'),
  ('bend_90',         'Bend deduction — 90°',            2,  '× bar dia',
   'IS 2502',  'The commonest deduction: every stirrup corner and every L-bend.'),
  ('bend_135',        'Bend deduction — 135°',           3,  '× bar dia',
   'IS 2502',  'Used at the two hook ends of a closed stirrup.'),
  ('hook_standard',   'Standard hook allowance (180°)',  9,  '× bar dia',
   'IS 2502',  'Added per hooked end. Assumes an internal bend radius of 2d.'),
  ('stirrup_hook_factor', 'Stirrup hook — multiple of dia', 10, '× bar dia',
   'IS 13920', 'Extension beyond a 135° stirrup hook.'),
  ('stirrup_hook_min_mm', 'Stirrup hook — minimum',      75, 'mm',
   'IS 13920', 'The stirrup hook is the GREATER of 10d and this figure.'),
  ('crank_factor',    'Extra length per crank',          0.42, '× crank rise',
   'IS 2502',  '1/sin45° − 1/tan45° = 0.414, rounded to 0.42 as on site.'),
  ('unit_weight_divisor', 'Unit weight divisor',         162, '—',
   'IS 1786',  'Unit weight = d² ÷ this, in kg per metre, d in mm.')
on conflict (code) do nothing;

-- `do nothing`, never `do update`: re-running the migration must not silently
-- reset a constant the firm's engineer has deliberately changed.


-- ############################################################
-- ###  3. THE SHAPE CATALOGUE — the formula as data
-- ############################################################
-- Σ straight = mult_a·A + mult_b·B + mult_c·C + mult_d·D, so a rectangular
-- stirrup is simply mult_a = mult_b = 2. The bend and hook counts sit beside
-- it, which means the whole formula for a shape is readable in one row.
create table if not exists public.bbs_shapes (
  code          text primary key,
  name          text not null,
  formula_kind  bbs_formula_kind not null default 'linear',

  mult_a numeric(6,3) not null default 0,
  mult_b numeric(6,3) not null default 0,
  mult_c numeric(6,3) not null default 0,
  mult_d numeric(6,3) not null default 0,

  n_bend_45      int not null default 0,
  n_bend_90      int not null default 0,
  n_bend_135     int not null default 0,
  n_hook_std     int not null default 0,
  n_hook_stirrup int not null default 0,

  -- What A/B/C/D mean for this shape, shown as the field labels on screen so
  -- nobody has to guess whether B is the second leg or the crank rise.
  label_a text, label_b text, label_c text, label_d text,
  formula text not null,
  sort_order int not null default 100,
  is_active boolean not null default true
);

insert into public.bbs_shapes
  (code, name, formula_kind, mult_a, mult_b, mult_c, mult_d,
   n_bend_45, n_bend_90, n_bend_135, n_hook_std, n_hook_stirrup,
   label_a, label_b, label_c, label_d, formula, sort_order)
values
  ('STR', 'Straight bar', 'linear', 1,0,0,0, 0,0,0,0,0,
   'Length', null, null, null,
   'A', 10),

  ('HOOK', 'Straight with hooks both ends', 'linear', 1,0,0,0, 0,0,0,2,0,
   'Length', null, null, null,
   'A + 2 × 9d', 20),

  ('LBEND', 'L-bend (one 90° bend)', 'linear', 1,1,0,0, 0,1,0,0,0,
   'Leg A', 'Leg B', null, null,
   'A + B − 2d', 30),

  ('UBEND', 'U-bar (two 90° bends)', 'linear', 1,1,1,0, 0,2,0,0,0,
   'Leg A', 'Leg B (base)', 'Leg C', null,
   'A + B + C − 2 × 2d', 40),

  -- n_bend_45 = 2 is PER CRANK; the function multiplies by the crank count.
  ('CRANK', 'Cranked / bent-up bar', 'crank', 1,0,0,0, 2,0,0,0,0,
   'Total run', 'Crank rise', null, null,
   'A + n × 0.42 × B − n × 2 × 1d', 50),

  -- 4 corners: three at 90°, and the two hook ends at 135°.
  ('STIRR-R', 'Rectangular stirrup / tie', 'linear', 2,2,0,0, 0,3,2,0,2,
   'Width (out-to-out)', 'Depth (out-to-out)', null, null,
   '2(A + B) + 2 × hook − 3 × 2d − 2 × 3d', 60),

  ('STIRR-C', 'Circular stirrup / tie', 'circular', 1,0,0,0, 0,0,2,0,2,
   'Tie centreline diameter', null, null, null,
   'π × A + 2 × hook − 2 × 3d', 70),

  ('SPIRAL', 'Spiral / helix', 'spiral', 1,0,0,0, 0,0,0,0,0,
   'Core centreline diameter', 'Pitch', 'Total height', null,
   '(C ÷ B + 1) × √((π × A)² + B²)', 80)
on conflict (code) do nothing;


-- ############################################################
-- ###  4. MEMBERS AND BARS
-- ############################################################
create table if not exists public.bbs_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  -- Optional tie to the programme, so steel can be reported per activity the
  -- way expenses already are. Nullable: a schedule is usually written before
  -- anybody has drawn the activity.
  activity_id uuid references public.schedule_activities(id) on delete set null,

  member_type bbs_member_type not null default 'beam',
  -- The mark as it appears on the drawing: B1, C2, F3. This is how the bender
  -- and the checker will refer to it, so it is what the PDF prints.
  mark text not null,
  description text,
  level text,
  drawing_ref text,

  -- Number of IDENTICAL members with this mark. The bar quantities below are
  -- per member; total quantity is this × that, computed in the view.
  member_count int not null default 1 check (member_count > 0),

  notes text,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bbs_members_project_idx
  on public.bbs_members (project_id, member_type, mark);

create table if not exists public.bbs_bars (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.bbs_members(id) on delete cascade,

  bar_mark text not null,
  -- The rolled sizes actually available. A typo of 15 instead of 16 would
  -- change the weight by 12% and nobody would notice on a printout.
  dia_mm int not null check (dia_mm in (6,8,10,12,16,20,25,28,32,36,40)),
  shape_code text not null references public.bbs_shapes(code),

  a_mm numeric(10,2) not null default 0 check (a_mm >= 0),
  b_mm numeric(10,2) not null default 0 check (b_mm >= 0),
  c_mm numeric(10,2) not null default 0 check (c_mm >= 0),
  d_mm numeric(10,2) not null default 0 check (d_mm >= 0),

  n_cranks int not null default 0 check (n_cranks >= 0),
  qty_per_member int not null default 1 check (qty_per_member > 0),

  remarks text,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists bbs_bars_member_idx
  on public.bbs_bars (member_id, sort_order);


-- ############################################################
-- ###  5. THE ENGINE — one function, answer plus working
-- ############################################################
-- Returns jsonb rather than a bare numeric so the breakdown travels WITH the
-- number. The screen prints `working` beside the answer; because both come out
-- of this one call, an explanation that disagrees with its own result is not
-- expressible.
--
-- STABLE, not IMMUTABLE: it reads the constants table, and a constant can be
-- edited. Marking it immutable would let Postgres cache a cutting length
-- computed under the old figures.
--
-- THE VIEWS ARE DROPPED FIRST, here rather than in §6, because they depend on
-- these two functions. Left in §6 the script runs once and then fails on every
-- re-run: `drop function` is refused ("other objects depend on it"), the
-- following `create function` errors with "already exists", and the OLD
-- function quietly survives — so the migration reports failure while the
-- database keeps stale arithmetic. Found by running this file twice against a
-- real Postgres. Anything a view calls must be dropped in dependency order.
drop view if exists public.v_bbs_project_steel cascade;
drop view if exists public.v_bbs_member_totals cascade;
drop view if exists public.v_bbs_bars cascade;

drop function if exists public.fn_bbs_cutting_length(text, numeric, numeric, numeric, numeric, numeric, int);
create function public.fn_bbs_cutting_length(
  p_shape  text,
  p_dia    numeric,
  p_a      numeric default 0,
  p_b      numeric default 0,
  p_c      numeric default 0,
  p_d      numeric default 0,
  p_cranks int default 0
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  s            public.bbs_shapes%rowtype;
  k_45         numeric; k_90 numeric; k_135 numeric;
  k_hook       numeric; k_sfac numeric; k_smin numeric; k_crank numeric;
  v_straight   numeric := 0;
  v_hooks      numeric := 0;
  v_deduct     numeric := 0;
  v_stirrup_hk numeric;
  v_total      numeric;
  v_turns      numeric;
  v_perturn    numeric;
  v_cranks     int;
  v_terms      text[] := '{}';
  v_warning    text;
begin
  select * into s from public.bbs_shapes where code = p_shape;
  if s.code is null then
    return jsonb_build_object('error', format('Unknown shape "%s"', p_shape));
  end if;
  if p_dia is null or p_dia <= 0 then
    return jsonb_build_object('error', 'Bar diameter is required.');
  end if;

  select value into k_45    from public.bbs_constants where code = 'bend_45';
  select value into k_90    from public.bbs_constants where code = 'bend_90';
  select value into k_135   from public.bbs_constants where code = 'bend_135';
  select value into k_hook  from public.bbs_constants where code = 'hook_standard';
  select value into k_sfac  from public.bbs_constants where code = 'stirrup_hook_factor';
  select value into k_smin  from public.bbs_constants where code = 'stirrup_hook_min_mm';
  select value into k_crank from public.bbs_constants where code = 'crank_factor';

  v_stirrup_hk := greatest(k_sfac * p_dia, k_smin);
  v_cranks     := greatest(coalesce(p_cranks, 0), 0);

  -- ---------- the straight part ----------
  if s.formula_kind = 'linear' then
    v_straight := s.mult_a * coalesce(p_a,0) + s.mult_b * coalesce(p_b,0)
                + s.mult_c * coalesce(p_c,0) + s.mult_d * coalesce(p_d,0);
    v_terms := v_terms || format('straight %s mm', round(v_straight, 2));

  elsif s.formula_kind = 'crank' then
    -- A is the run measured horizontally, B the rise of one crank. The extra
    -- steel is the difference between the sloping leg and its own horizontal
    -- projection, which is where 0.42 comes from.
    if v_cranks = 0 then
      v_warning := 'Crank count is zero — this is being computed as a straight bar.';
    end if;
    v_straight := coalesce(p_a,0) + v_cranks * k_crank * coalesce(p_b,0);
    v_terms := v_terms || format('run %s + %s crank(s) × %s × rise %s = %s mm',
                                 round(coalesce(p_a,0),2), v_cranks, trim_scale(k_crank),
                                 round(coalesce(p_b,0),2), round(v_straight,2));

  elsif s.formula_kind = 'circular' then
    v_straight := pi() * coalesce(p_a,0);
    v_terms := v_terms || format('π × %s = %s mm',
                                 round(coalesce(p_a,0),2), round(v_straight,2));

  elsif s.formula_kind = 'spiral' then
    if coalesce(p_b,0) <= 0 then
      return jsonb_build_object('error', 'A spiral needs a pitch greater than zero.');
    end if;
    -- One turn is the hypotenuse of the unrolled circumference and the pitch.
    -- The +1 turn is the closing turn at the top.
    v_turns   := coalesce(p_c,0) / p_b + 1;
    v_perturn := sqrt(power(pi() * coalesce(p_a,0), 2) + power(p_b, 2));
    v_straight := v_turns * v_perturn;
    v_terms := v_terms || format('%s turns × %s mm per turn = %s mm',
                                 round(v_turns,3), round(v_perturn,2),
                                 round(v_straight,2));
  end if;

  -- ---------- hooks ----------
  if s.n_hook_std > 0 then
    v_hooks := v_hooks + s.n_hook_std * k_hook * p_dia;
    v_terms := v_terms || format('+ %s × %sd hook = %s mm',
                                 s.n_hook_std, trim_scale(k_hook),
                                 round(s.n_hook_std * k_hook * p_dia, 2));
  end if;
  if s.n_hook_stirrup > 0 then
    v_hooks := v_hooks + s.n_hook_stirrup * v_stirrup_hk;
    v_terms := v_terms || format('+ %s × stirrup hook %s mm = %s mm',
                                 s.n_hook_stirrup, round(v_stirrup_hk,2),
                                 round(s.n_hook_stirrup * v_stirrup_hk, 2));
  end if;

  -- ---------- bend deductions ----------
  -- On a crank the 45° count on the shape row is PER CRANK, so it scales.
  declare
    n45 int := case when s.formula_kind = 'crank'
                    then s.n_bend_45 * v_cranks else s.n_bend_45 end;
  begin
    if n45 > 0 then
      v_deduct := v_deduct + n45 * k_45 * p_dia;
      v_terms := v_terms || format('− %s × 45° (%sd) = %s mm',
                                   n45, trim_scale(k_45), round(n45 * k_45 * p_dia, 2));
    end if;
  end;

  if s.n_bend_90 > 0 then
    v_deduct := v_deduct + s.n_bend_90 * k_90 * p_dia;
    v_terms := v_terms || format('− %s × 90° (%sd) = %s mm',
                                 s.n_bend_90, trim_scale(k_90),
                                 round(s.n_bend_90 * k_90 * p_dia, 2));
  end if;
  if s.n_bend_135 > 0 then
    v_deduct := v_deduct + s.n_bend_135 * k_135 * p_dia;
    v_terms := v_terms || format('− %s × 135° (%sd) = %s mm',
                                 s.n_bend_135, trim_scale(k_135),
                                 round(s.n_bend_135 * k_135 * p_dia, 2));
  end if;

  v_total := v_straight + v_hooks - v_deduct;

  -- A non-positive cutting length means the input is wrong — a stirrup smaller
  -- than its own bend deductions, usually a dimension typed in cm. It is
  -- REPORTED, never clamped: a silently corrected number is the one that gets
  -- cut.
  if v_total <= 0 then
    v_warning := 'Cutting length is zero or negative — check the dimensions and units (all dimensions are millimetres).';
  end if;

  return jsonb_build_object(
    'shape',             s.code,
    'shape_name',        s.name,
    'dia_mm',            p_dia,
    'straight_mm',       round(v_straight, 2),
    'hooks_mm',          round(v_hooks, 2),
    'deductions_mm',     round(v_deduct, 2),
    'cutting_length_mm', round(v_total, 2),
    'formula',           s.formula,
    'working',           array_to_string(v_terms, '  '),
    'warning',           v_warning
  );
end $$;

revoke all on function public.fn_bbs_cutting_length(text, numeric, numeric, numeric, numeric, numeric, int) from public, anon;
grant execute on function public.fn_bbs_cutting_length(text, numeric, numeric, numeric, numeric, numeric, int) to authenticated;


-- ---------- unit weight ----------
drop function if exists public.fn_bbs_unit_weight(numeric);
create function public.fn_bbs_unit_weight(p_dia numeric)
returns numeric
language sql
stable
set search_path = public
as $$
  select round(p_dia * p_dia /
               (select value from public.bbs_constants where code = 'unit_weight_divisor'),
               4);
$$;

revoke all on function public.fn_bbs_unit_weight(numeric) from public, anon;
grant execute on function public.fn_bbs_unit_weight(numeric) to authenticated;


-- ############################################################
-- ###  6. THE SCHEDULE — one row per bar mark
-- ############################################################
-- (The drops for these three live in §5, above the functions they depend on.)
create view public.v_bbs_bars with (security_invoker = true) as
select
  b.id                    as bar_id,
  m.id                    as member_id,
  m.project_id,
  m.member_type,
  m.mark                  as member_mark,
  m.member_count,
  m.activity_id,

  b.bar_mark,
  b.dia_mm,
  b.shape_code,
  sh.name                 as shape_name,
  b.a_mm, b.b_mm, b.c_mm, b.d_mm,
  b.n_cranks,
  b.qty_per_member,
  b.remarks,
  b.sort_order,

  calc.j                                                as calc,
  ((calc.j)->>'cutting_length_mm')::numeric(12,2)        as cutting_length_mm,
  ((calc.j)->>'working')                                 as working,
  ((calc.j)->>'warning')                                 as warning,

  (b.qty_per_member * m.member_count)                    as total_qty,

  -- Length in metres, and the total for all identical members. Rounded once,
  -- here, so every roll-up below adds the same numbers the schedule prints.
  round(((calc.j)->>'cutting_length_mm')::numeric / 1000, 3)
                                                         as cutting_length_m,
  round(((calc.j)->>'cutting_length_mm')::numeric / 1000
        * b.qty_per_member * m.member_count, 3)          as total_length_m,

  public.fn_bbs_unit_weight(b.dia_mm)                    as unit_weight_kg_m,
  round(((calc.j)->>'cutting_length_mm')::numeric / 1000
        * b.qty_per_member * m.member_count
        * public.fn_bbs_unit_weight(b.dia_mm), 3)        as total_weight_kg
from public.bbs_bars b
join public.bbs_members m on m.id = b.member_id
join public.bbs_shapes sh on sh.code = b.shape_code
cross join lateral (
  select public.fn_bbs_cutting_length(
           b.shape_code, b.dia_mm, b.a_mm, b.b_mm, b.c_mm, b.d_mm, b.n_cranks
         ) as j
) calc;

grant select on public.v_bbs_bars to authenticated;


create view public.v_bbs_member_totals with (security_invoker = true) as
select
  m.id            as member_id,
  m.project_id,
  m.member_type,
  m.mark,
  m.description,
  m.level,
  m.drawing_ref,
  m.member_count,
  m.activity_id,
  m.created_at,
  count(v.bar_id)::int                              as bar_marks,
  coalesce(sum(v.total_qty), 0)::int                as total_bars,
  coalesce(sum(v.total_length_m), 0)::numeric(12,3) as total_length_m,
  coalesce(sum(v.total_weight_kg), 0)::numeric(12,3) as total_weight_kg,
  count(*) filter (where v.warning is not null)::int as warnings
from public.bbs_members m
left join public.v_bbs_bars v on v.member_id = m.id
group by m.id, m.project_id, m.member_type, m.mark, m.description, m.level,
         m.drawing_ref, m.member_count, m.activity_id, m.created_at;

grant select on public.v_bbs_member_totals to authenticated;


-- Steel by diameter — the number that gets ordered, so it is a view rather
-- than something the screen adds up.
create view public.v_bbs_project_steel with (security_invoker = true) as
select
  v.project_id,
  v.dia_mm,
  count(*)::int                                     as bar_marks,
  sum(v.total_qty)::int                             as total_bars,
  sum(v.total_length_m)::numeric(12,3)              as total_length_m,
  max(v.unit_weight_kg_m)::numeric(10,4)            as unit_weight_kg_m,
  sum(v.total_weight_kg)::numeric(12,3)             as total_weight_kg
from public.v_bbs_bars v
group by v.project_id, v.dia_mm;

grant select on public.v_bbs_project_steel to authenticated;


-- ############################################################
-- ###  7. THE SELF-TEST
-- ############################################################
-- Eight worked examples with answers taken from standard IS 2502 practice. The
-- expected values are hand-derived and written out longhand in `working`, so a
-- reviewer can check the EXPECTATION as well as the result.
--
-- Run it after editing any constant. A module that computes steel lengths
-- should be able to prove itself on demand rather than being taken on trust.
drop function if exists public.fn_bbs_selftest();
create function public.fn_bbs_selftest()
returns table (
  case_no     int,
  case_name   text,
  hand_working text,
  expected_mm numeric,
  computed_mm numeric,
  diff_mm     numeric,
  passed      boolean
)
language plpgsql
stable
set search_path = public
as $$
declare
  t record;
  v numeric;
begin
  for t in
    select * from (values
      (1, 'Rectangular stirrup — beam 300×450, cover 25, 8 mm',
          '2(250+400) + 2×80 − 3×16 − 2×24 = 1300 + 160 − 48 − 48',
          'STIRR-R', 8::numeric, 250::numeric, 400::numeric, 0::numeric, 0::numeric, 0,
          1364::numeric),
      (2, 'Rectangular tie — column 400×400, cover 40, 8 mm',
          '2(320+320) + 2×80 − 3×16 − 2×24 = 1280 + 160 − 48 − 48',
          'STIRR-R', 8, 320, 320, 0, 0, 0,
          1344),
      (3, 'L-bar — 2000 + 500, 16 mm, one 90° bend',
          '2000 + 500 − 2×16',
          'LBEND', 16, 2000, 500, 0, 0, 0,
          2468),
      (4, 'U-bar — 300 + 600 + 300, 12 mm, two 90° bends',
          '1200 − 2 × (2×12)',
          'UBEND', 12, 300, 600, 300, 0, 0,
          1152),
      (5, 'Straight bar 4000 with a standard hook each end, 12 mm',
          '4000 + 2 × 9 × 12',
          'HOOK', 12, 4000, 0, 0, 0, 0,
          4216),
      (6, 'Cranked bar — run 5000, rise 384, 16 mm, 2 cranks',
          '5000 + 2 × 0.42 × 384 − 4 × 1 × 16 = 5000 + 322.56 − 64',
          'CRANK', 16, 5000, 384, 0, 0, 2,
          5258.56),
      (7, 'Circular tie — centreline dia 412, 8 mm',
          'π × 412 + 2×80 − 2×24 = 1294.34 + 160 − 48',
          'STIRR-C', 8, 412, 0, 0, 0, 0,
          1406.34),
      (8, 'Spiral — core 400, pitch 75, height 3000, 8 mm',
          '(3000/75 + 1) × √((π×400)² + 75²) = 41 × 1258.87',
          'SPIRAL', 8, 400, 75, 3000, 0, 0,
          51613.80)
    ) as x(no, nm, hw, shape, dia, a, b, c, d, cranks, expect)
  loop
    v := ((public.fn_bbs_cutting_length(t.shape, t.dia, t.a, t.b, t.c, t.d, t.cranks))
          ->>'cutting_length_mm')::numeric;

    case_no      := t.no;
    case_name    := t.nm;
    hand_working := t.hw;
    expected_mm  := t.expect;
    computed_mm  := v;
    diff_mm      := round(v - t.expect, 2);
    -- 0.01 mm, not "close enough": these are exact arithmetic, and a tolerance
    -- wide enough to hide a real error is worse than no test.
    passed       := abs(v - t.expect) < 0.01;
    return next;
  end loop;
end $$;

revoke all on function public.fn_bbs_selftest() from public, anon;
grant execute on function public.fn_bbs_selftest() to authenticated;


-- ############################################################
-- ###  8. RLS
-- ############################################################
alter table public.bbs_constants enable row level security;
alter table public.bbs_shapes    enable row level security;
alter table public.bbs_members   enable row level security;
alter table public.bbs_bars      enable row level security;

-- Constants and shapes: everybody reads (the site copy shows the working, and
-- the working cites these), founder alone writes. Changing a constant silently
-- restates every schedule in the database, so it is the narrowest write in the
-- module.
drop policy if exists bbs_const_read on public.bbs_constants;
create policy bbs_const_read on public.bbs_constants
  for select to authenticated using (true);

drop policy if exists bbs_const_write on public.bbs_constants;
create policy bbs_const_write on public.bbs_constants
  for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

drop policy if exists bbs_shape_read on public.bbs_shapes;
create policy bbs_shape_read on public.bbs_shapes
  for select to authenticated using (true);

drop policy if exists bbs_shape_write on public.bbs_shapes;
create policy bbs_shape_write on public.bbs_shapes
  for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

-- Members and bars: every project member READS — the bar bender is the whole
-- audience — founder/PM write.
drop policy if exists bbs_member_read on public.bbs_members;
create policy bbs_member_read on public.bbs_members
  for select to authenticated using (public.is_member(project_id));

drop policy if exists bbs_member_write on public.bbs_members;
create policy bbs_member_write on public.bbs_members
  for all to authenticated
  using (public.my_role() in ('founder','pm') and public.is_member(project_id))
  with check (public.my_role() in ('founder','pm') and public.is_member(project_id));

drop policy if exists bbs_bar_read on public.bbs_bars;
create policy bbs_bar_read on public.bbs_bars
  for select to authenticated
  using (exists (select 1 from public.bbs_members m
                 where m.id = member_id and public.is_member(m.project_id)));

drop policy if exists bbs_bar_write on public.bbs_bars;
create policy bbs_bar_write on public.bbs_bars
  for all to authenticated
  using (exists (select 1 from public.bbs_members m
                 where m.id = member_id
                   and public.my_role() in ('founder','pm')
                   and public.is_member(m.project_id)))
  with check (exists (select 1 from public.bbs_members m
                 where m.id = member_id
                   and public.my_role() in ('founder','pm')
                   and public.is_member(m.project_id)));

-- Ordinary DELETE (covered by the `for all` policies above) rather than a trip
-- through fn_delete_record: a schedule line is a statement about a drawing, not
-- a record of anything that happened. Nothing references it, no money moves, no
-- stock moves. Deleting a member cascades to its bars, which is right — the
-- bars have no meaning without it.


-- ############################################################
-- ###  9. AUDIT
-- ############################################################
-- `fn_audit` from 001 does `coalesce(new.id::text, old.id::text)`, so it works
-- only on tables with an `id` column. `bbs_constants` and `bbs_shapes` are keyed
-- by `code` — attaching fn_audit to them raises
--   record "new" has no field "id"
-- and, because the trigger is part of the same transaction, ABORTS the write.
-- The symptom is nasty: the edit appears to succeed on screen and the value is
-- unchanged. (Found by running this migration against a real Postgres before
-- shipping it, not by reading it.)
--
-- Rather than bolt a surrogate `id` onto two tables whose natural key is a
-- short code, this is a second audit function for code-keyed tables. Same rows
-- in the same audit_log, keyed the way the table actually is.
create or replace function public.fn_audit_by_code()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values (tg_table_name, tg_op,
          coalesce(new.code, old.code),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- The constants get an audit trigger for the same reason they get the narrowest
-- write policy: an edit here restates every cutting length in the database, and
-- "who changed 9d to 8d, and when" is the first question after a short bar.
drop trigger if exists audit_bbs_constants on public.bbs_constants;
create trigger audit_bbs_constants
  after insert or update or delete on public.bbs_constants
  for each row execute function public.fn_audit_by_code();

drop trigger if exists audit_bbs_shapes on public.bbs_shapes;
create trigger audit_bbs_shapes
  after insert or update or delete on public.bbs_shapes
  for each row execute function public.fn_audit_by_code();

drop trigger if exists audit_bbs_members on public.bbs_members;
create trigger audit_bbs_members
  after insert or update or delete on public.bbs_members
  for each row execute function public.fn_audit();

drop trigger if exists audit_bbs_bars on public.bbs_bars;
create trigger audit_bbs_bars
  after insert or update or delete on public.bbs_bars
  for each row execute function public.fn_audit();

-- Stamp who last edited a constant, so the audit row and the table agree.
create or replace function public.fn_bbs_touch_constant()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists bbs_const_touch on public.bbs_constants;
create trigger bbs_const_touch
  before update on public.bbs_constants
  for each row execute function public.fn_bbs_touch_constant();


-- ############################################################
-- ### 10. VERIFY  —  run this and read the `passed` column
-- ############################################################
select * from public.fn_bbs_selftest() order by case_no;

select p.proname, count(*)::int as arities
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_bbs_cutting_length', 'fn_bbs_unit_weight',
                    'fn_bbs_selftest', 'fn_bbs_touch_constant', 'fn_audit_by_code')
group by p.proname
order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('bbs_constants', 'bbs_shapes', 'bbs_members', 'bbs_bars',
                     'v_bbs_bars', 'v_bbs_member_totals', 'v_bbs_project_steel')
order by table_name;
