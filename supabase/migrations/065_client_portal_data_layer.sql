-- ============================================================
-- 065 — CLIENT ROLE + CURATED CLIENT DATA LAYER
--
-- A fifth role. A client signs in to the same app, is tied to exactly ONE
-- project, and can reach a small curated surface built for them — never the
-- internal one.
--
-- DATA LAYER ONLY. No UI this session.
--
-- ============================================================
-- THE THREE THINGS THAT WOULD HAVE LEAKED, AND WHY
-- ============================================================
--
-- ---------- 1. is_member() IS THE WHOLE BUILDING ----------
-- Roughly thirty tables are gated `using (is_member(project_id))`: tasks, site
-- logs, snags, RFIs, clashes, approvals, documents, material inward, purchase
-- orders, drawings, RA bills… If a client were ever added to `project_members`,
-- is_member() would return TRUE and they would inherit read access to ALL of it
-- in one step. Not a leak of one figure — a leak of the entire project.
--
-- So two defences, not one:
--   * the client link is a SEPARATE table (`client_projects`). A client is
--     never a project member.
--   * `is_member()` is re-emitted below to return FALSE for a client
--     UNCONDITIONALLY, before it looks at project_members at all. If somebody
--     adds a client row there by mistake in three years, nothing opens.
--
-- The second defence is the one that matters. The first is a convention; this
-- one is enforcement.
--
-- ---------- 2. `using (true)` MEANS "ANY AUTHENTICATED USER" ----------
-- Fourteen policies grant read to `authenticated` with no condition. A client
-- IS authenticated. Without the change below a client would have seen:
--   * `profiles`         — every staff member, name and role
--   * `project_members`  — who works on which project, across EVERY project,
--                          which also hands them the project ids of other
--                          clients to probe with
--   * `labour_contractors`, `labour_workers`, `labour_trades` — the firm's
--                          entire labour supply chain
--   * `materials`, `bbs_constants`, `bbs_shapes`, `expense_categories`
--   * `learn_categories`, `learn_articles` — the firm's own method statements
--
-- Every one of those is now `is_internal()`.
--
-- ---------- 3. THE MANAGEMENT FEE HIDES INSIDE INVOICES ----------
-- `invoice_type` has three values and one of them is `management_fee`. Showing
-- a client "their invoices" without filtering type would have told them the fee
-- in rupees. The client invoice view returns `inv_type = 'progress'` ONLY.
--
-- ============================================================
-- HOW THE CURATED LAYER IS BUILT, AND WHY NOT security_invoker
-- ============================================================
-- The client's own permissions on internal tables are (correctly) nothing. So a
-- `security_invoker` view over them would return nothing for a client — the
-- view has to run as its OWNER, with the client scoping in the WHERE clause.
--
-- That is the pattern this codebase already uses for `v_project_commercials`
-- and `v_project_pnl` (010, 038), and it carries the same warning:
--
--     THE WHERE CLAUSE IS THE ACCESS CONTROL.
--     Losing `where project_id = fn_client_project()` from any view below is a
--     silent, total leak of every project to every client.
--
-- Each view is therefore built the same way and says so, so a reviewer can
-- check one line per view rather than reason about it.
--
-- ============================================================
-- ONE THING THE FOUNDER MUST DECIDE — READ THIS
-- ============================================================
-- The brief asks for open-book spend AND spend-vs-contract-value, and also that
-- the client never sees margin. Those two cannot both be fully true:
--
--     margin ≈ contract value − total spent
--
-- and both numbers are on the client's own dashboard by design. A client with a
-- calculator can derive the firm's gross position on their job.
--
-- That is inherent to open book, not a bug in this migration — the client is
-- being shown cost precisely so they can see it. But it is a commercial choice
-- and it is being made HERE, so it is stated here rather than discovered later.
-- If it is not acceptable, the fix is to drop `contract_value` from
-- `v_client_project` and show spend against a client-facing BUDGET instead; the
-- view is one line to change. Nothing else in this file depends on it.
--
-- The MANAGEMENT FEE PERCENTAGE is never exposed either way.
--
-- Run AFTER 064.
-- ============================================================


