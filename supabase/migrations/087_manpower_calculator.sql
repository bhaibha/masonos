-- ============================================================================
-- 087  M14  MANPOWER CALCULATOR
-- ============================================================================
--
-- Pick an activity, type a quantity, get the gang, the man-days and how long it
-- will take. The other half of M13-A: same question, same input, different
-- answer — one says what to order, this one says who to send.
--
-- ---------------------------------------------------------------------------
-- ABOUT IS 7272, SAID PLAINLY
-- ---------------------------------------------------------------------------
-- IS 7272 is "Recommendation for Labour Output Constants for Building Work".
-- **Part 1 is the NORTH zone** (1974, reaffirmed 2010); Part 2 is the SOUTH
-- zone. This firm builds in Bengaluru, so Part 2 is the relevant one — and the
-- copy that circulates freely online is Part 1, which is the wrong half of the
-- country. Worth knowing before anybody types figures in.
--
-- **NOTHING SEEDED HERE IS AN IS 7272 FIGURE, AND NOTHING CLAIMS TO BE.**
-- BIS standards are documents you buy, and the 044 rule in this repo is cite a
-- standard, never transcribe it. Beyond the copyright, an output constant
-- recalled rather than read is a guess wearing a standard's authority, which is
-- the 058 failure exactly — confidently wrong about the number that reaches a
-- gang. So every seeded row is `source = 'site_practice'` and
-- `verified = false`, `is_ref` is NULL, and the calculator WARNS on every
-- result computed from an unverified constant.
--
-- The remedy is one screen away: a founder opens Reference, types the figure
-- from their own copy of the standard or from the firm's own records, sets
-- `is_ref` and ticks verified. The table then belongs to the firm rather than
-- to whoever wrote this migration — which is the 053 rule (the client's own
-- sheet is the authority on the client's own constants) and the 046 rule (take
-- their form, do not improve it).
--
-- ---------------------------------------------------------------------------
-- THE GANG IS THE UNIT, NOT THE TRADE
-- ---------------------------------------------------------------------------
-- A constant could be stored per trade ("a mason lays 0.9 cum a day") or per
-- GANG ("1 mason and 2 helpers lay 1.1 cum a day"). Both are arithmetically
-- equivalent and the gang is the honest one: a mason without a helper does not
-- lay brick, and a site sends gangs, not individuals. So `output_per_gang_day`
-- sits on the activity and `labour_gang_lines` says who is in the gang. The
-- per-trade man-days everybody actually wants are DERIVED and returned
-- alongside, so both readings exist without two stored numbers that can drift.
--
--   gang_days   = qty / (output_per_gang_day × efficiency)
--   man_days[t] = gang_days × persons_of_trade_t
--   duration    = ceil(gang_days / number_of_gangs)
--
-- ---------------------------------------------------------------------------
-- THE TRADES ARE 054's TRADES
-- ---------------------------------------------------------------------------
-- `labour_gang_lines.trade` is a FK to `labour_trades(name)` — the same list
-- the attendance register has used since 054. A second list of "Mason /
-- Helper" would drift the first time somebody added one to either, and then
-- planned man-days and recorded man-days would be about different people (the
-- 062 reuse-the-enum rule).
--
-- That shared list is also what makes `fn_manpower_vs_actual` possible with NO
-- NEW COLUMN: `labour_attendance` already carries `trade`, `workers_present`
-- and `activity_id`, so planned against worked is a join, not a feature.
--
-- ---------------------------------------------------------------------------
-- IT DOES NOT TOUCH THE PROGRAMME
-- ---------------------------------------------------------------------------
-- Saving an estimate against a `schedule_activities` row REPORTS the gap —
-- "you have allowed 14 days, this gang needs 18" — and never writes
-- planned_end. 042 gave `fn_generate_schedule` ownership of the dates and made
-- it stretch the final activity to land on the handover; a calculator quietly
-- restating that would produce a programme claiming one date and drawn to
-- another. Same shape as `fn_labour_headcount_check` (054): show both numbers
-- and the variance, let a person decide.
--
-- No money anywhere — wage rates live in `labour_rates` (054) and are not read
-- here. Man-days are not wages, so every internal role including supervisors
-- may use this.
--
-- Depends on: 001 (profiles/projects/audit), 042 (schedule_activities),
-- 051 (fn_audit_by_code), 054 (labour_trades, labour_attendance),
-- 065 (is_internal). Independent of 085/086.
-- ============================================================================


-- ############################################################
-- ### 1. THE CONSTANTS  —  one labelled row per activity
-- ############################################################

