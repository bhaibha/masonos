-- ============================================================================
-- 083 — M36 Client Communication Log
--       what was said, what was promised, what was complained about
-- ============================================================================
--
-- WHY THREE TABLES AND NOT ONE
-- ----------------------------
-- A commitment has a DUE DATE and a done/pending state. A complaint has a
-- resolution note and a raised/resolved state. Folding them into the entries
-- table behind a `kind` column would leave half the columns null on every row
-- and make "show me everything overdue" a query about which nulls matter.
-- Explicit beats generic — the 060 lesson about three nullable FKs rather than
-- a (table_name, record_id) pair.
--
-- Both link to an entry through a NULLABLE `entry_id`. A promise made on a call
-- points at that call; one that arrives another way is still tracked. Requiring
-- the link would mean you cannot open a complaint until you have logged the
-- conversation it came from, and under pressure those get typed in the wrong
-- order. ON DELETE SET NULL, never cascade (031): deleting the record of a
-- phone call must not delete the promise made during it.
--
-- SUPERVISORS AND THE COMMERCIAL FLAG
-- -----------------------------------
-- A client log is mostly commercial. "They think the terrace railing is too
-- expensive" and "agreed ₹2L for the extra bathroom" are money, and a free-text
-- summary CANNOT be column-gated the way `po_lines.rate` is (012) — there is no
-- column to revoke. So the row carries `is_commercial` and the READ POLICY
-- hides those from supervisors.
--
-- It DEFAULTS TO TRUE, and that direction is the whole safety of it: a hurried
-- entry is hidden rather than exposed, and somebody has to deliberately mark a
-- conversation as site-only. A default of false would make every un-thought-
-- about row visible, which is the failure this flag exists to prevent. A
-- BEFORE trigger also forces it true whenever the entry links to a VO or an
-- approval, because those are commercial by definition and the person typing
-- should not have to remember.
--
-- Same shape as 023's `has_cost_implication` and 060's LEFT JOIN: flag the row,
-- let the policy hide it, never restate the money rule in a second place where
-- it can drift.
--
-- Supervisors can READ their project's non-commercial entries and cannot write
-- at all. Logging a client interaction is founder/pm/accounts — a supervisor
-- who took the call tells the office, which is also how the firm works.
--
-- THE 24-HOUR EDIT WINDOW
-- -----------------------
-- "Append-only-feel, edits tracked in audit" needed a decision about how long
-- an edit stays possible. Forever-with-audit means the entry AS DISPLAYED can
-- be silently rewritten in 2028 and a reader must go digging in `audit_log` to
-- know — which makes "append-only" a description of the UI rather than a
-- property of the data. Never-editable makes a typo permanent.
--
-- So: editable for 24 hours from creation, frozen after, enforced by
-- `fn_comm_entry_freeze` (a TRIGGER, not the form — a form-only rule
-- disappears the first time anything talks to the API directly, the 050
-- lesson). A correction after that is a NEW entry, which is how a site diary
-- has always worked.
--
-- The freeze deliberately does NOT apply to commitments and complaints: those
-- describe an OPEN state that is supposed to change — a promise gets done, a
-- complaint gets resolved. Freezing them would make the registers useless.
-- Their edits are audited like everything else.
--
-- WHAT THIS IS NOT
-- ----------------
-- Not a client-facing surface. `client_messages` (065) is the thread the client
-- writes in and reads. This is the FIRM'S record OF the client, including
-- entries the client would not agree with, and no `v_client_*` view exposes it.
-- The RLS is `is_internal()`-based throughout, so a client account gets zero
-- rows from all three tables.
--
-- Re-runnable: enums `if not exists`, tables `if not exists`, `drop policy if
-- exists` before create, `drop trigger if exists` before create.
-- ============================================================================

-- ############################################################
-- ###  1. Types
-- ############################################################
do $$ begin
  create type comm_channel as enum
    ('call','meeting','whatsapp','email','site_visit','letter');
exception when duplicate_object then null; end $$;

