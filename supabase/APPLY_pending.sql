-- ============================================================
-- MASON OS — Migration 067: the founder's client roster
--
-- 065 built the client data layer; 066 stopped its aggregates answering a
-- question they had just refused. Neither gave the founder a way to GRANT or
-- REVOKE portal access without opening the SQL editor. This is that.
--
-- One view and three functions. No new client-readable surface: every object
-- here is internal-only, and the two aggregates carry the 066 wrapper from the
-- day they are written rather than being retro-fitted after a sweep finds them.
--
-- WHAT THIS DELIBERATELY IS NOT:
--
--   * Not a permission grid. The ten v_client_* views ARE the permission model.
--     A per-module toggle would advertise granularity the data layer does not
--     have, and every toggle would become a lie the first time somebody edits a
--     view. What a client can see is a property of the SCHEMA, not of a row in
--     a settings table.
--
--   * Not an impersonation / "view as client" path. The curated views scope
--     off the caller's own JWT via fn_client_project(). A true preview would
--     mean minting or borrowing a client session, and building an impersonation
--     door into the one part of this app whose entire story is "the database
--     refuses" is a bad trade. Instead the roster reports EXPOSURE — the counts
--     of what has actually been shared — which answers the question the founder
--     is really asking ("what have I shown this person?") without opening one.
--
--   * Not a CRM. Module 25 is cut. This administers portal access, nothing
--     more: no contacts, no leads, no pipeline.
--
-- Re-runnable: view is drop-then-create (house rule), functions are
-- create-or-replace with fresh signatures.
-- ============================================================


-- ############################################################
-- ###  1. The roster
-- ############################################################
-- Owner-run, NOT security_invoker. It reads profiles rows for people the caller
-- may not otherwise see and joins to projects, whose contract columns are
-- revoked from `authenticated` (the 010 pattern). The WHERE clause IS the
-- access control here — losing it is a full leak of every client account in the
-- company, so it is the first thing to check when editing this view.
--
-- No money of any kind appears below. A client roster has no legitimate reason
-- to carry a contract value, and not selecting it means no future edit can
-- accidentally expose one.

drop view if exists public.v_client_roster;

create view public.v_client_roster as
select
  cp.id                    as link_id,
  cp.user_id,
  p.full_name,
  p.is_active,
  cp.project_id,
  pr.name                  as project_name,
  pr.status                as project_status,
  cp.created_at            as granted_at,
  g.full_name              as granted_by_name,

  -- EXPOSURE. What this client can actually reach today. These are the numbers
  -- the founder is really asking about, and they are counted here rather than
  -- on the screen so the browser never does the arithmetic (CLAUDE.md rule 2).
  (select count(*) from public.documents d
    where d.project_id = cp.project_id and d.client_visible)::int
                           as shared_documents,
  (select count(*) from public.client_photos ph
    where ph.project_id = cp.project_id)::int
                           as published_photos,
  (select count(*) from public.invoices i
    where i.project_id = cp.project_id
      and i.inv_type::text = 'progress'
      and i.status::text <> 'draft')::int
                           as visible_invoices,

  -- Approvals still sitting with them. An age would be better than a count
  -- (the 060 lesson) but it belongs on the approvals screen, not here — this
  -- column exists so the roster can say "waiting on Ramesh" at a glance.
  (select count(*) from public.client_approvals a
    where a.project_id = cp.project_id and a.status::text = 'pending')::int
                           as pending_approvals,

  -- Unread in each direction, so the founder can see a client talking into a
  -- void — the failure mode a portal actually has.
  (select count(*) from public.client_messages m
    where m.project_id = cp.project_id
      and m.from_client and m.read_at is null)::int
                           as unread_from_client,
  (select max(m.created_at) from public.client_messages m
    where m.project_id = cp.project_id)
                           as last_message_at

