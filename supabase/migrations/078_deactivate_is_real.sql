-- ============================================================
-- MASON OS — Migration 078: "Deactivate" has to actually deactivate
--
-- `profiles.is_active` has existed since 001 and the Admin screen has offered
-- a Deactivate button for months. NOTHING IN THE DATABASE READ THAT COLUMN.
-- Not one policy, not one helper. A deactivated staff member could still sign
-- in and see every expense, every vendor rate, every document their role
-- allowed — the button removed them from assignee dropdowns and from the daily
-- push digest, and that was the whole of it.
--
-- That was worse than having no button. A founder who "removed" somebody
-- believed the account was closed, so nobody changed a password or chased an
-- offboarding. **A control that reports success and does nothing is a lie the
-- app tells its owner.** Same family as 069 (a table with no UPDATE policy
-- refuses silently) and 072 (a column nothing writes) — this one just pointed
-- the wrong way round: the write happened, the read never did.
--
-- WHY NOT DELETE INSTEAD
-- ----------------------
-- `profiles.id` is referenced by 104 foreign keys across 36 migrations —
-- created_by, raised_by, approved_by, certified_by — and none of them cascade.
-- Postgres refuses to delete anybody who has ever created a task or approved a
-- bill, and that refusal is correct: a name is what makes a record evidence.
-- CLAUDE.md has said "users are NOT deletable, deactivate instead" since 022.
-- This migration is what makes the second half of that sentence true.
--
-- HARDEN THE FUNCTION, DON'T SWEEP THE POLICIES (the 065 lesson)
-- --------------------------------------------------------------
-- `my_role()` returning NULL for an inactive profile closes almost everything
-- at once: is_founder(), is_internal(), is_client() and every policy that names
-- a role all go false together, and `fn_client_project()` returns null so every
-- curated client view empties. One function instead of two hundred policies,
-- and nothing to keep in step later.
--
-- Two places that is NOT enough, both found by asking pg_policies rather than
-- by reading from memory (the 066 rule — enumerate the surface from the
-- schema):
--
--   1. `is_member()` falls through to `exists (select 1 from project_members
--      where user_id = auth.uid())`, which is still TRUE for a deactivated PM.
--      Their assignment row does not disappear when they are deactivated, and
--      it should not — reactivating must restore what they had. So the active
--      check goes at the TOP of is_member(), exactly where the client check
--      went in 065.
--
--   2. Fifteen policies grant on `auth.uid()` directly — "your own row" rules
--      that never ask what role you are. The catalogue query that found them:
--
--        select tablename, policyname, qual, with_check from pg_policies
--        where (qual like '%auth.uid()%' or with_check like '%auth.uid()%')
--          and qual||with_check not like '%is_member%'
--          and qual||with_check not like '%fn_client_project%';
--
--      Two of those (petty cash entries, reached through a subquery on the
--      account holder) were invisible to a line-based grep and would have been
--      missed. Re-run that query after adding any own-row policy.
--
-- WHAT IS DELIBERATELY LEFT OPEN
-- ------------------------------
--   * `profiles_read` keeps `id = auth.uid()`. A deactivated user must still be
--     able to read their OWN row, or the app cannot tell them why it stopped
--     working — it would render a dashboard of empty lists instead, which is
--     the row-of-zeros failure this repo has a rule about (056/063/066). The
--     row contains their own name and role and nothing else.
--   * `push_subscriptions` keeps its four own-row policies. They carry no
--     company data — a browser endpoint and a device label — and the digest
--     already filters on `p.is_active` (036/037), so a deactivated phone stops
--     receiving anyway. Unsubscribing a dead device should keep working.
--
-- NOT A REPLACEMENT FOR REVOKING THE PASSWORD. The account can still SIGN IN:
-- auth.users is untouched, so Supabase still issues a JWT. What changes is that
-- the JWT now buys nothing — every policy refuses. RLS is evaluated per query
-- against the live `profiles` row, so this takes effect on the next request,
-- not when the token expires. For a genuinely hostile departure, deactivate
-- here AND reset the password in the Supabase dashboard.
--
-- Re-runnable: create-or-replace functions, drop-then-create policies.
-- ============================================================


-- ############################################################
-- ###  1. THE PREDICATE
-- ############################################################
-- SECURITY DEFINER so it can read `profiles` without RLS applying — the same
-- shape as my_role() itself, and what stops a policy on `profiles` recursing
-- into a function that reads `profiles`.
--
-- `exists` rather than reading the column, so an auth.uid() with no profile row
-- at all (a half-created account) is inactive rather than NULL. A three-valued
-- answer in a security predicate is how a policy accidentally passes.

create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and is_active
  )
$$;

