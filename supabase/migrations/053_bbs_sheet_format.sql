-- ============================================================
-- MASON OS — Migration 053: the firm's own BBS sheet layout (B4 part 3)
--
-- The founder's existing bar bending schedule sheet was supplied. Two things
-- on it that the database did not yet hold, plus one discrepancy worth naming.
--
-- ---------- 1. THE UNIT WEIGHTS ON THE SHEET ARE NOT d²/162 ----------
-- The sheet's own header row reads:
--      φ8 0.395   φ10 0.616   φ12 0.888   φ16 1.579   φ20 2.466
-- d²/162   gives  0.3951      0.6173      0.8889      1.5802      2.4691
-- d²/162.2 gives  0.3946      0.6165      0.8878      1.5783      2.4661
--
-- Rounded to three places, 162.2 matches the sheet on φ8, φ10, φ12 and φ20;
-- 162 matches on none of them. So the firm works to 162.2 — the exact figure,
-- since π/4 × d² × 7850 kg/m³ = d²/162.28 — and 051 seeded the rounded
-- textbook 162. This migration moves it.
--
-- BE HONEST ABOUT THE ONE THAT STILL DIFFERS: φ16. The sheet prints 1.579,
-- d²/162.2 gives 1.5783 → 1.578. A 0.001 gap, 0.06%, and it means the sheet's
-- five figures do not all come from ONE divisor — they look like conventional
-- table values that were each rounded by hand. Rather than build a
-- per-diameter override table to chase 0.06%, the divisor stays a single
-- number the founder can see and change. If that last gram matters, say so and
-- a per-size table is a small migration.
--
-- Guarded so a deliberate choice already made is never overwritten, audited
-- either way, and reversible in one tap on the IS rules screen.
--
-- ---------- 2. "No of pieces required (per 12m length)" ----------
-- Steel is delivered in fixed lengths, so the ordering figure is the number of
-- 12 m bars, not the weight. ceil(total length ÷ stock length), which is a
-- quantity calculation and therefore belongs in Postgres, not in the PDF
-- generator. The 12 is itself a constant — some suppliers deliver 11 m or 9 m —
-- so it goes in bbs_constants with everything else.
--
-- NOTE: this is a straight ceiling of the total length. It is NOT a cutting
-- optimisation: two 4 m bars and a 5 m bar do not actually come out of one 12 m
-- length without offcuts. Nesting is a different problem, and a figure that
-- pretended to solve it would under-order. The number here is the honest
-- minimum, and the firm's wastage allowance still applies on top.
--
-- ---------- 3. LAST / OMITTED BAR MARK ----------
-- The sheet carries two boxes: the last bar mark used and any mark numbers
-- skipped. That is a real check — a gap in the sequence is usually a bar
-- somebody deleted and forgot to re-issue. Computed here rather than typed.
-- It only applies where bar marks are plain numbers (01, 02, 03…) as on the
-- firm's sheet; where they are member-prefixed (B1-1) there is no sequence to
-- audit and the function says so rather than inventing one.
--
-- Requires 051 and 052. Additive.
-- ============================================================


-- ############################################################
-- ###  1. CONSTANTS
-- ############################################################
insert into public.bbs_constants (code, label, value, unit, is_ref, note) values
  ('stock_length_m', 'Stock bar length', 12, 'm', 'IS 1786',
   'The delivered length steel is cut from. Used for the pieces-required figure.'),
  ('unit_weight_decimals', 'Unit weight — decimal places', 3, 'places', 'IS 1786',
   'The unit weight is ROUNDED to this before being multiplied by the length, '
   'because that rounded figure is what prints in the column heading. If the '
   'app multiplied by 0.3951 while printing 0.395, a checker adding the sheet '
   'up by hand would get a different answer from the app — and would be right '
   'to distrust it.')
on conflict (code) do nothing;

