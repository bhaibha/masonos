-- ============================================================
-- MASON OS — Migration 010: commercial-figure privacy on projects
--
-- contract_value, management_fee_pct and management_fee_amount are readable by
-- any project member today, supervisors included, because projects_read is
-- `using (is_member(id))` with no column restriction and RLS cannot limit
-- columns. The Project Detail header hides them in the UI, but a supervisor can
-- read them straight from PostgREST — the same gap 006 closed for
-- material_inward.rate. This closes it at the database level.
--
-- Shape mirrors 006: revoke SELECT on the table, re-grant the safe columns
-- one by one, and expose the sensitive three through an owner-run view that
-- carries its own role check.
--
-- Requires the frontend change shipped alongside (fetchProjects/fetchProject
-- select only the safe columns; commercials come from v_project_commercials).
-- The client tolerates either order — it falls back if the view is absent.
-- ============================================================

-- ---------- COLUMN-LEVEL SELECT ----------

-- All app users share the `authenticated` Postgres role; per-user access is via
-- JWT + RLS, not roles. So this hides the three columns from EVERYONE reading
-- the table directly — including the founder. Privileged reads go through the
-- view below. INSERT/UPDATE are untouched, so the (SQL-only, for now) project
-- admin path still writes them.
revoke select on public.projects from authenticated;

grant select (
  id, name, client_name, site_address, status,
  start_date, target_end_date, created_at
) on public.projects to authenticated;


-- ---------- ROLE-GATED COMMERCIAL VIEW ----------

-- Deliberately NOT security_invoker: it runs as the view owner so it can read
-- the columns `authenticated` no longer can. That makes the WHERE clause the
-- access control, so it must check BOTH membership and role. Drop either and
-- it leaks.
create or replace view public.v_project_commercials as
select
  p.id,
  p.contract_value,
  p.management_fee_pct,
  p.management_fee_amount
from public.projects p
where public.is_member(p.id)
  and public.my_role() in ('founder', 'pm', 'accounts');

grant select on public.v_project_commercials to authenticated;

comment on view public.v_project_commercials is
  'Contract value and management fee per project. Owner-run, so the WHERE '
  'clause is the access control: project membership AND founder/pm/accounts. '
  'Supervisors get zero rows.';


-- ---------- NOTE ----------
-- If a project edit screen is added later, its UPDATE cannot use PostgREST''s
-- default return=representation (that re-SELECTs every column and will hit the
-- revoke). Use Prefer: return=minimal, or return only the granted columns.