from public.client_projects cp
join public.profiles p  on p.id  = cp.user_id
join public.projects pr on pr.id = cp.project_id
left join public.profiles g on g.id = cp.granted_by
-- THE ACCESS CONTROL. Founder and accounts see every client; a PM sees clients
-- on projects they are assigned to. A supervisor and a client both get nothing:
-- is_member() is false for a client since 065, and supervisors are excluded by
-- the role list.
where public.is_internal()
  and (
    public.is_founder()
    or public.my_role()::text = 'accounts'
    or (public.my_role()::text = 'pm' and public.is_member(cp.project_id))
  );

comment on view public.v_client_roster is
  'One row per client account with what that client can actually reach. '
  'Owner-run: the WHERE clause is the access control. Carries no money.';

grant select on public.v_client_roster to authenticated;


-- ############################################################
-- ###  2. Suspend — the common case, and reversible
-- ############################################################
-- At handover you stop the login; you do not erase the person who approved the
-- kitchen layout. profiles.is_active is the existing switch for exactly this,
-- and it already exists on the Admin team screen for staff.
--
-- Separate from unlinking on purpose: the two are different acts with different
-- consequences, and a single "remove" button would hide which one happened.

create or replace function public.fn_set_client_active(
  p_user   uuid,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_founder() then
    raise exception 'Only a founder can suspend or restore portal access'
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.client_projects where user_id = p_user) then
    raise exception 'That account is not a client of any project'
      using errcode = '22023';
  end if;

  update public.profiles
     set is_active = p_active
   where id = p_user
     and role::text = 'client';   -- belt and braces: never touches a staff row

  if not found then
    raise exception 'No client profile found for that account'
      using errcode = '22023';
  end if;
end $$;

revoke all on function public.fn_set_client_active(uuid, boolean) from public, anon;
grant execute on function public.fn_set_client_active(uuid, boolean) to authenticated;