-- ---------- the divisor, moved to the firm's own figure ----------
-- Their sheet is printed to d²/162.2. Migration 051 seeded 162, the rounded
-- textbook value, because that was the figure to hand. The firm's paper is the
-- authority on what the firm uses — the same reasoning as taking their twenty
-- site checklists verbatim in 046 — so this moves it.
--
-- Guarded on `value = 162`: if the founder has already set something
-- deliberately, that choice stands. Reversible in one tap on the IS rules
-- screen, and audited either way. Cutting lengths are unaffected; only weights
-- move, by about 0.12%.
update public.bbs_constants
   set value = 162.2,
       note  = 'Unit weight = d² ÷ this, in kg per metre, d in mm. 162.2 is the '
               'arithmetically exact figure (π/4 × d² × 7850 kg/m³ = d²/162.28) '
               'and is what the firm''s own BBS sheet is printed to — φ8 0.395, '
               'φ12 0.888, φ16 1.579, φ20 2.466. Set it to 162 for the rounded '
               'textbook value instead; the difference is about 0.12%.'
 where code = 'unit_weight_divisor' and value = 162;


-- ############################################################
-- ###  1b. UNIT WEIGHT — round to what gets printed
-- ############################################################
-- Views come down BEFORE the function they call, or the drop is refused and the
-- create that follows fails with "already exists" while the old function
-- survives (the 051 lesson, learned the hard way on a second run).
drop view if exists public.v_bbs_project_steel cascade;
drop view if exists public.v_bbs_member_totals cascade;
drop view if exists public.v_bbs_bars cascade;

drop function if exists public.fn_bbs_unit_weight(numeric);
create function public.fn_bbs_unit_weight(p_dia numeric)
returns numeric
language sql
stable
set search_path = public
as $$
  select round(
    p_dia * p_dia /
      (select value from public.bbs_constants where code = 'unit_weight_divisor'),
    (select value from public.bbs_constants where code = 'unit_weight_decimals')::int
  );
$$;

revoke all on function public.fn_bbs_unit_weight(numeric) from public, anon;
grant execute on function public.fn_bbs_unit_weight(numeric) to authenticated;

-- 051's v_bbs_bars and v_bbs_member_totals, unchanged, recreated because the
-- drop above took them.
create view public.v_bbs_bars with (security_invoker = true) as
select
  b.id as bar_id, m.id as member_id, m.project_id, m.member_type,
  m.mark as member_mark, m.member_count, m.activity_id,
  b.bar_mark, b.dia_mm, b.shape_code, sh.name as shape_name,
  b.a_mm, b.b_mm, b.c_mm, b.d_mm, b.n_cranks, b.qty_per_member, b.remarks,
  b.sort_order,
  calc.j as calc,
  ((calc.j)->>'cutting_length_mm')::numeric(12,2) as cutting_length_mm,
  ((calc.j)->>'working')                          as working,
  ((calc.j)->>'warning')                          as warning,
  (b.qty_per_member * m.member_count)             as total_qty,
  round(((calc.j)->>'cutting_length_mm')::numeric / 1000, 3) as cutting_length_m,
  round(((calc.j)->>'cutting_length_mm')::numeric / 1000
        * b.qty_per_member * m.member_count, 3)   as total_length_m,
  public.fn_bbs_unit_weight(b.dia_mm)             as unit_weight_kg_m,
  round(((calc.j)->>'cutting_length_mm')::numeric / 1000
        * b.qty_per_member * m.member_count
        * public.fn_bbs_unit_weight(b.dia_mm), 3) as total_weight_kg
from public.bbs_bars b
join public.bbs_members m on m.id = b.member_id
join public.bbs_shapes sh on sh.code = b.shape_code
cross join lateral (
  select public.fn_bbs_cutting_length(
           b.shape_code, b.dia_mm, b.a_mm, b.b_mm, b.c_mm, b.d_mm, b.n_cranks) as j
) calc;

grant select on public.v_bbs_bars to authenticated;

create view public.v_bbs_member_totals with (security_invoker = true) as
select
  m.id as member_id, m.project_id, m.member_type, m.mark, m.description,
  m.level, m.drawing_ref, m.member_count, m.activity_id, m.created_at,
  count(v.bar_id)::int                               as bar_marks,
  coalesce(sum(v.total_qty), 0)::int                 as total_bars,
  coalesce(sum(v.total_length_m), 0)::numeric(12,3)  as total_length_m,
  coalesce(sum(v.total_weight_kg), 0)::numeric(12,3) as total_weight_kg,
  count(*) filter (where v.warning is not null)::int as warnings
