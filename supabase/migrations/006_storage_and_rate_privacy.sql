-- ============================================================
-- MASON OS — Migration 006: close two read-side holes
--
-- 1. storage.objects — the blanket `storage_rw` policy let ANY authenticated
--    user read ANY object in receipts / site-photos / documents. Replaced with
--    per-bucket policies keyed on the leading path segment (= project_id) and
--    public.is_member(). The documents bucket additionally hides confidential
--    files from supervisors, matching docs_read on the table.
--
-- 2. material_inward.rate / vendor_id — RLS cannot restrict columns, and every
--    app user shares the `authenticated` role, so supervisors could read
--    purchase rates straight from PostgREST. Fixed with column-level GRANTs
--    plus a rate-bearing view restricted to founder/pm/accounts.
--
-- Object paths are already `<project_id>/<uuid>.<ext>` for all three buckets,
-- so no data migration is needed. Verify before running:
--   select name from storage.objects
--   where bucket_id in ('receipts','site-photos','documents')
--     and split_part(name,'/',1) !~
--       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--   -- expect zero rows
-- ============================================================


-- ---------- HELPERS ----------

-- Leading path segment as a uuid, or NULL if it isn't one. A bare
-- `split_part(name,'/',1)::uuid` would raise on a malformed key and error the
-- whole query rather than just denying the row.
create or replace function public.fn_storage_project(p_name text)
returns uuid
language plpgsql
immutable
as $$
declare
  seg text;
begin
  seg := split_part(p_name, '/', 1);
  if seg !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return null;
  end if;
  return seg::uuid;
exception when others then
  return null;
end $$;

-- Is the object at this path a confidential document?
--
-- MUST be SECURITY DEFINER. A plain subquery against public.documents inside a
-- storage policy runs as the caller, so RLS (docs_read) would hide the
-- confidential row from a supervisor, `exists` would come back false, and the
-- policy would conclude "not confidential" and GRANT access — the exact
-- opposite of the intent. Running as owner sees the true value.
create or replace function public.fn_doc_is_confidential(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select d.is_confidential
     from public.documents d
     where d.file_path = p_path
     limit 1),
    false)
$$;

revoke all on function public.fn_doc_is_confidential(text) from public, anon;
grant execute on function public.fn_doc_is_confidential(text) to authenticated;

-- The policy looks up by file_path on every object read.
create index if not exists documents_file_path_idx
  on public.documents (file_path);


-- ---------- 1. STORAGE POLICIES ----------

drop policy if exists storage_rw on storage.objects;

-- READ ------------------------------------------------------

create policy receipts_read on storage.objects for select to authenticated
using (
  bucket_id = 'receipts'
  and public.is_member(public.fn_storage_project(name))
);

create policy site_photos_read on storage.objects for select to authenticated
using (
  bucket_id = 'site-photos'
  and public.is_member(public.fn_storage_project(name))
);

create policy documents_read on storage.objects for select to authenticated
using (
  bucket_id = 'documents'
  and public.is_member(public.fn_storage_project(name))
  and (
    not public.fn_doc_is_confidential(name)
    or public.my_role() in ('founder', 'pm', 'accounts')
  )
);

-- WRITE -----------------------------------------------------
-- Supervisors upload challan and site photos; they never upload to the vault
-- (mirrors docs_write on public.documents).

create policy receipts_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'receipts'
  and public.is_member(public.fn_storage_project(name))
);

create policy site_photos_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'site-photos'
  and public.is_member(public.fn_storage_project(name))
);

create policy documents_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'documents'
  and public.is_member(public.fn_storage_project(name))
  and public.my_role() in ('founder', 'pm', 'accounts')
);

-- DELETE ----------------------------------------------------
-- Founder, or whoever uploaded it. No UPDATE policy: objects are immutable
-- once written (uploads always use a fresh uuid, upsert:false).

create policy storage_delete on storage.objects for delete to authenticated
using (
  bucket_id in ('receipts', 'site-photos', 'documents')
  and public.is_member(public.fn_storage_project(name))
  and (public.is_founder() or owner = auth.uid())
);


-- ---------- 2. material_inward RATE PRIVACY ----------

-- Column-level SELECT. Postgres grants are per-database-role, and all app
-- users share `authenticated`, so this hides rate and vendor_id from everyone
-- reading the table directly — including the founder. Privileged reads go
-- through v_material_inward_rates below.
revoke select on public.material_inward from authenticated;

grant select (
  id, project_id, material_id, inward_date, qty,
  challan_no, challan_photo, remarks, created_by, created_at
) on public.material_inward to authenticated;

-- INSERT is untouched: the app still writes rate when a founder/pm enters one.

-- Safe read for everyone. security_invoker → RLS (inward_read) still applies
-- and the caller's column grants are satisfied.
create or replace view public.v_material_inward with (security_invoker = true) as
select id, project_id, material_id, inward_date, qty,
       challan_no, challan_photo, remarks, created_by, created_at
from public.material_inward;

grant select on public.v_material_inward to authenticated;

-- Rate-bearing read. Deliberately NOT security_invoker: it runs as the view
-- owner so it can see the restricted columns, therefore it does its own
-- authorisation in the WHERE clause. Both checks are required.
create or replace view public.v_material_inward_rates as
select i.id, i.project_id, i.material_id, i.inward_date, i.qty,
       i.vendor_id, i.challan_no, i.rate, i.challan_photo, i.remarks,
       i.created_by, i.created_at
from public.material_inward i
where public.is_member(i.project_id)
  and public.my_role() in ('founder', 'pm', 'accounts');

grant select on public.v_material_inward_rates to authenticated;

comment on view public.v_material_inward_rates is
  'Inward rows including rate and vendor_id. Runs as owner, so the WHERE '
  'clause is the access control: project membership + founder/pm/accounts.';
