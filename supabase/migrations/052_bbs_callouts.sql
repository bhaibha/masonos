-- ============================================================
-- MASON OS — Migration 052: bar callout expansion (B4 part 2)
--
-- 051 computes cutting lengths, but every bar mark still has to be typed in
-- with its dimensions worked out by hand. That is the tedious half AND the
-- error-prone half: counting stirrups from a spacing, subtracting cover twice,
-- working out a crank rise. This migration does that arithmetic from the
-- notation already written on the drawing.
--
-- You record the member once — 300 × 450, 5000 long, 25 cover — and then type
-- what the section says:
--
--     4-Y16 BOTTOM
--     2-Y12 TOP
--     2-Y16 CRANK
--     Y8 @150 STIRRUP
--
-- and get eight bar marks with dimensions, counts, cutting lengths and weights.
-- The stirrup count comes from the spacing, the stirrup dimensions from the
-- section minus cover, the crank rise from the depth minus cover minus the bar
-- itself.
--
-- ---------- WHY THIS AND NOT "READ THE DRAWING" ----------
-- Extracting reinforcement from a drawing image needs a vision model. It would
-- be confidently wrong some of the time, and a plausible-looking bar schedule
-- that nobody checks is the single worst thing this module could produce — the
-- error is invisible from the moment the concrete is poured. Expansion is
-- deterministic: the engineer states what the drawing says, in their own
-- notation, and the machine does only the counting and the geometry. Nothing is
-- inferred that was not written down.
--
-- ---------- IT REFUSES RATHER THAN GUESSES ----------
-- A line it cannot parse fails the WHOLE expansion, naming the line and why.
-- There is no partial apply and no "best effort" row. A schedule that silently
-- dropped one callout would be short of bars with nothing on screen to say so.
-- Likewise a diameter that is not a rolled size is refused, not rounded, and a
-- stirrup asked for on a member with no recorded depth is refused, not assumed.
--
-- ---------- WHAT IT DELIBERATELY DOES NOT DECIDE ----------
-- Development and anchorage length. That depends on steel grade, concrete
-- grade, bond condition and the designer's detail, and it is on the drawing.
-- `anchorage_mm` is a field the engineer fills from the drawing, defaulting to
-- ZERO — a default of "some sensible number" would be the app quietly designing
-- the joint. Lap lengths and wastage are likewise left to the ordering
-- allowance, and the steel summary says so.
--
-- ---------- RE-RUNNING IS SAFE ----------
-- The callout text is stored on the member. Re-applying replaces only the bars
-- this function generated (`from_callout`), leaving anything added by hand
-- alone — so an engineer can correct one line of the callouts without losing
-- the extra bar they added at a support.
--
-- Requires 051. Additive; every column added to a table 051 already created has
-- its own `add column if not exists` (the 042 lesson).
-- ============================================================


-- ############################################################
-- ###  1. MEMBER GEOMETRY
-- ############################################################
-- 051's bbs_members recorded WHAT the member is. To expand callouts it also
-- needs HOW BIG it is. Separate statements, not an edited create block:
-- `create table if not exists` will not add a column to a table that exists.
alter table public.bbs_members add column if not exists length_mm    numeric(10,2);
alter table public.bbs_members add column if not exists width_mm     numeric(10,2);
alter table public.bbs_members add column if not exists depth_mm     numeric(10,2);
alter table public.bbs_members add column if not exists cover_mm     numeric(10,2) default 25;
-- Per end. Added to straight and cranked bars. Default 0 ON PURPOSE — see the
-- header: a non-zero default would be the app designing the anchorage.
alter table public.bbs_members add column if not exists anchorage_mm numeric(10,2) default 0;
-- Circular columns take a circular tie rather than a rectangular one.
alter table public.bbs_members add column if not exists is_circular  boolean not null default false;
alter table public.bbs_members add column if not exists diameter_mm  numeric(10,2);
-- The callouts as typed off the drawing. Kept so they can be corrected and
-- re-applied, and so the schedule can be traced back to what was read.
alter table public.bbs_members add column if not exists callout_text text;

-- Marks the bars this expansion produced, so a re-run replaces them without
-- touching anything entered by hand.
alter table public.bbs_bars add column if not exists from_callout boolean not null default false;


