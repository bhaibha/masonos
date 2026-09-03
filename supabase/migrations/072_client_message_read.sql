-- ============================================================
-- MASON OS — Migration 072: the team can mark client messages read
--
-- 065 built client_messages with policies for SELECT and INSERT and, on
-- purpose, none for UPDATE or DELETE — "a sent message stays sent. A thread
-- somebody can edit after the fact is not a record of a conversation." That
-- decision stands.
--
-- But it also means `read_at` — a column 065 created and 067's roster counts
-- (`unread_from_client`) — can never be set. Until now nothing could set it,
-- because there was no team screen either; the count would simply have grown
-- forever once one existed.
--
-- So: no UPDATE policy (the thread stays immutable to a direct PATCH), and one
-- narrow SECURITY DEFINER function that touches exactly one column on exactly
-- the messages the client sent. Same shape as 069's document functions, and for
-- the same reason — an RLS UPDATE policy cannot say WHICH column, and on this
-- table `body`, `from_client` and `author_id` are the record.
--
-- WHAT THIS DELIBERATELY DOES NOT DO:
--   * No read receipt for the CLIENT. `read_at` is the firm's own bookkeeping —
--     "has anybody looked at this yet" — not a promise to the client that a
--     human has read their message. v_client_messages does not carry the column
--     and this migration does not add it. Showing a client "read ✓✓" and then
--     not replying for a week is worse than showing nothing.
--   * No unread flag on a TEAM message. The client's own reading habits are
--     not the firm's business, and there is nothing useful to do with it.
--
-- Re-runnable: create-or-replace, fresh signature.
-- ============================================================

create or replace function public.fn_mark_client_messages_read(p_project uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  -- Runs as owner, so every check the policies would have made is made here.
  if not public.is_member(p_project) then
    raise exception 'That project is not one you work on.' using errcode = '42501';
  end if;

  -- A client must never mark their own messages as read by the team. is_member
  -- already returns false for a client (065), so this is the second gate rather
  -- than the only one.
  if public.is_client() then
    raise exception 'Not available.' using errcode = '42501';
  end if;

  update public.client_messages
     set read_at = now()
   where project_id = p_project
     and from_client              -- only what the CLIENT sent
     and read_at is null;         -- and only once, so the first reader is kept

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_mark_client_messages_read(uuid) from public, anon;
grant execute on function public.fn_mark_client_messages_read(uuid) to authenticated;

comment on function public.fn_mark_client_messages_read(uuid) is
  'Marks the client''s unread messages on one project as read. The only way '
  'read_at is ever set — client_messages has no UPDATE policy, so a direct '
  'PATCH cannot edit a sent message.';


-- ---------- VERIFY ----------
select
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'client_messages'
      and cmd in ('UPDATE', 'DELETE'))                     as write_policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'fn_mark_client_messages_read')      as fns;
-- Expect: write_policies = 0 (the thread is still immutable), fns = 1.
