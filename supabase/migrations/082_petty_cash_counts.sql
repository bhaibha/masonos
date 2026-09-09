-- ============================================================================
-- 082 — A cash count is a record, not a moment
--       (and the repair of a petty cash bug that has been live since 002)
-- ============================================================================
--
-- §0 IS A PRODUCTION BUG, FOUND BY RUNNING THE CHAIN
-- --------------------------------------------------
-- `fn_pc_to_expense` (002, re-emitted in 020) mirrors a petty cash SPEND into
-- the ledger with `coalesce(new.category_id, 999)` — clearly meaning "fall
-- back to Misc". But `expense_categories.id` is a SERIAL and the 002 seed
-- inserts (name, sort) without ids, so 'Misc' is **id 18 with sort 999**.
-- There is no category 18… sorry, there is no category with ID 999 at all.
--
-- So a petty cash spend saved WITHOUT a category has always raised
--     insert or update on table "expenses" violates foreign key constraint
--     "expenses_category_id_fkey" — Key (category_id)=(999) is not present
-- and, because the trigger runs in the same transaction, the ENTRY IS
-- REFUSED too. `petty_cash_entries.category_id` is nullable, so the schema
-- openly invites the case that breaks.
--
-- It has never been reported because M21 has no screen — nobody has ever been
-- able to save a petty cash entry through the app. The 069 lesson exactly: a
-- capability nobody exercises is a capability nobody discovers is broken. It
-- would have surfaced on the first spend logged through the UI this migration
-- is being written for.
--
-- Fixed by resolving Misc BY NAME (which the seed guarantees and a unique
-- index protects) instead of by a guessed id. It deliberately RAISES rather
-- than creating the category if it is missing — inventing master data to make
-- a write succeed is the thing 050 refused to do.
--
-- WHY THIS IS THE ONLY SCHEMA CHANGE M21 NEEDS
-- -------------------------------------------
-- Everything else the petty cash screens use already exists and was checked
-- before this file was written, not assumed (the 077 lesson):
--   · petty_cash_accounts (002)      — project_id, holder, imprest_amount,
--                                      unique(project_id, holder)
--   · pc_entry_type (002)            — 'top_up' | 'spend' | 'return'
--   · petty_cash_entries (002)       — + voided_at/by/reason from 020
--   · fn_pc_to_expense (002 → 020)   — a SPEND mirrors into expenses carrying
--                                      pc_entry_id, so the void can find it
--   · v_petty_cash_balance (020)     — security_invoker, voided entries
--                                      excluded IN THE JOIN
--   · fn_void_record (021)           — 'petty_cash_entries' branch, founder/
--                                      accounts only, cascades to the expense
--   · pca_read/pca_write, pce_read/pce_insert (002 → 078)
-- The module has had a complete backend and no screen since February. This
-- migration adds the ONE thing the screens need that the database cannot
-- already answer: what was physically in the tin, and when.
--
-- THE BOOK BALANCE IS FROZEN, NOT RECOMPUTED
-- ------------------------------------------
-- `book_balance` is stored on the row rather than derived from
-- v_petty_cash_balance at read time. A reconciliation is evidence about a
-- MOMENT: if somebody voids an entry from three weeks ago, last month's count
-- must still say what it said on the day, or it stops being a reconciliation
-- and becomes a restatement. Same rule as the certified RA bill snapshot (032)
-- and the snapshotted inspection question (045).
--
-- `variance` is GENERATED, because it is a consequence of two columns on the
-- same row and nobody should have a field to type it into (the 033 rule).
--
-- NO ADJUSTING ENTRY, DELIBERATELY
-- --------------------------------
-- A count that disagrees with the book is REPORTED and nothing else. It would
-- be one line to write a `spend` for the difference, and that line would move
-- real money in the project ledger because two numbers did not match. The
-- correction stays a deliberate act somebody makes with a reason attached.
-- `pc_entry_type` is left alone for the same reason — adding an 'adjustment'
-- value would create a category of spend that never had a receipt.
--
-- COUNTS ARE APPEND-ONLY
-- ----------------------
-- SELECT and INSERT policies, no UPDATE and no DELETE — the same shape as
-- `documents` (069) and `petty_cash_entries` itself, where the ABSENCE of a
-- policy is what makes the record unbypassable. A mis-typed count is corrected
-- by counting again, which is also what happens with actual cash.
--
-- WHO MAY COUNT: exactly who may already see the account. The predicate is
-- copied from `pce_read` rather than reinvented, so the holder can count their
-- own tin (which is the person actually holding it) and founder/accounts can
-- count anyone's. `is_active_user()` is included because 078 taught that a
-- policy granting on auth.uid() alone survives deactivation.
--
-- Re-runnable: table `if not exists`, `drop policy if exists` before create,
-- `drop trigger if exists` before create.
-- ============================================================================