-- ############################################################
-- ###  2. THE PARSER — pure, no writes, no member lookup
-- ############################################################
-- Takes the text and the geometry and returns the bar marks it WOULD create,
-- one row per callout line, each carrying its own ok/problem. Pure so that the
-- preview on screen, the apply, and the self-test all run the same code — three
-- parsers would eventually disagree about what a line means.
--
-- The grammar it accepts, deliberately small:
--
--   COUNT FORM     4-Y16 / 4Y16 / 4-16 / 4 #16 / 4x16      → count, diameter
--   SPACING FORM   Y8@150 / 8 @ 150 / Ø8-150 c/c           → diameter, spacing
--   KEYWORDS       TOP T BOTTOM BOT B  (position, kept as a remark)
--                  STIRRUP STIRRUPS TIE TIES LINK LINKS    (also implied by @)
--                  CRANK CRANKED BENT  [CRANK x2 / CRANK(2) for the count,
--                                       default 2 — one at each end]
--                  HOOK HOOKED                             (hooks both ends)
--                  EXTRA                                   (remark only)
--   COMMENTS       a line starting with -- or # is ignored
--
-- Anything else is a refusal with a message, never a guess.
drop function if exists public.fn_bbs_parse_callouts(text, numeric, numeric, numeric, numeric, numeric, boolean, numeric, text);
create function public.fn_bbs_parse_callouts(
  p_text       text,
  p_length     numeric,
  p_width      numeric,
  p_depth      numeric,
  p_cover      numeric,
  p_anchorage  numeric default 0,
  p_circular   boolean default false,
  p_diameter   numeric default null,
  p_prefix     text    default 'B'
)
returns table (
  line_no     int,
  source_line text,
  ok          boolean,
  problem     text,
  bar_mark    text,
  dia_mm      int,
  shape_code  text,
  a_mm        numeric,
  b_mm        numeric,
  c_mm        numeric,
  d_mm        numeric,
  n_cranks    int,
  qty         int,
  remarks     text,
  cutting_length_mm numeric,
  working     text,
  warning     text
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_lines   text[];
  v_raw     text;
  v_s       text;
  v_i       int := 0;
  v_seq     int := 0;
  v_m       text[];
  v_dia     int;
  v_qty     int;
  v_space   numeric;
  v_cover   numeric := coalesce(p_cover, 0);
  v_anch    numeric := coalesce(p_anchorage, 0);
  v_clear   numeric;
  v_calc    jsonb;
  v_pos     text;
  v_shape   text;
  v_cranks  int;
  v_a numeric; v_b numeric; v_c numeric; v_d numeric;
  v_rem     text;
  v_prob    text;
begin
  if coalesce(btrim(p_text), '') = '' then
    return;
  end if;

  v_lines := regexp_split_to_array(p_text, E'\r?\n');

  foreach v_raw in array v_lines loop
    v_i := v_i + 1;

    -- Reset every per-line variable. A value surviving from the previous line
    -- is how a parser produces a confident wrong answer.
    v_dia := null; v_qty := null; v_space := null; v_prob := null;
    v_shape := null; v_cranks := 0; v_rem := null;
    v_a := 0; v_b := 0; v_c := 0; v_d := 0; v_calc := null;

    if coalesce(btrim(v_raw), '') = '' then continue; end if;
    if btrim(v_raw) like '--%' or btrim(v_raw) like '#%' then continue; end if;

    -- Normalise: upper case, strip the diameter symbols and the "c/c" noise,
    -- collapse whitespace. MM is dropped so "8mm @ 150mm" reads the same as
    -- "8@150".
    v_s := upper(btrim(v_raw));
    v_s := replace(replace(replace(v_s, 'Ø', ''), 'φ', ''), '⌀', '');
    v_s := regexp_replace(v_s, 'C/C|CC\M|MM\M', ' ', 'g');
    v_s := regexp_replace(v_s, '\s+', ' ', 'g');

    -- ---------- position / remark keywords ----------
    v_pos := case
      when v_s ~ '\mTOP\M'    or v_s ~ '\mT\M' then 'Top'
      when v_s ~ '\mBOTTOM\M' or v_s ~ '\mBOT\M' or v_s ~ '\mB\M' then 'Bottom'
      else null end;

    -- ---------- which shape ----------
    if v_s ~ '@' or v_s ~ '\mSTIRRUPS?\M' or v_s ~ '\mTIES?\M' or v_s ~ '\mLINKS?\M' then
      v_shape := case when p_circular then 'STIRR-C' else 'STIRR-R' end;
    elsif v_s ~ '\mCRANK(ED)?\M' or v_s ~ '\mBENT\M' then
      v_shape := 'CRANK';
    elsif v_s ~ '\mHOOK(ED)?\M' then
      v_shape := 'HOOK';
    else
      v_shape := 'STR';
    end if;

    -- ---------- numbers ----------
    if v_shape in ('STIRR-R', 'STIRR-C') then
      -- Spacing form. The diameter is the number before the @.
      v_m := regexp_match(v_s, '(\d+)\s*@\s*(\d+)');
      if v_m is null then
        -- A stirrup line without a spacing may still give an explicit count.
        v_m := regexp_match(v_s, '(\d+)\s*[-X]?\s*[YTD#]?\s*(\d+)');
        if v_m is null then
          v_prob := 'Could not find a diameter and spacing. Write it as "Y8 @150 stirrup".';
        else
          v_qty := v_m[1]::int;
          v_dia := v_m[2]::int;
        end if;
      else
        v_dia   := v_m[1]::int;
        v_space := v_m[2]::numeric;
        if v_space <= 0 then
          v_prob := 'Spacing must be greater than zero.';
        elsif p_length is null then
          v_prob := 'This member has no length recorded, so the stirrups cannot be counted.';
        else
          -- Bars fit within the clear run between end covers, plus the one at
          -- the start. floor()+1 is the site rule; it is never rounded up
          -- "to be safe", because a schedule that quietly adds steel is as
          -- wrong as one that omits it.
          v_clear := p_length - 2 * v_cover;
          if v_clear <= 0 then
            v_prob := 'Cover is larger than the member length — check the units.';
          else
            v_qty := floor(v_clear / v_space)::int + 1;
            v_rem := format('@ %s c/c over %s mm', v_space, round(v_clear));
          end if;
        end if;
      end if;
    else
      v_m := regexp_match(v_s, '(\d+)\s*[-X]?\s*[YTD#]?\s*(\d+)');
      if v_m is null then
        v_prob := 'Could not find a count and a diameter. Write it as "4-Y16".';
      else
        v_qty := v_m[1]::int;
        v_dia := v_m[2]::int;
      end if;
    end if;

    -- ---------- validate ----------
    if v_prob is null then
      if v_dia is null or v_dia not in (6,8,10,12,16,20,25,28,32,36,40) then
        v_prob := format('%s is not a rolled bar size.', coalesce(v_dia::text, '?'));
      elsif v_qty is null or v_qty <= 0 then
        v_prob := 'Number of bars must be at least one.';
      end if;
    end if;

    -- ---------- geometry ----------
    if v_prob is null then
      if v_shape = 'STIRR-R' then
        if p_width is null or p_depth is null then
          v_prob := 'A rectangular stirrup needs the member width and depth.';
        else
          v_a := p_width - 2 * v_cover;
          v_b := p_depth - 2 * v_cover;
        end if;

      elsif v_shape = 'STIRR-C' then
        if p_diameter is null then
          v_prob := 'A circular tie needs the column diameter.';
        else
          -- Centreline diameter of the tie: column less both covers less the
          -- tie bar itself.
          v_a := p_diameter - 2 * v_cover - v_dia;
        end if;

      elsif v_shape = 'CRANK' then
        if p_length is null or p_depth is null then
          v_prob := 'A cranked bar needs the member length and depth.';
        else
          v_a := p_length - 2 * v_cover + 2 * v_anch;
          v_b := p_depth - 2 * v_cover - v_dia;
          -- The crank count needs an UNAMBIGUOUS form: "CRANK x1" or
          -- "CRANK(1)". The obvious pattern '(\d+)\s*CRANK' looks right and is
          -- badly wrong — in "2-Y16 CRANK" it matches the DIAMETER, giving 16
          -- cranks and a bar 1810 mm too long. Caught by
          -- fn_bbs_callout_selftest() on the first run; it would not have been
          -- caught by reading the line.
          v_m := regexp_match(v_s, 'CRANKS?\s*[X(]\s*(\d+)');
          -- Default 2: one crank at each end, which is the ordinary detail.
          v_cranks := coalesce(v_m[1]::int, 2);
        end if;

      else  -- STR / HOOK
        if p_length is null then
          v_prob := 'This member has no length recorded.';
        else
          v_a := p_length - 2 * v_cover + 2 * v_anch;
        end if;
      end if;
    end if;

    -- ---------- cutting length, from 051's engine ----------
    if v_prob is null then
      v_calc := public.fn_bbs_cutting_length(v_shape, v_dia, v_a, v_b, v_c, v_d, v_cranks);
      if v_calc ? 'error' then
        v_prob := v_calc->>'error';
      end if;
    end if;

    v_seq := v_seq + 1;

    line_no     := v_i;
    source_line := btrim(v_raw);
    ok          := v_prob is null;
    problem     := v_prob;
    bar_mark    := format('%s-%s', p_prefix, v_seq);
    dia_mm      := v_dia;
    shape_code  := v_shape;
    a_mm        := round(v_a, 2);
    b_mm        := round(v_b, 2);
    c_mm        := round(v_c, 2);
    d_mm        := round(v_d, 2);
    n_cranks    := v_cranks;
    qty         := v_qty;
    remarks     := nullif(btrim(concat_ws(' · ', v_pos, v_rem)), '');
    cutting_length_mm := (v_calc->>'cutting_length_mm')::numeric;
    working     := v_calc->>'working';
    warning     := v_calc->>'warning';
    return next;
  end loop;
end $$;

revoke all on function public.fn_bbs_parse_callouts(text, numeric, numeric, numeric, numeric, numeric, boolean, numeric, text) from public, anon;
grant execute on function public.fn_bbs_parse_callouts(text, numeric, numeric, numeric, numeric, numeric, boolean, numeric, text) to authenticated;


-- ############################################################
-- ###  3. PREVIEW AGAINST A REAL MEMBER
-- ############################################################
-- Thin wrapper: looks the geometry up, calls the one parser. This is what the
-- screen shows while somebody types, so the preview and the apply cannot
-- disagree about what a line means.
drop function if exists public.fn_bbs_preview_callouts(uuid, text);
create function public.fn_bbs_preview_callouts(p_member uuid, p_text text)
returns table (
  line_no int, source_line text, ok boolean, problem text,
  bar_mark text, dia_mm int, shape_code text,
  a_mm numeric, b_mm numeric, c_mm numeric, d_mm numeric,
  n_cranks int, qty int, remarks text,
  cutting_length_mm numeric, working text, warning text
)
language plpgsql
stable
set search_path = public
as $$
declare m public.bbs_members%rowtype;
begin
  select * into m from public.bbs_members where id = p_member;
  if m.id is null then
    raise exception 'That member no longer exists.';
  end if;
  if not public.is_member(m.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  return query
  select * from public.fn_bbs_parse_callouts(
    p_text, m.length_mm, m.width_mm, m.depth_mm,
    coalesce(m.cover_mm, 25), coalesce(m.anchorage_mm, 0),
    m.is_circular, m.diameter_mm, m.mark);
end $$;

revoke all on function public.fn_bbs_preview_callouts(uuid, text) from public, anon;
grant execute on function public.fn_bbs_preview_callouts(uuid, text) to authenticated;


-- ############################################################
-- ###  4. APPLY — all or nothing
-- ############################################################
drop function if exists public.fn_bbs_apply_callouts(uuid, text);
create function public.fn_bbs_apply_callouts(p_member uuid, p_text text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m       public.bbs_members%rowtype;
  v_bad   text;
  v_n     int;
  v_order int := 0;
  r       record;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may write a bar schedule.'
      using errcode = '42501';
  end if;

  select * into m from public.bbs_members where id = p_member;
  if m.id is null then
    raise exception 'That member no longer exists.';
  end if;
  if not public.is_member(m.project_id) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  -- Every line must parse. A partial apply would leave the schedule short of
  -- bars with nothing on screen to say which ones.
  select string_agg(format('line %s "%s" — %s', p.line_no, p.source_line, p.problem),
                    E'\n' order by p.line_no)
    into v_bad
  from public.fn_bbs_preview_callouts(p_member, p_text) p
  where not p.ok;

  if v_bad is not null then
    raise exception E'These callouts could not be read:\n%', v_bad;
  end if;

  select count(*) into v_n from public.fn_bbs_preview_callouts(p_member, p_text);
  if v_n = 0 then
    raise exception 'No callouts to expand.';
  end if;

  -- Replace only what a previous expansion generated. A bar added by hand at a
  -- support is somebody's deliberate correction and survives.
  delete from public.bbs_bars where member_id = p_member and from_callout;

  for r in select * from public.fn_bbs_preview_callouts(p_member, p_text) order by line_no
  loop
    v_order := v_order + 10;
    insert into public.bbs_bars
      (member_id, bar_mark, dia_mm, shape_code, a_mm, b_mm, c_mm, d_mm,
       n_cranks, qty_per_member, remarks, sort_order, from_callout)
    values
      (p_member, r.bar_mark, r.dia_mm, r.shape_code, r.a_mm, r.b_mm, r.c_mm,
       r.d_mm, r.n_cranks, r.qty, r.remarks, v_order, true);
  end loop;

  update public.bbs_members
     set callout_text = p_text, updated_at = now()
   where id = p_member;

  return v_n;
end $$;

revoke all on function public.fn_bbs_apply_callouts(uuid, text) from public, anon;
grant execute on function public.fn_bbs_apply_callouts(uuid, text) to authenticated;


-- ############################################################
-- ###  5. PARSER SELF-TEST
-- ############################################################
-- Same shape of guarantee as fn_bbs_selftest in 051, for the layer above it:
-- a fixed beam, a fixed set of callouts, and hand-derived expectations.
drop function if exists public.fn_bbs_callout_selftest();
create function public.fn_bbs_callout_selftest()
returns table (
  case_no  int,
  callout  text,
  expected text,
  got      text,
  passed   boolean
)
language plpgsql
stable
set search_path = public
as $$
declare
  -- Beam 300 wide × 450 deep × 5000 long, 25 cover, no anchorage.
  t text := E'4-Y16 BOTTOM\n2-Y12 TOP\n2-Y16 CRANK\nY8 @150 STIRRUP\nY7 @100 STIRRUP';
  r record;
  v_exp text;
begin
  for r in
    select * from public.fn_bbs_parse_callouts(t, 5000, 300, 450, 25, 0, false, null, 'B1')
    order by line_no
  loop
    v_exp := case r.line_no
      -- 5000 − 2×25 = 4950 straight
      when 1 then '4 × Ø16 STR, A=4950, cut 4950.00'
      when 2 then '2 × Ø12 STR, A=4950, cut 4950.00'
      -- rise = 450 − 50 − 16 = 384; cut = 4950 + 2×0.42×384 − 4×16 = 5208.56
      when 3 then '2 × Ø16 CRANK, A=4950, B=384, cut 5208.56'
      -- A=250, B=400; count = floor(4950/150)+1 = 34; cut = 1364.00
      when 4 then '34 × Ø8 STIRR-R, A=250, B=400, cut 1364.00'
      -- Ø7 is not rolled — must be refused, not rounded
      when 5 then 'REFUSED: not a rolled bar size'
      else '?' end;

    case_no  := r.line_no;
    callout  := r.source_line;
    expected := v_exp;
    got      := case
      when not r.ok then 'REFUSED: ' || r.problem
      else format('%s × Ø%s %s, A=%s%s, cut %s',
                  r.qty, r.dia_mm, r.shape_code, trim_scale(r.a_mm),
                  case when r.b_mm > 0 then ', B=' || trim_scale(r.b_mm) else '' end,
                  r.cutting_length_mm)
      end;
    passed := case
      when r.line_no = 5 then not r.ok and r.problem like '%rolled bar size%'
      else got = expected end;
    return next;
  end loop;
end $$;

revoke all on function public.fn_bbs_callout_selftest() from public, anon;
grant execute on function public.fn_bbs_callout_selftest() to authenticated;


-- ############################################################
-- ###  6. VERIFY
-- ############################################################
select * from public.fn_bbs_callout_selftest() order by case_no;

-- 051's engine must still be intact — 052 changes nothing in it, and this is
-- the cheapest way to know that.
select count(*) filter (where passed) as engine_passing,
       count(*)                        as engine_total
from public.fn_bbs_selftest();

select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_bbs_parse_callouts', 'fn_bbs_preview_callouts',
                    'fn_bbs_apply_callouts', 'fn_bbs_callout_selftest')
group by p.proname order by p.proname;