-- ############################################################
-- ###  1. THE ROLE
-- ############################################################
-- `my_role()` returns the ENUM, so every comparison below is written
-- `::text = 'client'`. A newly added enum label cannot be used as a literal in
-- the same transaction, and the Supabase SQL editor runs this whole file as one
-- (the 021 lesson). `::text` sidesteps it entirely.
alter type user_role add value if not exists 'client';


-- ############################################################
-- ###  2. THE LINK — one client, one project
-- ############################################################
-- Deliberately NOT `project_members`. See the header: membership is the key to
-- thirty internal tables and a client must never hold it.
create table if not exists public.client_projects (
  -- Surrogate `id` even though `user_id` would be a perfectly good primary
  -- key. fn_audit() does coalesce(new.id::text, old.id::text), so attaching it
  -- to a table keyed by anything else raises "record new has no field id" — and
  -- because the trigger runs in the same transaction, THE WRITE IS ABORTED.
  -- Granting a client access would have failed with an error that names
  -- neither this table nor that function (the 051 lesson, caught in testing).
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Who let them in, and when. A client account is a commercial act.
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists client_projects_project_idx
  on public.client_projects (project_id);

-- `user_id` is UNIQUE, which is what enforces "exactly one project". A second
-- row for the same client is not possible, so no view below has to cope with a
-- client who belongs to two jobs.

alter table public.client_projects enable row level security;

drop policy if exists client_projects_read on public.client_projects;
create policy client_projects_read on public.client_projects
  for select to authenticated
  using (
    user_id = auth.uid()                       -- a client sees their own link
    or public.my_role()::text in ('founder', 'pm', 'accounts')
  );

-- Only a founder grants or revokes portal access.
drop policy if exists client_projects_write on public.client_projects;
create policy client_projects_write on public.client_projects
  for all to authenticated
  using (public.is_founder())
  with check (public.is_founder());

drop trigger if exists audit_client_projects on public.client_projects;
create trigger audit_client_projects
  after insert or update or delete on public.client_projects
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  3. HELPERS
-- ############################################################
create or replace function public.is_client()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role()::text = 'client', false)
$$;

-- Everyone who is NOT a client and IS signed in. Used to close the
-- `using (true)` policies without naming four roles in fourteen places.
create or replace function public.is_internal()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() is not null
     and public.my_role()::text <> 'client'
$$;

-- THE scoping function. Every curated view below filters on this and nothing
-- else. Returns NULL for anybody who is not a client, which makes every client
-- view return zero rows for internal staff too — they have the real screens.
create or replace function public.fn_client_project()
returns uuid
language sql stable security definer set search_path = public as $$
  select cp.project_id
  from public.client_projects cp
  where cp.user_id = auth.uid()
    and public.is_client()
$$;

revoke all on function public.is_client() from public, anon;
revoke all on function public.is_internal() from public, anon;
revoke all on function public.fn_client_project() from public, anon;
grant execute on function public.is_client() to authenticated;
grant execute on function public.is_internal() to authenticated;
grant execute on function public.fn_client_project() to authenticated;


