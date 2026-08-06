-- ============================================================
-- MASON OS — Migration 036: web push notifications (daily task nudge)
--
-- The app is already an installable PWA, so the phone can receive a push
-- without WhatsApp, SMS, a provider or a per-message fee. This migration adds
-- the storage and the server-side query; the sending lives in the
-- `daily-task-push` Edge Function, and the browser end lives in
-- src/lib/push.ts and public/sw.js.
--
-- ---------- WHAT A PUSH IS AND ISN'T ----------
-- It is a NUDGE, not a receipt. A phone that is off, out of coverage or has
-- revoked permission simply doesn't get it, and nothing in the app should ever
-- depend on one having arrived. The task list remains the record; the push is
-- a tap-through to it.
--
-- ---------- WHY SUBSCRIPTIONS ARE PER DEVICE, NOT PER USER ----------
-- One person may install the app on a phone and a tablet, and each install
-- gets its own endpoint from the browser vendor. The unique key is therefore
-- the endpoint, not the user — and a user with three rows gets three
-- notifications, which is what they asked for by installing it three times.
--
-- ---------- DEAD ENDPOINTS ----------
-- When a push service returns 404 or 410 the subscription is gone for good
-- (app uninstalled, permission revoked). The function marks it `disabled_at`
-- rather than deleting it, so "why did Ravi stop getting these" is answerable.
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. TABLE
-- ############################################################

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,

  -- The browser's push endpoint. Unique because re-subscribing on the same
  -- device returns the same endpoint, and we want an upsert, not a duplicate.
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,

  -- Helps answer "which device is this" when someone has several.
  user_agent text,

  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count int not null default 0,
  disabled_at timestamptz
);

create index if not exists push_sub_user_idx
  on public.push_subscriptions (user_id)
  where disabled_at is null;


-- ############################################################
-- ###  2. RLS — each person manages their own devices
-- ############################################################
alter table public.push_subscriptions enable row level security;

-- No cross-user visibility at all: a subscription is a device identifier, and
-- nobody in the business needs to see anyone else's. The Edge Function reads
-- them with the service role, which bypasses RLS.
drop policy if exists push_own_read on public.push_subscriptions;
create policy push_own_read on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

drop policy if exists push_own_insert on public.push_subscriptions;
create policy push_own_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists push_own_update on public.push_subscriptions;
create policy push_own_update on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Turning notifications off is a delete, and it's the one thing a person must
-- always be able to do to their own device without asking anyone.
drop policy if exists push_own_delete on public.push_subscriptions;
create policy push_own_delete on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());


-- ############################################################
-- ###  3. AUDIT
-- ############################################################
-- Included for consistency, though nothing here is financial: it answers
-- "when did this device stop receiving" without guesswork.
drop trigger if exists audit_push_subscriptions on public.push_subscriptions;
create trigger audit_push_subscriptions
  after insert or update or delete on public.push_subscriptions
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  4. THE DIGEST
-- ############################################################
-- One row per person who has something to do today, with the counts already
-- worded. The Edge Function does no arithmetic — it formats nothing beyond
-- what is returned here, so the notification and the screen can never disagree.
--
-- SECURITY DEFINER because it runs for everyone at once, from a service-role
-- caller with no auth.uid(). It is NOT granted to authenticated: no user has a
-- reason to read everyone else's workload.
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
  -- Everyone who can act on a task, on the projects they are assigned to.
  workers as (
    select pm.user_id, pm.project_id, p.full_name
    from public.project_members pm
    join public.profiles p on p.id = pm.user_id
    where p.is_active
      and p.role in ('founder', 'pm', 'supervisor')
  ),
  mine as (
    select
      w.user_id,
      w.full_name,
      pr.name as project_name,
      count(*) filter (where t.planned_date = td.d)             as due_today,
      count(*) filter (where t.planned_date < td.d)             as overdue
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


-- ############################################################
-- ###  5. SCHEDULING HELPER
-- ############################################################
-- Call this ONCE after deploying the Edge Function, with your own values:
--
--   select public.fn_schedule_daily_push(
--     'https://<project-ref>.supabase.co/functions/v1/daily-task-push',
--     '<the PUSH_SECRET you set on the function>',
--     '<your anon key>',
--     '30 1 * * *'          -- 01:30 UTC = 07:00 IST
--   );
--
-- Keeping it in a function rather than a pasted cron.schedule call means the
-- secret is typed once, in a statement you can clear from your editor,
-- instead of living in a migration file that goes into git.
--
-- ---------- WHY THE ANON KEY IS NEEDED ----------
-- Supabase's function gateway rejects any request without an Authorization
-- header — 401 UNAUTHORIZED_NO_AUTH_HEADER — before our code runs at all. The
-- anon key satisfies that gateway and nothing more: it grants no data access
-- here, because the function's own gate is the x-mason-secret header. The anon
-- key already ships inside the frontend bundle, so it is not a secret.
drop function if exists public.fn_schedule_daily_push(text, text, text);

create or replace function public.fn_schedule_daily_push(
  p_url      text,
  p_secret   text,
  p_anon_key text,
  p_schedule text default '30 1 * * *'
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- auth.uid() is NULL in the SQL editor, where this is meant to be run: the
  -- dashboard connects as `postgres`, not as a signed-in user. Same shape as
  -- the sweep functions in 028/033/034 — gate a signed-in caller by role, and
  -- let an owner-level connection through.
  if auth.uid() is not null and public.my_role() is distinct from 'founder' then
    raise exception 'Only the founder may schedule notifications.'
      using errcode = '42501';
  end if;

  begin
    perform cron.unschedule('mason-daily-task-push');
  exception when others then null; end;

  perform cron.schedule(
    'mason-daily-task-push',
    p_schedule,
    format(
      $cmd$select net.http_post(
             url := %L,
             headers := jsonb_build_object(
               'Content-Type', 'application/json',
               'Authorization', 'Bearer ' || %L,
               'x-mason-secret', %L),
             body := '{}'::jsonb
           );$cmd$,
      p_url, p_anon_key, p_secret
    )
  );
end $$;

revoke all on function public.fn_schedule_daily_push(text, text, text, text) from public, anon;
grant execute on function public.fn_schedule_daily_push(text, text, text, text) to authenticated;

-- pg_net is what lets cron reach the Edge Function over HTTP. Wrapped, like
-- every extension call in this codebase, so a missing extension is a notice
-- rather than a failed migration.
do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net not enabled (%). Enable it in Database → Extensions before scheduling the push.', sqlerrm;
end $$;


-- ############################################################
-- ###  6. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'push_subscriptions'
order by ordinal_position;

-- Expect both functions.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_daily_task_digest', 'fn_schedule_daily_push')
order by proname;

-- Sanity check: what would go out today. Empty is fine on a quiet day.
select * from public.fn_daily_task_digest();