revoke all on function public.is_active_user() from public, anon;
grant execute on function public.is_active_user() to authenticated;

comment on function public.is_active_user() is
  'True when the caller has a profile row and it is active (078). Deactivating '
  'somebody is meant to close the account, so this is ANDed into every policy '
  'that grants on auth.uid() without asking what role the caller has.';


-- ############################################################
-- ###  2. my_role() — the one change that closes most of it
-- ############################################################
-- Everything role-shaped in this database is downstream of this function.
-- is_founder(), is_internal(), is_client() and fn_client_project() all go false
-- or null for an inactive account without being touched.

create or replace function public.my_role()
returns user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles
   where id = auth.uid()
     and is_active
$$;

comment on function public.my_role() is
  'The caller''s access role, or NULL if their account is deactivated (078). '
  'Every role-gated policy in the database reads this, so deactivation '
  'propagates without a policy sweep.';


-- ############################################################
-- ###  3. is_member() — the fall-through project_members does not close
-- ############################################################
-- A deactivated PM keeps their `project_members` rows on purpose: reactivating
-- them must restore exactly the projects they had, and deleting the rows would
-- make deactivation destructive. So the check goes at the top of the function
-- instead, in front of the exists().

create or replace function public.is_member(p_project uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when not public.is_active_user() then false
    when public.is_client() then false
    else public.is_founder()
      or public.my_role()::text = 'accounts'
      or exists (select 1 from public.project_members
                 where project_id = p_project and user_id = auth.uid())
  end
$$;


-- ############################################################
-- ###  4. THE OWN-ROW POLICIES
-- ############################################################
-- Each of these grants on `auth.uid()` and never asks what role the caller is,
-- so my_role() going null does not touch them. Re-emitted with the active check
-- ANDed in. The rest of each rule is unchanged from the migration that wrote it.

-- --- expenses: the author can fix their own entry (002) -------------------
drop policy if exists exp_update on public.expenses;
create policy exp_update on public.expenses for update to authenticated
  using (
    public.is_active_user()
    and (public.my_role() = 'founder' or created_by = auth.uid())
  );

-- --- petty cash: the holder sees their own account (002) ------------------
drop policy if exists pca_read on public.petty_cash_accounts;
create policy pca_read on public.petty_cash_accounts for select to authenticated
  using (
    public.is_active_user()
    and (holder = auth.uid() or public.my_role() in ('founder','accounts'))
  );

-- The two entry policies reach the holder through a subquery on the account,
-- which is why a line-based grep could not see them.
drop policy if exists pce_read on public.petty_cash_entries;
create policy pce_read on public.petty_cash_entries for select to authenticated
  using (
    public.is_active_user()
    and exists (
      select 1 from public.petty_cash_accounts a
      where a.id = petty_cash_entries.account_id
        and (a.holder = auth.uid() or public.my_role() in ('founder','accounts'))
    )
  );

drop policy if exists pce_insert on public.petty_cash_entries;
create policy pce_insert on public.petty_cash_entries for insert to authenticated
  with check (
    public.is_active_user()
    and exists (
      select 1 from public.petty_cash_accounts a
      where a.id = petty_cash_entries.account_id
        and (a.holder = auth.uid() or public.my_role() in ('founder','accounts'))
    )
  );

-- --- site logs: the author can correct their own log (001) ----------------
drop policy if exists logs_update on public.site_logs;
create policy logs_update on public.site_logs for update to authenticated
  using (
    public.is_active_user()
    and (created_by = auth.uid() or public.is_founder())
  );

-- --- documents: the uploader can remove what they filed (003) -------------
-- The most dangerous one on the list. A deactivated account could DELETE every
-- document it had ever uploaded.
drop policy if exists docs_delete on public.documents;
create policy docs_delete on public.documents for delete to authenticated
  using (
    public.is_active_user()
    and (public.is_founder() or uploaded_by = auth.uid())
  );

-- --- profiles: edit your own name and phone (001) -------------------------
-- SELECT on your own row stays open (see the header). Writing does not.
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for update to authenticated
  using (public.is_active_user() and id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select role from public.profiles where id = auth.uid())
  );

-- --- client_projects: a client sees their own link (065) ------------------
drop policy if exists client_projects_read on public.client_projects;
create policy client_projects_read on public.client_projects
  for select to authenticated
  using (
    public.is_active_user()
    and (
      user_id = auth.uid()
      or public.my_role()::text in ('founder', 'pm', 'accounts')
    )
  );

