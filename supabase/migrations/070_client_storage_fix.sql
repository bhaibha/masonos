-- ============================================================
-- MASON OS — Migration 070: 068's storage policies could never have worked
--
-- THE BUG. 068 granted a client read on a storage object like this:
--
--     exists (select 1 from public.documents d
--             where d.file_path = storage.objects.name
--               and d.project_id = public.fn_client_project()
--               and d.client_visible and not d.is_confidential)
--
-- The condition is right and the subquery returns NOTHING, because
-- **a policy's subquery is itself subject to RLS on the table it reads**. It is
-- evaluated with the privileges of the querying user, so the client's own
-- policies apply to `public.documents` — and `documents_read` requires
-- `is_member(project_id)`, which 065 deliberately made FALSE for a client.
--
-- So the client can see the document through `v_client_documents` (an OWNER-RUN
-- view, which is why the list renders) and cannot see the same row through the
-- base table (correct), and the policy asked the base table (wrong). Storage
-- answered "Object not found", which is what Supabase returns for an object RLS
-- filtered out — indistinguishable from a genuinely missing file, which is why
-- this took three rounds to corner.
--
-- THE FIX. Ask the same owner-run view the portal already reads. The storage
-- grant then derives from the exact object the list is built from, so the two
-- cannot disagree by construction — a stronger version of what 068 was reaching
-- for, and one line shorter.
--
--     exists (select 1 from public.v_client_documents d
--             where d.file_path = storage.objects.name)
--
-- v_client_documents already carries all three conditions (own project,
-- client_visible, not confidential), so nothing is lost by not restating them —
-- and restating them would be the second copy that eventually drifts.
--
-- `v_client_photos` gets the same treatment. Its policy would ACCIDENTALLY have
-- worked, because `client_photos_read` permits `project_id =
-- fn_client_project()` — but relying on that means the storage grant silently
-- breaks the day somebody tightens client_photos. Both go through the view.
--
-- THE GENERAL RULE, worth remembering: an RLS policy that queries another table
-- gets that table's RLS too. If the policy needs to see a row the caller cannot,
-- it must go through a SECURITY DEFINER function or an owner-run view.
--
-- Re-runnable: drop-then-create.
-- ============================================================


drop policy if exists documents_client_read on storage.objects;
create policy documents_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_client()
    and exists (
      select 1
      from public.v_client_documents d
      where d.file_path = storage.objects.name
    )
  );


drop policy if exists site_photos_client_read on storage.objects;
create policy site_photos_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'site-photos'
    and public.is_client()
    and exists (
      select 1
      from public.v_client_photos p
      where p.photo_path = storage.objects.name
    )
  );


-- ---------- VERIFY ----------
-- Not verifiable as `postgres`: is_client() is false and both policies
-- short-circuit before the subquery. Verify through a real client session —
-- client-proof.js Part 5 opens a shared document and a published photo, and
-- checks the receipts and drawings buckets are still refused.

select policyname, qual is not null as has_using
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname in ('documents_client_read', 'site_photos_client_read')
order by 1;
