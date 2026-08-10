-- ============================================================
-- MASON OS — Migration 041: overhead categories become a founder-managed list
--
-- 040 made the 12 overhead headings an enum, on the argument that a lookup
-- table invites someone to "just add one" mid-month and quietly split a year's
-- reporting in two. That argument was about WHO can add one, not about whether
-- the list can ever change — and it is the founder's firm, so it should be the
-- founder's chart of headings.
--
-- So: a table, with the guards that make the original worry unfounded.
--
--   * Only a FOUNDER can add, rename or retire a heading. Accounts picks from
--     the list. One person decides what the headings are, which is the whole
--     point — two people inventing headings is how "Office utilities" and
--     "Internet" become two series that nobody can compare year on year.
--   * A unique index on lower(btrim(name)) means "Software", "software" and
--     "Software " are the same heading, refused at the database. Case and a
--     trailing space are the two ways a duplicate actually gets created.
--   * RETIRE, don't delete, anything that has been used. Deleting a heading
--     with history behind it would orphan or silently re-file real money;
--     retiring hides it from new entries and leaves every past entry reporting
--     exactly as it always did. `fn_delete_overhead_category` allows a true
--     delete ONLY for a heading nothing has ever pointed at — the typo you
--     created a minute ago.
--
-- Renaming is safe here because entries reference the heading by id, not by
-- text: correcting a spelling updates the history rather than forking it.
--
-- ---------- WHY NOT A BRANCH IN fn_delete_record ----------
-- Same reason `fn_void_company_expense` is its own function (040): every branch
-- in that dispatcher resolves a project and calls `is_member()`. An overhead
-- heading has no project. A branch there would be routing with nowhere to
-- route. The contract is what matters and it is kept: no DELETE policy on the
-- table, security definer, founder-gated, and a refusal that names what is in
-- the way.
--
-- Re-runnable throughout — the enum-to-table migration is guarded on the old
-- column still existing.
-- ============================================================


