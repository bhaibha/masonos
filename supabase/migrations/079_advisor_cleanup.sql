-- ============================================================
-- MASON OS — Migration 079: Supabase advisor cleanup
--
-- Answering the Security Advisor's 23 "Security Definer View" errors and the
-- warning list. The short version, because most of it is not a defect:
--
--   * 22 owner-run views were audited ONE BY ONE against a real PostgreSQL
--     with five signed-in roles. Every one is correctly gated. Nothing leaks.
--   * 3 of them did not need owner rights and are switched to
--     security_invoker here — proven to return IDENTICAL rows for founder, pm,
--     accounts, supervisor and client before and after.
--   * 6 functions had a mutable search_path. Fixed here.
--   * Everything else the advisor reports is either safe by design or a
--     performance lint that would cost more than it buys at this scale. The
--     reasoning is written out below so the next person does not re-litigate
--     it from scratch.
--
-- WHY "SECURITY DEFINER VIEW" IS AN ERROR THE ADVISOR CANNOT JUDGE
-- ---------------------------------------------------------------
-- The linter flags any view that is not `security_invoker`, because such a
-- view reads its base tables as the OWNER and therefore bypasses RLS. That is
-- exactly what this app wants in two situations, and in both the WHERE clause
-- IS the access control (the 010 -> 038 pattern):
--
--   1. Money columns. `projects.contract_value`, `management_fee_pct`,
--      `po_lines.rate`, `material_inward.rate`, `schedule_activities.budget_amount`
--      are REVOKED from `authenticated` at the column level. An invoker-rights
--      view over them returns a permission error for everyone including the
--      founder, so those views must run as owner and gate on
--      `is_member(...) and my_role() in (...)`.
--   2. The client portal. A client has `is_member() = false` by construction
--      (065), so every base table refuses them. The ten `v_client_*` views run
--      as owner and gate on `project_id = fn_client_project()`.
--
-- AUDITED, NOT ASSUMED. Each of the 22 was queried as founder / pm / accounts /
-- supervisor / client on a database carrying real rows. Result: every
-- money-bearing view returned 0 rows to the supervisor and 0 to the client;
-- every client view returned 0 to all four internal roles and its own rows to
-- the client. `v_labour_project_cost` was the only one with no gate in its own
-- text — it aggregates `v_labour_cost`, whose gate it inherits, and it uses
-- GROUP BY, so an unauthorised caller gets ZERO ROWS rather than the row of
-- zeros the 066 rule exists to prevent. Confirmed by query, not by reading.
--
-- If any of those views is ever edited, THE WHERE CLAUSE IS THE SECURITY.
-- Losing it is a silent full-table leak.
-- ============================================================


-- ############################################################
-- ###  1. THREE VIEWS THAT NEVER NEEDED OWNER RIGHTS
-- ############################################################
-- None of these reads a revoked column, and none serves the client portal.
-- They were owner-run only because the surrounding migrations were.
--
-- Their own WHERE clauses already restrict to
-- `is_member(project_id) and my_role() in ('founder','pm','accounts')`, and
-- every base table underneath (expenses, budgets, ra_bills,
-- labour_attendance, labour_contractors) has RLS at least as tight. So the
-- rows a caller can see are unchanged; the difference is that RLS on the base
-- tables now applies as a second, independent check rather than being skipped.
--
-- Verified before and after on a real PostgreSQL, five roles, same fixtures:
--
--   view                     founder  pm  accounts  supervisor  client
--   v_labour_cost                  3   3         3           0       0
--   v_labour_project_cost          1   1         1           0       0
--   v_pnl_by_category              1   1         1           0       0
--
-- Identical in both modes. `fn_labour_rate` is SECURITY DEFINER, which is what
-- lets v_labour_cost still resolve a rate for a PM who cannot read
-- `labour_rates` directly — that is why the conversion does not break.

alter view public.v_labour_cost         set (security_invoker = true);
alter view public.v_labour_project_cost set (security_invoker = true);
alter view public.v_pnl_by_category     set (security_invoker = true);

comment on view public.v_labour_cost is
  'Per-attendance labour cost. security_invoker since 079 — it reads no '
  'revoked column, so base-table RLS applies on top of its own WHERE.';