-- --- assistant: own threads, messages and proposals (064) -----------------
-- These are `for all`, so they are writes as well as reads — a deactivated
-- account could keep spending Gemini calls. The tools it could reach are all
-- RLS-bound and would return nothing, which is exactly the confident-lie case
-- 064's own header warns about.
drop policy if exists chat_thread_own on public.chat_threads;
create policy chat_thread_own on public.chat_threads
  for all to authenticated
  using (public.is_active_user() and user_id = auth.uid())
  with check (public.is_active_user() and user_id = auth.uid());

drop policy if exists chat_msg_own on public.chat_messages;
create policy chat_msg_own on public.chat_messages
  for all to authenticated
  using (public.is_active_user() and user_id = auth.uid())
  with check (public.is_active_user() and user_id = auth.uid());

drop policy if exists assistant_action_own on public.assistant_actions;
create policy assistant_action_own on public.assistant_actions
  for all to authenticated
  using (public.is_active_user() and user_id = auth.uid())
  with check (public.is_active_user() and user_id = auth.uid());

-- `assistant_usage_own` already carries is_internal() from 066, which goes
-- false on its own. Nothing to do.

-- --- storage: the uploader can delete a compliance proof (028) ------------
drop policy if exists compliance_files_delete on storage.objects;
create policy compliance_files_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'compliance'
  and public.is_active_user()
  and (public.is_founder() or owner = auth.uid())
);


-- ############################################################
-- ###  5. THE TWO WAYS THIS COULD LOCK THE FIRM OUT
-- ############################################################
-- Deactivation is now absolute, which makes two mistakes unrecoverable through
-- the app: deactivating yourself, and deactivating the last founder. Either one
-- would leave nobody able to reach Admin, because `profiles_admin` requires
-- is_founder() and is_founder() now requires an active profile.
--
-- A BEFORE UPDATE trigger rather than checks inside an RPC, because
-- `profiles_admin` lets a founder PATCH the table directly from PostgREST —
-- which is exactly what the Admin screen does today — so a guard living in a
-- function would simply not run. Same reasoning as 050's decision-column
-- trigger.
--
-- It RAISES rather than silently restoring the old value: the founder pressed a
-- button and is owed an answer.
--
-- auth.uid() is NULL in the SQL editor, so the self-check does not fire there.
-- That is the deliberate escape hatch: a founder locked out by some other route
-- can be restored with a direct UPDATE as postgres.
--
-- Which means — stated plainly rather than implied — THE SELF-CHECK IS THE ONE
-- THAT ACTUALLY FIRES IN THE APP. To deactivate the last founder through the
-- Admin screen you would have to be a founder yourself, and if you are a
-- different founder then there are two active founders and it is not the last
-- one. The last-founder check only ever triggers from the SQL editor or a
-- service-role script. Both were confirmed firing in testing; only the first
-- one is reachable by a mis-click.

create or replace function public.fn_profile_active_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Only deactivation is guarded. Reactivating anybody is always allowed.
  if new.is_active or not old.is_active then
    return new;
  end if;

  if new.id = auth.uid() then
    raise exception
      'You cannot deactivate your own account. Ask another founder to do it.'
      using errcode = '42501';
  end if;

  if old.role = 'founder'::user_role
     and not exists (
       select 1 from public.profiles
        where role = 'founder'::user_role
          and is_active
          and id <> new.id
     )
  then
    raise exception
      'This is the last active founder. Promote somebody else first, or nobody can reach Admin.'
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists profile_active_guard on public.profiles;
create trigger profile_active_guard
  before update on public.profiles
  for each row execute function public.fn_profile_active_guard();


-- ---------- VERIFY ----------
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_active_user')        as fn_predicate,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'fn_profile_active_guard') as fn_guard,
  (select count(*) from pg_trigger
    where tgname = 'profile_active_guard' and not tgisinternal)         as trg,
  -- Every own-row policy that still grants on auth.uid() WITHOUT the active
  -- check. Expect exactly 4 — the push_subscriptions own-row policies, left
  -- open deliberately (see the header). `profiles_read` does not appear
  -- because it carries is_internal(), which the filter below excludes.
  -- Anything ELSE showing up here is a policy written after 078 that needs the
  -- same treatment; this select is the standing check for that.
  (select count(*) from pg_policies
    where (coalesce(qual,'') like '%auth.uid()%'
        or coalesce(with_check,'') like '%auth.uid()%')
      and coalesce(qual,'')||coalesce(with_check,'') not like '%is_member%'
      and coalesce(qual,'')||coalesce(with_check,'') not like '%fn_client_project%'
      and coalesce(qual,'')||coalesce(with_check,'') not like '%is_active_user%'
      and coalesce(qual,'')||coalesce(with_check,'') not like '%is_internal%')  as still_open;
-- Expect: fn_predicate = 1, fn_guard = 1, trg = 1, still_open = 4.