create table if not exists public.labour_activities (
  code        text primary key,
  label       text not null,
  category    text not null,
  -- What a quantity of this activity is measured in. Matches the units the
  -- material calculator already speaks (086) so a person can carry a figure
  -- from one tab to the other without converting.
  unit        text not null,

  -- NULLABLE ON PURPOSE. A row with no output is a row nobody has filled in,
  -- and `fn_manpower` refuses it by name rather than inventing one.
  output_per_gang_day numeric(10,3) check (output_per_gang_day is null or output_per_gang_day > 0),

  -- 'site_practice' = a starting figure shipped with the app, believed
  -- reasonable and confirmed by nobody. 'firm' = the firm measured it.
  -- 'is_code' = taken from a purchased standard, with is_ref naming the table.
  source      text not null default 'site_practice'
              check (source in ('site_practice','firm','is_code')),
  -- Free text, e.g. "IS 7272 (Part 2) Table 4". Blank until somebody with the
  -- document in front of them fills it in.
  is_ref      text,

  -- The honesty mechanism. Ships FALSE on every seeded row.
  verified    boolean not null default false,
  verified_by uuid references public.profiles(id),
  verified_on date,

  note        text,
  is_active   boolean not null default true,
  sort        int not null default 100,
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now(),

  -- A row cannot claim to come from a code without saying which clause.
  constraint la_is_ref_needed check (source <> 'is_code' or coalesce(btrim(is_ref),'') <> ''),
  -- Verified means somebody put their name to it.
  constraint la_verified_has_who check (
    not verified or (verified_by is not null and verified_on is not null))
);

alter table public.labour_activities enable row level security;


-- ############################################################
-- ### 2. THE GANG  —  who does it, from 054's trade list
-- ############################################################

create table if not exists public.labour_gang_lines (
  activity_code text not null references public.labour_activities(code) on delete cascade,
  trade         text not null references public.labour_trades(name),
  -- Fractional on purpose: a mestri supervising four gangs is 0.25 of each.
  persons       numeric(6,2) not null check (persons > 0),
  sort          int not null default 100,
  primary key (activity_code, trade)
);

alter table public.labour_gang_lines enable row level security;


-- ############################################################
-- ### 3. SEED  —  starting figures, owned by nobody yet
-- ############################################################
--
-- `on conflict do nothing` throughout: a founder who has corrected a figure
-- must never have it reset by a re-run (the 051/086 rule).
--
-- Read every number below as "somebody's rough idea of a normal day", because
-- that is what it is. They are here so the screen is usable on day one and so
-- the SHAPE is obvious, not because they are right for this firm's gangs, this
-- firm's sites or this firm's supervision.