-- ############################################################
-- ###  2. MUTABLE search_path ON SIX FUNCTIONS
-- ############################################################
-- All 107 SECURITY DEFINER functions in this database already pin their
-- search_path — that discipline has held since 001. These six are SECURITY
-- INVOKER and were missed, which is why the advisor lists them.
--
-- On an invoker function a hijacked search_path only lets a caller attack
-- themselves, so the risk is low — with two exceptions that make this worth
-- doing rather than dismissing:
--
--   `is_founder()` is read by RLS policies across the database. It calls
--   `my_role()` unqualified. A caller who could point `search_path` at a
--   schema of their own would redirect that call and decide their own role.
--   PostgREST gives no way to set search_path today, so this is defence in
--   depth rather than a live hole — but a security predicate should not
--   depend on a client-side setting staying locked down.
--
--   `fn_storage_project()` is called inside the storage.objects policies, the
--   same argument.
--
-- No index expression and no generated column depends on any of these
-- (checked), so the loss of inlining that a SET clause causes has no
-- correctness consequence here. Volatility is unchanged.

alter function public.is_founder()                        set search_path = public;
alter function public.fn_storage_project(text)            set search_path = public;
alter function public.fn_doc_kind_shareable(text)         set search_path = public;
alter function public.fn_learn_normalise_ref(text)        set search_path = public;
alter function public.fn_compliance_series()              set search_path = public;
alter function public.fn_schedule_template_rows(integer)  set search_path = public;


-- ############################################################
-- ###  3. WHAT IS DELIBERATELY NOT CHANGED
-- ############################################################
-- Recorded here so the next reader does not "fix" a decision.
--
-- 19 remaining owner-run views. Every one either reads a column revoked from
--   `authenticated` or serves the client portal. Converting them would return
--   a permission error to the founder, not tighten anything. Audited above.
--
-- `profiles` has TWO permissive UPDATE policies (`profiles_admin` +
--   `profiles_self`). The advisor flags multiple permissive policies as a
--   performance lint. They are OR-ed on purpose: a founder may edit anybody,
--   and anybody may edit their own name and phone. Merging them into one
--   policy would be one expression doing two unrelated jobs, and 078 already
--   added the active check to the second. Left alone.
--
-- ~152 policies call `auth.uid()` / `my_role()` / `is_member()` directly
--   rather than as `(select auth.uid())`. That is the advisor's
--   `auth_rls_initplan` lint: an uncached call is re-evaluated PER ROW instead
--   of once per query. It is a genuine optimisation on a table with a hundred
--   thousand rows. This firm runs at most 4 active projects and ~15 users, and
--   the largest table in the database is the audit log. Rewriting 152 security
--   predicates to save microseconds is a large, risky diff against a
--   correctness surface that is currently proven — the wrong trade today.
--   Revisit if a table passes ~50k rows and a screen feels slow; do it a
--   module at a time, re-running the role sweep after each.
--
-- RLS COVERAGE IS COMPLETE: every table in `public` has RLS enabled, none has
--   RLS with zero policies, and NO policy grants anything to `anon` or
--   `public`. Confirmed from the catalogue, not from memory.


-- ---------- VERIFY ----------
-- A select, not `raise notice` — the Supabase SQL editor does not display
-- notices, which made an earlier dry run in this repo report nothing at all.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='v'
      and coalesce((select option_value from pg_options_to_table(c.reloptions)
                     where option_name='security_invoker'),'off') <> 'true')   as owner_run_views,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
      and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) x
                       where x like 'search_path=%'))                          as fns_without_search_path,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and not c.relrowsecurity)       as tables_without_rls,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relrowsecurity
      and not exists (select 1 from pg_policies p
                       where p.schemaname='public' and p.tablename=c.relname)) as rls_but_no_policy,
  (select count(*) from pg_policies where schemaname='public'
      and (roles::text like '%anon%' or roles = '{public}'))                   as policies_open_to_anon;
-- Expect: owner_run_views = 19, fns_without_search_path = 0,
--         tables_without_rls = 0, rls_but_no_policy = 0, policies_open_to_anon = 0.
