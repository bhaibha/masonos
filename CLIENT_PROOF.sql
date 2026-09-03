-- ============================================================
-- CLIENT PROOF — SQL version, run in the Supabase SQL editor.
--
-- This impersonates the client INSIDE POSTGRES, which is stricter than signing
-- in: it bypasses the app, the router, the guards and the screens entirely, so
-- what is left is only what the database itself will hand over.
--
-- HOW TO USE
--   1. Run §0 once and note the two uuids it prints.
--   2. Paste them into the two \set lines in §1.
--   3. Run §1, then run each section below it.
--
-- Every section states what a PASS looks like. Read those, not just the output:
-- an empty result is a pass in Part 2 and a WARNING in Part 1.
-- ============================================================


-- ############################################################
-- §0 · get the two ids (run as postgres, no impersonation yet)
-- ############################################################
select
  (select cp.user_id
     from public.client_projects cp
     join auth.users u on u.id = cp.user_id
    where u.email = 'testclient@yourmasons.test')          as client_user_id,
  (select cp.project_id
     from public.client_projects cp
     join auth.users u on u.id = cp.user_id
    where u.email = 'testclient@yourmasons.test')          as their_project_id;

-- And a project they must NOT see. Any id from here that is not the one above.
select id, name, status from public.projects order by name;


-- ############################################################
-- §1 · become the client — EVERYTHING below runs as they would
-- ############################################################
-- Paste the three uuids from §0.
\set client_id    '00000000-0000-0000-0000-000000000000'
\set their_proj   '00000000-0000-0000-0000-000000000000'
\set other_proj   '00000000-0000-0000-0000-000000000000'

begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":":client_id","role":"authenticated"}';

-- If the line above does not take effect, your Postgres reads a different GUC.
-- Check with: select auth.uid();  -- must return :client_id, not null.
-- If it returns null, use client-proof.js in the browser instead — that runs
-- through a real session and cannot be got wrong.

select auth.uid()               as acting_as,      -- expect :client_id
       public.my_role()::text   as role,           -- expect client
       public.is_client()       as is_client,      -- expect t
       public.is_internal()     as is_internal,    -- expect f
       public.fn_client_project() as my_project;   -- expect :their_proj


-- ############################################################
-- PART 1 · what the client SHOULD see
-- ############################################################
-- PASS = these return ROWS. If they are all empty you have proved nothing:
-- an empty database and a working gate look identical. Share a document and
-- publish a photo as the founder first, then re-run.

select 'v_client_project'          as surface, count(*) from public.v_client_project
union all select 'v_client_progress',          count(*) from public.v_client_progress
union all select 'v_client_progress_summary',  count(*) from public.v_client_progress_summary
union all select 'v_client_spend_by_category', count(*) from public.v_client_spend_by_category
union all select 'v_client_spend_summary',     count(*) from public.v_client_spend_summary
union all select 'v_client_documents',         count(*) from public.v_client_documents
union all select 'v_client_photos',            count(*) from public.v_client_photos
union all select 'v_client_invoices',          count(*) from public.v_client_invoices
union all select 'v_client_approvals',         count(*) from public.v_client_approvals
union all select 'v_client_messages',          count(*) from public.v_client_messages
order by 1;

-- Every row must belong to THEIR project. Expect ZERO rows from this query —
-- it looks for strays.
select 'progress'   as v, count(*) from public.v_client_progress   where project_id <> :'their_proj'
union all select 'documents',  count(*) from public.v_client_documents  where project_id <> :'their_proj'
union all select 'photos',     count(*) from public.v_client_photos     where project_id <> :'their_proj'
union all select 'invoices',   count(*) from public.v_client_invoices   where project_id <> :'their_proj'
union all select 'approvals',  count(*) from public.v_client_approvals  where project_id <> :'their_proj';
-- PASS = every count is 0.

-- Eyeball the actual content once — numbers alone hide a wrong column.
select * from public.v_client_project;
select * from public.v_client_spend_summary;    -- contract + spent, NO fee, NO margin
select * from public.v_client_spend_by_category;
select invoice_number, invoice_date, total, is_paid from public.v_client_invoices;


-- ############################################################
-- PART 2 · the nine categories that must be refused
-- ############################################################
-- PASS = 0 for every row, or a permission error. Both are correct answers.

-- ---- 1. Management fee ----
select 'projects raw'          as surface, count(*) from public.projects
union all select 'v_project_commercials', count(*) from public.v_project_commercials
union all select 'v_project_contract',    count(*) from public.v_project_contract;

-- These two must ERROR with "permission denied for column" (010 revoked them):
select management_fee_pct    from public.projects;
select management_fee_amount from public.projects;

-- The curated view must not carry the columns at all. Expect ZERO rows:
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'v_client_project'
  and column_name in ('management_fee_pct','management_fee_amount','contract_value');

-- No management_fee or vendor_voucher bill may reach them. Expect ZERO rows:
select i.invoice_number, i.inv_type::text
from public.invoices i
where i.id in (select id from public.v_client_invoices)
  and i.inv_type::text <> 'progress';

-- ---- 2. Project margin / P&L ----
select 'v_project_pnl'     as surface, count(*) from public.v_project_pnl
union all select 'v_pnl_by_category', count(*) from public.v_pnl_by_category
union all select 'fn_company_pnl',    count(*) from public.fn_company_pnl()
union all select 'fn_project_evm',    count(*) from public.fn_project_evm(:'their_proj');

-- ---- 3. Company overheads ----
select 'company_expenses'   as surface, count(*) from public.company_expenses
union all select 'overhead_categories', count(*) from public.overhead_categories
union all select 'fn_overhead_summary', count(*) from public.fn_overhead_summary('2000-01-01','2099-12-31')
union all select 'fn_company_net',      count(*) from public.fn_company_net('2000-01-01','2099-12-31');

