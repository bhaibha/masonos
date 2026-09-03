-- ============================================================
-- MASON OS — Migration 070: 068's storage policies could never have worked
--
-- THE BUG. 068 granted a client read on a storage object like this:
--
--     exists (select 1 from public.documents d
--             where d.file_path = storage.objects.name
--               and d.project_id = public.fn_client_project()
--               and d.client_visible and not d.is_confidential)
--
-- The condition is right and the subquery returns NOTHING, because
-- **a policy's subquery is itself subject to RLS on the table it reads**. It is
-- evaluated with the privileges of the querying user, so the client's own
-- policies apply to `public.documents` — and `documents_read` requires
-- `is_member(project_id)`, which 065 deliberately made FALSE for a client.
--
-- So the client can see the document through `v_client_documents` (an OWNER-RUN
-- view, which is why the list renders) and cannot see the same row through the
-- base table (correct), and the policy asked the base table (wrong). Storage
-- answered "Object not found", which is what Supabase returns for an object RLS
-- filtered out — indistinguishable from a genuinely missing file, which is why
-- this took three rounds to corner.
--
-- THE FIX. Ask the same owner-run view the portal already reads. The storage
-- grant then derives from the exact object the list is built from, so the two
-- cannot disagree by construction — a stronger version of what 068 was reaching
-- for, and one line shorter.
--
--     exists (select 1 from public.v_client_documents d
--             where d.file_path = storage.objects.name)
--
-- v_client_documents already carries all three conditions (own project,
-- client_visible, not confidential), so nothing is lost by not restating them —
-- and restating them would be the second copy that eventually drifts.
--
-- `v_client_photos` gets the same treatment. Its policy would ACCIDENTALLY have
-- worked, because `client_photos_read` permits `project_id =
-- fn_client_project()` — but relying on that means the storage grant silently
-- breaks the day somebody tightens client_photos. Both go through the view.
--
-- THE GENERAL RULE, worth remembering: an RLS policy that queries another table
-- gets that table's RLS too. If the policy needs to see a row the caller cannot,
-- it must go through a SECURITY DEFINER function or an owner-run view.
--
-- Re-runnable: drop-then-create.
-- ============================================================


drop policy if exists documents_client_read on storage.objects;
create policy documents_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_client()
    and exists (
      select 1
      from public.v_client_documents d
      where d.file_path = storage.objects.name
    )
  );


drop policy if exists site_photos_client_read on storage.objects;
create policy site_photos_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'site-photos'
    and public.is_client()
    and exists (
      select 1
      from public.v_client_photos p
      where p.photo_path = storage.objects.name
    )
  );


-- ---------- VERIFY ----------
-- Not verifiable as `postgres`: is_client() is false and both policies
-- short-circuit before the subquery. Verify through a real client session —
-- client-proof.js Part 5 opens a shared document and a published photo, and
-- checks the receipts and drawings buckets are still refused.

select policyname, qual is not null as has_using
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname in ('documents_client_read', 'site_photos_client_read')
order by 1;
-- ============================================================
-- MASON OS — Migration 071: restore the internal approvals register
--
-- A REGRESSION I INTRODUCED IN 065. Line 645 of that migration reads:
--
--     drop view if exists public.v_client_approvals cascade;
--     create view public.v_client_approvals as ...   -- the CLIENT's view
--
-- but `v_client_approvals` already existed. Migration 060 created it as the
-- INTERNAL register — approvals GIVEN BY a client, with project_name,
-- approved_by_name, method, evidence_missing, the linked VO and the raiser's
-- name. 065 dropped that and reused the name for the PORTAL view — approvals
-- shown TO a client, deliberately stripped of all of it.
--
-- Same name, two opposite meanings, and the second silently replaced the first.
-- The founder's Tasks -> Approvals screen has been broken from the moment 065
-- was applied: it selects `project_name`, which the new view does not have, so
-- the register reports "column v_client_approvals.project_name does not exist"
-- and shows an empty list. Approvals raised there were real, reached the client
-- and were decided correctly — only the internal LIST was blind.
--
-- The lesson, and it is a cheap one to have learned: **`drop view … cascade`
-- with a name you did not create is not an idempotency helper, it is a
-- clobber.** 065 wrote that line ten times without checking whether any of the
-- ten names were already taken. One was. Grep for the name first.
--
-- THE FIX. `v_client_approvals` stays as the portal view — ten `v_client_*`
-- views now follow that convention and it is load-bearing across the security
-- test, the sweep and the portal. 060's register comes back under a name that
-- says what it is: `v_approval_register`. The internal screen is repointed at
-- it in the same commit.
--
-- Re-runnable: drop-then-create.
-- ============================================================

drop view if exists public.v_approval_register;

create view public.v_approval_register with (security_invoker = true) as
select
  a.id,
  a.approval_no,
  a.project_id,
  p.name                                as project_name,
  a.subject,
  a.title,
  a.details,
  a.approved_by_name,
  a.client_role,
  a.method,
  a.status,
  a.decided_on,
  a.reject_reason,
  a.decided_at,
  dec.full_name                         as decided_by_name,
  raiser.full_name                      as raised_by_name,
  a.variation_id,
  vo.vo_number,
  vo.title                              as variation_title,
  a.document_id,
  d.title                               as document_title,
  a.material_id,
  m.name                                as material_name,
  a.evidence,
  cardinality(a.evidence)               as evidence_count,
  -- The register's own honesty flag (060). A verbal approval with nothing
  -- attached is the weakest row in here, and the screen shows it as such rather
  -- than letting it sit among countersigned sheets looking identical.
  (cardinality(a.evidence) = 0)         as evidence_missing,
  a.created_at,
  a.updated_at