insert into public.labour_activities (code, label, category, unit, output_per_gang_day, note, sort) values
  -- ---------- MASONRY ----------
  ('brick_230',    'Brickwork 230 mm',                   'Masonry',   'cum',  1.100,
   'Traditional brick in cement mortar, straight walls. Openings, corners and curved work are slower.', 10),
  ('block_200',    'Solid block masonry 200 mm',         'Masonry',   'sqm',  9.000,
   'Solid concrete block, 400×200 face.', 20),
  ('block_150',    'Solid block masonry 150 mm',         'Masonry',   'sqm', 10.000, null, 30),
  ('block_100',    'Solid block masonry 100 mm',         'Masonry',   'sqm', 12.000,
   'Partition block. Faster because the units are lighter.', 40),
  ('block_aac',    'AAC block masonry',                  'Masonry',   'sqm', 14.000,
   'Thin-bed adhesive and a lighter unit, so noticeably faster than concrete block.', 50),

  -- ---------- PLASTER ----------
  ('plaster_int',  'Internal plaster 12 mm',             'Plaster',   'sqm', 11.000, null, 110),
  ('plaster_ext',  'External plaster 20 mm',             'Plaster',   'sqm',  7.000,
   'Slower than internal: two coats, scaffolding, and weather.', 120),
  ('plaster_ceil', 'Ceiling plaster',                    'Plaster',   'sqm',  7.000,
   'Overhead work. Do not plan it at internal-wall rates.', 130),

  -- ---------- CONCRETE ----------
  ('pcc_manual',   'PCC, mixed and laid on site',        'Concrete',  'cum',  5.000, null, 210),
  ('rcc_manual',   'RCC, mixed and placed on site',      'Concrete',  'cum',  4.000,
   'Site mixing. The gang is large because the mixer, the barrows and the vibrator all need somebody.', 220),
  ('rcc_pump',     'RCC placing from ready-mix pump',    'Concrete',  'cum', 28.000,
   'PLACING ONLY — the concrete arrives. This is the figure that makes a pour day look easy and the shuttering week look hard.', 230),

  -- ---------- RCC ANCILLARY ----------
  ('rebar_fix',    'Reinforcement cut, bend and fix',    'RCC',       'tonne', 0.250,
   'A quarter tonne per gang-day, i.e. about eight man-days a tonne. Heavily dependent on bar size — small-diameter slab mesh is far slower per tonne than column mains.', 310),
  ('form_fix',     'Shuttering — fix',                   'RCC',       'sqm', 10.000, null, 320),
  ('form_strike',  'Shuttering — strike and clean',      'RCC',       'sqm', 25.000,
   'Much faster than fixing, and routinely forgotten when a programme is drawn.', 330),

  -- ---------- TILING ----------
  ('tile_floor',   'Floor tiling',                       'Tiling',    'sqm', 11.000,
   'Large-format tile on a level bed. Small tile, patterns and diagonal laying are slower.', 410),
  ('tile_wall',    'Wall tiling / dado',                 'Tiling',    'sqm',  7.000,
   'Slower than floor: every course is set and checked.', 420),

  -- ---------- FINISHES ----------
  ('putty',        'Wall putty, two coats',              'Finishes',  'sqm', 35.000, null, 510),
  ('paint_int',    'Internal primer + two coats',        'Finishes',  'sqm', 40.000, null, 520),
  ('paint_ext',    'External paint / texture',           'Finishes',  'sqm', 25.000,
   'Scaffolding and weather again.', 530),
  ('ceiling_gyp',  'Gypsum false ceiling',               'Finishes',  'sqm', 12.000,
   'Plain ceiling. Coves, steps and light troughs are a different job.', 540),
  ('waterproof',   'Waterproofing, cementitious',        'Finishes',  'sqm', 30.000,
   'Coats only. Fillets, corners and the day spent waiting between coats are not in this figure.', 550),
  ('door_frame',   'Door / window frame fixing',         'Finishes',  'nos',  4.000, null, 560),
  ('door_shutter', 'Shutter hanging with hardware',      'Finishes',  'nos',  3.000, null, 570),

  -- ---------- EARTHWORK ----------
  ('exc_soft',     'Manual excavation, soft soil',       'Earthwork', 'cum', 15.000,
   'Ordinary soil within 1.5 m depth. Deeper means lifting, which is slower per cum.', 610),
  ('exc_hard',     'Manual excavation, hard soil',       'Earthwork', 'cum',  7.000,
   'Hard murum. Rock needs breaking and is not this line.', 620),
  ('backfill',     'Backfill and consolidate',           'Earthwork', 'cum', 20.000,
   'In layers with watering and ramming.', 630)
on conflict (code) do nothing;

insert into public.labour_gang_lines (activity_code, trade, persons, sort) values
  ('brick_230','Mason',1,10),           ('brick_230','Helper',2,20),
  ('block_200','Mason',1,10),           ('block_200','Helper',2,20),
  ('block_150','Mason',1,10),           ('block_150','Helper',2,20),
  ('block_100','Mason',1,10),           ('block_100','Helper',2,20),
  ('block_aac','Mason',1,10),           ('block_aac','Helper',1,20),
  ('plaster_int','Mason',1,10),         ('plaster_int','Helper',2,20),
  ('plaster_ext','Mason',1,10),         ('plaster_ext','Helper',2,20),
  ('plaster_ceil','Mason',1,10),        ('plaster_ceil','Helper',2,20),
  ('pcc_manual','Mason',1,10),          ('pcc_manual','Helper',6,20),
  ('rcc_manual','Mason',1,10),          ('rcc_manual','Helper',8,20),
  ('rcc_pump','Mason',2,10),            ('rcc_pump','Helper',8,20),
  ('rebar_fix','Bar bender',1,10),      ('rebar_fix','Helper',1,20),
  ('form_fix','Shuttering carpenter',1,10),   ('form_fix','Helper',1,20),
  ('form_strike','Shuttering carpenter',1,10),('form_strike','Helper',2,20),
  ('tile_floor','Tiler',1,10),          ('tile_floor','Helper',1,20),
  ('tile_wall','Tiler',1,10),           ('tile_wall','Helper',1,20),
  ('putty','Painter',1,10),             ('putty','Helper',1,20),
  ('paint_int','Painter',1,10),         ('paint_int','Helper',1,20),
  ('paint_ext','Painter',1,10),         ('paint_ext','Helper',1,20),
  ('ceiling_gyp','Carpenter',1,10),     ('ceiling_gyp','Helper',1,20),
  ('waterproof','Mason',1,10),          ('waterproof','Helper',1,20),
  ('door_frame','Carpenter',1,10),      ('door_frame','Helper',1,20),
  ('door_shutter','Carpenter',1,10),    ('door_shutter','Helper',1,20),
  ('exc_soft','Mestri',1,10),           ('exc_soft','Helper',5,20),
  ('exc_hard','Mestri',1,10),           ('exc_hard','Helper',5,20),
  ('backfill','Mestri',1,10),           ('backfill','Helper',5,20)