-- ---- 4. Vendor rates ----
select 'vendors'          as surface, count(*) from public.vendors
union all select 'labour_rates',    count(*) from public.labour_rates
union all select 'rate_comparisons', count(*) from public.rate_comparisons
union all select 'rc_quotes',       count(*) from public.rc_quotes
union all select 'v_rc_matrix',     count(*) from public.v_rc_matrix
union all select 'v_material_inward_rates', count(*) from public.v_material_inward_rates;

-- ---- 5. PO / GRN rates ----
select 'purchase_orders'  as surface, count(*) from public.purchase_orders
union all select 'po_lines',        count(*) from public.po_lines
union all select 'goods_receipts',  count(*) from public.goods_receipts
union all select 'grn_lines',       count(*) from public.grn_lines
union all select 'v_po_lines_rated', count(*) from public.v_po_lines_rated
union all select 'v_po_value',      count(*) from public.v_po_value
union all select 'v_po_match',      count(*) from public.v_po_match;

-- ---- 6. Other projects ----
-- project_members is the one that matters most: it maps every project in the
-- company and would hand this client the project ids of your other clients.
select 'projects raw'   as surface, count(*) from public.projects
union all select 'project_members', count(*) from public.project_members
union all select 'v_portfolio_summary', count(*) from public.v_portfolio_summary;

-- ---- 7. Other clients ----
-- client_projects is the ONE table where 1 row is correct — their own link.
select count(*) as client_project_rows,
       bool_and(user_id = :'client_id') as all_mine   -- expect 1 and t
from public.client_projects;

select 'v_client_roster' as surface, count(*) from public.v_client_roster
union all select 'fn_client_roster_summary', count(*) from public.fn_client_roster_summary()
union all select 'client_approvals raw',     count(*) from public.client_approvals
union all select 'profiles',                 count(*) from public.profiles;
-- profiles must be 1 (their own). Everything else 0.

-- ---- 8. Budgets, raw ----
select 'budgets'         as surface, count(*) from public.budgets
union all select 'expenses',        count(*) from public.expenses
union all select 'v_budget_vs_actual', count(*) from public.v_budget_vs_actual
union all select 'v_project_spend',  count(*) from public.v_project_spend
union all select 'schedule_activities', count(*) from public.schedule_activities
union all select 'fn_expense_total', count(*) from public.fn_expense_total(:'their_proj');

-- ---- 9. MIS ----
select 'v_mis_projects'  as surface, count(*) from public.v_mis_projects
union all select 'fn_mis_company',  count(*) from public.fn_mis_company()
union all select 'fn_mis_trend',    count(*) from public.fn_mis_trend()
union all select 'fn_mis_by_category', count(*) from public.fn_mis_by_category()
union all select 'fn_mis_exceptions',  count(*) from public.fn_mis_exceptions();


-- ############################################################
-- PART 3 · cross-project isolation
-- ############################################################
-- The curated views scope off fn_client_project(), so asking them for another
-- project must return nothing. This is what proves the scoping lives in the
-- database rather than in the screen. PASS = every count 0.

select 'progress @ other'   as surface, count(*) from public.v_client_progress   where project_id = :'other_proj'
union all select 'documents @ other', count(*) from public.v_client_documents  where project_id = :'other_proj'
union all select 'photos @ other',    count(*) from public.v_client_photos     where project_id = :'other_proj'
union all select 'invoices @ other',  count(*) from public.v_client_invoices   where project_id = :'other_proj'
union all select 'approvals @ other', count(*) from public.v_client_approvals  where project_id = :'other_proj'
union all select 'fn_project_evm @ other',  count(*) from public.fn_project_evm(:'other_proj')
union all select 'fn_expense_total @ other', count(*) from public.fn_expense_total(:'other_proj')
union all select 'fn_qa_summary @ other',    count(*) from public.fn_qa_summary(:'other_proj')
union all select 'fn_safety_summary @ other', count(*) from public.fn_safety_summary(:'other_proj');


-- ############################################################
-- PART 4 · defence in depth — the one that matters in three years
-- ############################################################
-- A client wrongly added to project_members must change NOTHING. is_member()
-- returns false for a client before it consults that table at all (065).

rollback;   -- end the impersonated transaction first

-- As postgres, deliberately make the mistake:
insert into public.project_members (project_id, user_id)
select cp.project_id, cp.user_id
from public.client_projects cp
join auth.users u on u.id = cp.user_id
where u.email = 'testclient@yourmasons.test'
on conflict do nothing;

-- Become the client again and re-check the worst of it:
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":":client_id","role":"authenticated"}';

select public.is_member(:'their_proj') as is_member;   -- MUST be false
select 'expenses' as t, count(*) from public.expenses
union all select 'budgets',         count(*) from public.budgets
union all select 'purchase_orders', count(*) from public.purchase_orders
union all select 'tasks',           count(*) from public.tasks
union all select 'documents',       count(*) from public.documents
union all select 'v_project_pnl',   count(*) from public.v_project_pnl;
-- ALL must still be 0.
rollback;

-- Undo the deliberate mistake:
delete from public.project_members pm
using public.client_projects cp, auth.users u
where pm.project_id = cp.project_id
  and pm.user_id   = cp.user_id
  and u.id = cp.user_id
  and u.email = 'testclient@yourmasons.test';

-- Confirm clean:
select count(*) as bad_rows
from public.project_members pm
join public.client_projects cp
  on cp.project_id = pm.project_id and cp.user_id = pm.user_id;   -- expect 0
