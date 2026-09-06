-- ============================================================
-- CLEAR THE TEST RECORDS INSIDE A PROJECT — keep the project itself
--
-- For the case where the PROJECT is real but the rows in it are not: you were
-- checking that the tabs work and typed expenses, tasks, photos, snags, POs and
-- bills that mean nothing. This empties those and leaves the project set up.
--
-- IT ROLLS BACK BY DEFAULT. Run it, read the report, and only then change the
-- last line from ROLLBACK to COMMIT and run it again. Nothing is destroyed on
-- the first run.
--
-- Run it in the Supabase SQL editor, which connects as `postgres` — RLS does
-- not apply there, which is the only reason this can reach rows the app itself
-- refuses to delete (expenses, POs, invoices and stock have no DELETE policy on
-- purpose; CLAUDE.md says void, never delete). That rule protects a real
-- ledger. These rows were never real, so there is no audit trail worth keeping
-- and a ledger full of voided test entries would be worse than an empty one.
-- **Do not adapt this script for live data.** Use the app's void.
--
-- WHAT IS KEPT (edit §1 to change)
--   projects            the project row, contract value, dates, DLP
--   project_members     who is assigned to it
--   client_projects     the client's portal link
--   budgets             the budget lines you set up
--   schedule_activities the programme
--
-- Kept by default because losing a real one hurts and clearing a fake one is
-- two taps in the app. Delete a line from the keep list to wipe it too.
--
-- WHAT IS DELETED
--   Every other row in the 44 project-scoped tables: expenses, tasks, site
--   logs, materials in and out, petty cash, documents, photos, drawings,
--   snags, NCRs, RFIs, site instructions, VOs, POs, invoices, RA bills,
--   retention, BGs, insurance, compliance, clashes, approvals, client
--   messages, health snapshots, labour, BBS members, assistant threads.
--
-- Verified against a real PostgreSQL: EVERY foreign key pointing at a
-- project-scoped table is ON DELETE CASCADE or SET NULL — there is not one
-- NO ACTION or RESTRICT among them — so no delete here can be blocked by a
-- child row, and the order does not matter. Child tables without a project_id
-- of their own (po_lines, invoice_items, ra_bill_lines' quotes, petty cash
-- entries, drawing revisions, BBS bars) go with their parent through that
-- cascade. There are also no BEFORE/AFTER DELETE triggers on these tables
-- other than the audit logger, so nothing can raise mid-way.
-- ============================================================
begin;

-- ---------- 1. WHICH PROJECT, AND WHAT TO KEEP ----------

create temp table _clear_projects (name text) on commit drop;
insert into _clear_projects (name) values
  ('__put_the_project_name_here__')     -- exactly as it appears on the dashboard
  ;

create temp table _keep_tables (table_name text) on commit drop;
insert into _keep_tables (table_name) values
  ('project_members'),      -- who works on it
  ('client_projects'),      -- the client's portal access
  ('budgets'),              -- the budget lines
  ('schedule_activities')   -- the programme
  ;


-- ---------- 2. WHAT WILL GO ----------
-- The report goes into a TEMP TABLE, not `raise notice`. The Supabase SQL
-- editor does not display notices at all, so a dry run reported through them
-- shows the founder nothing and the safety pass is worthless — found the first
-- time this was run for real. §5 selects this table, and the editor shows the
-- LAST result set, so there is exactly one final select in this file.
create temp table _report (
  project      text,
  disposition  text,      -- CLEAR or keep
  table_name   text,
  rows_before  bigint,
  rows_deleted bigint
) on commit drop;

do $$
declare
  p record; t record; n bigint;
begin
  -- `pj`, not `p`: the record variable declared above shadows a table alias of
  -- the same name, and plpgsql reports it as "record p is not assigned yet",
  -- which reads like a logic bug rather than a name collision.
  if not exists (select 1 from public.projects pj join _clear_projects c on c.name = pj.name) then
    raise exception
      'No project matches that name. Names in the database: %',
      (select string_agg(name, ' | ' order by name) from public.projects);
  end if;

  for p in
    select pr.id, pr.name from public.projects pr
    join _clear_projects c on c.name = pr.name
    order by pr.name
  loop
    -- Tables that WILL be cleared. Only rows that exist are listed, so the
    -- report is what you are about to lose rather than 44 lines of zeroes.
    for t in
      select c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name
       and tb.table_type = 'BASE TABLE'
      where c.table_schema = 'public'
        and c.column_name = 'project_id'
        and c.table_name not in (select table_name from _keep_tables)
      order by 1
    loop
      execute format('select count(*) from public.%I where project_id = $1', t.table_name)
        into n using p.id;
      if n > 0 then
        insert into _report values (p.name, 'CLEAR', t.table_name, n, null);
      end if;
    end loop;

    -- And what survives, listed even at zero — "budgets 0" is worth seeing,
    -- because it says the budget you thought you had set up is not there.
    for t in select table_name from _keep_tables order by 1 loop
      execute format('select count(*) from public.%I where project_id = $1', t.table_name)
        into n using p.id;
      insert into _report values (p.name, 'keep', t.table_name, n, 0);
    end loop;
  end loop;
end $$;


-- ---------- 3. DELETE ----------
do $$
declare
  p record; t record; killed bigint;
begin
  for p in
    select pr.id, pr.name from public.projects pr join _clear_projects c on c.name = pr.name
  loop
    for t in
      select c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name
       and tb.table_type = 'BASE TABLE'
      where c.table_schema = 'public'
        and c.column_name = 'project_id'
        and c.table_name not in (select table_name from _keep_tables)
      order by 1
    loop
      execute format('delete from public.%I where project_id = $1', t.table_name) using p.id;
      get diagnostics killed = row_count;
      -- Stamped back onto the report, so `rows_deleted` can be compared with
      -- `rows_before`. They should match; a difference means something wrote
      -- to the table between the two passes.
      update _report r
         set rows_deleted = killed
       where r.project = p.name and r.table_name = t.table_name and r.disposition = 'CLEAR';
    end loop;
  end loop;
end $$;


-- ---------- 4. THE FILES ARE STILL IN STORAGE ----------
-- Deleting a `documents` row does not delete the file behind it. Every path in
-- this app starts `<project_id>/`, so this removes the objects for the same
-- project. Commented out because it is the one part with no report and no
-- second chance — uncomment only when the row counts above looked right.
--
-- do $$
-- declare p record; n bigint;
-- begin
--   for p in select pr.id from public.projects pr join _clear_projects c on c.name = pr.name loop
--     delete from storage.objects
--      where bucket_id in ('documents','site-photos','receipts','drawings','compliance')
--        and name like p.id::text || '/%';
--     get diagnostics n = row_count;
--     raise notice 'deleted % storage object(s)', n;
--   end loop;
-- end $$;


-- ---------- 5. THE REPORT ----------
-- The ONLY select in this file, because the editor shows the last result set.
-- Read every CLEAR line: that is what disappears when you change ROLLBACK to
-- COMMIT. A TOTAL line closes each project.
select project, disposition, table_name, rows_before, rows_deleted
from (
  select project, disposition, table_name, rows_before, rows_deleted,
         case disposition when 'CLEAR' then 1 else 2 end as grp,
         table_name as sort2
  from _report
  union all
  select project, 'TOTAL', '— rows cleared —',
         sum(rows_before), sum(rows_deleted), 1, 'zzzz'
  from _report where disposition = 'CLEAR'
  group by project
) q
order by project, grp, sort2;


-- ---------- 6. CHANGE THIS TO COMMIT WHEN THE COUNTS LOOK RIGHT ----------
rollback;