on conflict (activity_code, trade) do nothing;


-- ############################################################
-- ### 4. SAVED ESTIMATES
-- ############################################################

create table if not exists public.manpower_estimates (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  activity_code text not null references public.labour_activities(code),

  title         text not null check (btrim(title) <> ''),
  work_area     text,

  qty            numeric(14,3) not null check (qty > 0),
  gangs          int not null default 1 check (gangs > 0),
  efficiency_pct numeric(6,2) not null default 100
                 check (efficiency_pct >= 10 and efficiency_pct <= 200),

  -- FROZEN AT SAVE. Not recomputed on read: correct an output constant next
  -- year and what was planned this year must still read as it was planned
  -- (032/045/086).
  gang_days      numeric(12,3) not null,
  duration_days  int not null,
  total_man_days numeric(12,3) not null,
  -- TRUE when the constant behind this was still unconfirmed at the moment of
  -- saving. Stored, not derived, so the record says what it was worth AT THE
  -- TIME rather than borrowing today's confidence.
  from_unverified boolean not null default true,

  -- The programme row this plans, when there is one. SET NULL, never cascade —
  -- deleting an activity must not delete the record that somebody worked out
  -- how long it would take (the 031 container rule).
  activity_id   uuid references public.schedule_activities(id) on delete set null,

  working       text,
  notes         text,
  created_by    uuid not null default auth.uid() references public.profiles(id),
  created_at    timestamptz not null default now()
);

create table if not exists public.manpower_estimate_lines (
  id          uuid primary key default gen_random_uuid(),
  estimate_id uuid not null references public.manpower_estimates(id) on delete cascade,
  trade       text not null references public.labour_trades(name),
  persons_per_gang numeric(6,2) not null,
  man_days    numeric(12,3) not null,
  sort        int not null default 100
);

alter table public.manpower_estimates      enable row level security;
alter table public.manpower_estimate_lines enable row level security;

create index if not exists mpe_project_idx  on public.manpower_estimates (project_id, created_at desc);
create index if not exists mpe_activity_idx on public.manpower_estimates (activity_id) where activity_id is not null;
create index if not exists mpel_est_idx     on public.manpower_estimate_lines (estimate_id);


-- ############################################################
-- ### 5. THE CALCULATOR
-- ############################################################

