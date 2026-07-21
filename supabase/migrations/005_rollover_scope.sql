-- ============================================================
-- MASON OS — Migration 005: scope rollover_tasks to one project
--
-- The 001_core.sql version took only p_date, ran SECURITY DEFINER, and had no
-- authorisation check — so any authenticated user rolled over unfinished tasks
-- for EVERY project in the database, including ones they can't see.
--
-- This replaces it with a project-scoped, membership-checked version.
-- ============================================================

-- Drop the old unscoped overload first. If both existed, a call passing only
-- p_date would silently resolve to the dangerous one.
drop function if exists public.rollover_tasks(date);

create or replace function public.rollover_tasks(
  p_project uuid,
  p_date    date default current_date
)
returns int
language plpgsql
security definer                       -- needed so the copy runs as one unit
set search_path = public
as $$
declare
  n int;
begin
  -- Authorisation. SECURITY DEFINER bypasses RLS, so the checks that the
  -- tasks_read / tasks_write policies would have made are made explicitly here.
  -- auth.uid() still reflects the calling user's JWT inside a definer function.
  if auth.uid() is null then
    raise exception 'rollover_tasks: no authenticated user';
  end if;

  if not public.is_member(p_project) then
    raise exception 'rollover_tasks: not a member of project %', p_project
      using errcode = '42501';         -- insufficient_privilege
  end if;

  -- Mirrors tasks_write: accounts may read tasks but never create them.
  if public.my_role() not in ('founder', 'pm', 'supervisor') then
    raise exception 'rollover_tasks: role % may not create tasks', public.my_role()
      using errcode = '42501';
  end if;

  with src as (
    select *
    from public.tasks
    where project_id = p_project                 -- << the scoping fix
      and planned_date = p_date
      and status in ('pending', 'partial', 'not_done')
      -- don't roll the same task twice
      and not exists (
        select 1 from public.tasks c where c.rolled_from = tasks.id
      )
  ),
  ins as (
    insert into public.tasks
      (project_id, title, trade, work_area, planned_date,
       target_qty, qty_unit, rolled_from, created_by)
    select
      project_id, title, trade, work_area, p_date + 1,
      case
        when status = 'partial'
          then greatest(coalesce(target_qty, 0) - coalesce(done_qty, 0), 0)
        else target_qty
      end,
      qty_unit, id, created_by
    from src
    returning 1
  )
  select count(*) into n from ins;

  return n;
end $$;

comment on function public.rollover_tasks(uuid, date) is
  'Copies unfinished tasks for ONE project from p_date to the next day. '
  'SECURITY DEFINER with explicit is_member + role checks standing in for RLS.';

-- Only signed-in users may call it. Without this, `anon` inherits EXECUTE from
-- PUBLIC and reaches a definer function that writes rows.
revoke all on function public.rollover_tasks(uuid, date) from public;
revoke all on function public.rollover_tasks(uuid, date) from anon;
grant execute on function public.rollover_tasks(uuid, date) to authenticated;
