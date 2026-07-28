-- ============================================================
-- MASON OS — clear ALL transaction data, keep masters
--
-- Run ONLY with a verified backup. All-or-nothing: wrapped in a single
-- transaction, so any error rolls the whole thing back and nothing is lost.
--
-- Verified against migrations 001–022 (the void/cancel/delete work added three
-- new foreign keys that changed the required order — see FK NOTES below).
--
-- ---------- DELETES FROM (20 tables) ----------
--   invoice_lines            po_invoices          grn_lines
--   goods_receipts           po_lines             purchase_orders
--   material_issues          material_inward      variation_orders
--   safety_checklist_items   safety_checklists    incidents
--   tasks                    site_logs            documents
--   expenses                 budgets              petty_cash_entries
--   petty_cash_accounts      audit_log
--
-- ---------- PRESERVES (7 tables) ----------
--   profiles            — users, their roles and designations
--   projects            — including contract_value and management_fee_pct
--   project_members     — who is assigned to what
--   expense_categories  — the chart of accounts
--   vendors             — vendor master
--   materials           — material master
--   auth.users          — untouched, so everyone keeps their login
--
-- ---------- FK NOTES (why the order is what it is) ----------
-- Most child tables cascade, but FIVE references have no ON DELETE clause and
-- therefore force a specific sequence. Getting these wrong is what makes the
-- script fail halfway:
--   1. po_invoices.expense_id  -> expenses          : po_invoices BEFORE expenses
--   2. material_inward.grn_line_id -> grn_lines     : inward BEFORE grn_lines   (020)
--   3. expenses.pc_entry_id -> petty_cash_entries   : expenses BEFORE pc entries (020)
--   4. grn_lines.po_line_id -> po_lines             : grn_lines BEFORE po_lines
--   5. invoice_lines.po_line_id -> po_lines         : invoice_lines BEFORE po_lines
-- Two more are safe by construction, noted where they occur:
--   documents.po_id -> purchase_orders is ON DELETE SET NULL (014), so purchase
--     orders may be cleared before documents without a violation.
--   tasks.rolled_from -> tasks is self-referential; deleting the whole table in
--     one statement satisfies it.
-- audit_log goes LAST: every delete above fires an audit trigger that writes to
-- it, so clearing it first would leave a fresh set of rows behind.
--
-- Nothing here touches voided_at / cancelled_at columns — this removes the rows
-- outright. It is for wiping test data before real entry begins, NOT for
-- correcting a live record. Once real data is in, use void or cancel instead.
-- ============================================================

BEGIN;

-- ---------- 1. PROCUREMENT: invoices ----------
-- invoice_lines first (child of both po_invoices and po_lines).
-- po_invoices must precede expenses — it holds expense_id.
DELETE FROM public.invoice_lines;
DELETE FROM public.po_invoices;

-- ---------- 2. MATERIAL MOVEMENTS ----------
-- material_inward must precede grn_lines — since migration 020 it holds
-- grn_line_id, the back-link that lets a GRN void reverse its own stock.
DELETE FROM public.material_issues;
DELETE FROM public.material_inward;

-- ---------- 3. PROCUREMENT: receipts and orders ----------
-- grn_lines before po_lines (holds po_line_id, no cascade).
-- purchase_orders last of this group; documents.po_id is SET NULL so the
-- document rows survive this statement and are cleared in step 6.
DELETE FROM public.grn_lines;
DELETE FROM public.goods_receipts;
DELETE FROM public.po_lines;
DELETE FROM public.purchase_orders;

-- ---------- 4. VARIATIONS ----------
DELETE FROM public.variation_orders;

-- ---------- 5. SAFETY ----------
-- Items cascade from checklists; listed explicitly so the intent is on record.
DELETE FROM public.safety_checklist_items;
DELETE FROM public.safety_checklists;
DELETE FROM public.incidents;

-- ---------- 6. SITE, TASKS, DOCUMENTS ----------
DELETE FROM public.tasks;          -- self-FK (rolled_from) satisfied by a full delete
DELETE FROM public.site_logs;
DELETE FROM public.documents;      -- metadata only; storage objects survive, see NOT COVERED

