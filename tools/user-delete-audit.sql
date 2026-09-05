-- ============================================================
-- WHICH USERS CAN BE DELETED?
--
-- Run in the Supabase SQL editor. READ ONLY — it counts, it changes nothing.
--
-- Deleting an auth user cascades to `profiles`, and from there to
-- project_members, client_projects and push_subscriptions. Everything else
-- that points at a person — created_by, raised_by, uploaded_by, decided_by,
-- published_by and about thirty more — has NO on-delete clause, so Postgres
-- REFUSES the delete rather than erasing who authorised something. That is the
-- rule in CLAUDE.md ("users are NOT deletable") enforced by the schema.
--
-- SAFE    = nothing points at them; the dashboard delete will work.
-- BLOCKED = they have done something. Deactivate (staff) or suspend/remove
--           access (client) instead. The last column names what is in the way.
-- ============================================================

do $$
declare
  u record; r record; n bigint; blockers bigint; detail text;
begin
  raise notice '%', '';
  raise notice '%', rpad('EMAIL',34) || rpad('ROLE',12) || rpad('VERDICT',10) || 'WHAT IS IN THE WAY';
  raise notice '%', repeat('-', 100);

  for u in
    select au.id, au.email, coalesce(p.role::text,'(no profile)') as role
    from auth.users au
    left join public.profiles p on p.id = au.id
    order by au.email
  loop
    blockers := 0; detail := '';
    for r in
      select c.conrelid::regclass::text as tbl, a.attname::text as col, c.confdeltype as od
      from pg_constraint c
      join unnest(c.conkey) with ordinality k(attnum, ord) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass
      order by 1, 2
    loop
      if r.od not in ('c','n') then
        execute format('select count(*) from %s where %I = $1', r.tbl, r.col)
          into n using u.id;
        if n > 0 then
          blockers := blockers + n;
          detail := detail || format('%s.%s(%s) ', replace(r.tbl,'public.',''), r.col, n);
        end if;
      end if;
    end loop;

    raise notice '%', rpad(coalesce(u.email,'?'),34) || rpad(u.role,12)
      || rpad(case when blockers = 0 then 'SAFE' else 'BLOCKED' end,10)
      || case when blockers = 0 then '-' else detail end;
  end loop;
  raise notice '%', '';
end $$;
