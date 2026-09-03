-- ============================================================
-- MASON OS — Migration 068: a client can DOWNLOAD what has been shared
--
-- FOUND WHILE BUILDING CP3, before the screens existed to expose it.
--
-- 065 exposed the metadata — v_client_documents returns a title and a
-- file_path, v_client_photos returns a photo_path — but never touched storage.
-- The bucket policies from 006 all read:
--
--     using (bucket_id = '…' and public.is_member(fn_storage_project(name)))
--
-- and 065 HARDENED is_member() to return false for a client. So a client can
-- see that a document called "Kitchen layout, rev C" exists and cannot open it,
-- and every published photo renders as a broken image.
--
-- That is the gate working correctly and being wrong. This adds two policies —
-- ADDITIVE, since RLS policies are permissive and OR together, so nothing about
-- internal access changes.
--
-- THE SHAPE OF THE FIX MATTERS. The obvious version is to relax is_member() or
-- add `or project_id = fn_client_project()`, which would grant a client every
-- object under their project's prefix: receipts, drawings, confidential
-- documents, unpublished site photos — everything the site has ever uploaded to
-- that job. Instead each policy demands a MATCHING PUBLISHED ROW for that exact
-- path. Access is per-object and derived from the act of publishing, so the
-- storage grant and the visible list cannot drift apart: unshare the document
-- and the file is refused in the same instant.
--
-- Read-only. No insert, update or delete policy is added for clients in any
-- bucket — a client uploading a file is a separate decision, not a side effect
-- of being able to read one.
--
-- Re-runnable: drop-then-create, since `create policy` has no OR REPLACE.
-- ============================================================


-- ---------- published photos ----------
-- The path must appear in client_photos, which is the publish act itself (065).
-- A photo sitting in site_logs.photos that nobody published stays unreadable,
-- which is the entire point of client_photos being its own table.
drop policy if exists site_photos_client_read on storage.objects;
create policy site_photos_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'site-photos'
    and public.is_client()
    and exists (
      select 1
      from public.client_photos cp
      where cp.photo_path = storage.objects.name
        and cp.project_id = public.fn_client_project()
    )
  );


-- ---------- shared documents ----------
-- Mirrors v_client_documents EXACTLY — same three conditions, so the list and
-- the download can never disagree. `is_confidential` is checked here as well as
-- in the view: a confidential document must not become readable because
-- somebody ticked client_visible, and stating it in both places means neither
-- one is load-bearing alone.
drop policy if exists documents_client_read on storage.objects;
create policy documents_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_client()
    and exists (
      select 1
      from public.documents d
      where d.file_path = storage.objects.name
        and d.project_id = public.fn_client_project()
        and d.client_visible
        and not d.is_confidential
    )
  );


-- ---------- NOT granted, and deliberately ----------
-- receipts   : a supplier bill shows what the firm paid a vendor. Open book is
--              spend BY CATEGORY (v_client_spend_by_category), never the
--              individual voucher with a rate on it.
-- drawings   : the consultant's IP and the firm's coordination record. If a
--              client should have a drawing, it gets shared as a DOCUMENT,
--              through the one path that has a visibility flag on it.
-- compliance : statutory filings are the firm's obligation, not the client's
--              business.
--
-- No policy is written for those three, so the default-deny stands.


-- ---------- VERIFY ----------
-- As `postgres` this proves nothing — is_client() is false and both policies
-- short-circuit. Verify through a real client session:
--   1. sign in as the test client
--   2. supabase.storage.from('documents').createSignedUrl(<shared path>, 60)
--      -> must succeed
--   3. same call with a path that is NOT client_visible
--      -> must fail
-- client-proof.js Part 5 does both.

select policyname
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname in ('site_photos_client_read', 'documents_client_read')
order by 1;
-- Expect exactly these two rows.
