-- ============================================================
-- 060 — C2 CLIENT APPROVALS (Module 07, internal record version)
--
-- A register of decisions THE CLIENT made, recorded by us. There is no client
-- portal and no client login; nobody outside the firm ever touches this table.
-- What it captures is the thing that actually happens on a luxury residential
-- job: the owner says "yes, go with the Italian marble" on a site walk or over
-- WhatsApp, work proceeds, and four months later somebody asks who approved it.
--
-- ------------------------------------------------------------
-- WHY THE CLIENT IS FREE TEXT AND NOT A ROW IN profiles
-- ------------------------------------------------------------
-- `approved_by_name` is a plain text field. The client is not a user of this
-- system, and giving them a row in `profiles` — or a `client_users` table —
-- would imply an account that will never exist and a login nobody will ever
-- issue. The register records what somebody outside the system said; modelling
-- them as a user would be modelling a fiction.
--
-- ------------------------------------------------------------
-- WHY THERE IS NO AMOUNT COLUMN, EVER
-- ------------------------------------------------------------
-- Supervisors must read this register — they are the ones acting on "the client
-- approved the sample, proceed" — and CLAUDE.md's #1 rule is that supervisors
-- see no figures. So an approval that concerns money links to the VARIATION
-- ORDER and holds no rupee value of its own, exactly as `site_instructions`
-- does in 023 with `has_cost_implication`.
--
-- variation_orders' own RLS already excludes supervisors, so the display view
-- LEFT JOINs it: a supervisor sees "Variation order · VO —" with the number and
-- amount blank, and a founder sees both. No column-level revoke is needed on
-- this table, because the secret was never in it.
--
-- ------------------------------------------------------------
-- WHY THE "CANNOT APPROVE WHAT YOU RAISED" RULE DOES NOT APPLY
-- ------------------------------------------------------------
-- The roles matrix says a PM cannot approve records they raised. That rule
-- exists to stop somebody rubber-stamping their own request. Here the decision
-- was made by the CLIENT, outside this system; the PM is a witness recording
-- it, not an approver. Applying the rule would mean the person who actually
-- took the phone call is the one person who cannot log it — which is the entire
-- use case.
--
-- The honest consequence is that one person can, alone, assert that the client
-- approved something. That is inherent to recording an out-of-band decision and
-- cannot be designed away. What CAN be done is refuse to hide it:
--
--   * `method` is mandatory, so "verbal" never masquerades as "signed";
--   * `fn_project_approval_summary` counts approvals with NO EVIDENCE attached
--     and the screen shows that count, because a verbal approval with nothing
--     behind it is the weakest record in the register and should look like it;
--   * every insert, update and delete is audited.
--
-- ------------------------------------------------------------
-- WHY THREE NULLABLE FKs RATHER THAN (table_name, record_id)
-- ------------------------------------------------------------
-- A generic pair is tempting and cannot be enforced: nothing stops it pointing
-- at a row that has since been cancelled, deleted or never existed, and no
-- database check will ever catch it. Three explicit FKs — variation, document,
-- material — get referential integrity for free and cost one nullable column
-- each. ON DELETE SET NULL, not cascade: deleting a document must not delete
-- the record that the client approved something (the 031 container rule).
--
-- Re-runnable throughout.
-- ============================================================


