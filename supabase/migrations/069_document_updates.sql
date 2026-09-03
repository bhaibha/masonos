-- ============================================================
-- MASON OS — Migration 069: documents can be updated at all
--
-- FOUND BY THE SHARE TOGGLE FAILING. `documents` has policies for SELECT
-- (003, tightened in 006), INSERT (docs_write) and DELETE (docs_delete) — and
-- NONE for UPDATE. RLS is default-deny, so every UPDATE on that table has
-- always been refused.
--
-- That means migration 031's sub-folder move has been broken since the day it
-- shipped: `setDocumentSubfolder` issues a PATCH, Postgres refuses it, and the
-- feature has simply never worked. Nobody noticed because filing a document
-- into a sub-folder after uploading it is rare, and the error surfaced as a
-- toast people dismissed. A capability nobody exercises is a capability nobody
-- discovers is missing.
--
-- WHY RPCs AND STILL NO UPDATE POLICY
--
-- The obvious fix is `create policy docs_update ... using (is_member(...))`.
-- That is wrong here for the reason recorded against 021 and 050: an RLS UPDATE
-- policy CANNOT restrict which columns are written. A policy loose enough to
-- let somebody file a document into a sub-folder is also loose enough for a
-- hand-written PATCH to flip `is_confidential` to false, or repoint
-- `project_id` at another job, or rewrite `file_path` to a different object.
-- On this table those three columns are the entire security model:
-- `is_confidential` hides a document from supervisors AND from clients,
-- `project_id` is what every is_member() check reads, and `file_path` is what
-- the 068 storage policy matches on.
--
-- So `documents` keeps NO update policy, default-deny stands, and the two
-- things that legitimately change are two narrow SECURITY DEFINER functions.
-- Same shape as fn_void_record (020) and fn_cancel_document (021): the absence
-- of a policy is what makes the RPC unbypassable.
--
-- Re-runnable: create-or-replace, fresh signatures.
-- ============================================================


-- ############################################################
-- ###  1. Share a document with the client portal
-- ############################################################
-- Founder/PM only — the same pair that may publish a photo (client_photos_write
-- in 065). Sharing is a commercial judgement about what the client is shown,
-- not a filing decision, so accounts is deliberately excluded even though they
-- may upload.

create or replace function public.fn_set_document_shared(
  p_document uuid,
  p_shared   boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project      uuid;
  v_confidential boolean;
begin
  select project_id, is_confidential
    into v_project, v_confidential
  from public.documents
  where id = p_document;

  if v_project is null then
    raise exception 'That document no longer exists.' using errcode = '22023';
  end if;

  -- Runs as owner, so RLS does not apply — every check the policies would have
  -- made has to be made here, explicitly.
  if not public.is_member(v_project) then
    raise exception 'That document is not on a project you work on.'
      using errcode = '42501';
  end if;

  if public.my_role()::text not in ('founder', 'pm') then
    raise exception 'Only a founder or project manager decides what the client sees.'
      using errcode = '42501';
  end if;

  -- A confidential document can never be shared. v_client_documents and the 068
  -- storage policy both test is_confidential independently, so this is the third
  -- statement of the same rule — deliberately, because the failure mode is a
  -- document reaching an outsider and none of the three should be load-bearing
  -- alone.
  if p_shared and v_confidential then
    raise exception 'A confidential document cannot be shared with a client.'
      using errcode = '42501';
  end if;

  update public.documents
     set client_visible = p_shared
   where id = p_document;
end $$;

revoke all on function public.fn_set_document_shared(uuid, boolean) from public, anon;
grant execute on function public.fn_set_document_shared(uuid, boolean) to authenticated;

comment on function public.fn_set_document_shared(uuid, boolean) is
  'The only way client_visible changes. documents has no UPDATE policy, so this '
  'function cannot be bypassed by a direct PATCH.';


-- ############################################################
-- ###  2. Repair the sub-folder move (migration 031)
-- ############################################################
-- Same reasoning, and this one is a bug fix rather than a new feature: the UI
-- has offered this since 031 and Postgres has refused it every time.

create or replace function public.fn_set_document_subfolder(
  p_document  uuid,
  p_subfolder uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project  uuid;
  v_sf_proj  uuid;
begin
  select project_id into v_project
  from public.documents where id = p_document;

  if v_project is null then
    raise exception 'That document no longer exists.' using errcode = '22023';
  end if;

  if not public.is_member(v_project) then
    raise exception 'That document is not on a project you work on.'
      using errcode = '42501';
  end if;

  if public.my_role()::text not in ('founder', 'pm', 'accounts') then
    raise exception 'You cannot move documents.' using errcode = '42501';
  end if;

  -- null = back to the folder root, which is the ON DELETE SET NULL state a
  -- deleted sub-folder leaves behind (031). Anything else must be a sub-folder
  -- on the SAME project, or a document could be filed into another job's tree.
  if p_subfolder is not null then
    select project_id into v_sf_proj
    from public.doc_subfolders where id = p_subfolder;

    if v_sf_proj is null then
      raise exception 'That sub-folder no longer exists.' using errcode = '22023';
    end if;
    if v_sf_proj <> v_project then
      raise exception 'That sub-folder belongs to a different project.'
        using errcode = '42501';
    end if;
  end if;

  update public.documents
     set subfolder_id = p_subfolder
   where id = p_document;
end $$;

revoke all on function public.fn_set_document_subfolder(uuid, uuid) from public, anon;
grant execute on function public.fn_set_document_subfolder(uuid, uuid) to authenticated;


-- ---------- VERIFY ----------
-- Confirm there is still NO update policy on documents — if one appears later,
-- both functions above become bypassable and the column protections evaporate.
select
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'documents'
      and cmd = 'UPDATE')                                    as update_policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('fn_set_document_shared',
                        'fn_set_document_subfolder'))        as fns;
-- Expect: update_policies = 0, fns = 2.
