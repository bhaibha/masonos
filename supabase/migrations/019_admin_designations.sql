-- ============================================================
-- MASON OS — Migration 019: job designations + founder admin
--
-- Adds a DISPLAY-ONLY job title to profiles. Permissions still come from the
-- existing 4-value user_role enum (founder/pm/supervisor/accounts) — no RLS
-- policy anywhere is rewritten, so there is zero risk of widening money access.
--
--   designation  = what they're called  (Site Engineer, Billing Engineer, …)
--   role         = what they can see    (the RLS gate, unchanged)
--
-- projects_write and members_write (001_core.sql) already restrict INSERT/
-- UPDATE/DELETE to founders, so project creation and member assignment need no
-- new policy. Only the profile-admin path needs widening: 001 let founders
-- UPDATE profiles, but there was no policy allowing them to see the team list
-- with roles — profiles_read is `using (true)`, so that already works.
-- ============================================================

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
-- founder can remove a profile row (the auth user is removed separately via
-- the Edge Function / dashboard).
drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete on public.profiles for delete to authenticated
  using (public.is_founder());

-- ---------- NOTE for the app layer ----------
-- Migration 010 revoked SELECT on public.projects and re-granted an explicit
-- column list WITHOUT contract_value / management_fee_pct. PostgREST's default
-- Prefer: return=representation re-SELECTs every column after an INSERT/UPDATE,
-- which would hit that revoke and 400. The admin screen therefore writes
-- projects with `.select('id, name')` (granted columns only) or minimal return.
