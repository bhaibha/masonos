-- ============================================================
-- REMOVE TEST DATA AND TEST USERS
--
-- IT ROLLS BACK BY DEFAULT. Run it, read the counts, and only then change
-- the last line from ROLLBACK to COMMIT and run it again. Nothing is
-- destroyed on the first run.
--
-- Deleting a project CASCADES to 45 tables — tasks, expenses, documents,
-- photos, snags, RFIs, invoices, approvals, everything. There is no undo.
-- Name only projects you are certain are test.
-- ============================================================
begin;

-- ---------- 1. NAME WHAT IS TEST ----------
-- Edit both lists. Leave a list empty to skip that half.

create temp table _test_users (email text) on commit drop;
insert into _test_users (email) values
  ('testclient@yourmasons.test')          -- add more rows as needed
  ;

create temp table _test_projects (name text) on commit drop;
insert into _test_projects (name) values
  ('__none__')                            -- e.g. ('Test Villa') — see warning above
  ;

-- ---------- 2. SHOW WHAT WILL GO ----------
do $$
declare r record; n bigint;
begin
  raise notice '%', '';
  raise notice '%', '--- users to delete ---';
  for r in
    select au.id, au.email from auth.users au
    join _test_users t on lower(t.email) = lower(au.email)
  loop
    raise notice '  % (%)', r.email, r.id;
  end loop;

  raise notice '%', '--- projects to delete (CASCADES) ---';
  for r in
    select p.id, p.name from public.projects p
    join _test_projects t on t.name = p.name
  loop
    execute 'select count(*) from public.expenses where project_id = $1' into n using r.id;
    raise notice '  % — % expense row(s) will go with it', r.name, n;
  end loop;
  raise notice '%', '';
end $$;

-- ---------- 3. DELETE ----------

-- Projects first: the cascade removes their client_projects links, so a test
-- client attached only to a test project becomes deletable in the same run.
delete from public.projects p
using _test_projects t
where t.name = p.name;

-- Rows that would otherwise BLOCK the user delete, but only ones the user
-- authored themselves. Nothing here touches another person's records.
delete from public.client_messages m
using auth.users au, _test_users t
where m.author_id = au.id and lower(t.email) = lower(au.email);

delete from public.client_photos c
using auth.users au, _test_users t
where c.published_by = au.id and lower(t.email) = lower(au.email);

delete from public.documents d
using auth.users au, _test_users t
where d.uploaded_by = au.id and lower(t.email) = lower(au.email);

-- The user. Cascades to profiles, and from there to project_members,
-- client_projects and push_subscriptions.
delete from auth.users au
using _test_users t
where lower(t.email) = lower(au.email);

-- ---------- 4. WHAT IS LEFT ----------
select 'projects' as thing, count(*) from public.projects
union all select 'users', count(*) from auth.users
union all select 'profiles', count(*) from public.profiles
union all select 'client_projects', count(*) from public.client_projects
order by 1;

-- ---------- 5. CHANGE THIS TO COMMIT WHEN THE COUNTS LOOK RIGHT ----------
rollback;