-- ############################################################
-- ###  4. HARDEN is_member() — the single most important statement here
-- ############################################################
-- A client can never be a member, whatever `project_members` says. The check
-- is FIRST so it short-circuits before the table is consulted.
create or replace function public.is_member(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.is_client() then false
    else public.is_founder()
      or public.my_role()::text = 'accounts'
      or exists (select 1 from public.project_members
                 where project_id = p_project and user_id = auth.uid())
  end
$$;


-- ############################################################
-- ###  5. CLOSE THE `using (true)` POLICIES
-- ############################################################
-- Each of these previously said "any signed-in user". A client is signed in.

-- A client may still read their OWN profile row (their name, for the portal
-- header). Staff rows are internal.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated
  using (public.is_internal() or id = auth.uid());

-- Membership across every project is a map of the whole company, and it hands
-- out other clients' project ids.
drop policy if exists members_read on public.project_members;
create policy members_read on public.project_members
  for select to authenticated using (public.is_internal());

drop policy if exists cat_read on public.expense_categories;
create policy cat_read on public.expense_categories
  for select to authenticated using (public.is_internal());

drop policy if exists mat_read on public.materials;
create policy mat_read on public.materials
  for select to authenticated using (public.is_internal());

-- Labour: the firm's supply chain. Guarded on existence so this file still runs
-- on a database where 054 has not been applied.
do $$
begin
  if to_regclass('public.labour_trades') is not null then
    execute 'drop policy if exists lab_trade_read on public.labour_trades';
    execute 'create policy lab_trade_read on public.labour_trades
             for select to authenticated using (public.is_internal())';
  end if;
  if to_regclass('public.labour_contractors') is not null then
    execute 'drop policy if exists lab_contractor_read on public.labour_contractors';
    execute 'create policy lab_contractor_read on public.labour_contractors
             for select to authenticated using (public.is_internal())';
  end if;
  if to_regclass('public.labour_workers') is not null then
    execute 'drop policy if exists lab_worker_read on public.labour_workers';
    execute 'create policy lab_worker_read on public.labour_workers
             for select to authenticated using (public.is_internal())';
  end if;

  -- BBS reference data (051).
  if to_regclass('public.bbs_constants') is not null then
    execute 'drop policy if exists bbs_const_read on public.bbs_constants';
    execute 'create policy bbs_const_read on public.bbs_constants
             for select to authenticated using (public.is_internal())';
  end if;
  if to_regclass('public.bbs_shapes') is not null then
    execute 'drop policy if exists bbs_shape_read on public.bbs_shapes';
    execute 'create policy bbs_shape_read on public.bbs_shapes
             for select to authenticated using (public.is_internal())';
  end if;

  -- Mason Learn is the firm's own IP (057).
  if to_regclass('public.learn_categories') is not null then
    execute 'drop policy if exists learn_cat_read on public.learn_categories';
    execute 'create policy learn_cat_read on public.learn_categories
             for select to authenticated using (public.is_internal())';
  end if;
  if to_regclass('public.learn_articles') is not null then
    execute 'drop policy if exists learn_article_read on public.learn_articles';
    execute $p$create policy learn_article_read on public.learn_articles
             for select to authenticated
             using (public.is_internal()
                    and (status::text = 'published'
                         or public.my_role()::text in ('founder','pm')))$p$;
  end if;
end $$;


-- ############################################################
-- ###  6. EXPLICIT OPT-IN: what the team chooses to share
-- ############################################################
-- Nothing is client-visible by default. Both flags below default FALSE, and
-- there is no bulk "share everything" anywhere in this file.
alter table public.documents
  add column if not exists client_visible boolean not null default false;

create index if not exists documents_client_visible_idx
  on public.documents (project_id) where client_visible;

-- Photos live inside `site_logs.photos` as a text[], so a per-photo flag cannot
-- be added to a column. Rather than bolt a parallel array onto site_logs — two
-- arrays that must stay index-aligned is a bug waiting to happen — publishing a
-- photo to the client is its OWN ROW. It is an act, and it has an author.
create table if not exists public.client_photos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  -- Storage path in the site-photos bucket.
  photo_path text not null,
  caption text,
  taken_on date,

  published_by uuid not null default auth.uid() references public.profiles(id),
  published_at timestamptz not null default now(),

  -- One publish per photo. A double tap must not show the client the same
  -- picture twice.
  constraint client_photos_uk unique (photo_path)
);

create index if not exists client_photos_project_idx
  on public.client_photos (project_id, published_at desc);

alter table public.client_photos enable row level security;

drop policy if exists client_photos_read on public.client_photos;
create policy client_photos_read on public.client_photos
  for select to authenticated
  using (
    public.is_member(project_id)                       -- internal
    or project_id = public.fn_client_project()          -- the client themselves
  );

drop policy if exists client_photos_write on public.client_photos;
create policy client_photos_write on public.client_photos
  for all to authenticated
  using (public.is_member(project_id)
         and public.my_role()::text in ('founder', 'pm'))
  with check (public.is_member(project_id)
              and public.my_role()::text in ('founder', 'pm'));

drop trigger if exists audit_client_photos on public.client_photos;
create trigger audit_client_photos
  after insert or update or delete on public.client_photos
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  7. PAYMENT STATUS — it did not exist, so it is added
-- ############################################################
-- The brief asks to show the client which of their invoices are paid.
-- `invoice_status` is only ('issued','cancelled'); there is no payment tracking
-- anywhere in this database. Rather than derive a fiction, two columns are
-- added and accounts records the fact.
--
-- Deliberately NOT a payments ledger with allocations and part-payments — that
-- is a real module and this is not the session for it. This records what the
-- client needs: was it paid, when, how much.
alter table public.invoices
  add column if not exists paid_on date;
