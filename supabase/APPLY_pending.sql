-- ==============================================================
-- MASON OS — pending migrations.
-- Paste this whole file into the Supabase SQL editor and Run.
--
-- 001–018 are all APPLIED (confirmed 2026-07-25) and have been removed from
-- this file. Only 019 is outstanding.
--
-- FULLY re-runnable: columns use add-if-not-exists, triggers and policies
-- drop-if-exists before create. Running it twice is harmless.
-- ==============================================================


-- ############################################################
-- ###  019_admin_designations.sql
-- ############################################################

-- Adds a DISPLAY-ONLY job title to profiles. Permissions still come from the
-- existing 4-value user_role enum (founder/pm/supervisor/accounts) — no RLS
-- policy anywhere is rewritten, so there is zero risk of widening money access.
--
--   designation  = what they're called  (Site Engineer, Billing Engineer, …)
--   role         = what they can see    (the RLS gate, unchanged)
--
-- projects_write and members_write (001_core.sql) already restrict INSERT/
-- UPDATE/DELETE to founders, so project creation and member assignment need no
-- new policy.

alter table public.profiles
  add column if not exists designation text;

comment on column public.profiles.designation is
  'Job title for display only (Site Engineer, Planning Engineer, …). '
  'Permissions come from profiles.role, never from this column.';

-- ---------- AUDIT ----------
-- profiles is an approval-adjacent master (role changes decide who sees money),
-- so it belongs in the audit log alongside vendors/materials from 018.
drop trigger if exists audit_profiles on public.profiles;
create trigger audit_profiles
  after insert or update or delete on public.profiles
  for each row execute function public.fn_audit();

-- ---------- FOUNDER: full profile management ----------
-- 001 already has profiles_admin for UPDATE by founders. Add DELETE so a
-- founder can remove a profile row.
drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles for delete to authenticated
  using (public.is_founder());


-- ==============================================================
-- VERIFY (should return one row: designation | text)
-- ==============================================================
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'profiles'
  and column_name = 'designation';