from public.bbs_members m
left join public.v_bbs_bars v on v.member_id = m.id
group by m.id, m.project_id, m.member_type, m.mark, m.description, m.level,
         m.drawing_ref, m.member_count, m.activity_id, m.created_at;

grant select on public.v_bbs_member_totals to authenticated;


-- ############################################################
-- ###  2. PIECES REQUIRED, PER DIAMETER
-- ############################################################
-- v_bbs_project_steel gains the ordering figure. Dropped and recreated, never
-- `create or replace view` — that cannot add a column mid-list (the standing
-- rule, which has bitten three times). Its drop is in §1b, above the function
-- it calls.
create view public.v_bbs_project_steel with (security_invoker = true) as
select
  v.project_id,
  v.dia_mm,
  count(*)::int                                     as bar_marks,
  sum(v.total_qty)::int                             as total_bars,
  sum(v.total_length_m)::numeric(12,3)              as total_length_m,
  max(v.unit_weight_kg_m)::numeric(10,4)            as unit_weight_kg_m,
  sum(v.total_weight_kg)::numeric(12,3)             as total_weight_kg,
  round(sum(v.total_weight_kg) / 1000, 5)::numeric(12,5) as total_tonnes,
  -- ceil, because you cannot buy 8.63 of a bar. Not a nesting calculation —
  -- see the header.
  ceil(sum(v.total_length_m) /
       (select c.value from public.bbs_constants c where c.code = 'stock_length_m')
      )::int                                        as pieces_required
from public.v_bbs_bars v
group by v.project_id, v.dia_mm;

grant select on public.v_bbs_project_steel to authenticated;


-- ############################################################
-- ###  3. BAR MARK SEQUENCE AUDIT
-- ############################################################
-- Returns the highest bar mark in use and any numbers missing below it, for the
-- two boxes at the top of the firm's sheet.
drop function if exists public.fn_bbs_mark_audit(uuid);
create function public.fn_bbs_mark_audit(p_project uuid)
returns table (
  numeric_marks int,
  total_marks   int,
  last_mark     text,
  omitted       text
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_max int;
begin
  if not public.is_member(p_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  select count(*) filter (where b.bar_mark ~ '^\s*\d+\s*$'),
         count(*)
    into numeric_marks, total_marks
  from public.bbs_bars b
  join public.bbs_members m on m.id = b.member_id
  where m.project_id = p_project;

  if coalesce(numeric_marks, 0) = 0 then
    -- Member-prefixed marks (B1-1) have no single sequence to audit. Say so
    -- rather than inventing one out of the trailing digits.
    last_mark := null;
    omitted   := null;
    return next;
    return;
  end if;

  select max(btrim(b.bar_mark)::int) into v_max
  from public.bbs_bars b
  join public.bbs_members m on m.id = b.member_id
  where m.project_id = p_project and b.bar_mark ~ '^\s*\d+\s*$';

  last_mark := lpad(v_max::text, 2, '0');

  select string_agg(lpad(g::text, 2, '0'), ', ' order by g)
    into omitted
  from generate_series(1, v_max) g
  where not exists (
    select 1 from public.bbs_bars b
    join public.bbs_members m on m.id = b.member_id
    where m.project_id = p_project
      and b.bar_mark ~ '^\s*\d+\s*$'
      and btrim(b.bar_mark)::int = g);

  return next;
end $$;

revoke all on function public.fn_bbs_mark_audit(uuid) from public, anon;
grant execute on function public.fn_bbs_mark_audit(uuid) to authenticated;


-- ############################################################
-- ###  4. VERIFY
-- ############################################################
select count(*) filter (where passed) as engine_passing, count(*) as engine_total
from public.fn_bbs_selftest();

select count(*) filter (where passed) as callout_passing, count(*) as callout_total
from public.fn_bbs_callout_selftest();

select code, value, unit from public.bbs_constants
where code in ('stock_length_m', 'unit_weight_divisor', 'unit_weight_divisor_exact')
order by code;

select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'fn_bbs_mark_audit'
group by p.proname;