alter table public.invoices
  add column if not exists paid_amount numeric(14,2);

drop function if exists public.fn_record_invoice_payment(uuid, date, numeric);
create function public.fn_record_invoice_payment(
  p_invoice uuid,
  p_on      date,
  p_amount  numeric
)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_project uuid; v_total numeric;
begin
  if public.my_role()::text not in ('founder', 'accounts') then
    raise exception 'Only a founder or accounts records a payment.'
      using errcode = '42501';
  end if;

  select project_id, total into v_project, v_total
  from public.invoices where id = p_invoice;
  if v_project is null then
    raise exception 'That invoice no longer exists.';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'A payment needs an amount.';
  end if;
  if p_amount > v_total then
    raise exception
      'That is more than the invoice total. Record what was actually received.';
  end if;

  update public.invoices
  set paid_on = coalesce(p_on, (now() at time zone 'Asia/Kolkata')::date),
      paid_amount = p_amount
  where id = p_invoice;
end $$;

revoke all on function public.fn_record_invoice_payment(uuid, date, numeric)
  from public, anon;
grant execute on function public.fn_record_invoice_payment(uuid, date, numeric)
  to authenticated;


-- ############################################################
-- ###  8. THE MESSAGE THREAD
-- ############################################################
create table if not exists public.client_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  body text not null,
  -- Set at insert by the trigger below, never trusted from the client.
  from_client boolean not null default false,

  author_id uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  read_at timestamptz,

  constraint client_message_body check (btrim(body) <> '')
);

create index if not exists client_messages_idx
  on public.client_messages (project_id, created_at desc);

-- `from_client` decides which side of the thread a message renders on, so a
-- client must not be able to set it and impersonate the team.
create or replace function public.fn_client_message_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.from_client := public.is_client();
  new.author_id := auth.uid();
  return new;
end $$;

drop trigger if exists client_message_stamp on public.client_messages;
create trigger client_message_stamp
  before insert on public.client_messages
  for each row execute function public.fn_client_message_stamp();

alter table public.client_messages enable row level security;

drop policy if exists client_messages_read on public.client_messages;
create policy client_messages_read on public.client_messages
  for select to authenticated
  using (
    public.is_member(project_id)
    or project_id = public.fn_client_project()
  );

drop policy if exists client_messages_write on public.client_messages;
create policy client_messages_write on public.client_messages
  for insert to authenticated
  with check (
    (public.is_member(project_id)
     and public.my_role()::text in ('founder', 'pm'))
    or project_id = public.fn_client_project()
  );

-- No UPDATE and no DELETE policy: a sent message stays sent. A thread somebody
-- can edit after the fact is not a record of a conversation.

drop trigger if exists audit_client_messages on public.client_messages;
create trigger audit_client_messages
  after insert or update or delete on public.client_messages
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  9. THE CURATED VIEWS
-- ############################################################
-- EVERY view below is owner-run (NOT security_invoker) and scoped by
--     where <project> = public.fn_client_project()
-- That WHERE clause IS the access control. Deleting it from any one of these
-- leaks every project to every client. It is the first thing to check when
-- editing this section.
--
-- fn_client_project() returns NULL for internal staff, so these views are also
-- empty for founders and PMs — who have the real screens.

-- ---------- the project itself ----------
-- contract_value IS included: it is the client's own contract and they signed
-- it. management_fee_pct is NOT, and never appears in this file.
drop view if exists public.v_client_project cascade;
create view public.v_client_project as
select
  p.id                  as project_id,
  p.name,
  p.client_name,
  p.site_address,
  p.status,
  p.start_date,
  p.target_end_date,
  coalesce(p.contract_value, 0)::numeric(14,2) as contract_value
from public.projects p
where p.id = public.fn_client_project();

grant select on public.v_client_project to authenticated;


-- ---------- progress ----------
-- Activity name, dates and percent complete. NO budget_amount, NO earned value,
-- no CPI/SPI, no cost variance. A client seeing CPI would be reading the firm's
-- cost performance on their own job.
drop view if exists public.v_client_progress cascade;
create view public.v_client_progress as
select
  a.id            as activity_id,
  a.project_id,
  a.code,
  a.name,
  a.phase,
  a.planned_start,
  a.planned_end,
  a.actual_start,
  a.actual_end,
  a.pct_complete,
  a.sort_order
