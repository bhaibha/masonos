-- ============================================================
-- MASON OS — Migration 030: founder-level delete on the drawing register
--
-- 029 refused to delete any drawing that had revisions, and any revision that
-- had ever been issued. The reasoning was sound — a register is a record of
-- what site was told to build — but it made a mistyped drawing number
-- permanent, which is worse. A four-project internal tool needs an eraser.
--
-- The split, matching how the rest of the app treats removal:
--   • FOUNDER  — may delete a drawing outright (its revisions cascade with it),
--                and may delete any single revision whatever its status.
--   • PM       — unchanged from 029: only a drawing with no revisions, and only
--                a revision still in WIP. They maintain the register; they
--                don't get to erase what was issued.
--
-- Every delete still lands in audit_log with the actor, so "who removed
-- SD-101" is answerable after the fact. That is what makes relaxing this safe:
-- the record moves from the table to the log, it doesn't vanish.
--
-- KNOWN GAP (already parked in ROADMAP): the sheet itself stays in the
-- `drawings` storage bucket. Orphaned-object cleanup is a separate job, and
-- deleting rows while leaving files is the same behaviour every other module
-- has today.
--
-- Re-runnable: single create-or-replace on fn_delete_record.
-- ============================================================

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

  -- ------------------------------------ DRAWING REVISION (relaxed in 030)
  elsif p_table = 'drawing_revisions' then
    select project_id, status::text into v_project, v_status
    from public.drawing_revisions where id = p_id;
    if v_project is null then raise exception 'That revision no longer exists.'; end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501'; end if;
    -- A PM may only remove a sheet that never reached site.
    if v_status <> 'wip' and v_role <> 'founder' then
      raise exception
        'That revision was issued for construction. Only the founder can remove it — supersede it with a newer revision instead.';
    end if;
    delete from public.drawing_revisions where id = p_id;

  -- ------------------------------------------- DRAWING (relaxed in 030)
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
    -- drawing_revisions.drawing_id is ON DELETE CASCADE, so the revisions go
    -- with it. The audit rows for each stay.
    delete from public.drawings where id = p_id;

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


-- ---------- VERIFY ----------
-- Expect one row. The behaviour change is inside the body, so there is nothing
-- structural to check beyond the function still existing.
select proname, prosecdef
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'fn_delete_record';
