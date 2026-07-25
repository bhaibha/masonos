-- ============================================================
-- MASON OS — Migration 018: consolidation fixes
--
-- Found by audit of CLAUDE.md rule 5 ("audit log on every financial + material
-- + approval table") and the 006/017 column-grant interaction.
--
-- 1. MISSING AUDIT TRIGGERS. These carry money or stock movement but had no
--    audit trigger — a rate could be edited on an approved PO, or an invoice
--    line altered, with no trail:
--      po_lines             (rate, line_total)
--      invoice_lines        (rate_invoiced, line_total)
--      grn_lines            (qty_received → drives stock)
--      petty_cash_accounts  (imprest_amount)
--      vendors              (payee master — approval-adjacent)
--      materials            (material master, low-stock thresholds)
--
-- 2. material_inward.vendor_name UNREADABLE. Migration 006 did
--    `revoke select on material_inward` + `grant select (explicit columns)`.
--    Migration 017 then ADDED vendor_name, which is not in that grant — so no
--    role can read it directly, and the safe view omits it. Re-grant it and
--    add it to v_material_inward / v_material_inward_rates.
--
-- Idempotent: drop-trigger-if-exists before create; views replaced.
-- ============================================================

-- ---------- 1. AUDIT TRIGGER GAPS ----------

drop trigger if exists audit_po_lines on public.po_lines;
create trigger audit_po_lines
  after insert or update or delete on public.po_lines
  for each row execute function public.fn_audit();

drop trigger if exists audit_invoice_lines on public.invoice_lines;
create trigger audit_invoice_lines
  after insert or update or delete on public.invoice_lines
  for each row execute function public.fn_audit();

drop trigger if exists audit_grn_lines on public.grn_lines;
create trigger audit_grn_lines
  after insert or update or delete on public.grn_lines
  for each row execute function public.fn_audit();

drop trigger if exists audit_pc_accounts on public.petty_cash_accounts;
create trigger audit_pc_accounts
  after insert or update or delete on public.petty_cash_accounts
  for each row execute function public.fn_audit();

drop trigger if exists audit_vendors on public.vendors;
create trigger audit_vendors
  after insert or update or delete on public.vendors
  for each row execute function public.fn_audit();

drop trigger if exists audit_materials on public.materials;
create trigger audit_materials
  after insert or update or delete on public.materials
  for each row execute function public.fn_audit();


-- ---------- 2. material_inward.vendor_name GRANT ----------
-- vendor_name is a name, not a rate — safe for every project member to read
-- (supervisors already see which vendor delivered via the challan).
grant select (vendor_name) on public.material_inward to authenticated;

-- DROP-then-create, not create-or-replace: adding vendor_name mid-list shifts
-- column positions, and replace-in-place refuses that ("cannot change name of
-- view column"). Same lesson as v_po_match in 013.
drop view if exists public.v_material_inward cascade;
create view public.v_material_inward with (security_invoker = true) as
select id, project_id, material_id, inward_date, qty,
       vendor_name, challan_no, challan_photo, remarks, created_by, created_at
from public.material_inward;
grant select on public.v_material_inward to authenticated;

-- Rate-bearing view stays gated to founder/pm/accounts.
drop view if exists public.v_material_inward_rates cascade;
create view public.v_material_inward_rates as
select i.id, i.project_id, i.material_id, i.inward_date, i.qty,
       i.vendor_id, i.vendor_name, i.challan_no, i.rate, i.challan_photo,
       i.remarks, i.created_by, i.created_at
from public.material_inward i
where public.is_member(i.project_id)
  and public.my_role() in ('founder','pm','accounts');
grant select on public.v_material_inward_rates to authenticated;
