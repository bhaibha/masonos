-- READ ONLY. What is actually in the database, per project and per user.
do $$
declare
  p record; t record; n bigint; total bigint; detail text;
begin
  raise notice '%', '';
  raise notice '%', '=== PROJECTS ===';
  raise notice '%', rpad('PROJECT',24) || rpad('STATUS',12) || rpad('ROWS',8) || 'BIGGEST TABLES';
  raise notice '%', repeat('-', 100);

  for p in select id, name, status::text as st from public.projects order by name loop
    total := 0; detail := '';
    for t in
      select c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name
       and tb.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'project_id'
      order by 1
    loop
      execute format('select count(*) from public.%I where project_id = $1', t.table_name)
        into n using p.id;
      if n > 0 then
        total := total + n;
        if n >= 3 then detail := detail || format('%s(%s) ', t.table_name, n); end if;
      end if;
    end loop;
    raise notice '%', rpad(p.name,24) || rpad(p.st,12) || rpad(total::text,8) || detail;
  end loop;

  raise notice '%', '';
  raise notice '%', '=== USERS ===';
  raise notice '%', rpad('EMAIL',34) || rpad('ROLE',12) || rpad('VERDICT',10) || 'IN THE WAY';
  raise notice '%', repeat('-', 100);
  for p in
    select au.id, au.email, coalesce(pr.role::text,'(none)') as role
    from auth.users au left join public.profiles pr on pr.id = au.id
    order by au.email
  loop
    total := 0; detail := '';
    for t in
      select c.conrelid::regclass::text as tbl, a.attname::text as col, c.confdeltype as od
      from pg_constraint c
      join unnest(c.conkey) with ordinality k(attnum, ord) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype='f' and c.confrelid='public.profiles'::regclass and c.confdeltype not in ('c','n')
      order by 1,2
    loop
      execute format('select count(*) from %s where %I = $1', t.tbl, t.col) into n using p.id;
      if n > 0 then
        total := total + n;
        detail := detail || format('%s.%s(%s) ', replace(t.tbl,'public.',''), t.col, n);
      end if;
    end loop;
    raise notice '%', rpad(coalesce(p.email,'?'),34) || rpad(p.role,12)
      || rpad(case when total=0 then 'SAFE' else 'BLOCKED' end,10)
      || case when total=0 then '-' else detail end;
  end loop;
  raise notice '%', '';
end $$;
