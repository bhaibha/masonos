-- ============================================================
-- MASON OS — Migration 037: the daily digest must follow is_member() semantics
--
-- 036's fn_daily_task_digest joined `project_members` directly, so it only ever
-- found people with an explicit membership row. But `is_member()` — the rule
-- every RLS policy in this app uses — returns TRUE for a founder on every
-- project, membership row or not. Founders therefore have no rows in that
-- table, and the digest silently returned nothing for them: a pending task sat
-- on screen while the notification insisted there was nothing due.
--
-- The lesson is broader than this function: anything that asks "which projects
-- does this person work on" must ask it the same way RLS does, or the two will
-- disagree exactly when it matters.
--
--   founder            → every active project
--   pm / supervisor    → the projects they are assigned to
--   accounts           → none; they don't work tasks
--
-- Re-runnable: single create-or-replace, same signature as 036.
-- ============================================================

create or replace function public.fn_daily_task_digest()
returns table (
  user_id       uuid,
  full_name     text,
  task_count    int,
  overdue_count int,
  project_names text
)
language sql
stable
security definer
set search_path = public
as $$
  with today as (select (now() at time zone 'Asia/Kolkata')::date as d),
  -- Everyone who can act on a task, scoped the way is_member() scopes them.
  workers as (
    -- Founders: every active project, with or without a membership row.
    select p.id as user_id, pr.id as project_id, p.full_name
    from public.profiles p
    cross join public.projects pr
    where p.is_active
      and p.role = 'founder'
      and pr.status::text = 'active'

    union

    -- Everyone else: exactly what they are assigned to.
    select p.id, pm.project_id, p.full_name
    from public.project_members pm
    join public.profiles p on p.id = pm.user_id
    where p.is_active
      and p.role in ('pm', 'supervisor')
  ),
  mine as (
    select
      w.user_id,
      w.full_name,
      pr.name as project_name,
      count(*) filter (where t.planned_date = td.d) as due_today,
      count(*) filter (where t.planned_date < td.d) as overdue
    from workers w
    join public.tasks t on t.project_id = w.project_id
    join public.projects pr on pr.id = w.project_id
    cross join today td
    where t.status::text = 'pending'
      and t.planned_date <= td.d
      and pr.status::text = 'active'
    group by w.user_id, w.full_name, pr.name
  )
  select
    m.user_id,
    m.full_name,
    sum(m.due_today)::int,
    sum(m.overdue)::int,
    string_agg(distinct m.project_name, ', ' order by m.project_name)
  from mine m
  group by m.user_id, m.full_name
  having sum(m.due_today) + sum(m.overdue) > 0;
$$;

revoke all on function public.fn_daily_task_digest() from public, anon, authenticated;


-- ---------- VERIFY ----------
-- With a pending task on an active project, the founder should now appear.
select * from public.fn_daily_task_digest();