-- ############################################################
-- ###  0. Repair fn_pc_to_expense — see the header
-- ############################################################
-- Same shape as 020's version in every other respect: SECURITY DEFINER so a
-- holder whose role cannot write `expenses` directly still gets the mirror,
-- and it carries `pc_entry_id` so fn_void_record can find the expense to
-- reverse. The only change is how the fallback category is resolved.
create or replace function public.fn_pc_to_expense()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cat int;
begin
  if new.entry_type <> 'spend' then
    return new;
  end if;

  v_cat := new.category_id;

  if v_cat is null then
    -- By NAME, not by a guessed id. `expense_categories.name` is unique, and
    -- 'Misc' is seeded in 002.
    select id into v_cat
      from public.expense_categories
     where lower(btrim(name)) = 'misc'
     order by id
     limit 1;
  end if;

  if v_cat is null then
    -- Says what to do rather than surfacing a foreign key violation naming a
    -- constraint the person has never heard of.
    raise exception
      'This petty cash spend has no category, and no "Misc" category exists to fall back on. Pick a category, or add one named Misc.'
      using errcode = '23503';
  end if;

  insert into public.expenses (project_id, expense_date, category_id, description,
                               amount, source, receipt_path, created_by, pc_entry_id)
  select a.project_id, new.entry_date, v_cat, new.description,
         new.amount, 'petty_cash', new.receipt_path, new.created_by, new.id
  from public.petty_cash_accounts a
  where a.id = new.account_id;

  return new;
end $$;

-- ############################################################
-- ###  1. The table
-- ############################################################
create table if not exists public.petty_cash_counts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.petty_cash_accounts(id) on delete cascade,

  counted_on date not null default current_date,

  -- What was physically in the tin.
  counted_amount numeric(14,2) not null check (counted_amount >= 0),

  -- What the app said it should be, AT THE MOMENT OF COUNTING. Frozen on
  -- purpose — see the header. Not null, so a count can never exist without
  -- the figure it was checked against.
  book_balance numeric(14,2) not null,

  -- Positive = more cash than the book expected, negative = short.
  variance numeric(14,2)
    generated always as (counted_amount - book_balance) stored,

  -- Mandatory once the two disagree; the app enforces the prompt, the CHECK
  -- enforces the rule. A variance nobody explained is the thing this whole
  -- screen exists to surface.
  note text,

  counted_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),

  constraint pcc_note_when_off check (
    counted_amount = book_balance or btrim(coalesce(note, '')) <> ''
  )
);

create index if not exists pcc_account_idx
  on public.petty_cash_counts (account_id, counted_on desc);

-- ############################################################
-- ###  2. RLS — the same audience as the account itself
-- ############################################################
alter table public.petty_cash_counts enable row level security;

-- The predicate is lifted from pce_read (002 → 078) rather than rewritten, so
-- the two cannot drift: anyone who may read the entries may read the counts.
drop policy if exists pcc_read on public.petty_cash_counts;
create policy pcc_read on public.petty_cash_counts for select to authenticated
  using (
    public.is_active_user()
    and exists (
      select 1 from public.petty_cash_accounts a
      where a.id = petty_cash_counts.account_id
        and (a.holder = auth.uid() or public.my_role() in ('founder','accounts'))
    )
  );

drop policy if exists pcc_insert on public.petty_cash_counts;
create policy pcc_insert on public.petty_cash_counts for insert to authenticated
  with check (
    public.is_active_user()
    and exists (
      select 1 from public.petty_cash_accounts a
      where a.id = petty_cash_counts.account_id
        and (a.holder = auth.uid() or public.my_role() in ('founder','accounts'))
    )
  );

-- No UPDATE policy and no DELETE policy. Deliberate — see the header.

-- ############################################################
-- ###  3. Audit
-- ############################################################
-- The table is keyed by `id`, so the standard fn_audit applies (the 051 trap
-- only bites code-keyed tables).
drop trigger if exists audit_pc_counts on public.petty_cash_counts;
create trigger audit_pc_counts
  after insert or update or delete on public.petty_cash_counts
  for each row execute function public.fn_audit();

-- ############################################################
-- ###  4. Verify
-- ############################################################
-- One final SELECT — the Supabase SQL editor shows only the LAST result set
-- and does not display `raise notice` at all.
--
-- Expect: tbl = 1, gen_variance = 1, policies = 2, no_update_or_delete = 0,
--         note_check = 1, audit_trg = 1, idx = 1, misc_resolves = 1,
--         fallback_999_gone = 0.
select
  (select count(*) from public.expense_categories
    where lower(btrim(name)) = 'misc')                                    as misc_resolves,
  (select count(*) from pg_proc
    where proname = 'fn_pc_to_expense'
      and prosrc like '%coalesce(new.category_id, 999)%')                  as fallback_999_gone,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'petty_cash_counts')   as tbl,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'petty_cash_counts'
      and column_name = 'variance'
      and is_generated = 'ALWAYS')                                        as gen_variance,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'petty_cash_counts')      as policies,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'petty_cash_counts'
      and cmd in ('UPDATE','DELETE'))                                     as no_update_or_delete,
  (select count(*) from pg_constraint
    where conname = 'pcc_note_when_off')                                  as note_check,
  (select count(*) from pg_trigger
    where tgname = 'audit_pc_counts' and not tgisinternal)                as audit_trg,
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'pcc_account_idx')        as idx;
