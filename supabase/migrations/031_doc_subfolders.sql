-- ============================================================
-- MASON OS — Migration 031: founder-created sub-folders in the document vault
--
-- The eight top-level folders (contracts, drawings, permits, invoices,
-- purchase_orders, qc_certificates, photos, other) stay exactly as they are —
-- they're referenced by DOC_FOLDERS in TypeScript, by the PO auto-filing in
-- 014, and by every existing row. This adds ONE optional level underneath, so
-- "Permits → BBMP" and "Contracts → Subcontractors" become possible without
-- touching what's there.
--
-- ---------- WHY A TABLE AND NOT JUST A TEXT COLUMN ----------
-- A `subfolder text` column would mean a folder only exists while a file is in
-- it: create it, upload nothing, refresh, it's gone. The founder is creating
-- these deliberately, ahead of the files, so they need somewhere to live.
--
-- ---------- WHAT HAPPENS WHEN A SUB-FOLDER IS DELETED ----------
-- `on delete set null` — the files move back to the parent folder's root.
-- A container disappearing must never take documents with it, and a cascade
-- here would do exactly that.
--
-- ---------- SCOPE ----------
-- Founder creates and removes them; everyone who can read the vault can see
-- them, and anyone who can upload can file into one. Sub-folders hold no
-- figures and no access rules of their own — confidentiality still lives on
-- the document row, where docs_read enforces it.
--
-- Re-runnable: create-table-if-not-exists, add-column-if-not-exists,
-- drop-policy before create, create-or-replace on the function.
-- ============================================================


-- ############################################################
-- ###  1. TABLE
-- ############################################################

create table if not exists public.doc_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  -- The parent folder, one of the eight fixed values. Text rather than an enum
  -- because `documents.folder` is text today and the two must agree.
  folder text not null,
  name text not null,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);

-- Case-insensitive: "BBMP" and "bbmp" in the same folder is a filing mistake,
-- not two folders.
create unique index if not exists doc_subfolder_uk
  on public.doc_subfolders (project_id, folder, lower(btrim(name)));

create index if not exists doc_subfolder_folder_idx
  on public.doc_subfolders (project_id, folder);

alter table public.doc_subfolders drop constraint if exists doc_subfolder_name_ck;
alter table public.doc_subfolders add constraint doc_subfolder_name_ck
  check (coalesce(btrim(name), '') <> '');


-- ############################################################
-- ###  2. LINK FROM DOCUMENTS
-- ############################################################
-- Nullable: null means the file sits at the top level of its folder, which is
-- where every existing row stays. No backfill, no default.
alter table public.documents
  add column if not exists subfolder_id uuid
  references public.doc_subfolders(id) on delete set null;

create index if not exists documents_subfolder_idx
  on public.documents (subfolder_id);


-- ############################################################
-- ###  3. RLS
-- ############################################################
alter table public.doc_subfolders enable row level security;

-- Everyone who can reach the vault sees the folder structure. The files inside
-- are still filtered by docs_read, so a supervisor sees a folder that may hold
-- confidential documents but not the documents themselves — same as today with
-- the eight fixed folders.
drop policy if exists subfolder_read on public.doc_subfolders;
create policy subfolder_read on public.doc_subfolders for select to authenticated
  using (public.is_member(project_id));

drop policy if exists subfolder_insert on public.doc_subfolders;
create policy subfolder_insert on public.doc_subfolders for insert to authenticated
  with check (public.is_member(project_id) and public.is_founder());

drop policy if exists subfolder_update on public.doc_subfolders;
create policy subfolder_update on public.doc_subfolders for update to authenticated
  using (public.is_member(project_id) and public.is_founder())
  with check (public.is_member(project_id) and public.is_founder());

-- No DELETE policy — removal goes through fn_delete_record like everything else.


