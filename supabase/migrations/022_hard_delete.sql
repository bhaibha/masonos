-- ============================================================
-- MASON OS — Migration 022: hard delete for records with no downstream effect
--
-- Completes the three-mechanism removal design:
--   1. hard delete   — no downstream effect            (THIS FILE)
--   2. void/reverse  — financial + stock rows          (migration 020, 021)
--   3. cancel/reject — workflow documents: PO, VO      (migration 021)
--
-- ---------- WHAT IS DELIBERATELY *NOT* DELETABLE ----------
-- expenses · petty_cash_entries · material_inward · material_issues ·
-- goods_receipts · po_invoices · approved purchase_orders · variation_orders
--
-- These carry money or stock. Deleting one destroys the audit trail on a
-- figure someone will later have to explain, and GST invoices carry a statutory
-- retention requirement. They are VOIDED or CANCELLED instead — the row stays,
-- marked, and stops counting. The founder already has that power on all of them.
--
-- ---------- WHAT IS DELETABLE (founder/pm, reference-checked) ----------
--   tasks               — blocked if another task was rolled over from it
--   site_logs           — nothing references them
--   safety_checklists   — items cascade
--   incidents           — nothing references them
--   documents           — storage object removed by the caller afterwards
--   purchase_orders     — ONLY while status = 'requested' (a draft PR).
--                         Anything approved has a PO number in a vendor's hands,
--                         so it gets cancelled, not deleted.
--   materials           — blocked if any movement or PO line uses it
--   vendors             — blocked if any expense, delivery or PO references it
--   budgets             — figures, but no history: they're a plan, not a record
--
-- ---------- NOT DELETABLE, BY DECISION ----------
-- PROJECTS: every table cascades on project_id, so one click would destroy a
-- whole job's history. Archive instead (status → completed / on_hold), which
-- the Admin → Projects screen already does.
-- USERS: their name is stamped on expenses, tasks and approvals via
-- created_by / raised_by / approved_by. Deactivate instead (already built), so
-- history still says who did what.
--
-- ---------- HOW IT'S ENFORCED ----------
-- No DELETE policies are added. RLS is default-deny, so with no policy the
-- client simply cannot delete these tables — the ONLY route is
-- fn_delete_record(), which is SECURITY DEFINER and does the role check and the
-- reference checks itself. Same shape as fn_void_record / fn_cancel_document.
--
-- The one exception is `documents`, which has carried a docs_delete policy
-- since 003. It's left in place (a user removing their own upload is harmless)
-- and the RPC works alongside it.
--
-- Re-runnable: create-or-replace only.
-- ============================================================


