-- ============================================================================
-- 081 — A goods receipt needs a number of its own
-- ============================================================================
--
-- WHY
-- ---
-- `goods_receipts` has existed since 012 with no human-readable reference:
-- id, po_id, received_date, note, challan_photo, received_by, created_at.
-- That was fine while the GRN only ever appeared inside the app, next to the
-- PO it belongs to. It stops being fine the moment it is a PDF — a printed
-- document that a store-keeper files, a vendor is shown, or an accounts query
-- refers to needs something to be called, and "the receipt against PO-000042
-- on the 3rd" is not a reference, it is a description.
--
-- Every other document in this app already has one, all in the same shape:
-- PO-000042 (012), SNG-0001 (027), NCR-0001 (043), CA-0001 (060),
-- CLH-0001 (062). This follows it exactly rather than inventing a format.
--
-- NO GUARD TRIGGER, AND THAT IS DELIBERATE
-- ----------------------------------------
-- 060 and 062 both carry a BEFORE UPDATE trigger refusing a change to the
-- document number, because those tables have writable UPDATE policies.
-- `goods_receipts` has SELECT and INSERT policies and NO UPDATE POLICY AT ALL
-- (012, lines 312–320) — so a PATCH from the client is refused by RLS before
-- any trigger would fire. The 069 lesson, the other way round: here the
-- ABSENCE of a policy is already the protection, and adding a trigger would be
-- machinery guarding a door that is welded shut. The only writes to this table
-- are the SECURITY DEFINER void/cancel functions in 020/021, which touch
-- voided_at and never the number.
--
-- fn_receive_goods NEEDS NO CHANGE
-- --------------------------------
-- Its insert (015, re-emitted in 020 and 021 — the 021 arity is the live one)
-- names po_id, received_date, note and received_by. It does not name grn_no,
-- so the column DEFAULT supplies it. Checked before writing this, per the 077
-- lesson: read the function before changing it.
--
-- THE ORDER OF §3 AND §4 IS THE WHOLE MIGRATION
-- ---------------------------------------------
-- Backfill the existing rows FIRST, then advance the sequence past the highest
-- number the backfill used. Doing it the other way round — or setting the
-- default before the backfill — gives the next real receipt a number a
-- historical row already holds, and the UNIQUE constraint refuses the insert.
-- That is exactly the collision the test-data clear produced in September when
-- the sequences were reset before the delete was committed. The setval is
-- wrapped in greatest() so a second run cannot wind the sequence BACKWARDS,
-- which would reintroduce the same collision on a re-run.
--
-- Re-runnable: sequence `if not exists`, column `add column if not exists`
-- (the 042 lesson — a create statement is not the source of truth once the
-- table exists), backfill scoped to `where grn_no is null`, setval guarded.
-- ============================================================================

-- ############################################################
-- ###  1. The sequence
-- ############################################################
create sequence if not exists public.grn_no_seq;

-- ############################################################
-- ###  2. The column — nullable for now, so the backfill can run
-- ############################################################
alter table public.goods_receipts
  add column if not exists grn_no text;

-- ############################################################
-- ###  3. Backfill the receipts already recorded
-- ############################################################
-- Chronological, so GRN-0001 is genuinely the first goods this firm received
-- rather than whichever row the planner happened to return first.
-- `created_at` breaks a tie within a day; `id` makes it total, so the
-- numbering is reproducible if this ever has to be rebuilt from scratch.
with ordered as (
  select id,
         row_number() over (order by received_date, created_at, id) as n
  from public.goods_receipts
  where grn_no is null
)
update public.goods_receipts g
   set grn_no = 'GRN-' || lpad(o.n::text, 4, '0')
  from ordered o
 where o.id = g.id;

-- ############################################################
-- ###  4. Move the sequence past everything the backfill used
-- ############################################################
-- Reads the numbers actually present rather than counting rows: if a receipt
-- is ever hard-deleted, counting would hand its number to the next one.
-- greatest(…, last_value) means a re-run is a no-op instead of a rewind.
select setval(
  'public.grn_no_seq',
  greatest(
    (select coalesce(max(nullif(regexp_replace(grn_no, '\D', '', 'g'), ''))::bigint, 0)
       from public.goods_receipts),
    (select last_value from public.grn_no_seq)
  ),
  true
);

-- ############################################################
-- ###  5. Now it can carry the default and the constraints
-- ############################################################
alter table public.goods_receipts
  alter column grn_no
  set default 'GRN-' || lpad(nextval('public.grn_no_seq')::text, 4, '0');

-- Only safe because §3 filled every existing row. If this raises, the backfill
-- did not run — do not "fix" it by dropping the NOT NULL.
alter table public.goods_receipts
  alter column grn_no set not null;

create unique index if not exists goods_receipts_grn_no_uk
  on public.goods_receipts (grn_no);

-- A GRN is read by anyone who may read the PO it belongs to; `grn_read` (012)
-- already scopes that, and this table has no column grants, so the new column
-- needs no grant of its own. (Checked — the 027 trap applies to `projects` and
-- `material_inward`, not here.)

-- ############################################################
-- ###  6. Verify
-- ############################################################
-- One final SELECT, because the Supabase SQL editor shows only the LAST result
-- set and does not display `raise notice` at all.
--
-- Expect: col = 1, has_default = 1, is_not_null = 1, uk = 1, unnumbered = 0,
--         duplicates = 0, and seq_ahead_of_max = true.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'goods_receipts'
      and column_name = 'grn_no')                                    as col,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'goods_receipts'
      and column_name = 'grn_no' and column_default is not null)     as has_default,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'goods_receipts'
      and column_name = 'grn_no' and is_nullable = 'NO')             as is_not_null,
  (select count(*) from pg_indexes
    where schemaname = 'public'
      and indexname = 'goods_receipts_grn_no_uk')                    as uk,
  (select count(*) from public.goods_receipts where grn_no is null)  as unnumbered,
  (select count(*) from (
      select grn_no from public.goods_receipts
       group by grn_no having count(*) > 1) d)                       as duplicates,
  (select (select last_value from public.grn_no_seq)
          >= coalesce(max(nullif(regexp_replace(grn_no, '\D', '', 'g'), ''))::bigint, 0)
     from public.goods_receipts)                                     as seq_ahead_of_max;
