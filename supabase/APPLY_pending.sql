-- ============================================================
-- MASON OS — Migration 076: the roster learns who to email, and whether
--                           the client ever arrived
--
-- FOUND WHILE WIRING PASSWORD RECOVERY. `v_client_roster` (067) reports a
-- client's NAME and their exposure counts and nothing else — deliberately, at
-- the time, because the screen only needed to say "this person can see four
-- documents". Recovery needs two facts it does not carry:
--
--   email            you cannot send a reset link to a full_name.
--   has_signed_in    which decides WHICH email to send. A client who has never
--                    signed in did not forget a password — they never had one,
--                    and a reset link would be the wrong thing to send. That is
--                    a re-invite. A client who HAS signed in and cannot get in
--                    wants a reset.
--
-- Getting that distinction wrong is the difference between "here is a link to
-- change your password" landing on somebody who has no password, and a founder
-- wondering why the client is still stuck.
--
-- WHY IT IS SAFE TO JOIN auth.users HERE
-- --------------------------------------
-- `v_client_roster` is OWNER-RUN (no security_invoker), so the join runs as the
-- view's owner, which can read auth.users. The WHERE clause is still the access
-- control — founder and accounts see every client, a PM sees clients on their
-- own projects, a supervisor and a client see nothing. That clause is unchanged
-- and it is the first thing to check when editing this view.
--
-- The email being exposed is the firm's OWN client's address, to the firm's own
-- founder, who typed it into the invite form in the first place. No new
-- information leaves the building.
--
-- WHAT IS STILL NOT HERE: no password state, no auth metadata, no provider, no
-- token. `last_sign_in_at` and `email` are the two facts the screen acts on, and
-- selecting more "while we are in here" would be handing the browser a copy of
-- the auth table for no reason.
--
-- Re-runnable: drop-then-create (house rule — never `create or replace view`).
-- ============================================================

drop view if exists public.v_client_roster;

create view public.v_client_roster as
select
  cp.id                    as link_id,
  cp.user_id,
  p.full_name,
  -- 076. The address the invite went to, and the one a reset goes to.
  u.email,
  p.is_active,
  cp.project_id,
  pr.name                  as project_name,
  pr.status                as project_status,
  cp.created_at            as granted_at,
  g.full_name              as granted_by_name,

  -- 076. Has this person ever actually arrived? Null until they do.
  u.last_sign_in_at,
  (u.last_sign_in_at is not null)          as has_signed_in,

  -- EXPOSURE. What this client can actually reach today (067).
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
  (select count(*) from public.client_approvals a
    where a.project_id = cp.project_id and a.status::text = 'pending')::int
                           as pending_approvals,
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
join auth.users u       on u.id  = cp.user_id
left join public.profiles g on g.id = cp.granted_by
-- THE ACCESS CONTROL — unchanged from 067.
where public.is_internal()
  and (
    public.is_founder()
    or public.my_role()::text = 'accounts'
    or (public.my_role()::text = 'pm' and public.is_member(cp.project_id))
  );

comment on view public.v_client_roster is
  'One row per client account with what that client can actually reach, plus '
  'their email and whether they have ever signed in (076). Owner-run: the '
  'WHERE clause is the access control. Carries no money.';

grant select on public.v_client_roster to authenticated;


-- ---------- fn_client_roster_summary depends on this view ----------
-- `drop view` above is NOT cascade, so a dependent view would have blocked it
-- and said so. But `fn_client_roster_summary` is a FUNCTION reading the view by
-- name — Postgres does not track that as a dependency, so it would have kept
-- working against a view that no longer existed until somebody called it. This
-- proves it still resolves.
do $$
declare v_ok boolean;
begin
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'fn_client_roster_summary'
  ) into v_ok;

  if not v_ok then
    raise exception 'fn_client_roster_summary is missing — re-run migration 067.';
  end if;
end $$;


-- ---------- VERIFY ----------
-- Zero rows as `postgres` (is_internal() is false) — the gate working, not
-- missing data. Verify through the app as the founder.

select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'v_client_roster'
  and column_name in ('email', 'last_sign_in_at', 'has_signed_in')
order by 1;
-- Expect three rows.