-- ############################################################
-- ###  1. THE TABLE
-- ############################################################
create table if not exists public.overhead_categories (
  id uuid primary key default gen_random_uuid(),

  name text not null,

  -- Only the 12 seeded headings carry a slug: it is the key the old enum
  -- values are matched on during the backfill below, and nothing reads it
  -- afterwards. A founder-created heading has none.
  slug text unique,

  -- Retired headings stay for history and disappear from new entries.
  active boolean not null default true,

  -- Seeds are spaced by 10 so a new heading can be slotted between two of them
  -- later without renumbering the world.
  sort_order int not null default 999,

  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The guard that makes a free-typed list safe: one heading per name, ignoring
-- case and surrounding space.
drop index if exists public.overhead_cat_name_uk;
create unique index overhead_cat_name_uk
  on public.overhead_categories (lower(btrim(name)));

comment on table public.overhead_categories is
  'Founder-managed chart of overhead headings. Retire, never delete, anything '
  'with history behind it — company_expenses references these by id, so a '
  'rename corrects the past rather than forking it.';


-- ############################################################
-- ###  2. SEED — the 12 headings from 040
-- ############################################################
-- `on conflict (slug) do nothing`: re-running must not resurrect a heading the
-- founder has since renamed or retired.
insert into public.overhead_categories (name, slug, sort_order) values
  ('GST / tax payment',              'gst_tax',               10),
  ('Licence & statutory fees',       'license_statutory',     20),
  ('Software & subscriptions',       'software',              30),
  ('Office rent',                    'office_rent',           40),
  ('Office utilities',               'office_utilities',      50),
  ('Non-site salaries',              'non_site_salaries',     60),
  ('Professional fees (CA / legal)', 'professional_fees',     70),
  ('Bank charges',                   'bank_charges',          80),
  ('Marketing',                      'marketing',             90),
  ('Insurance (non-project)',        'insurance_non_project', 100),
  ('Depreciation',                   'depreciation',          110),
  ('Miscellaneous',                  'misc',                  120)
on conflict (slug) do nothing;


-- ############################################################
-- ###  3. RLS — founder writes, accounts reads
-- ############################################################
alter table public.overhead_categories enable row level security;

drop policy if exists overhead_cat_read on public.overhead_categories;
create policy overhead_cat_read on public.overhead_categories
  for select to authenticated
  using (public.my_role() in ('founder', 'accounts'));

-- Insert, rename and retire are all founder-only. Accounts records money
-- against the headings; it does not decide what the headings are.
drop policy if exists overhead_cat_insert on public.overhead_categories;
create policy overhead_cat_insert on public.overhead_categories
  for insert to authenticated
  with check (public.my_role() = 'founder');

drop policy if exists overhead_cat_update on public.overhead_categories;
create policy overhead_cat_update on public.overhead_categories
  for update to authenticated
  using (public.my_role() = 'founder')
  with check (public.my_role() = 'founder');

-- No DELETE policy. fn_delete_overhead_category is the only path.


-- ############################################################
-- ###  4. AUDIT
-- ############################################################
drop trigger if exists audit_overhead_categories on public.overhead_categories;
create trigger audit_overhead_categories
  after insert or update or delete on public.overhead_categories
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  5. MOVE company_expenses OFF THE ENUM
-- ############################################################
alter table public.company_expenses
  add column if not exists category_id uuid references public.overhead_categories(id);

-- Backfill and drop, guarded on the old column still being there so a second
-- run is a no-op rather than an error. The whole block is dynamic SQL for the
-- same reason: a plain UPDATE naming `category` fails to plan once the column
-- is gone, even inside an `if` that is false.
do $$
declare v_orphans int;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'company_expenses'
      and column_name  = 'category'
  ) then
    execute $q$
      update public.company_expenses c
         set category_id = oc.id
        from public.overhead_categories oc
       where oc.slug = c.category::text
         and c.category_id is null
    $q$;

    -- Nothing may be left behind: an entry with no heading would vanish from
    -- every total silently, which is worse than the migration failing here.
    execute 'select count(*) from public.company_expenses where category_id is null'
      into v_orphans;
    if v_orphans > 0 then
      raise exception
        '% overhead row(s) could not be matched to a heading. Aborting rather than losing them from the totals.',
        v_orphans;
    end if;

    -- The index named the old column, so it goes first.
    execute 'drop index if exists public.company_exp_live_idx';
    execute 'alter table public.company_expenses drop column category';
  end if;
end $$;

-- Backfilled, so it can be required from here on.
alter table public.company_expenses
  alter column category_id set not null;

create index if not exists company_exp_live_idx
  on public.company_expenses (spend_date, category_id)
  where voided_at is null;

-- The enum has no remaining references. Dropping it stops anyone reading two
-- sources of truth for the same list a year from now; if something unexpected
-- still depends on it, leave it and carry on rather than failing the migration.
do $$ begin
  drop type if exists overhead_category;
exception when dependent_objects_still_exist then
  raise notice 'overhead_category still has dependents — left in place.';
end $$;