-- ############################################################
-- ###  fn_delete_record — the only route to a hard delete
-- ############################################################
create or replace function public.fn_delete_record(
  p_table text,
  p_id    uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_project uuid;
  v_status  text;
  v_n       int;
  v_name    text;
  v_me      uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  v_role := public.my_role();

  -- Coarse gate. Each branch then applies its own rule, because they differ:
  -- site/procurement records are founder/pm, budgets are founder/accounts
  -- (matching budgets_write in 002).
  if v_role not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot delete records.' using errcode = '42501';
  end if;

  -- Site and procurement records: founder/pm. Listed explicitly rather than
  -- "everything except budgets", so the not-deletable branches below still
  -- reach an accounts user with their own, more useful message ("void it
  -- instead") rather than a role refusal.
  if p_table in ('tasks', 'site_logs', 'safety_checklists', 'incidents',
                 'documents', 'purchase_orders', 'materials', 'vendors')
     and v_role not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may delete this record.'
      using errcode = '42501';
  end if;

  -- ------------------------------------------------------------- TASK
  if p_table = 'tasks' then
    select project_id into v_project from public.tasks where id = p_id;
    if v_project is null then
      raise exception 'That task no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    -- The rollover chain is history: deleting a link would orphan the tail.
    select count(*) into v_n from public.tasks where rolled_from = p_id;
    if v_n > 0 then
      raise exception
        'This task was rolled over to a later day (% follow-on task(s)). Delete those first.', v_n;
    end if;

    delete from public.tasks where id = p_id;

  -- --------------------------------------------------------- SITE LOG
  elsif p_table = 'site_logs' then
    select project_id into v_project from public.site_logs where id = p_id;
    if v_project is null then
      raise exception 'That site log no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    delete from public.site_logs where id = p_id;

  -- ------------------------------------------------- SAFETY CHECKLIST
  elsif p_table = 'safety_checklists' then
    select project_id into v_project from public.safety_checklists where id = p_id;
    if v_project is null then
      raise exception 'That checklist no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    -- safety_checklist_items has ON DELETE CASCADE (011).
    delete from public.safety_checklists where id = p_id;

  -- ----------------------------------------------------------- INCIDENT
  elsif p_table = 'incidents' then
    select project_id into v_project from public.incidents where id = p_id;
    if v_project is null then
      raise exception 'That incident no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    delete from public.incidents where id = p_id;

  -- ----------------------------------------------------------- DOCUMENT
  elsif p_table = 'documents' then
    select project_id into v_project from public.documents where id = p_id;
    if v_project is null then
      raise exception 'That document no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    delete from public.documents where id = p_id;

  -- ------------------------------------------------- DRAFT PURCHASE REQUEST
  elsif p_table = 'purchase_orders' then
    select project_id, status::text into v_project, v_status
    from public.purchase_orders where id = p_id;

    if v_project is null then
      raise exception 'That request no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;

    -- Once approved it has a PO number a vendor may already hold. Cancel it.
    if v_status <> 'requested' then
      raise exception
        'Only a draft request can be deleted. This one is % — cancel it instead, so it keeps its number and stays on record.',
        v_status;
    end if;

    -- Belt and braces: a requested PO should have neither, but never assume.
    select count(*) into v_n from public.goods_receipts where po_id = p_id;
    if v_n > 0 then
      raise exception 'This request already has goods receipts against it. Void those first.';
    end if;
    select count(*) into v_n from public.po_invoices where po_id = p_id;
    if v_n > 0 then
      raise exception 'This request already has invoices against it. Void those first.';
    end if;

    -- po_lines has ON DELETE CASCADE (012).
    delete from public.purchase_orders where id = p_id;

  -- ----------------------------------------------------------- MATERIAL
  elsif p_table = 'materials' then
    select name into v_name from public.materials where id = p_id;
    if v_name is null then
      raise exception 'That material no longer exists.';
    end if;

    select (select count(*) from public.material_inward where material_id = p_id)
         + (select count(*) from public.material_issues where material_id = p_id)
         + (select count(*) from public.po_lines       where material_id = p_id)
      into v_n;

    if v_n > 0 then
      raise exception
        '% is used by % record(s) — deliveries, issues or order lines. Deactivate it instead so it stops appearing in pickers.',
        v_name, v_n;
    end if;

    delete from public.materials where id = p_id;

  -- ------------------------------------------------------------- VENDOR
  elsif p_table = 'vendors' then
    select name into v_name from public.vendors where id = p_id;
    if v_name is null then
      raise exception 'That vendor no longer exists.';
    end if;

    select (select count(*) from public.expenses         where vendor_id = p_id)
         + (select count(*) from public.material_inward  where vendor_id = p_id)
         + (select count(*) from public.purchase_orders  where vendor_id = p_id)
      into v_n;

    if v_n > 0 then
      raise exception
        '% is linked to % record(s) — expenses, deliveries or orders. Deactivate it instead so it stops appearing in pickers.',
        v_name, v_n;
    end if;

    delete from public.vendors where id = p_id;

  -- ------------------------------------------------------------- BUDGET
  elsif p_table = 'budgets' then
    select project_id into v_project from public.budgets where id = p_id;
    if v_project is null then
      raise exception 'That budget line no longer exists.';
    end if;
    if not public.is_member(v_project) then
      raise exception 'Not a member of that project.' using errcode = '42501';
    end if;
    -- budgets_write is founder/accounts (002); keep delete consistent with it.
    if v_role not in ('founder', 'accounts') then
      raise exception 'Only a founder or accounts may remove a budget line.'
        using errcode = '42501';
    end if;

    delete from public.budgets where id = p_id;

  -- --------------------------------------------- NOT DELETABLE, ON PURPOSE
  elsif p_table in ('expenses', 'petty_cash_entries', 'material_inward',
                    'material_issues', 'goods_receipts', 'po_invoices') then
    raise exception
      'A % carries money or stock and is never deleted — void it instead. The row stays on record, marked VOID, and stops counting.',
      p_table;

  elsif p_table = 'variation_orders' then
    raise exception
      'A variation order changes the contract value and is never deleted — cancel it instead.';

  elsif p_table = 'projects' then
    raise exception
      'Projects are never deleted — every record hangs off them. Set the project to Completed or On hold on the Manage screen instead.';

  elsif p_table = 'profiles' then
    raise exception
      'People are never deleted — their name is on the records they raised. Deactivate them on the Manage screen instead.';

  else
    raise exception 'fn_delete_record: % is not a deletable table', p_table;
  end if;

  -- The per-table fn_audit() DELETE triggers already captured old_data. This
  -- row makes deletions greppable as one action, alongside VOID and CANCEL.
  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values (p_table, 'DELETE_HARD', p_id::text,
          jsonb_build_object('deleted_by', v_me, 'deleted_at', now()), null);
end $$;

revoke all on function public.fn_delete_record(text, uuid) from public, anon;
grant execute on function public.fn_delete_record(text, uuid) to authenticated;

comment on function public.fn_delete_record(text, uuid) is
  'The only route to a hard delete. Founder/PM, reference-checked, refuses '
  'money/stock rows (void those) and workflow documents (cancel those). '
  'No DELETE policies exist on these tables, so this cannot be bypassed.';


-- ############################################################
-- ###  AUDIT COVERAGE FOR THE NEWLY DELETABLE TABLES
-- ############################################################
-- A delete must leave a trail. tasks, site_logs, documents, materials, vendors
-- and purchase_orders already carry fn_audit triggers (001, 003, 012, 018);
-- the safety tables did not have full coverage.
drop trigger if exists audit_incidents_all on public.incidents;
create trigger audit_incidents_all
  after insert or update or delete on public.incidents
  for each row execute function public.fn_audit();

drop trigger if exists audit_safety_checklists_all on public.safety_checklists;
create trigger audit_safety_checklists_all
  after insert or update or delete on public.safety_checklists
  for each row execute function public.fn_audit();

drop trigger if exists audit_budgets_all on public.budgets;
create trigger audit_budgets_all
  after insert or update or delete on public.budgets
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  VERIFY
-- ############################################################
-- Expect all four removal functions.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('fn_delete_record', 'fn_cancel_document',
                  'fn_void_record', 'fn_stock_on_hand')
order by proname;