-- Returns the answer and the working together, in one jsonb, built from the
-- same variables — the 051 rule, so the explanation on screen cannot describe
-- arithmetic the function is no longer doing.
--
-- `p_target_days` is the question a PM actually asks, backwards: not "how long
-- with two gangs" but "how many gangs to finish in ten days". Both directions
-- come back in one call because they are one division.
drop function if exists public.fn_manpower(text, numeric, int, numeric, int);
create function public.fn_manpower(
  p_activity_code text,
  p_qty           numeric,
  p_gangs         int default 1,
  p_efficiency_pct numeric default 100,
  p_target_days   int default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  a            public.labour_activities%rowtype;
  v_eff        numeric := coalesce(p_efficiency_pct, 100);
  v_out        numeric;
  v_gang_days  numeric;
  v_duration   int;
  v_gang_size  numeric;
  v_total_md   numeric;
  v_lines      jsonb := '[]'::jsonb;
  v_gangs_for  int;
  v_warn       text;
  r            record;
begin
  if coalesce(p_qty, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Quantity must be more than zero.');
  end if;
  if coalesce(p_gangs, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', 'There has to be at least one gang.');
  end if;
  if v_eff < 10 or v_eff > 200 then
    return jsonb_build_object('ok', false,
      'error', 'Efficiency must be between 10% and 200%. Outside that the figure is not an adjustment, it is a different activity.');
  end if;

  select * into a from public.labour_activities where code = p_activity_code;
  if not found then
    return jsonb_build_object('ok', false,
      'error', format('No activity is held with the code "%s".', p_activity_code));
  end if;

  -- A row nobody has filled in is refused BY NAME, never guessed past.
  if a.output_per_gang_day is null then
    return jsonb_build_object('ok', false,
      'error', format('"%s" has no daily output recorded yet. A founder can set it on the Reference tab — the app will not invent one.', a.label));
  end if;

  select coalesce(sum(g.persons), 0) into v_gang_size
    from public.labour_gang_lines g where g.activity_code = a.code;
  if v_gang_size <= 0 then
    return jsonb_build_object('ok', false,
      'error', format('"%s" has no gang recorded against it, so there is nobody to divide the work between.', a.label));
  end if;

  v_out       := a.output_per_gang_day * (v_eff / 100);
  v_gang_days := p_qty / v_out;
  v_duration  := ceil(v_gang_days / p_gangs)::int;
  v_total_md  := v_gang_days * v_gang_size;

  if p_target_days is not null and p_target_days > 0 then
    v_gangs_for := ceil(v_gang_days / p_target_days)::int;
  end if;

  -- THE WARNING THAT MAKES THE WHOLE MODULE HONEST. A result computed from a
  -- figure nobody has confirmed says so, every single time, rather than once in
  -- a banner people stop seeing.
  if not a.verified then
    v_warn := format(
      'This uses a starting figure of %s %s per gang-day that NOBODY HAS CONFIRMED — it shipped with the app and is not from any standard. Check it against your own records, or against your copy of IS 7272 Part 2 (South zone, the one that applies in Bengaluru), and tick it verified on the Reference tab.',
      trim_scale(a.output_per_gang_day), a.unit);
  end if;

  for r in
    select g.trade, g.persons
      from public.labour_gang_lines g
     where g.activity_code = a.code
     order by g.sort, g.trade
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'trade',            r.trade,
      'persons_per_gang', trim_scale(r.persons),
      'persons_total',    trim_scale(round(r.persons * p_gangs, 2)),
      'man_days',         round(v_gang_days * r.persons, 1)));
  end loop;

  return jsonb_build_object(
    'ok', true,
    'warning', v_warn,
    'activity', jsonb_build_object(
      'code', a.code, 'label', a.label, 'unit', a.unit, 'category', a.category,
      'output_per_gang_day', trim_scale(a.output_per_gang_day),
      'source', a.source, 'is_ref', a.is_ref, 'verified', a.verified, 'note', a.note),
    'lines', v_lines,
    'detail', jsonb_build_object(
      'gang_days',       round(v_gang_days, 2),
      'duration_days',   v_duration,
      'gang_size',       trim_scale(v_gang_size),
      'people_on_site',  trim_scale(round(v_gang_size * p_gangs, 2)),
      'total_man_days',  round(v_total_md, 1),
      'effective_output', round(v_out, 3),
      'gangs_for_target', v_gangs_for,
      'target_days',      p_target_days),
    'working', format(
      E'%s at %s %s per gang-day%s\n'
      'Work = %s %s ÷ %s = %s gang-days\n'
      'Gang is %s (%s people), so %s × %s = %s man-days in total\n'
      '%s gang%s on it → %s ÷ %s = %s day%s, with %s people on site%s',
      a.label, trim_scale(a.output_per_gang_day), a.unit,
        case when v_eff <> 100
          then format(', adjusted to %s%% = %s %s', trim_scale(v_eff), round(v_out,3), a.unit)
          else '' end,
      trim_scale(p_qty), a.unit, round(v_out,3), round(v_gang_days,2),
      (select string_agg(format('%s × %s', trim_scale(g.persons), g.trade), ' + ' order by g.sort, g.trade)
         from public.labour_gang_lines g where g.activity_code = a.code),
        trim_scale(v_gang_size), round(v_gang_days,2), trim_scale(v_gang_size), round(v_total_md,1),
      p_gangs, case when p_gangs = 1 then '' else 's' end,
        round(v_gang_days,2), p_gangs, v_duration, case when v_duration = 1 then '' else 's' end,
        trim_scale(round(v_gang_size * p_gangs, 2)),
      case when v_gangs_for is not null
        then format(E'\nTo finish in %s days you would need %s gang%s, i.e. %s people.',
                    p_target_days, v_gangs_for, case when v_gangs_for = 1 then '' else 's' end,
                    trim_scale(round(v_gang_size * v_gangs_for, 2)))
        else '' end)
  );
end $$;


-- ############################################################
-- ### 6. AGAINST THE PROGRAMME  —  reported, never written
-- ############################################################

-- The estimate says how long the work takes; the programme says how long it has
-- been given. This returns both and the gap. It does NOT touch planned_end:
-- 042 made `fn_generate_schedule` the owner of the dates, and a calculator
-- quietly restating them produces a programme that claims one date and is drawn
-- to another.
--
-- Zero rows when the estimate has no activity linked — the 073 rule, so the
-- panel disappears rather than showing a comparison against nothing.
drop function if exists public.fn_manpower_vs_schedule(uuid);
create function public.fn_manpower_vs_schedule(p_estimate uuid)
returns table (
  activity_code   text,
  activity_name   text,
  planned_start   date,
  planned_end     date,
  days_allowed    int,
  days_needed     int,
  shortfall_days  int,
  gangs_planned   int,
  gangs_needed    int
)
language sql stable security invoker set search_path = public as $$
  select
    sa.code,
    sa.name,
    sa.planned_start,
    sa.planned_end,
    (sa.planned_end - sa.planned_start + 1)                                   as days_allowed,
    e.duration_days,
    greatest(e.duration_days - (sa.planned_end - sa.planned_start + 1), 0)    as shortfall_days,
    e.gangs,
    ceil(e.gang_days / greatest(sa.planned_end - sa.planned_start + 1, 1))::int as gangs_needed
  from public.manpower_estimates e
  join public.schedule_activities sa on sa.id = e.activity_id
  where e.id = p_estimate;
$$;


-- ############################################################
-- ### 7. AGAINST WHAT WAS ACTUALLY WORKED
-- ############################################################

-- Planned man-days per trade against attendance man-days per trade, for one
-- schedule activity. NO NEW COLUMN was needed: `labour_attendance` has carried
-- `trade`, `workers_present` and `activity_id` since 054, and the gang lines
-- speak the same trade list — which is the whole reason 054's list was reused
-- rather than a second one invented.
--
-- Voided attendance is excluded, the way every total in this app excludes it.
-- Zero rows when nothing has been planned for the activity (073).
drop function if exists public.fn_manpower_vs_actual(uuid);
create function public.fn_manpower_vs_actual(p_activity uuid)
returns table (
  trade          text,
  planned_days   numeric,
  actual_days    numeric,
  variance_days  numeric,
  estimates_n    int
)
language sql stable security invoker set search_path = public as $$
  with planned as (
    select l.trade, sum(l.man_days) as planned_days, count(distinct e.id)::int as estimates_n
      from public.manpower_estimate_lines l
      join public.manpower_estimates e on e.id = l.estimate_id
     where e.activity_id = p_activity
     group by l.trade
  ),
  worked as (
    select att.trade, sum(att.workers_present)::numeric as actual_days
      from public.labour_attendance att
     where att.activity_id = p_activity and att.voided_at is null
     group by att.trade
  )
  select
    coalesce(p.trade, w.trade),
    round(coalesce(p.planned_days, 0), 1),
    round(coalesce(w.actual_days, 0), 1),
    round(coalesce(w.actual_days, 0) - coalesce(p.planned_days, 0), 1),
    coalesce(p.estimates_n, 0)
  from planned p
  full outer join worked w on w.trade = p.trade
  -- Only report once something has been PLANNED for this activity. Attendance
  -- with no estimate behind it is not a variance, it is just attendance.
  where exists (select 1 from planned)
  order by 1;
$$;


-- ############################################################
-- ### 8. HOW MUCH OF THE TABLE IS ACTUALLY OURS
-- ############################################################

-- One row, so the Reference screen can lead with "9 of 26 confirmed" rather
-- than making somebody count ticks. Internal-only, and it is a count of rows
-- the caller can already see, so no 066 wrapper is needed beyond the gate.
drop function if exists public.fn_labour_constant_status();
create function public.fn_labour_constant_status()
returns table (total int, verified int, unfilled int, from_code int)
language sql stable security invoker set search_path = public as $$
  select
    count(*)::int,
    count(*) filter (where verified)::int,
    count(*) filter (where output_per_gang_day is null)::int,
    count(*) filter (where source = 'is_code')::int
  from public.labour_activities
  where is_active;
$$;


-- ############################################################
-- ### 9. SELF-TEST
-- ############################################################

-- Worked examples with answers derived by hand, run through the SAME function
-- the screen uses. The expectation is printed next to the result so the
-- expectation can be argued with too.
--
-- These test the ARITHMETIC, not the constants — the constants are explicitly
-- unconfirmed, and a test that asserted them would be asserting a guess. Each
-- case therefore passes its own output figure in via efficiency, or uses a
-- ratio that holds whatever the seeded number is.
drop function if exists public.fn_manpower_selftest();
create function public.fn_manpower_selftest()
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
  r     jsonb;
  v_out numeric;
begin
  -- Pin the seeded brickwork output so the cases below are arithmetic, not a
  -- claim about how fast anybody lays brick.
  select output_per_gang_day into v_out from public.labour_activities where code = 'brick_230';

  -- 45 cum at the seeded rate, one gang of 1 mason + 2 helpers.
  r := public.fn_manpower('brick_230', 45, 1, 100, null);

  case_no := 1; scenario := '45 cum brickwork, 1 gang';
  measure := 'gang-days'; expected := round(45 / v_out, 2);
  computed := (r->'detail'->>'gang_days')::numeric;
  diff := round(computed - expected, 2); passed := abs(diff) <= 0.01; return next;

  case_no := 2; scenario := '45 cum brickwork, 1 gang';
  measure := 'total man-days'; expected := round(45 / v_out * 3, 1);
  computed := (r->'detail'->>'total_man_days')::numeric;
  diff := round(computed - expected, 1); passed := abs(diff) <= 0.1; return next;

  case_no := 3; scenario := '45 cum brickwork, 1 gang';
  measure := 'mason man-days'; expected := round(45 / v_out * 1, 1);
  computed := (select (l->>'man_days')::numeric from jsonb_array_elements(r->'lines') l
                where l->>'trade' = 'Mason');
  diff := round(computed - expected, 1); passed := abs(diff) <= 0.1; return next;

  case_no := 4; scenario := '45 cum brickwork, 1 gang';
  measure := 'helper man-days'; expected := round(45 / v_out * 2, 1);
  computed := (select (l->>'man_days')::numeric from jsonb_array_elements(r->'lines') l
                where l->>'trade' = 'Helper');
  diff := round(computed - expected, 1); passed := abs(diff) <= 0.1; return next;

  -- Three gangs: the work does not change, the calendar does.
  r := public.fn_manpower('brick_230', 45, 3, 100, null);
  case_no := 5; scenario := '45 cum brickwork, 3 gangs';
  measure := 'duration days'; expected := ceil(45 / v_out / 3);
  computed := (r->'detail'->>'duration_days')::numeric;
  diff := round(computed - expected, 0); passed := abs(diff) <= 0.01; return next;

  case_no := 6; scenario := '45 cum brickwork, 3 gangs';
  measure := 'man-days unchanged'; expected := round(45 / v_out * 3, 1);
  computed := (r->'detail'->>'total_man_days')::numeric;
  diff := round(computed - expected, 1); passed := abs(diff) <= 0.1; return next;

  case_no := 7; scenario := '45 cum brickwork, 3 gangs';
  measure := 'people on site'; expected := 9;
  computed := (r->'detail'->>'people_on_site')::numeric;
  diff := round(computed - expected, 1); passed := abs(diff) <= 0.01; return next;

  -- Efficiency scales output, so half the efficiency is twice the gang-days.
  r := public.fn_manpower('brick_230', 45, 1, 50, null);
  case_no := 8; scenario := '45 cum brickwork at 50% efficiency';
  measure := 'gang-days double'; expected := round(45 / v_out * 2, 2);
  computed := (r->'detail'->>'gang_days')::numeric;
  diff := round(computed - expected, 2); passed := abs(diff) <= 0.02; return next;

  -- The backwards question: how many gangs to hit a date.
  r := public.fn_manpower('brick_230', 45, 1, 100, 10);
  case_no := 9; scenario := '45 cum brickwork, wanted in 10 days';
  measure := 'gangs needed'; expected := ceil(45 / v_out / 10);
  computed := (r->'detail'->>'gangs_for_target')::numeric;
  diff := round(computed - expected, 0); passed := abs(diff) <= 0.01; return next;

  -- A gang of 1 bender + 1 helper on a tonne of steel: 8 man-days at the
  -- seeded 0.25 t/gang-day. Tests a non-masonry gang and a non-cum unit.
  r := public.fn_manpower('rebar_fix', 1, 1, 100, null);
  case_no := 10; scenario := '1 tonne of reinforcement, 1 gang';
  measure := 'total man-days'; expected := 8.0;
  computed := (r->'detail'->>'total_man_days')::numeric;
  diff := round(computed - expected, 1); passed := abs(diff) <= 0.1; return next;

  -- Every seeded row ships unconfirmed, and the result must SAY so.
  r := public.fn_manpower('brick_230', 45, 1, 100, null);
  case_no := 11; scenario := 'a seeded constant nobody has confirmed';
  measure := 'warns (1 = yes)'; expected := 1;
  computed := case when (r->>'warning') is not null then 1 else 0 end;
  diff := computed - expected; passed := diff = 0; return next;

  -- And an impossible input is refused rather than clamped (051).
  r := public.fn_manpower('brick_230', 45, 1, 500, null);
  case_no := 12; scenario := 'efficiency of 500% asked for';
  measure := 'refused (1 = yes)'; expected := 1;
  computed := case when (r->>'ok')::boolean then 0 else 1 end;
  diff := computed - expected; passed := diff = 0; return next;

  return;
end $$;


-- ############################################################
-- ### 10. RLS
-- ############################################################

-- `is_internal()`, never `using (true)` — the 065 lesson applied on the day the
-- table is created rather than left for a later audit.
drop policy if exists la_read on public.labour_activities;
create policy la_read on public.labour_activities
  for select to authenticated using (public.is_internal());

drop policy if exists la_write on public.labour_activities;
create policy la_write on public.labour_activities
  for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

drop policy if exists lgl_read on public.labour_gang_lines;
create policy lgl_read on public.labour_gang_lines
  for select to authenticated using (public.is_internal());

drop policy if exists lgl_write on public.labour_gang_lines;
create policy lgl_write on public.labour_gang_lines
  for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

-- Estimates: every internal role on their own project, supervisors included.
-- There is no money here — man-days are not wages, and `labour_rates` is a
-- different table this module never reads — and the supervisor is the person
-- who has to decide whether today's gang is big enough.
drop policy if exists mpe_read on public.manpower_estimates;
create policy mpe_read on public.manpower_estimates
  for select to authenticated
  using (public.is_internal() and public.is_member(project_id));

drop policy if exists mpe_write on public.manpower_estimates;
create policy mpe_write on public.manpower_estimates
  for all to authenticated
  using (public.is_internal() and public.is_member(project_id))
  with check (public.is_internal() and public.is_member(project_id));

drop policy if exists mpel_read on public.manpower_estimate_lines;
create policy mpel_read on public.manpower_estimate_lines
  for select to authenticated
  using (exists (select 1 from public.manpower_estimates e
                 where e.id = estimate_id
                   and public.is_internal() and public.is_member(e.project_id)));

drop policy if exists mpel_write on public.manpower_estimate_lines;
create policy mpel_write on public.manpower_estimate_lines
  for all to authenticated
  using (exists (select 1 from public.manpower_estimates e
                 where e.id = estimate_id
                   and public.is_internal() and public.is_member(e.project_id)))
  with check (exists (select 1 from public.manpower_estimates e
                 where e.id = estimate_id
                   and public.is_internal() and public.is_member(e.project_id)));


-- ############################################################
-- ### 11. GRANTS
-- ############################################################

grant select, insert, update, delete on public.labour_activities  to authenticated;
grant select, insert, update, delete on public.labour_gang_lines  to authenticated;
grant select, insert, update, delete on public.manpower_estimates to authenticated;
grant select, insert, update, delete on public.manpower_estimate_lines to authenticated;

revoke all on function public.fn_manpower(text, numeric, int, numeric, int) from public, anon;
revoke all on function public.fn_manpower_vs_schedule(uuid)  from public, anon;
revoke all on function public.fn_manpower_vs_actual(uuid)    from public, anon;
revoke all on function public.fn_labour_constant_status()     from public, anon;
revoke all on function public.fn_manpower_selftest()          from public, anon;

grant execute on function public.fn_manpower(text, numeric, int, numeric, int) to authenticated;
grant execute on function public.fn_manpower_vs_schedule(uuid)  to authenticated;
grant execute on function public.fn_manpower_vs_actual(uuid)    to authenticated;
grant execute on function public.fn_labour_constant_status()     to authenticated;
grant execute on function public.fn_manpower_selftest()          to authenticated;


-- ############################################################
-- ### 12. AUDIT + TOUCH
-- ############################################################

-- Code-keyed, so `fn_audit_by_code` from 051 — `fn_audit` reads NEW.id and
-- would ABORT the write on a table keyed by text.
drop trigger if exists audit_labour_activities on public.labour_activities;
create trigger audit_labour_activities
  after insert or update or delete on public.labour_activities
  for each row execute function public.fn_audit_by_code();

-- The gang lines are keyed by a PAIR, so neither audit function fits. Their
-- parent is audited and a gang line is meaningless without it, so this is a
-- deliberate omission rather than an oversight — recorded here so the next
-- person does not "fix" it by attaching fn_audit and aborting every write.

create or replace function public.fn_labour_activity_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  -- Confirming a figure has to record WHO, or "verified" means nothing in two
  -- years. Stamped here rather than trusted from the client.
  if new.verified and not coalesce(old.verified, false) then
    new.verified_by := auth.uid();
    new.verified_on := (now() at time zone 'Asia/Kolkata')::date;
  elsif not new.verified then
    new.verified_by := null;
    new.verified_on := null;
  end if;
  return new;
end $$;

drop trigger if exists labour_activity_touch on public.labour_activities;
create trigger labour_activity_touch
  before update on public.labour_activities
  for each row execute function public.fn_labour_activity_touch();


-- ############################################################
-- ### 13. VERIFY  —  expect 12 rows all passed = t, then 26|52|0|8|4
-- ############################################################

select * from public.fn_manpower_selftest() order by case_no;

select
  (select count(*) from public.labour_activities)                    as activities_26,
  (select count(*) from public.labour_gang_lines)                    as gang_lines_52,
  (select count(*) from public.labour_activities where verified)     as verified_0,
  (select count(*) from pg_policies where schemaname = 'public'
     and tablename in ('labour_activities','labour_gang_lines',
                       'manpower_estimates','manpower_estimate_lines'))  as policies_8,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'fn_manpower%')    as manpower_fns_4;