-- ############################################################
-- ###  4. AUDIT
-- ############################################################
drop trigger if exists audit_doc_subfolders on public.doc_subfolders;
create trigger audit_doc_subfolders
  after insert or update or delete on public.doc_subfolders
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  5. HARD DELETE — add a doc_subfolders branch
-- ############################################################
-- Identical to 030 plus one branch. Founder only, and it never refuses on
-- account of the files inside: the FK is ON DELETE SET NULL, so they return to
-- the parent folder rather than disappearing with the container.
create or replace function public.fn_delete_record(
  p_table text,
  p_id    uuid
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_role text; v_project uuid; v_status text; v_n int; v_name text;
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  v_role := public.my_role();
  if v_role not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot delete records.' using errcode = '42501';
  end if;

  if p_table in ('tasks', 'site_logs', 'safety_checklists', 'incidents',
                 'documents', 'purchase_orders', 'materials', 'vendors', 'snags',
                 'drawings', 'drawing_revisions')
     and v_role not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may delete this record.'
      using errcode = '42501';
  end if;

  if p_table = 'tasks' then
    select project_id into v_project from public.tasks where id = p_id;
    if v_project is null then raise exception 'That task no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    select count(*) into v_n from public.tasks where rolled_from = p_id;
    if v_n > 0 then
      raise exception
        'This task was rolled over to a later day (% follow-on task(s)). Delete those first.', v_n; end if;
    delete from public.tasks where id = p_id;

  elsif p_table = 'site_logs' then
    select project_id into v_project from public.site_logs where id = p_id;
    if v_project is null then raise exception 'That site log no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    delete from public.site_logs where id = p_id;

  elsif p_table = 'safety_checklists' then
    select project_id into v_project from public.safety_checklists where id = p_id;
    if v_project is null then raise exception 'That checklist no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    delete from public.safety_checklists where id = p_id;

  elsif p_table = 'incidents' then
    select project_id into v_project from public.incidents where id = p_id;
    if v_project is null then raise exception 'That incident no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    delete from public.incidents where id = p_id;

  elsif p_table = 'snags' then
    select project_id, status::text into v_project, v_status
    from public.snags where id = p_id;
    if v_project is null then raise exception 'That snag no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status = 'verified' then
      raise exception
        'That snag was verified — it is the record that a defect was fixed and signed off. Reopen it if the defect has come back.';
    end if;
    delete from public.snags where id = p_id;

  elsif p_table = 'compliance_items' then
    select project_id, status::text into v_project, v_status
    from public.compliance_items where id = p_id;
    if not found then raise exception 'That compliance item no longer exists.'; end if;
    if v_project is not null and not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status = 'filed' then
      raise exception
        'That item is filed and holds the proof of a statutory filing. Reopen it first if the filing was recorded in error.';
    end if;
    delete from public.compliance_items where id = p_id;

  elsif p_table = 'drawing_revisions' then
    select project_id, status::text into v_project, v_status
    from public.drawing_revisions where id = p_id;
    if v_project is null then raise exception 'That revision no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status <> 'wip' and v_role <> 'founder' then
      raise exception
        'That revision was issued for construction. Only the founder can remove it — supersede it with a newer revision instead.';
    end if;
    delete from public.drawing_revisions where id = p_id;

  elsif p_table = 'drawings' then
    select project_id into v_project from public.drawings where id = p_id;
    if v_project is null then raise exception 'That drawing no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    select count(*) into v_n from public.drawing_revisions where drawing_id = p_id;
    if v_n > 0 and v_role <> 'founder' then
      raise exception
        'This drawing has % revision(s) on the register. Only the founder can delete a drawing that has been issued.',
        v_n;
    end if;
    delete from public.drawings where id = p_id;

  -- --------------------------------------------------- DOC SUB-FOLDER
  elsif p_table = 'doc_subfolders' then
    select project_id, name into v_project, v_name
    from public.doc_subfolders where id = p_id;
    if v_project is null then raise exception 'That sub-folder no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role <> 'founder' then
      raise exception 'Only the founder may remove a sub-folder.'
        using errcode = '42501';
    end if;
    -- Files are NOT blocked and NOT deleted: subfolder_id is ON DELETE SET
    -- NULL, so they reappear at the top level of the parent folder.
    delete from public.doc_subfolders where id = p_id;

  elsif p_table = 'documents' then
    select project_id into v_project from public.documents where id = p_id;
    if v_project is null then raise exception 'That document no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    delete from public.documents where id = p_id;

  elsif p_table = 'purchase_orders' then
    select project_id, status::text into v_project, v_status
    from public.purchase_orders where id = p_id;
    if v_project is null then raise exception 'That request no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_status <> 'requested' then
      raise exception
        'Only a draft request can be deleted. This one is % — cancel it instead, so it keeps its number and stays on record.',
        v_status; end if;
    select count(*) into v_n from public.goods_receipts where po_id = p_id;
    if v_n > 0 then
      raise exception 'This request already has goods receipts against it. Void those first.'; end if;
    select count(*) into v_n from public.po_invoices where po_id = p_id;
    if v_n > 0 then
      raise exception 'This request already has invoices against it. Void those first.'; end if;
    delete from public.purchase_orders where id = p_id;

  elsif p_table = 'materials' then
    select name into v_name from public.materials where id = p_id;
    if v_name is null then raise exception 'That material no longer exists.'; end if;
    select (select count(*) from public.material_inward where material_id = p_id)
         + (select count(*) from public.material_issues where material_id = p_id)
         + (select count(*) from public.po_lines       where material_id = p_id)
      into v_n;
    if v_n > 0 then
      raise exception
        '% is used by % record(s) — deliveries, issues or order lines. Deactivate it instead so it stops appearing in pickers.',
        v_name, v_n; end if;
    delete from public.materials where id = p_id;

  elsif p_table = 'vendors' then
    select name into v_name from public.vendors where id = p_id;
    if v_name is null then raise exception 'That vendor no longer exists.'; end if;
    select (select count(*) from public.expenses        where vendor_id = p_id)
         + (select count(*) from public.material_inward where vendor_id = p_id)
         + (select count(*) from public.purchase_orders where vendor_id = p_id)
      into v_n;
    if v_n > 0 then
      raise exception
        '% is linked to % record(s) — expenses, deliveries or orders. Deactivate it instead so it stops appearing in pickers.',
        v_name, v_n; end if;
    delete from public.vendors where id = p_id;

  elsif p_table = 'budgets' then
    select project_id into v_project from public.budgets where id = p_id;
    if v_project is null then raise exception 'That budget line no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    if v_role not in ('founder', 'accounts') then
      raise exception 'Only a founder or accounts may remove a budget line.'
        using errcode = '42501'; end if;
    delete from public.budgets where id = p_id;

  elsif p_table in ('expenses', 'petty_cash_entries', 'material_inward',
                    'material_issues', 'goods_receipts', 'po_invoices') then
    raise exception
      'A % carries money or stock and is never deleted — void it instead. The row stays on record, marked VOID, and stops counting.',
      p_table;

  elsif p_table in ('variation_orders', 'site_instructions', 'rfis', 'invoices') then
    raise exception
      'A % is a workflow document and is never deleted — cancel it instead, with a reason.',
      p_table;

  elsif p_table = 'projects' then
    raise exception
      'Projects are never deleted — every record hangs off them. Set the project to Completed or On hold on the Manage screen instead.';

  elsif p_table = 'profiles' then
    raise exception
      'People are never deleted — their name is on the records they raised. Deactivate them on the Manage screen instead.';

  else
    raise exception 'fn_delete_record: % is not a deletable table', p_table;
  end if;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values (p_table, 'DELETE_HARD', p_id::text,
          jsonb_build_object('deleted_by', v_me, 'deleted_at', now()), null);
end $$;

revoke all on function public.fn_delete_record(text, uuid) from public, anon;
grant execute on function public.fn_delete_record(text, uuid) to authenticated;


-- ############################################################
-- ###  6. VERIFY
-- ############################################################
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'doc_subfolders'
order by ordinal_position;

-- Expect one row: documents.subfolder_id.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'documents'
  and column_name = 'subfolder_id';

-- Expect the case-insensitive uniqueness guard. Last statement in the file.
select indexname from pg_indexes
where schemaname = 'public' and indexname = 'doc_subfolder_uk';
