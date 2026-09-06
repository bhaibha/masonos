-- ============================================================
-- MASON OS — Migration 080: narrow v_client_roster to the founder
--
-- The Security Advisor's remaining non-view error is "Exposed Auth Users" on
-- `public.v_client_roster` — it joins `auth.users` and is granted to
-- `authenticated`. Looked at properly, the linter is pointing at something
-- real, though not the thing it thinks:
--
--   * It is NOT an open door. The view is owner-run and its WHERE clause gates
--     on `is_internal() and (is_founder() or accounts or pm-on-that-project)`.
--     Proven by query in 079: a supervisor and a client both get zero rows.
--   * It exposes only TWO columns of auth.users — `email` and
--     `last_sign_in_at` — and only for accounts that are CLIENTS, because the
--     join starts from `client_projects`. No password hash, no token, no staff
--     row, no user who is not a client.
--
-- SO WHAT IS ACTUALLY WRONG: the database gate is WIDER THAN EVERY CONSUMER.
-- `v_client_roster` is read by exactly one screen — Admin -> Clients — and
-- `ADMIN_ROLES` in src/lib/types.ts is `['founder']`. A PM or an accounts user
-- can never reach that screen. The only way either of them could pull a
-- client's email address out of this view is by calling PostgREST directly.
--
-- That is the definition of a gate that is too generous: nothing needs it, and
-- 076 widened the blast radius when it added `email` for the reset-link
-- feature (which is also founder-only). Narrowing costs nothing and removes an
-- auth.users column from two roles that never legitimately read it.
--
-- 067 SET the wider gate deliberately, when the roster carried only names and
-- exposure counts and a PM looking at their own project's client seemed
-- reasonable. What changed is 076: the same view now carries an email address
-- and a last-sign-in time. **A view's audience is a decision about its widest
-- column, and adding a column can invalidate the answer.** Re-ask the question
-- whenever a view gains a field, not only when it is created.
--
-- THE SUMMARY MUST MOVE WITH IT — the 067 lesson exactly. Narrowing the view
-- without narrowing `fn_client_roster_summary` would hand a PM the row of
-- zeros the 066 wrapper exists to prevent: they pass `is_internal()` and the
-- role list, the roster underneath returns nothing, and `count(*)` over no
-- rows is a legitimate 0. Both change in the same migration.
--
-- Re-runnable: drop-then-create the view (never `create or replace` — the 013
-- rule), create-or-replace the function.
-- ============================================================


-- ############################################################
-- ###  1. THE VIEW
-- ############################################################
-- Identical to 076 in every respect except the last line.

drop view if exists public.v_client_roster cascade;

create view public.v_client_roster as
select
  cp.id                as link_id,
  cp.user_id,
  p.full_name,
  u.email,
  p.is_active,
  cp.project_id,
  pr.name              as project_name,
  pr.status            as project_status,
  cp.created_at        as granted_at,
  g.full_name          as granted_by_name,
  u.last_sign_in_at,
  (u.last_sign_in_at is not null) as has_signed_in,

  -- EXPOSURE COUNTS: what has actually been shown to this client. No money
  -- anywhere in this view, by design (067) — it answers "what have I shown
  -- this person?", never "what is this job worth?".
  (select count(*) from public.documents d
    where d.project_id = cp.project_id and d.client_visible)::int    as shared_documents,
  (select count(*) from public.client_photos ph
    where ph.project_id = cp.project_id)::int                        as published_photos,
  (select count(*) from public.invoices i
    where i.project_id = cp.project_id
      and i.inv_type::text = 'progress'
      and i.status::text <> 'draft')::int                            as visible_invoices,
  (select count(*) from public.client_approvals a
    where a.project_id = cp.project_id
      and a.status::text = 'pending')::int                           as pending_approvals,
  (select count(*) from public.client_messages m
    where m.project_id = cp.project_id
      and m.from_client and m.read_at is null)::int                  as unread_from_client,
  (select max(m.created_at) from public.client_messages m
    where m.project_id = cp.project_id)                              as last_message_at

from public.client_projects cp
join public.profiles  p  on p.id  = cp.user_id
join public.projects  pr on pr.id = cp.project_id
join auth.users       u  on u.id  = cp.user_id
left join public.profiles g on g.id = cp.granted_by

-- THE GATE. Founder only, matching ADMIN_ROLES in the app. This line is the
-- access control — the view is owner-run, so losing it exposes every client's
-- email address to every signed-in account.
where public.is_founder();

grant select on public.v_client_roster to authenticated;

comment on view public.v_client_roster is
  'Founder-only client roster: who has portal access, to what, and what has '
  'been shared with them. Narrowed from founder/pm/accounts to founder alone '
  'in 080 — it carries auth.users.email since 076, and only the founder-only '
  'Admin screen ever reads it.';


-- ############################################################
-- ###  2. THE SUMMARY, MOVED TO MATCH
-- ############################################################
-- `is_internal()` alone would be wrong here for the same reason it was wrong
-- in 067: the wrapper has to restate the restriction of the thing being
-- summed, or a caller who passes the wrapper and fails the source gets zeros
-- instead of nothing.

create or replace function public.fn_client_roster_summary()
returns table (
  client_count         int,
  active_count         int,
  suspended_count      int,
  projects_with_client int,
  pending_approvals    int,
  unread_from_clients  int
)
language sql stable set search_path = public
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
  where public.is_founder();
$$;

revoke all on function public.fn_client_roster_summary() from public, anon;
grant execute on function public.fn_client_roster_summary() to authenticated;


-- ############################################################
-- ###  3. THE OTHER READER OF THIS VIEW
-- ############################################################
-- 076's lesson: `drop view` warns about dependent VIEWS and says nothing about
-- a FUNCTION that reads one by name. `fn_client_roster_summary` is re-created
-- above, so it is fine — but assert it, because the failure mode is a function
-- that still exists and raises at call time.

do $$
begin
  perform 1 from public.v_client_roster limit 1;   -- resolves, 0 rows as postgres
  perform public.fn_client_roster_summary();       -- resolves against the new view
end $$;


-- ---------- VERIFY ----------
select
  (select count(*) from pg_views
    where schemaname = 'public' and viewname = 'v_client_roster')          as view_exists,
  -- The gate text. Should mention is_founder and NOT the wider role list.
  (select case when definition ~* 'is_founder\(\)' then 1 else 0 end
     from pg_views where schemaname='public' and viewname='v_client_roster') as gates_on_founder,
  (select case when definition ~* '''pm''|''accounts''' then 1 else 0 end
     from pg_views where schemaname='public' and viewname='v_client_roster') as still_lists_pm_accounts,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='fn_client_roster_summary')      as summary_fn;
-- Expect: view_exists = 1, gates_on_founder = 1, still_lists_pm_accounts = 0,
--         summary_fn = 1.