from public.schedule_activities a
where a.project_id = public.fn_client_project()
order by a.sort_order, a.planned_start;

grant select on public.v_client_progress to authenticated;


-- ---------- the headline: one row, budget-weighted ----------
-- Weighted by activity budget internally (a plain average calls a job half done
-- when the expensive half has not started — the 063 lesson), but the WEIGHTS
-- ARE NOT EXPOSED. Only the resulting percentage leaves this view.
drop view if exists public.v_client_progress_summary cascade;
create view public.v_client_progress_summary as
select
  a.project_id,
  count(*)::int                                   as activity_count,
  count(*) filter (where a.pct_complete >= 100)::int as completed_count,
  case
    when sum(a.budget_amount) > 0
      then round(sum(a.pct_complete * a.budget_amount) / sum(a.budget_amount), 1)
    when count(*) > 0 then round(avg(a.pct_complete), 1)
  end                                             as pct_complete,
  min(a.planned_start)                            as starts,
  max(a.planned_end)                              as ends
from public.schedule_activities a
where a.project_id = public.fn_client_project()
group by a.project_id;

grant select on public.v_client_progress_summary to authenticated;


-- ---------- photos the team published ----------
drop view if exists public.v_client_photos cascade;
create view public.v_client_photos as
select c.id, c.project_id, c.photo_path, c.caption, c.taken_on, c.published_at
from public.client_photos c
where c.project_id = public.fn_client_project()
order by c.published_at desc;

grant select on public.v_client_photos to authenticated;


-- ---------- open book: spend by category ----------
-- Live expenses only (voids excluded, the 020 rule). No vendor, no rate, no
-- individual line — a category and a total. The client sees WHAT their money
-- went on, not who was paid what, which is the firm's commercial position.
drop view if exists public.v_client_spend_by_category cascade;
create view public.v_client_spend_by_category as
select
  e.project_id,
  c.name                                        as category,
  sum(e.amount + e.gst_amount)::numeric(14,2)   as amount,
  count(*)::int                                 as entries
from public.expenses e
join public.expense_categories c on c.id = e.category_id
where e.project_id = public.fn_client_project()
  and e.voided_at is null
group by e.project_id, c.name
order by 3 desc;

grant select on public.v_client_spend_by_category to authenticated;


-- ---------- open book: the headline ----------
-- See the header: `contract_value` and `spent` together let a client derive the
-- firm's gross position. That is what open book means and it is a commercial
-- decision, recorded at the top of this file.
--
-- What is NOT here: management fee, margin, margin %, overheads, committed
-- costs, retention, or anything from v_project_pnl.
drop view if exists public.v_client_spend_summary cascade;
create view public.v_client_spend_summary as
select
  p.id                                          as project_id,
  coalesce(p.contract_value, 0)::numeric(14,2)  as contract_value,
  coalesce(s.spent, 0)::numeric(14,2)           as spent,
  case when coalesce(p.contract_value, 0) > 0
    then round(coalesce(s.spent, 0) * 100.0 / p.contract_value, 1)
  end                                           as pct_of_contract
from public.projects p
left join lateral (
  select sum(e.amount + e.gst_amount) as spent
  from public.expenses e
  where e.project_id = p.id and e.voided_at is null
) s on true
where p.id = public.fn_client_project();

grant select on public.v_client_spend_summary to authenticated;


-- ---------- documents the team shared ----------
-- `client_visible` AND not confidential. Both, so a document that is
-- confidential can never be shared by ticking one box.
drop view if exists public.v_client_documents cascade;
create view public.v_client_documents as
select d.id, d.project_id, d.folder, d.title, d.file_path, d.file_type,
       d.created_at
from public.documents d
where d.project_id = public.fn_client_project()
  and d.client_visible
  and not d.is_confidential;

grant select on public.v_client_documents to authenticated;


