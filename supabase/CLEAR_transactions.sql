-- ============================================================
-- MASON OS — clear ALL transaction data, keep masters
--
-- Run ONLY with a verified backup. All-or-nothing: wrapped in a single
-- transaction, so any error rolls the whole thing back and nothing is lost.
--
-- Verified against migrations 001–037. Rewritten 2026-08-06 to cover everything
-- Group A added: instructions, RFIs, snags, compliance, drawings, RA bills,
-- retention, guarantees, insurance and document sub-folders.
--
-- ---------- DELETES FROM (33 tables) ----------
--   invoice_items            invoices              po_invoices
--   grn_lines                goods_receipts        po_lines
--   purchase_orders          material_issues       material_inward
--   ra_bill_lines            ra_bills              retention_releases
--   bank_guarantees          insurance_policies    compliance_items
--   drawing_revisions        drawings              rfis
--   site_instructions        variation_orders      snags
--   safety_checklist_items   safety_checklists     incidents
--   tasks                    site_logs             documents
--   doc_subfolders           expenses              budgets
--   petty_cash_entries       petty_cash_accounts   audit_log
--
-- ---------- PRESERVES ----------
--   profiles            — users, their roles and designations
--   projects            — including contract_value, fee % and DLP dates
--   project_members     — who is assigned to what
--   expense_categories  — the chart of accounts
--   vendors             — vendor master
--   materials           — material master
--   push_subscriptions  — device notification opt-ins; clearing these would
--                         force everyone to re-enable notifications for nothing
--   auth.users          — untouched, so everyone keeps their login
--
-- ---------- WHAT THIS DOES **NOT** DO ----------
-- 1. FILES STAY. Deleting a row does not remove the object it points at. After
--    this runs, empty the five buckets by hand in Storage:
--      receipts · site-photos · documents · compliance · drawings
--    Skipping that leaves orphaned files nothing references — harmless, but
--    they still count against storage and confuse anyone browsing.
-- 2. NUMBER SERIES CONTINUE. Your first real bill would be RA-0007 rather than
--    RA-0001. The optional block at the very end resets them; it is separate
--    and commented out because restarting a sequence is only safe once the
--    rows using those numbers are actually gone.
-- 3. PROJECTS SURVIVE, including their status. If AADHYA is marked `completed`
--    from testing and is actually live, fix that on Manage → Projects
--    afterwards — the daily digest only looks at active projects.
--
-- ---------- FK NOTES (why the order is what it is) ----------
-- Most children cascade from their parent, but several references have no
-- ON DELETE clause and therefore force a sequence. Getting these wrong is what
-- makes a clear-down fail halfway:
--   • expenses.pc_entry_id            → petty_cash_entries   (020)
--   • material_inward.grn_line_id     → grn_lines            (020)
--   • po_invoices.expense_id          → expenses             (013)
--   • site_instructions.variation_id  → variation_orders     (023)
--   • insurance_policies.renewed_from → itself               (034)
-- So: children before parents, and expenses last among the money tables.
-- ============================================================

begin;

-- ---------- 1. Procurement chain (deepest first) ----------
delete from public.grn_lines;
delete from public.goods_receipts;
delete from public.po_invoices;          -- references expenses
delete from public.po_lines;
delete from public.purchase_orders;

-- ---------- 2. Client billing ----------
delete from public.invoice_items;
delete from public.invoices;

-- ---------- 3. Contractor billing, retention, guarantees ----------
delete from public.ra_bill_lines;
delete from public.ra_bills;
delete from public.retention_releases;
delete from public.bank_guarantees;

-- ---------- 4. Registers ----------
delete from public.insurance_policies;   -- self-reference: one flat delete is fine
delete from public.compliance_items;
delete from public.drawing_revisions;
delete from public.drawings;
delete from public.snags;
delete from public.rfis;
delete from public.site_instructions;    -- references variation_orders
delete from public.variation_orders;

-- ---------- 5. Materials ----------
delete from public.material_issues;
delete from public.material_inward;      -- references grn_lines, already gone

-- ---------- 6. Site records ----------
delete from public.safety_checklist_items;
delete from public.safety_checklists;
delete from public.incidents;
delete from public.tasks;                -- self-reference via rolled_from
delete from public.site_logs;

-- ---------- 7. Documents ----------
delete from public.documents;            -- subfolder_id is ON DELETE SET NULL
delete from public.doc_subfolders;

-- ---------- 8. Money, last ----------
delete from public.expenses;             -- was referenced by po_invoices, now gone
delete from public.budgets;
delete from public.petty_cash_entries;
delete from public.petty_cash_accounts;

-- ---------- 9. The trail of all the above ----------
-- Deleted last on purpose: every statement above fires audit triggers, so
-- clearing it first would only refill it.
delete from public.audit_log;

-- ---------- VERIFY BEFORE COMMITTING ----------
-- All zero. If any row survives, something references it that this script
-- doesn't know about — roll back and say so rather than deleting by hand.
select
  (select count(*) from public.expenses)            as expenses,
  (select count(*) from public.purchase_orders)     as purchase_orders,
  (select count(*) from public.invoices)            as invoices,
  (select count(*) from public.ra_bills)            as ra_bills,
  (select count(*) from public.retention_releases)  as retention,
  (select count(*) from public.bank_guarantees)     as guarantees,
  (select count(*) from public.insurance_policies)  as insurance,
  (select count(*) from public.compliance_items)    as compliance,
  (select count(*) from public.drawings)            as drawings,
  (select count(*) from public.snags)               as snags,
  (select count(*) from public.rfis)                as rfis,
  (select count(*) from public.tasks)               as tasks,
  (select count(*) from public.documents)           as documents,
  (select count(*) from public.audit_log)           as audit_log;

-- Masters should be UNTOUCHED. Confirm these still hold your real data.
select
  (select count(*) from public.profiles)           as profiles,
  (select count(*) from public.projects)           as projects,
  (select count(*) from public.project_members)    as members,
  (select count(*) from public.vendors)            as vendors,
  (select count(*) from public.materials)          as materials,
  (select count(*) from public.expense_categories) as categories;

commit;


-- ============================================================
-- OPTIONAL — restart the number series so real data begins at 0001.
-- Run ONLY after the commit above has succeeded and you have confirmed the
-- tables are empty. Restarting a sequence while numbered rows still exist
-- would eventually collide and raise a unique violation.
-- ============================================================
-- alter sequence public.po_number_seq   restart with 1;
-- alter sequence public.vo_number_seq   restart with 1;
-- alter sequence public.si_number_seq   restart with 1;
-- alter sequence public.rfi_number_seq  restart with 1;
-- alter sequence public.snag_number_seq restart with 1;
-- alter sequence public.ra_bill_seq     restart with 1;
-- alter sequence public.invoice_p_seq   restart with 1;
-- alter sequence public.invoice_m_seq   restart with 1;
-- alter sequence public.invoice_v_seq   restart with 1;
