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