do $$ begin
  create type commitment_state as enum ('pending','done','dropped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type complaint_state as enum ('open','resolved','withdrawn');
exception when duplicate_object then null; end $$;

-- ############################################################
-- ###  2. The log
-- ############################################################
create sequence if not exists public.comm_no_seq;

create table if not exists public.client_comm_entries (
  id uuid primary key default gen_random_uuid(),
  comm_no text not null unique
    default 'COM-' || lpad(nextval('public.comm_no_seq')::text, 4, '0'),

  project_id uuid not null references public.projects(id) on delete cascade,

  channel comm_channel not null,

  -- When the conversation HAPPENED, not when it was typed up. They are
  -- routinely a day or two apart and the first is the one that matters when a
  -- sequence of events is reconstructed (the 060 rule).
  occurred_on date not null default current_date,
  -- Optional: a dispute about "you said that on the Tuesday morning" needs it.
  occurred_at time,

  /** who from the client's side was on the call — plain text, they have no
      account and never will (the 060 rule about not modelling outsiders) */
  client_person text,

  summary text not null check (btrim(summary) <> ''),

  -- Hidden from supervisors when true. Defaults TRUE — see the header.
  is_commercial boolean not null default true,

  -- Optional links. Explicit nullable FKs rather than a generic pair, and
  -- SET NULL so deleting the linked record never deletes the conversation.
  approval_id  uuid references public.client_approvals(id)   on delete set null,
  variation_id uuid references public.variation_orders(id)   on delete set null,
  document_id  uuid references public.documents(id)          on delete set null,

  logged_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cce_project_idx
  on public.client_comm_entries (project_id, occurred_on desc);

-- ############################################################
-- ###  3. Commitments — what we promised, by when
-- ############################################################
create table if not exists public.client_commitments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  entry_id uuid references public.client_comm_entries(id) on delete set null,

  promise text not null check (btrim(promise) <> ''),
  -- Nullable: "we'll look into it" is a real promise with no date, and forcing
  -- one would make people invent a date the client never heard.
  due_on date,

  state commitment_state not null default 'pending',
  closed_on date,
  closing_note text,

  -- Who in the firm owes it. Nullable — sometimes it is the firm, not a person.
  owner_id uuid references public.profiles(id),

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A closed commitment must say when. Anything not pending is closed.
  constraint ccm_closed_has_date check (
    state = 'pending' or closed_on is not null
  )
);

create index if not exists ccm_open_idx
  on public.client_commitments (project_id, due_on)
  where state = 'pending'::commitment_state;

-- ############################################################
-- ###  4. Complaints — raised and resolved
-- ############################################################
create table if not exists public.client_complaints (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,

  entry_id uuid references public.client_comm_entries(id) on delete set null,

  raised_on date not null default current_date,
  subject text not null check (btrim(subject) <> ''),
  detail text,

  state complaint_state not null default 'open',
  resolved_on date,
  -- Mandatory once resolved: "resolved" with no account of HOW is the thing a
  -- register is supposed to prevent (the 060 evidence rule).
  resolution text,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ccp_resolved_needs_both check (
    state <> 'resolved'::complaint_state
    or (resolved_on is not null and btrim(coalesce(resolution, '')) <> '')
  ),
  constraint ccp_withdrawn_has_date check (
    state <> 'withdrawn'::complaint_state or resolved_on is not null
  )
);

create index if not exists ccp_open_idx
  on public.client_complaints (project_id, raised_on desc)
  where state = 'open'::complaint_state;

-- ############################################################
-- ###  5. Triggers
-- ############################################################

-- An entry linked to a VO or an approval is commercial whether or not the
-- person ticked the box. Forced here rather than in the form, so it holds for
-- anything talking to the API.
create or replace function public.fn_comm_entry_guard()
returns trigger language plpgsql as $$
begin
  if new.approval_id is not null or new.variation_id is not null then
    new.is_commercial := true;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists comm_entry_guard on public.client_comm_entries;
create trigger comm_entry_guard
  before insert or update on public.client_comm_entries
  for each row execute function public.fn_comm_entry_guard();

-- The 24-hour freeze. A trigger and not a policy, because an RLS UPDATE policy
-- cannot express "only if created_at is recent" against the OLD row in a way
-- that also produces a readable error (the 050 reasoning).
create or replace function public.fn_comm_entry_freeze()
returns trigger language plpgsql as $$
begin
  if old.created_at < now() - interval '24 hours' then
    raise exception
      'This entry was logged more than 24 hours ago and is now part of the record. Log a new entry correcting it rather than editing this one.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists comm_entry_freeze on public.client_comm_entries;
create trigger comm_entry_freeze
  before update on public.client_comm_entries
  for each row execute function public.fn_comm_entry_freeze();

-- Commitments and complaints describe an OPEN state that is meant to change,
-- so they get a touch trigger and no freeze.
create or replace function public.fn_comm_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ccm_touch on public.client_commitments;
create trigger ccm_touch before update on public.client_commitments
  for each row execute function public.fn_comm_touch();

drop trigger if exists ccp_touch on public.client_complaints;
create trigger ccp_touch before update on public.client_complaints
  for each row execute function public.fn_comm_touch();

-- ############################################################
-- ###  6. Audit — this is the evidence half of the ask
-- ############################################################
-- All three are keyed by `id`, so the standard fn_audit applies (the 051 trap
-- only bites code-keyed tables).
drop trigger if exists audit_cce on public.client_comm_entries;
create trigger audit_cce after insert or update or delete
  on public.client_comm_entries for each row execute function public.fn_audit();

drop trigger if exists audit_ccm on public.client_commitments;
create trigger audit_ccm after insert or update or delete
  on public.client_commitments for each row execute function public.fn_audit();

drop trigger if exists audit_ccp on public.client_complaints;
create trigger audit_ccp after insert or update or delete
  on public.client_complaints for each row execute function public.fn_audit();

-- ############################################################
-- ###  7. RLS
-- ############################################################
alter table public.client_comm_entries enable row level security;
alter table public.client_commitments  enable row level security;
alter table public.client_complaints   enable row level security;

-- ---------- entries ----------
-- Read: a member of the project, internal only, and a supervisor never sees a
-- commercial row. `is_member()` already returns false for a client (065) and
-- for a deactivated profile (078), so both are closed without restating either.
drop policy if exists cce_read on public.client_comm_entries;
create policy cce_read on public.client_comm_entries for select to authenticated
  using (
    public.is_internal()
    and public.is_member(project_id)
    and (not is_commercial or public.my_role()::text <> 'supervisor')
  );

-- Write: founder/pm/accounts. A supervisor who took the call tells the office.
drop policy if exists cce_write on public.client_comm_entries;
create policy cce_write on public.client_comm_entries for insert to authenticated
  with check (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','accounts')
  );

-- Update exists so the 24-hour correction is possible; the trigger is what
-- limits it. No DELETE policy at all — an entry never leaves the record.
drop policy if exists cce_update on public.client_comm_entries;
create policy cce_update on public.client_comm_entries for update to authenticated
  using (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','accounts')
  )
  with check (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','accounts')
  );

-- ---------- commitments ----------
-- A promise to the client is not a secret from the site — the site is usually
-- what has to deliver it — so supervisors read these in full. The commercial
-- content lives in the entry, which they may not see.
drop policy if exists ccm_read on public.client_commitments;
create policy ccm_read on public.client_commitments for select to authenticated
  using (public.is_internal() and public.is_member(project_id));

drop policy if exists ccm_write on public.client_commitments;
create policy ccm_write on public.client_commitments for all to authenticated
  using (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','accounts')
  )
  with check (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','accounts')
  );

-- ---------- complaints ----------
drop policy if exists ccp_read on public.client_complaints;
create policy ccp_read on public.client_complaints for select to authenticated
  using (public.is_internal() and public.is_member(project_id));

drop policy if exists ccp_write on public.client_complaints;
create policy ccp_write on public.client_complaints for all to authenticated
  using (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','accounts')
  )
  with check (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','accounts')
  );

-- ############################################################
-- ###  8. Summary for the dashboard strip
-- ############################################################
-- Returns ZERO ROWS when there is nothing waiting, so the strip vanishes
-- rather than rendering "0 overdue" — the 073 rule. And the 066 wrapper, so a
-- client or an outsider gets nothing rather than a row of zeros.
create or replace function public.fn_client_comm_attention(p_project uuid)
returns table (
  overdue_commitments int,
  due_soon_commitments int,
  open_complaints int,
  oldest_complaint_days int
)
language sql stable security invoker set search_path = public as $$
  select * from (
    select
      count(*) filter (
        where c.state = 'pending'::commitment_state
          and c.due_on is not null
          and c.due_on < (now() at time zone 'Asia/Kolkata')::date
      )::int as overdue_commitments,
      count(*) filter (
        where c.state = 'pending'::commitment_state
          and c.due_on is not null
          and c.due_on >= (now() at time zone 'Asia/Kolkata')::date
          and c.due_on <= (now() at time zone 'Asia/Kolkata')::date + 7
      )::int as due_soon_commitments,
      (select count(*) from public.client_complaints p
        where p.project_id = p_project
          and p.state = 'open'::complaint_state)::int as open_complaints,
      (select max((now() at time zone 'Asia/Kolkata')::date - p.raised_on)
         from public.client_complaints p
        where p.project_id = p_project
          and p.state = 'open'::complaint_state)::int as oldest_complaint_days
    from public.client_commitments c
    where c.project_id = p_project
  ) q
  where public.is_internal()
    and (q.overdue_commitments > 0
      or q.due_soon_commitments > 0
      or q.open_complaints > 0);
$$;

revoke all on function public.fn_client_comm_attention(uuid) from public, anon;
grant execute on function public.fn_client_comm_attention(uuid) to authenticated;

-- ############################################################
-- ###  9. Verify
-- ############################################################
-- One final SELECT — the Supabase SQL editor shows only the LAST result set
-- and does not display `raise notice`.
--
-- Expect: tables = 3, enums = 3, policies = 7, no_delete_policy = 0,
--         freeze_trg = 1, guard_trg = 1, audit_trgs = 3,
--         commercial_defaults_true = 1, attention_fn = 1.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public'
      and table_name in ('client_comm_entries','client_commitments','client_complaints')) as tables,
  (select count(*) from pg_type
    where typname in ('comm_channel','commitment_state','complaint_state'))               as enums,
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('client_comm_entries','client_commitments','client_complaints'))  as policies,
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'client_comm_entries' and cmd = 'DELETE')                           as no_delete_policy,
  (select count(*) from pg_trigger
    where tgname = 'comm_entry_freeze' and not tgisinternal)                              as freeze_trg,
  (select count(*) from pg_trigger
    where tgname = 'comm_entry_guard' and not tgisinternal)                               as guard_trg,
  (select count(*) from pg_trigger
    where tgname in ('audit_cce','audit_ccm','audit_ccp') and not tgisinternal)           as audit_trgs,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'client_comm_entries'
      and column_name = 'is_commercial' and column_default like '%true%')                 as commercial_defaults_true,
  (select count(*) from pg_proc where proname = 'fn_client_comm_attention')               as attention_fn;
