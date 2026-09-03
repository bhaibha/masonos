-- ============================================================
-- MASON OS — Migration 073: what the client is waiting on
--
-- The brief was "mark messages and approvals from the client as important".
-- Taken literally that is a stored `important` flag on every client-originated
-- row — and a flag that is true for EVERYTHING carries no information. It would
-- be a permanent red badge, and a permanent badge is one people stop seeing.
-- The same reasoning as 063's rule that a snooze must expire.
--
-- So this stores no flag. It DERIVES an alert from state that already means
-- something, in the shape 028 -> 033 -> 034 established and that the dashboard
-- already renders: one `fn_*_alert()` returning counts, and a strip that
-- disappears entirely when every count is zero.
--
-- FOUR SIGNALS, and each answers a different question:
--
--   unread_messages     the client wrote and nobody has opened the thread
--   unseen_rejections   the client asked for a CHANGE and nobody has looked.
--                       This is the one that needs action, so it is counted
--                       separately and it is what makes the strip urgent.
--   unseen_approvals    every other client decision nobody has looked at.
--                       Usually no action needed — counted, but never urgent.
--   stale_pending       you asked and they have not answered in 7+ days.
--                       Points the other way: chase the client, not the team.
--
-- THE NEW COLUMN. `client_approvals.team_seen_at` — the mirror of 072's
-- `read_at`, and added for the same reason: without it "has anybody looked at
-- this decision" is unanswerable, and the count would either be permanent or
-- would have to be faked from `decided_on`.
--
-- Set by fn_mark_approvals_seen, not by a policy. `client_approvals` has an
-- UPDATE policy (060) but it is guarded by fn_ca_guard, which refuses the
-- decision columns from a PostgREST caller. Adding `team_seen_at` to the set of
-- things a raw PATCH may write would widen that guard for no reason, so this
-- goes through a SECURITY DEFINER function touching one column — the 069/072
-- shape, now the standing pattern for "one narrow write on a guarded table".
--
-- Re-runnable: add column if not exists, create-or-replace functions.
-- ============================================================


-- ############################################################
-- ###  1. Has anybody on the team looked at this decision?
-- ############################################################

alter table public.client_approvals
  add column if not exists team_seen_at timestamptz;

comment on column public.client_approvals.team_seen_at is
  'When somebody internal first opened the register after the client decided. '
  'Null = the decision has not been seen. Set only by fn_mark_approvals_seen.';

-- Partial index: the only query is "decided but unseen", which on a healthy
-- register is a handful of rows out of everything ever approved.
--
-- NOTE the enum literal rather than `status::text <> 'pending'`. An index
-- predicate must be IMMUTABLE and the enum-to-text cast is only STABLE, so the
-- ::text form this file uses everywhere else is refused here with "functions in
-- index predicate must be marked IMMUTABLE". Safe in this direction because
-- `approval_state` was created back in 060 — the 021 trap only bites an enum
-- value added in the SAME transaction.
create index if not exists client_approvals_unseen_idx
  on public.client_approvals (project_id)
  where team_seen_at is null and status <> 'pending'::approval_state;


create or replace function public.fn_mark_approvals_seen(p_project uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if not public.is_member(p_project) then
    raise exception 'That project is not one you work on.' using errcode = '42501';
  end if;
  if public.is_client() then
    raise exception 'Not available.' using errcode = '42501';
  end if;

  update public.client_approvals
     set team_seen_at = now()
   where project_id = p_project
     and status::text <> 'pending'   -- a pending item has not been decided
     and team_seen_at is null;       -- once only, so the first reader is kept

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_mark_approvals_seen(uuid) from public, anon;
grant execute on function public.fn_mark_approvals_seen(uuid) to authenticated;


-- ############################################################
-- ###  2. The alert
-- ############################################################
-- security_invoker, so the counts are over exactly the projects the caller can
-- see: a PM gets their own jobs, a founder every job. No role check is written
-- here because client_messages_read and the approvals policies already decide
-- it — restating it would be a second copy that drifts.
--
-- The 066 wrapper is NOT needed on the outer select, because the aggregate is
-- guarded a different way: it returns zero rows unless something is actually
-- waiting. `having` is right here where it was wrong in 066 — there, hiding an
-- empty result would have hidden a legitimate "nothing spent"; here, "nothing
-- is waiting" IS the empty case and the strip should vanish.

create or replace function public.fn_client_attention()
returns table (
  unread_messages    int,
  unseen_rejections  int,
  unseen_approvals   int,
  stale_pending      int,
  oldest_pending_days int,
  latest_message_at  timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with m as (
    select count(*)::int as n, max(created_at) as latest
    from public.client_messages
    where from_client and read_at is null
  ),
  d as (
    select
      count(*) filter (where status::text = 'rejected')::int as rejections,
      count(*) filter (where status::text <> 'rejected')::int as approvals
    from public.client_approvals
    where status::text <> 'pending'
      and team_seen_at is null
  ),
  p as (
    select
      count(*) filter (
        where (current_date - created_at::date) >= 7
      )::int                                            as stale,
      max(current_date - created_at::date)::int         as oldest
    from public.client_approvals
    where status::text = 'pending'
  )
  select m.n, d.rejections, d.approvals, p.stale, p.oldest, m.latest
  from m, d, p
  -- Nothing waiting = no row = no strip. An alert that renders "0 unread" is
  -- noise, and noise is how a real one gets missed.
  where m.n > 0 or d.rejections > 0 or d.approvals > 0 or p.stale > 0;
$$;

revoke all on function public.fn_client_attention() from public, anon;
grant execute on function public.fn_client_attention() to authenticated;

comment on function public.fn_client_attention() is
  'Counts what the client is waiting on, or what they have said that nobody '
  'has read. Returns ZERO ROWS when there is nothing — the dashboard strip '
  'renders only when this returns something.';


-- ---------- VERIFY ----------
-- As `postgres` this returns nothing useful: security_invoker with no
-- auth.uid() means client_messages and client_approvals are both empty to the
-- caller, so the WHERE clause removes the row. That is the gate working (038).
-- Verify through the app as the founder.

select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'client_approvals'
      and column_name = 'team_seen_at')                       as col,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('fn_client_attention',
                        'fn_mark_approvals_seen'))            as fns;
-- Expect: col = 1, fns = 2.