from public.client_approvals a
join      public.projects p          on p.id = a.project_id
left join public.profiles dec        on dec.id = a.decided_by
left join public.profiles raiser     on raiser.id = a.raised_by
left join public.variation_orders vo on vo.id = a.variation_id
left join public.documents d         on d.id = a.document_id
left join public.materials m         on m.id = a.material_id;

comment on view public.v_approval_register is
  'The INTERNAL approvals register (060), restored after 065 reused its old '
  'name for the client portal view. security_invoker: a supervisor sees the '
  'approval with the variation half blank, because variation_orders RLS '
  'refuses it — no role check needed here.';

-- security_invoker, so this leaks nothing a caller could not already read:
-- client_approvals RLS decides the rows, and the LEFT JOINs go dark for anyone
-- who cannot see the joined record. That is the 060 design and it is preserved
-- exactly — this migration changes the NAME and nothing else.
grant select on public.v_approval_register to authenticated;


-- ---------- VERIFY ----------
-- Both views must exist, and they are different things:
--   v_approval_register  — internal, full detail, carries method + evidence
--   v_client_approvals   — the portal, no method, no evidence, no raiser
select viewname,
       (select count(*) from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = v.viewname)::int as cols
from pg_views v
where schemaname = 'public'
  and viewname in ('v_approval_register', 'v_client_approvals')
order by 1;
-- Expect two rows. v_approval_register has many more columns than
-- v_client_approvals — that difference IS the curation.
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
-- ============================================================
-- MASON OS — Migration 074: one gallery, whichever way the picture was shared
--
-- THE PROBLEM, hit twice in testing. A photo can reach a client by two routes:
--
--   1. published from the DAILY SITE LOG  -> a row in client_photos,
--                                            file in the `site-photos` bucket
--   2. uploaded to the document vault's   -> a row in documents,
--      "Photos" folder and shared            file in the `documents` bucket
--
-- `v_client_photos` only ever knew about the first. So a founder uploading
-- eleven images to a folder literally called **Photos** and ticking "share with
-- client" found them in the portal's DOCUMENTS tab, while the Photos tab said
-- "No photos yet". Both statements were true and the combination was nonsense.
--
-- Rather than teach the firm a rule ("site photos go here, client photos go
-- there") — which somebody forgets in a month — the view learns about both.
--
-- HOW THE TWO HALVES STAY HONEST:
--   * Each row now carries its `bucket`, because the file lives in a different
--     bucket depending on the route and the browser has to sign against the
--     right one. Deriving it in the app from the path would be guessing.
--   * `source` says which route it came by. Not shown to the client — they do
--     not care — but it is what makes an unexpected row explainable.
--   * The documents half applies the SAME three conditions as
--     v_client_documents (own project, client_visible, not confidential) plus
--     an image-type test. It cannot show anything that tab would not.
--
-- STORAGE NEEDS NO CHANGE. 070's `documents_client_read` already grants a
-- client read on any object backing a row in `v_client_documents`, and an image
-- document is such a row. `site_photos_client_read` covers the other half. The
-- two policies compose exactly as they should — which is a consequence of 070
-- keying on the published VIEW rather than on a path prefix.
--
-- Re-runnable: drop-then-create (house rule — never `create or replace view`).
-- ============================================================

drop view if exists public.v_client_photos cascade;

create view public.v_client_photos as
-- ---------- published from the site log ----------
select
  c.id,
  c.project_id,
  c.photo_path,
  'site-photos'::text                    as bucket,
  c.caption,
  c.taken_on,
  c.published_at                         as shown_since,
  'site_log'::text                       as source
from public.client_photos c
where c.project_id = public.fn_client_project()

union all

-- ---------- shared from the document vault ----------
-- An image is decided by file_type rather than by the folder: somebody will
-- eventually put a photo in Contracts, and a PDF in Photos. The MIME type is
-- what the browser will actually try to render.
select
  d.id,
  d.project_id,
  d.file_path                            as photo_path,
  'documents'::text                      as bucket,
  d.title                                as caption,
  d.created_at::date                     as taken_on,
  d.created_at                           as shown_since,
  'document'::text                       as source
from public.documents d
where d.project_id = public.fn_client_project()
  and d.client_visible
  and not d.is_confidential
  and coalesce(d.file_type, '') like 'image/%'

order by shown_since desc;

comment on view public.v_client_photos is
  'Every picture shared with the client, however it was shared: published from '
  'the site log, or an image document marked client_visible. Carries `bucket` '
  'because the two live in different buckets and the caller must sign against '
  'the right one.';

grant select on public.v_client_photos to authenticated;


-- ---------- 073 depends on this view? No — but check anything that did ----------
-- `drop … cascade` above would silently remove dependants. Nothing reads
-- v_client_photos except the portal and 070's storage policy (which references
-- it by name inside a USING expression, not as a dependency), so the cascade
-- has nothing to take. This block fails loudly if that ever stops being true.
do $$
declare
  v_missing text;
begin
  select string_agg(p.policyname, ', ')
    into v_missing
  from (values ('site_photos_client_read'), ('documents_client_read')) w(name)
  left join pg_policies p
    on p.schemaname = 'storage' and p.tablename = 'objects'
   and p.policyname = w.name
  where p.policyname is null;

  if v_missing is not null then
    raise exception
      'Migration 070 is not applied — the client can see photo rows but not the files. Run 070 first.';
  end if;
end $$;


-- ---------- VERIFY ----------
-- Zero rows as `postgres` (fn_client_project() is null) — the gate working.
-- Verify through the app: share one image from the vault AND publish one from
-- the site log, then check the portal's Photos tab shows BOTH and each opens.

select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'v_client_photos'
  and column_name in ('bucket', 'source', 'shown_since')
order by 1;
-- Expect three rows.