-- ---------- their invoices ----------
-- `inv_type = 'progress'` ONLY. A management_fee invoice would tell the client
-- the fee in rupees; a vendor_voucher is the firm's cost. Cancelled invoices
-- are excluded — a client should not be chased by a bill that was withdrawn.
drop view if exists public.v_client_invoices cascade;
create view public.v_client_invoices as
select
  i.id,
  i.project_id,
  i.invoice_number,
  i.invoice_date,
  i.period_from,
  i.period_to,
  i.subtotal,
  i.gst_amount,
  i.total,
  i.paid_on,
  i.paid_amount,
  (i.paid_on is not null)                        as is_paid,
  greatest(i.total - coalesce(i.paid_amount, 0), 0)::numeric(14,2) as outstanding
from public.invoices i
where i.project_id = public.fn_client_project()
  and i.inv_type::text = 'progress'
  and i.status::text <> 'cancelled';

grant select on public.v_client_invoices to authenticated;


-- ---------- what is waiting on them ----------
drop view if exists public.v_client_approvals cascade;
create view public.v_client_approvals as
select
  a.id,
  a.project_id,
  a.approval_no,
  a.subject,
  a.title,
  a.details,
  a.status,
  a.decided_on,
  a.reject_reason,
  a.created_at
from public.client_approvals a
where a.project_id = public.fn_client_project();

grant select on public.v_client_approvals to authenticated;


-- ---------- the thread ----------
drop view if exists public.v_client_messages cascade;
create view public.v_client_messages as
select
  m.id,
  m.project_id,
  m.body,
  m.from_client,
  -- The team's name is shown; a client message shows their own. No role, no
  -- designation — the client does not need the firm's org chart.
  case when m.from_client then null else pr.full_name end as author_name,
  m.created_at
from public.client_messages m
left join public.profiles pr on pr.id = m.author_id
where m.project_id = public.fn_client_project()
order by m.created_at;

grant select on public.v_client_messages to authenticated;


-- ############################################################
-- ### 10. WHAT A CLIENT MAY DO
-- ############################################################
-- Approve or reject something put to them. This is the ONLY write a client has
-- besides sending a message.
--
-- SECURITY DEFINER, because `client_approvals` deliberately has no write policy
-- for clients — they must not be able to touch any other column. The function
-- re-checks that the approval belongs to THEIR project.
drop function if exists public.fn_client_decide(uuid, text, text);
create function public.fn_client_decide(
  p_id     uuid,
  p_decision text,
  p_note   text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_project uuid;
  v_state   text;
  v_mine    uuid := public.fn_client_project();
begin
  if not public.is_client() then
    raise exception 'Only a client decides their own approvals.'
      using errcode = '42501';
  end if;
  if v_mine is null then
    raise exception 'No project is linked to this account.' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Unknown decision: %', p_decision;
  end if;

  select project_id, status::text into v_project, v_state
  from public.client_approvals where id = p_id;

  if v_project is null then
    raise exception 'That item is no longer available.';
  end if;
  -- The belt to the RLS braces: even though this runs as owner, it refuses
  -- anything outside the caller's own project.
  if v_project <> v_mine then
    raise exception 'That item is not on your project.' using errcode = '42501';
  end if;
  if v_state <> 'pending' then
    raise exception 'That item has already been %.', v_state;
  end if;
  if p_decision = 'rejected' and coalesce(btrim(p_note), '') = '' then
    raise exception 'Please say briefly why, so the team knows what to change.';
  end if;

  update public.client_approvals
  set status        = p_decision::approval_state,
      decided_on    = (now() at time zone 'Asia/Kolkata')::date,
      reject_reason = case when p_decision = 'rejected' then btrim(p_note) end,
      decided_by    = auth.uid(),
      decided_at    = now(),
      -- The method becomes 'signed': it was recorded by the client themselves
      -- in the portal, which is the strongest evidence this app can hold.
      method        = 'signed'::approval_method
  where id = p_id;
end $$;

revoke all on function public.fn_client_decide(uuid, text, text) from public, anon;
grant execute on function public.fn_client_decide(uuid, text, text) to authenticated;


-- ############################################################
-- ### 11. VERIFY
-- ############################################################
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_client', 'is_internal', 'fn_client_project',
                    'fn_client_decide', 'fn_record_invoice_payment',
                    'fn_client_message_stamp')
order by p.proname;

select table_name from information_schema.views
where table_schema = 'public' and table_name like 'v_client_%'
order by table_name;

-- Must return `false` — a client is never a member, whatever else is true.
select public.is_member('00000000-0000-0000-0000-000000000000'::uuid) as member_when_not_signed_in;