-- ############################################################
-- ###  3. Unlink — wrong person, or wrong project
-- ############################################################
-- Deletes the client_projects row and nothing else. The account survives with
-- no project, which is the state the portal already handles ("Your account is
-- not linked to a project yet"). The profile is NOT deleted, because their name
-- is stamped on approvals they signed — the same rule that makes projects and
-- users undeletable everywhere else in this app.
--
-- The delete is audited by the existing trigger on client_projects (065), so
-- "who removed this client and when" stays answerable.

create or replace function public.fn_unlink_client(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
begin
  if not public.is_founder() then
    raise exception 'Only a founder can remove portal access'
      using errcode = '42501';
  end if;

  select project_id into v_project
  from public.client_projects where user_id = p_user;

  if v_project is null then
    raise exception 'That account is not linked to a project'
      using errcode = '22023';
  end if;

  delete from public.client_projects where user_id = p_user;

  -- Deactivate in the same transaction. An account with a login and no project
  -- is a dead end for whoever holds it, and leaving it able to sign in serves
  -- nobody. Reversible: re-linking and fn_set_client_active(.., true) restores.
  update public.profiles set is_active = false
   where id = p_user and role::text = 'client';
end $$;

revoke all on function public.fn_unlink_client(uuid) from public, anon;
grant execute on function public.fn_unlink_client(uuid) to authenticated;


-- ############################################################
-- ###  4. Link an EXISTING account to a project
-- ############################################################
-- Creating the login is the Edge Function's job — the service-role key lives
-- only there. This covers the other two cases: re-linking somebody who was
-- unlinked, and moving a client to a different project.
--
-- `client_projects.user_id` is UNIQUE, so "one client account, exactly one
-- project" is enforced by the schema and this function does not have to
-- police it. An upsert is therefore a MOVE, which is the intended behaviour.

create or replace function public.fn_link_client(
  p_user    uuid,
  p_project uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_founder() then
    raise exception 'Only a founder can grant portal access'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_user and role::text = 'client'
  ) then
    -- Refuses to turn a staff account into a client. Doing that silently would
    -- revoke someone's internal access through a screen labelled "clients".
    raise exception 'That account is not a client. Change the role first if that is really intended.'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.projects where id = p_project) then
    raise exception 'No such project' using errcode = '22023';
  end if;

  insert into public.client_projects (user_id, project_id, granted_by)
  values (p_user, p_project, auth.uid())
  on conflict (user_id) do update
    set project_id = excluded.project_id,
        granted_by = excluded.granted_by,
        created_at = now();

  update public.profiles set is_active = true
   where id = p_user and role::text = 'client';
end $$;

revoke all on function public.fn_link_client(uuid, uuid) from public, anon;
grant execute on function public.fn_link_client(uuid, uuid) to authenticated;


-- ############################################################
-- ###  5. Company-wide roster summary
-- ############################################################
-- An aggregate. It gets the 066 wrapper NOW, on the day it is written, rather
-- than being found by a sweep in three months:
--     select * from ( <the aggregate> ) q where public.is_internal();
-- Without it a client would receive one row of zeros and a future screen would
-- render "0 clients" as though it were a fact about the company.
--
-- BUT is_internal() ALONE IS NOT ENOUGH HERE, and the first test run proved it:
-- a SUPERVISOR is internal, sees zero roster rows, and so received exactly that
-- row of zeros. The wrapper must match the audience of the thing being summed,
-- not merely exclude clients. So it repeats the roster's own role list.
--
-- The general rule this sharpens: `where public.is_internal()` is the right
-- wrapper for an aggregate over a surface EVERY internal role can read. For an
-- aggregate over a restricted surface, the wrapper must restate that surface's
-- restriction — otherwise the least-privileged internal role gets the zeros.

create or replace function public.fn_client_roster_summary()
returns table (
  client_count        int,
  active_count        int,
  suspended_count     int,
  projects_with_client int,
  pending_approvals   int,
  unread_from_clients int
)
language sql
stable
security invoker
set search_path = public
as $$
  select * from (
    select
      count(*)::int,
      count(*) filter (where is_active)::int,
      count(*) filter (where not is_active)::int,
      count(distinct project_id)::int,
      coalesce(sum(pending_approvals), 0)::int,
      coalesce(sum(unread_from_client), 0)::int
    from public.v_client_roster
  ) q
  where public.is_internal()
    and public.my_role()::text in ('founder', 'pm', 'accounts');
$$;

revoke all on function public.fn_client_roster_summary() from public, anon;
grant execute on function public.fn_client_roster_summary() to authenticated;


-- ############################################################
-- ###  6. Projects that have no client account yet
-- ############################################################
-- Powers the "grant access" form's project picker, and doubles as a nudge: an
-- active job with no client login is usually an oversight rather than a policy.

create or replace function public.fn_projects_without_client()
returns table (
  project_id   uuid,
  project_name text,
  status       text
)
language sql
stable
security invoker
set search_path = public
as $$
  select p.id, p.name, p.status::text
  from public.projects p
  where public.is_internal()
    and public.is_founder()
    and not exists (
      select 1 from public.client_projects cp where cp.project_id = p.id
    )
  order by p.name;
$$;

revoke all on function public.fn_projects_without_client() from public, anon;
grant execute on function public.fn_projects_without_client() to authenticated;


-- ---------- VERIFY ----------
-- From the SQL editor this returns ZERO rows: as `postgres`, auth.uid() is null
-- and is_internal() is false, so the view's WHERE clause excludes everything.
-- That is the gate working, not missing data (the 038 trap). Verify through the
-- app as the founder, and re-run client-security-sweep.js as the test client —
-- v_client_roster and both functions must report refused or empty.

select
  (select count(*) from pg_views
    where schemaname = 'public' and viewname = 'v_client_roster')      as roster_view,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('fn_set_client_active', 'fn_unlink_client',
                        'fn_link_client', 'fn_client_roster_summary',
                        'fn_projects_without_client'))                as fns;
-- Expect: roster_view = 1, fns = 5. More than 5 means an overload survived.