-- ############################################################
-- ###  1. TYPES
-- ############################################################
do $$ begin
  if not exists (select 1 from pg_type where typname = 'approval_subject') then
    create type approval_subject as enum (
      'material_selection',   -- a finish, fitting or shade chosen
      'design_change',        -- a change to the drawings
      'variation_order',      -- a VO the client has accepted
      'stage_signoff',        -- a stage handed over and accepted
      'sample',               -- a physical sample or mock-up
      'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'approval_method') then
    -- HOW the client said it. Mandatory, and never collapsed into a single
    -- "approved" tick: a message thread and a countersigned sheet are not the
    -- same evidence, and a register that shows them identically is worse than
    -- one that shows nothing, because it looks authoritative.
    create type approval_method as enum ('verbal', 'whatsapp', 'email', 'signed');
  end if;

  if not exists (select 1 from pg_type where typname = 'approval_state') then
    create type approval_state as enum ('pending', 'approved', 'rejected');
  end if;
end $$;

-- New types, so 021's "unsafe use of a new enum value in the same transaction"
-- trap does not apply. Comparisons are still written `::text` for consistency
-- with every other module.
create sequence if not exists public.approval_no_seq;


-- ############################################################
-- ###  2. THE TABLE
-- ############################################################
create table if not exists public.client_approvals (
  id uuid primary key default gen_random_uuid(),
  approval_no text not null unique
    default 'CA-' || lpad(nextval('public.approval_no_seq')::text, 4, '0'),

  project_id uuid not null references public.projects(id) on delete cascade,

  subject approval_subject not null,
  -- What, in one line, is being approved.
  title text not null,
  details text,

  -- ---- the client side ----
  approved_by_name text not null,
  -- "Owner", "Owner's architect", "Owner's representative". Who they are
  -- matters: an architect approving a finish and the owner approving it carry
  -- different weight, and six months later nobody remembers.
  client_role text,
  method approval_method not null,

  -- ---- the decision ----
  status approval_state not null default 'pending',
  -- WHEN THE CLIENT DECIDED, which is not when we typed it in. created_at
  -- records the second; this records the first, and it is the one that matters
  -- when a sequence of events is being reconstructed.
  decided_on date,
  reject_reason text,
  -- Our person who recorded the decision. Stamped only by the RPC.
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,

  -- ---- what it refers to ----
  variation_id uuid references public.variation_orders(id) on delete set null,
  document_id  uuid references public.documents(id)        on delete set null,
  material_id  uuid references public.materials(id)        on delete set null,

  -- Storage paths, `${project_id}/${uuid}` in the documents bucket. The
  -- screenshot of the WhatsApp message IS the record for most of these rows.
  evidence text[] not null default '{}',

  raised_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A rejection with no reason is not a record of anything. Enforced as a CHECK
  -- rather than in the form, because a form-only rule disappears the first time
  -- anything talks to the API directly — the same reasoning as 020's mandatory
  -- void reason.
  constraint ca_reject_reason check (
    status::text <> 'rejected' or coalesce(btrim(reject_reason), '') <> ''),

  -- A decided approval must say when it was decided.
  constraint ca_decided_on check (
    status::text = 'pending' or decided_on is not null)
);

-- Columns added after this create block first shipped go here, one statement
-- each — `create table if not exists` will not add them (the 042 lesson).
alter table public.client_approvals add column if not exists client_role text;
alter table public.client_approvals add column if not exists details text;

create index if not exists ca_project_idx
  on public.client_approvals (project_id, status, decided_on desc nulls first);
create index if not exists ca_variation_idx
  on public.client_approvals (variation_id) where variation_id is not null;
create index if not exists ca_document_idx
  on public.client_approvals (document_id) where document_id is not null;
create index if not exists ca_material_idx
  on public.client_approvals (material_id) where material_id is not null;

drop trigger if exists ca_touch on public.client_approvals;
create or replace function public.fn_ca_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger ca_touch before update on public.client_approvals
  for each row execute function public.fn_ca_touch();


-- ############################################################
-- ###  3. THE DECISION GUARD
-- ############################################################
-- An RLS UPDATE policy cannot say WHICH columns. The policy that lets a PM fix
-- a typo in the title also lets a PATCH set status = 'approved' with no
-- decided_by, no decided_at and no audit trail of who decided — the same hole
-- 021 found on purchase_orders and 050 found on rate_comparisons.
--
-- The discriminator is `current_user`: PostgREST connects as `authenticated`,
-- every RPC here is SECURITY DEFINER and runs as the owner. So this trigger
-- refuses the decision columns from the client and allows them from the
-- function. It RAISES rather than quietly restoring the old value — a PATCH
-- only sends changed columns, so the trigger fires only when somebody meant it,
-- and swallowing that would hide the bug instead of reporting it.
create or replace function public.fn_ca_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' then
    if new.status is distinct from old.status
       or new.decided_by is distinct from old.decided_by
       or new.decided_at is distinct from old.decided_at
       or new.decided_on is distinct from old.decided_on
       or new.reject_reason is distinct from old.reject_reason then
      raise exception
        'The decision on an approval is set through fn_set_approval_status, not by editing the row.'
        using errcode = '42501';
    end if;

    -- The number identifies the record in a letter to the client. It is not
    -- editable, by anyone, ever.
    if new.approval_no is distinct from old.approval_no then
      raise exception 'An approval number cannot be changed.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists ca_guard on public.client_approvals;
create trigger ca_guard before update on public.client_approvals
  for each row execute function public.fn_ca_guard();


-- ############################################################
-- ###  4. RLS
-- ############################################################
alter table public.client_approvals enable row level security;

-- Everyone on the project reads it, supervisors included — they are the people
-- who act on "the client approved the sample". is_member() already returns true
-- for a founder on every project and for accounts on every project, so this one
-- clause covers all four roles without restating the matrix.
drop policy if exists ca_read on public.client_approvals;
create policy ca_read on public.client_approvals
  for select to authenticated
  using (public.is_member(project_id));

drop policy if exists ca_insert on public.client_approvals;
create policy ca_insert on public.client_approvals
  for insert to authenticated
  with check (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm')
  );

drop policy if exists ca_update on public.client_approvals;
create policy ca_update on public.client_approvals
  for update to authenticated
  using (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm')
  )
  with check (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm')
  );

-- DELIBERATELY NO DELETE POLICY. RLS default-deny then makes fn_delete_approval
-- the only route, which is where the "you cannot delete a decided approval"
-- rule lives (mechanism 1 in CLAUDE.md).


-- ############################################################
-- ###  5. AUDIT
-- ############################################################
-- Keyed by `id`, so the ordinary fn_audit applies rather than 051's
-- code-keyed variant. Worth stating: attaching the wrong one aborts the write
-- and reports it as a missing field on `new`, which reads like a typo.
drop trigger if exists audit_client_approvals on public.client_approvals;
create trigger audit_client_approvals
  after insert or update or delete on public.client_approvals
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  6. THE REGISTER VIEW
-- ############################################################
-- security_invoker, so ca_read decides the rows AND variation_orders' own
-- policy decides whether the VO half resolves. A supervisor gets the approval
-- with `vo_number` null; a founder gets both. The money stays where its own RLS
-- already guards it, and this view never has to know the rule.
drop view if exists public.v_client_approvals cascade;
create view public.v_client_approvals with (security_invoker = true) as
select
  a.id,
  a.approval_no,
  a.project_id,
  p.name                                as project_name,
  a.subject,
  a.title,
  a.details,
  a.approved_by_name,
  a.client_role,
  a.method,
  a.status,
  a.decided_on,
  a.reject_reason,
  a.decided_at,
  dec.full_name                         as decided_by_name,
  raiser.full_name                      as raised_by_name,
  a.variation_id,
  vo.vo_number,
  vo.title                              as variation_title,
  a.document_id,
  d.title                               as document_title,
  a.material_id,
  m.name                                as material_name,
  a.evidence,
  cardinality(a.evidence)               as evidence_count,
  -- The register's own honesty flag. A verbal approval with nothing attached is
  -- the weakest row in here, and the screen shows it as such rather than
  -- letting it sit among countersigned sheets looking identical.
  (cardinality(a.evidence) = 0)         as evidence_missing,
  a.created_at,
  a.updated_at
from public.client_approvals a
join      public.projects p        on p.id = a.project_id
left join public.profiles dec      on dec.id = a.decided_by
left join public.profiles raiser   on raiser.id = a.raised_by
left join public.variation_orders vo on vo.id = a.variation_id
left join public.documents d       on d.id = a.document_id
left join public.materials m       on m.id = a.material_id;

grant select on public.v_client_approvals to authenticated;


-- ############################################################
-- ###  7. RECORDING THE DECISION
-- ############################################################
-- One act, one transaction, one code path: the status, the date, who recorded
-- it and when all move together. Two paths would eventually produce an approved
-- row with no idea who recorded it (the 043 lesson).
drop function if exists public.fn_set_approval_status(uuid, text, date, text);
create function public.fn_set_approval_status(
  p_id     uuid,
  p_status text,
  p_on     date default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_current text;
  v_role    text := public.my_role();
  v_me      uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if v_role not in ('founder', 'pm') then
    raise exception 'Only a founder or PM records a client decision.'
      using errcode = '42501';
  end if;
  if p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'Unknown status: %', p_status;
  end if;

  select project_id, status::text into v_project, v_current
  from public.client_approvals where id = p_id;

  if v_project is null then
    raise exception 'That approval no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  if p_status = 'rejected' and coalesce(btrim(p_reason), '') = '' then
    raise exception
      'Say why the client rejected it. A rejection with no reason tells the next person nothing.';
  end if;

  update public.client_approvals
  set status       = p_status::approval_state,
      -- Defaults to today in Asia/Kolkata, but the caller can pass the date the
      -- client ACTUALLY decided — which is usually earlier than the day
      -- somebody got round to typing it in.
      decided_on   = case when p_status = 'pending' then null
                          else coalesce(p_on, (now() at time zone 'Asia/Kolkata')::date) end,
      reject_reason = case when p_status = 'rejected' then btrim(p_reason) else null end,
      decided_by   = case when p_status = 'pending' then null else v_me end,
      decided_at   = case when p_status = 'pending' then null else now() end
  where id = p_id;
end $$;

revoke all on function public.fn_set_approval_status(uuid, text, date, text)
  from public, anon;
grant execute on function public.fn_set_approval_status(uuid, text, date, text)
  to authenticated;


-- ############################################################
-- ###  8. PROJECT SUMMARY — for the project detail card
-- ############################################################
-- Counts, plus the two things a founder actually wants to know at a glance:
-- how long the oldest undecided approval has been sitting, and how many decided
-- approvals have no evidence behind them.
drop function if exists public.fn_project_approval_summary(uuid);
create function public.fn_project_approval_summary(p_project uuid)
returns table (
  pending_count    int,
  approved_count   int,
  rejected_count   int,
  -- Days since the oldest still-pending approval was raised. Null when nothing
  -- is pending. A client decision nobody has chased is the thing that stalls a
  -- job, and a count alone does not show that one of them is nine weeks old.
  oldest_pending_days int,
  -- Decided approvals with no attached evidence. Named honestly rather than
  -- hidden: this is the number that matters if the approval is ever questioned.
  no_evidence_count int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where a.status::text = 'pending')::int,
    count(*) filter (where a.status::text = 'approved')::int,
    count(*) filter (where a.status::text = 'rejected')::int,
    max((current_date - a.created_at::date))
      filter (where a.status::text = 'pending')::int,
    count(*) filter (where a.status::text <> 'pending'
                       and cardinality(a.evidence) = 0)::int
  from public.client_approvals a
  where a.project_id = p_project
    and public.is_member(a.project_id);
$$;

revoke all on function public.fn_project_approval_summary(uuid) from public, anon;
grant execute on function public.fn_project_approval_summary(uuid) to authenticated;


-- ############################################################
-- ###  9. DELETING ONE
-- ############################################################
-- Its own function rather than a branch on fn_delete_record, following 050:
-- re-emitting that 300-line function to add five lines is how a transcription
-- error reaches production, and the rule here is specific enough to deserve
-- saying once, clearly.
--
-- THE RULE: a PENDING approval is a note somebody typed and can be removed. A
-- DECIDED one is a record of something the client said, and deleting it is
-- destroying evidence — the fix for a mistake is to set it back to pending and
-- correct it, which leaves the whole sequence in audit_log.
drop function if exists public.fn_delete_approval(uuid);
create function public.fn_delete_approval(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_status  text;
  v_no      text;
  v_role    text := public.my_role();
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if v_role not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may remove an approval.'
      using errcode = '42501';
  end if;

  select project_id, status::text, approval_no
    into v_project, v_status, v_no
  from public.client_approvals where id = p_id;

  if v_project is null then
    raise exception 'That approval no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  if v_status <> 'pending' then
    raise exception
      '% has been % and is a record of what the client said — it is not deleted. Set it back to pending first if it was logged in error; the correction stays in the audit trail.',
      v_no, v_status;
  end if;

  delete from public.client_approvals where id = p_id;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values ('client_approvals', 'DELETE_HARD', p_id::text,
          jsonb_build_object('deleted_by', auth.uid(), 'deleted_at', now(),
                             'approval_no', v_no), null);
end $$;

revoke all on function public.fn_delete_approval(uuid) from public, anon;
grant execute on function public.fn_delete_approval(uuid) to authenticated;


-- ############################################################
-- ### 10. VERIFY
-- ############################################################
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_set_approval_status', 'fn_project_approval_summary',
                    'fn_delete_approval', 'fn_ca_guard', 'fn_ca_touch')
group by p.proname order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('client_approvals', 'v_client_approvals')
order by table_name;