-- ---------- 7. MONEY ----------
-- expenses must precede petty_cash_entries — since migration 020 it holds
-- pc_entry_id, the link that lets a petty cash void reverse its mirrored expense.
DELETE FROM public.expenses;
DELETE FROM public.budgets;

-- ---------- 8. PETTY CASH ----------
DELETE FROM public.petty_cash_entries;
DELETE FROM public.petty_cash_accounts;

-- ---------- 9. AUDIT LOG (last — everything above wrote to it) ----------
DELETE FROM public.audit_log;

-- ---------- 10. RESET DOCUMENT NUMBERING ----------
-- So real data starts at PO-000001 / VO-0001 rather than continuing from test
-- numbers. Comment these two lines out to keep counting up instead.
ALTER SEQUENCE public.po_number_seq RESTART WITH 1;
ALTER SEQUENCE public.vo_number_seq RESTART WITH 1;

-- ============================================================
-- VERIFY BEFORE COMMITTING
-- These run inside the transaction. Every DELETED count must be 0 and every
-- PRESERVED count must be > 0 (except any master you never populated).
-- If anything looks wrong, run  ROLLBACK;  instead of letting it commit.
-- ============================================================
SELECT 'DELETED — every column below must read 0' AS check_group;
SELECT
  (SELECT count(*) FROM public.expenses)              AS expenses,
  (SELECT count(*) FROM public.budgets)               AS budgets,
  (SELECT count(*) FROM public.petty_cash_entries)    AS pc_entries,
  (SELECT count(*) FROM public.petty_cash_accounts)   AS pc_accounts,
  (SELECT count(*) FROM public.tasks)                 AS tasks,
  (SELECT count(*) FROM public.site_logs)             AS site_logs,
  (SELECT count(*) FROM public.material_inward)       AS inward,
  (SELECT count(*) FROM public.material_issues)       AS issues,
  (SELECT count(*) FROM public.purchase_orders)       AS purchase_orders,
  (SELECT count(*) FROM public.po_lines)              AS po_lines,
  (SELECT count(*) FROM public.goods_receipts)        AS goods_receipts,
  (SELECT count(*) FROM public.grn_lines)             AS grn_lines,
  (SELECT count(*) FROM public.po_invoices)           AS po_invoices,
  (SELECT count(*) FROM public.invoice_lines)         AS invoice_lines,
  (SELECT count(*) FROM public.variation_orders)      AS variation_orders,
  (SELECT count(*) FROM public.safety_checklists)     AS safety_checklists,
  (SELECT count(*) FROM public.safety_checklist_items) AS safety_items,
  (SELECT count(*) FROM public.incidents)             AS incidents,
  (SELECT count(*) FROM public.documents)             AS documents,
  (SELECT count(*) FROM public.audit_log)             AS audit_log;

SELECT 'PRESERVED — every column below must be > 0' AS check_group;
SELECT
  (SELECT count(*) FROM public.profiles)              AS users,
  (SELECT count(*) FROM public.projects)              AS projects,
  (SELECT count(*) FROM public.project_members)       AS project_members,
  (SELECT count(*) FROM public.expense_categories)    AS expense_categories,
  (SELECT count(*) FROM public.vendors)               AS vendors,
  (SELECT count(*) FROM public.materials)             AS materials;

COMMIT;

-- ============================================================
-- NOT COVERED BY THIS SCRIPT (deliberate)
--
-- 1. STORAGE FILES. Clearing `documents` removes the vault listings, but the
--    objects stay in the receipts / site-photos / documents buckets — orphaned
--    and invisible in the app. To clear them: Supabase dashboard → Storage →
--    pick each bucket → select all → delete. Do that AFTER this script.
--
-- 2. AUTH USERS. auth.users is untouched and profiles is preserved, so everyone
--    keeps their login, role, designation and project assignments.
--
-- 3. PROJECTS keep their contract_value and management_fee_pct. If a project
--    carries a test contract figure, edit it on Manage → Projects rather than
--    deleting the project.
--
-- 4. VENDOR and MATERIAL masters survive. Once their transactions are gone,
--    any of them CAN then be hard-deleted from the app (fn_delete_record only
--    refuses while something still references them).
-- ============================================================