-- ############################################################
-- ###  6. DELETE A HEADING — only one nothing has ever used
-- ############################################################
create or replace function public.fn_delete_overhead_category(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_n int; v_name text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() <> 'founder' then
    raise exception 'Only a founder may remove an overhead heading.'
      using errcode = '42501';
  end if;

  select name into v_name from public.overhead_categories where id = p_id;
  if v_name is null then
    raise exception 'That heading no longer exists.';
  end if;

  -- Voided entries count here too. A voided row is still a row someone will
  -- read one day, and it must still be able to say what it was for.
  select count(*) into v_n
  from public.company_expenses where category_id = p_id;

  if v_n > 0 then
    raise exception
      '"%" has % overhead entr% behind it. Retire it instead — it will disappear from new entries and leave the history intact.',
      v_name, v_n, case when v_n = 1 then 'y' else 'ies' end;
  end if;

  delete from public.overhead_categories where id = p_id;
end $$;

revoke all on function public.fn_delete_overhead_category(uuid) from public, anon;
grant execute on function public.fn_delete_overhead_category(uuid) to authenticated;


-- ############################################################
-- ###  7. SUMMARY — now grouped by heading id
-- ############################################################
-- Return type changes, and `create or replace` cannot change a return type.
-- Drop first (the 035 lesson), or this fails with "cannot change return type".
drop function if exists public.fn_overhead_summary(date, date);

create function public.fn_overhead_summary(
  p_from date,
  p_to   date
)
returns table (
  category_id   uuid,
  category_name text,
  entry_count   int,
  amount        numeric,
  gst_amount    numeric,
  total         numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    oc.id,
    oc.name,
    count(*)::int,
    sum(c.amount)::numeric(14,2),
    sum(c.gst_amount)::numeric(14,2),
    sum(c.amount + c.gst_amount)::numeric(14,2)
  from public.company_expenses c
  join public.overhead_categories oc on oc.id = c.category_id
  where c.voided_at is null
    and c.spend_date between p_from and p_to
    and public.my_role() in ('founder', 'accounts')
  group by oc.id, oc.name
  order by sum(c.amount + c.gst_amount) desc;
$$;

revoke all on function public.fn_overhead_summary(date, date) from public, anon;
grant execute on function public.fn_overhead_summary(date, date) to authenticated;


-- ############################################################
-- ###  8. COPY A MONTH FORWARD — same guard, new column
-- ############################################################
-- Identical to 040 except that it carries category_id. Re-emitted whole rather
-- than patched, so the file is the definition.
create or replace function public.fn_duplicate_overheads(
  p_source_month date,
  p_target_month date
)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_src_start date := date_trunc('month', p_source_month)::date;
  v_tgt_start date := date_trunc('month', p_target_month)::date;
  v_n int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'accounts') then
    raise exception 'Only a founder or accounts may copy overheads.'
      using errcode = '42501';
  end if;
  if v_src_start = v_tgt_start then
    raise exception 'Source and target month are the same.';
  end if;

  select count(*) into v_n
  from public.company_expenses
  where voided_at is null
    and spend_date >= v_tgt_start
    and spend_date < (v_tgt_start + interval '1 month')::date;

  if v_n > 0 then
    raise exception
      'That month already has % overhead entr%. Copying again would double them — void what is there first if you want to start over.',
      v_n, case when v_n = 1 then 'y' else 'ies' end;
  end if;

  insert into public.company_expenses
    (spend_date, category_id, amount, gst_amount, vendor_id, vendor_name,
     description, created_by)
  select
    least(
      v_tgt_start + (extract(day from s.spend_date)::int - 1),
      (v_tgt_start + interval '1 month' - interval '1 day')::date
    ),
    s.category_id, s.amount, s.gst_amount, s.vendor_id, s.vendor_name,
    s.description, auth.uid()
  from public.company_expenses s
  where s.voided_at is null
    and s.spend_date >= v_src_start
    and s.spend_date < (v_src_start + interval '1 month')::date;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_duplicate_overheads(date, date) from public, anon;
grant execute on function public.fn_duplicate_overheads(date, date) to authenticated;


-- `fn_company_net` is untouched: it sums amounts, and never looked at the
-- heading.


-- ############################################################
-- ###  9. VERIFY
-- ############################################################
-- Expect 12 seeded headings, all active.
select count(*) as seeded_headings,
       count(*) filter (where active) as active_headings
from public.overhead_categories;

-- Expect category_id (uuid, not null) present and NO `category` column.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'company_expenses'
  and column_name in ('category', 'category_id');

-- Expect zero: every existing overhead kept its heading through the move.
select count(*) as unmatched_overheads
from public.company_expenses where category_id is null;

-- Expect all three.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_delete_overhead_category', 'fn_overhead_summary',
                  'fn_duplicate_overheads')
order by proname;

-- Expect exactly one row — two would mean an overload survived (the 035 trap).
select count(*) as overhead_summary_arities from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'fn_overhead_summary';
