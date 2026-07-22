-- ============================================================
-- MASON OS — Migration 014: Purchase Orders folder in the Document Vault
--
-- Adds a 'purchase_orders' value to the doc_folder enum and links a document
-- back to its PO (documents.po_id), so the vault can show the PO's live status
-- next to the archived PDF.
--
-- NOTE on ADD VALUE: Postgres won't let a newly-added enum value be USED in the
-- same transaction it was added. That's fine here — nothing in this migration
-- inserts a document with the new folder; the app does that later at runtime.
-- ============================================================

alter type doc_folder add value if not exists 'purchase_orders';

alter table public.documents
  add column if not exists po_id uuid references public.purchase_orders(id) on delete set null;

create index if not exists documents_po_idx on public.documents (po_id);
