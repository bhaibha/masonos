-- ============================================================
-- MASON OS — clear TEST TRANSACTION data, keep masters
--
-- Run ONLY with a verified backup. All-or-nothing: wrapped in a transaction,
-- so any error rolls the whole thing back.
--
-- DELETES (transactional):
--   invoice_lines, po_invoices, grn_lines, goods_receipts, po_lines,
--   purchase_orders, variation_orders, safety_checklist_items,
--   safety_checklists, incidents, material_issues, material_inward,
--   petty_cash_entries, petty_cash_accounts, tasks, site_logs, documents,
--   expenses, budgets, audit_log
--
-- PRESERVES (masters/config):
--   profiles (users + roles), projects, project_members,
--   expense_categories, vendors, materials
--
-- ORDER: children before parents. Two orderings that matter —
--   1. po_invoices BEFORE expenses  (po_invoices.expense_id -> expenses.id)
--   2. tasks self-references via rolled_from, so it's cleared in one
--      statement (a plain DELETE of the whole table satisfies the self-FK).
--   3. audit_log LAST — the deletes above fire audit triggers that write to it,
--      so clearing it first would leave fresh rows behind.
-- ============================================================

BEGIN;

-- ORDER UPDATED BY MIGRATION 020, which added two back-links:
--   material_inward.grn_line_id -> grn_lines   (inward BEFORE grn_lines)
--   expenses.pc_entry_id        -> petty_cash_entries (expenses BEFORE pc entries)
-- The old order deleted grn_lines and petty_cash_entries first and would now
-- fail on those FKs.

-- ---------- PROCUREMENT (deepest children first) ----------
DELETE FROM public.invoice_lines;
DELETE FROM public.po_invoices;      -- must precede expenses (expense_id FK)

-- ---------- MATERIAL MOVEMENTS (masters `materials` kept) ----------
DELETE FROM public.material_issues;
DELETE FROM public.material_inward;  -- must precede grn_lines (grn_line_id FK)

-- ---------- PROCUREMENT, rest ----------
DELETE FROM public.grn_lines;
DELETE FROM public.goods_receipts;
DELETE FROM public.po_lines;
DELETE FROM public.purchase_orders;

-- ---------- VARIATIONS ----------
DELETE FROM public.variation_orders;

-- ---------- SAFETY ----------
DELETE FROM public.safety_checklist_items;
DELETE FROM public.safety_checklists;
DELETE FROM public.incidents;

-- ---------- SITE / TASKS ----------
DELETE FROM public.tasks;            -- self-FK (rolled_from) handled by full delete
DELETE FROM public.site_logs;

-- ---------- DOCUMENTS (metadata rows only — see note below) ----------
DELETE FROM public.documents;

-- ---------- MONEY ----------
DELETE FROM public.expenses;         -- must precede petty_cash_entries (pc_entry_id FK)
DELETE FROM public.budgets;

-- ---------- PETTY CASH ----------
DELETE FROM public.petty_cash_entries;
DELETE FROM public.petty_cash_accounts;

-- ---------- AUDIT LOG (last: the deletes above wrote to it) ----------
DELETE FROM public.audit_log;

-- ---------- RESET DOCUMENT NUMBER SEQUENCES ----------
-- So real data starts at PO-000001 / VO-0001 instead of continuing from test
-- numbers. Comment these two lines out if you'd rather keep counting up.
ALTER SEQUENCE public.po_number_seq RESTART WITH 1;
ALTER SEQUENCE public.vo_number_seq RESTART WITH 1;

-- ---------- VERIFY BEFORE COMMITTING ----------
-- These run inside the transaction. Every transactional count should be 0 and
-- every preserved count should be > 0. If anything looks wrong, run ROLLBACK;
-- instead of COMMIT;
SELECT 'DELETED — should all be 0' AS check_group;
SELECT
  (SELECT count(*) FROM public.expenses)                AS expenses,
  (SELECT count(*) FROM public.budgets)                 AS budgets,
  (SELECT count(*) FROM public.tasks)                   AS tasks,
  (SELECT count(*) FROM public.site_logs)               AS site_logs,
  (SELECT count(*) FROM public.material_inward)         AS material_inward,
  (SELECT count(*) FROM public.material_issues)         AS material_issues,
  (SELECT count(*) FROM public.purchase_orders)         AS purchase_orders,
  (SELECT count(*) FROM public.po_lines)                AS po_lines,
  (SELECT count(*) FROM public.goods_receipts)          AS goods_receipts,
  (SELECT count(*) FROM public.po_invoices)             AS po_invoices,
  (SELECT count(*) FROM public.variation_orders)        AS variation_orders,
  (SELECT count(*) FROM public.safety_checklists)       AS safety_checklists,
  (SELECT count(*) FROM public.incidents)               AS incidents,
  (SELECT count(*) FROM public.documents)               AS documents,
  (SELECT count(*) FROM public.petty_cash_accounts)     AS petty_cash_accounts,
  (SELECT count(*) FROM public.audit_log)               AS audit_log;

SELECT 'PRESERVED — should all be > 0 (except any you never created)' AS check_group;
SELECT
  (SELECT count(*) FROM public.profiles)                AS profiles_users,
  (SELECT count(*) FROM public.projects)                AS projects,
  (SELECT count(*) FROM public.project_members)         AS project_members,
  (SELECT count(*) FROM public.expense_categories)      AS expense_categories,
  (SELECT count(*) FROM public.vendors)                 AS vendors,
  (SELECT count(*) FROM public.materials)               AS materials;

COMMIT;

-- ============================================================
-- NOT covered by this script (deliberate):
--
-- 1. STORAGE FILES. Deleting `documents` rows removes the vault listings, but
--    the actual objects stay in the receipts / site-photos / documents buckets.
--    They're orphaned and invisible in the app. To clear them, use the Supabase
--    dashboard → Storage → select bucket → select all → delete. Do that AFTER
--    this script, and only if you're sure.
--
-- 2. AUTH USERS. `profiles` is preserved, and auth.users is untouched, so
--    everyone keeps their login.
--
-- 3. PROJECTS themselves are preserved, including contract_value and
--    management_fee_pct. If a test project has a fake contract value, edit that
--    row directly rather than deleting the project.
-- ============================================================
