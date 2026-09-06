-- ============================================================
-- MASON OS — Migration 077: a password the founder typed must be changed
--
-- Both Admin forms have always created a user with a password the FOUNDER
-- chooses and reads out — the Team form even labels it "Temporary password …
-- ask them to change it". Nothing enforced that. So today the founder knows
-- every staff member's and every client's password indefinitely, which is the
-- real problem with direct creation and the reason the invite flow was built.
--
-- Direct creation stays — it has to, because no email can leave this project
-- until custom SMTP is configured, and a firm cannot stop onboarding people
-- while it waits on a DNS record. But a password somebody else chose is a
-- shared secret, and it should survive exactly one sign-in.
--
-- WHY A COLUMN AND NOT auth METADATA
-- ----------------------------------
-- It could live in `auth.users.raw_user_meta_data`, which the client can read
-- from its own JWT. But metadata is writable by the user themselves through
-- `updateUser({ data })`, so somebody who did not want to change their password
-- could clear the flag from the browser console. On `profiles` it is behind
-- `profiles_admin` (founder-only UPDATE) plus the function below, and a user
-- cannot clear their own flag except by actually changing the password.
--
-- WHY THE FUNCTION, GIVEN profiles HAS AN UPDATE POLICY
-- -----------------------------------------------------
-- `profiles_admin` restricts UPDATE to a founder, so the person changing their
-- own password cannot clear their own flag — they would be locked in the
-- prompt forever. `fn_clear_password_change` lets exactly that one person clear
-- exactly that one column, and nothing else. Same shape as 069/072/073: the
-- narrow SECURITY DEFINER function rather than a policy loose enough to let a
-- PATCH write `role`.
--
-- NOT ENFORCED IN THE DATABASE, and said plainly: RLS cannot refuse a query
-- because somebody has not changed their password. The flag drives a ROUTE —
-- the app sends them to /set-password and will not let them past. A determined
-- user with the anon key could still read their own data while ignoring the
-- prompt. That is acceptable: this protects against a password the FOUNDER
-- knows staying live for a year, not against the account's owner.
--
-- Re-runnable: add column if not exists, create-or-replace function.
-- ============================================================

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

comment on column public.profiles.must_change_password is
  'True when the account was created with a password somebody else chose. The '
  'app routes them to /set-password until they change it (077).';


-- ############################################################
-- ###  Clear it — only for yourself, only this column
-- ############################################################

create or replace function public.fn_clear_password_change()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  update public.profiles
     set must_change_password = false
   where id = auth.uid();
end $$;

revoke all on function public.fn_clear_password_change() from public, anon;
grant execute on function public.fn_clear_password_change() to authenticated;

comment on function public.fn_clear_password_change() is
  'Called after a user sets their own password. Touches one column on the '
  'caller''s own row — profiles_admin restricts UPDATE to a founder, so without '
  'this the person changing their password could never clear their own flag.';


-- ############################################################
-- ###  Existing accounts
-- ############################################################
-- Everyone who exists right now was created with a founder-chosen password,
-- because that was the only route. Flagging them all would lock every current
-- user out of the app at their next sign-in until they picked a new password —
-- a migration should not do that to a working firm without being asked.
--
-- So existing accounts are left alone, and the flag applies from here on. The
-- founder can force a specific person by hand:
--
--   update public.profiles set must_change_password = true
--   where id = (select id from auth.users where email = 'someone@example.com');


-- ---------- VERIFY ----------
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'must_change_password')                  as col,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'fn_clear_password_change')                as fn,
  (select count(*) from public.profiles where must_change_password) as flagged_now;
-- Expect: col = 1, fn = 1, flagged_now = 0.
