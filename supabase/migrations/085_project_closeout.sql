-- ============================================================================
-- 085 — M28 Project Close-Out
--       the handover pack, the final account, and a close that can refuse
-- ============================================================================
--
-- THE FINAL ACCOUNT HAS TWO SIDES, AND MIXING THEM WOULD BE MEANINGLESS
-- ---------------------------------------------------------------------
-- The brief said "contract + approved VOs − certified − paid". Those figures
-- live on OPPOSITE sides of the ledger in this database:
--   · `invoices`  — what the firm bills the CLIENT (`progress`,
--                   `management_fee`), with `paid_on`/`paid_amount` from 065.
--                   Money coming IN.
--   · `ra_bills`  — what the firm's CONTRACTORS bill the firm, with
--                   `net_certified` (032) and retention held (033).
--                   Money going OUT.
-- Subtracting subcontractor certifications from the client's contract value
-- produces a number that describes nothing. So `fn_project_final_account`
-- returns them SEPARATELY:
--   client side      revised contract − invoiced − received
--   contractor side  certified − paid, plus retention still held
-- Closing a project means settling both, and releasing retention is a real
-- close-out act that 033 already models. Same rule as 056: do not name a figure
-- something it isn't.
--
-- OWNER-RUN, BECAUSE IT READS contract_value
-- ------------------------------------------
-- `projects.contract_value` is revoked from `authenticated` (010), so an
-- invoker-rights function reading it errors for EVERYONE including the founder.
-- `fn_project_final_account` is therefore SECURITY DEFINER with
-- `is_member(p_project) and my_role() in ('founder','pm')` as the access
-- control — the 010 → 038 owner-run pattern. **That predicate IS the gate;
-- losing it is a silent full-table leak**, which is why it is the first line of
-- the body rather than buried in a WHERE.
-- Wrapped so an unauthorised caller gets ZERO ROWS rather than a row of zeros
-- (066) — a final account reading ₹0.00 outstanding would be read as "settled".
--
-- A CLOSE THAT CANNOT REFUSE IS A LABEL
-- -------------------------------------
-- `project_status` has had a `completed` value since 001. Flipping it and
-- showing a badge is exactly what 078 found `profiles.is_active` doing for
-- months: the founder believes something happened and nothing did.
--
-- So `fn_close_project` REFUSES while anything is outstanding and NAMES what is
-- in the way, the way `fn_delete_record` (022) does:
--   · any REQUIRED checklist item unticked
--   · any snag still open or in progress
--   · the client still owing money, or still to be billed
-- The founder can waive the money gate with `p_force` AND a mandatory reason,
-- because a job can genuinely close with a disputed balance — but the waiver is
-- recorded on the row, so "we closed it anyway" is a fact somebody can find
-- rather than a silence. There is no waiver for open snags or missing required
-- documents: those are the things the pack exists to guarantee.
--
-- Deliberately NOT a write lock. Locking the project would mean a policy change
-- on roughly forty tables, and the firm would hit it the first time a warranty
-- claim needed logging. Closing records that the job is finished; it does not
-- pretend the record is finished.
--
-- THE PACK IS SEEDED FROM THE FIRM'S OWN LIST
-- -------------------------------------------
-- The four categories are the ones the firm named — as-builts, warranties,
-- manuals, completion certificates — so seeding them is taking the client's own
-- form rather than inventing content (046). Rows are added freely on top.
-- `document_id` is NULLABLE and ticking without one is allowed: a warranty
-- arrives as a physical booklet and a completion certificate is a stamped hard
-- copy. Forcing an upload would mean people tick nothing, or scan things badly
-- to get past a gate. The screen counts which items have evidence behind them,
-- because a tick with a file is stronger than a tick.
--
-- ONE CLOSE-OUT PER PROJECT — `unique (project_id)`. A second handover pack for
-- the same job is two versions of the truth.
--
-- Re-runnable: enum `if not exists`, tables `if not exists`, `drop policy if
-- exists` before create, `drop trigger if exists` before create, and the seed
-- guarded on the item not already existing.
-- ============================================================================

-- ############################################################
-- ###  1. Types
-- ############################################################
do $$ begin
  create type closeout_category as enum
    ('as_built','warranty','manual','certificate','other');
exception when duplicate_object then null; end $$;

-- ############################################################
-- ###  2. The close-out record
-- ############################################################
create table if not exists public.project_closeouts (
  id uuid primary key default gen_random_uuid(),

  -- One per project. A second handover pack is two versions of the truth.
  project_id uuid not null unique
    references public.projects(id) on delete cascade,

  -- ---------- client satisfaction ----------
  -- The RECORD of what the client said, captured by the firm (060). The client
  -- has a portal, but a client who never signs in must not make the project
  -- unclosable — and a score somebody typed on the client's behalf should look
  -- different from one the client entered, which is what `survey_method` is for.
  survey_score int check (survey_score between 1 and 10),
  survey_method text,
  survey_comments text,
  survey_taken_on date,

  -- ---------- lessons ----------
  lessons text,

  -- ---------- the close itself ----------
  closed_at timestamptz,
  closed_by uuid references public.profiles(id),
  -- Set only when a founder closed past an unsettled balance. Present = the
  -- money gate was waived, and this is the sentence explaining it.
  close_waiver_reason text,

  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A close is never anonymous or undated.
  constraint pcl_closed_has_who check (
    (closed_at is null and closed_by is null)
    or (closed_at is not null and closed_by is not null)
  ),
  -- A waiver without a close is meaningless; a waiver with no reason is the
  -- thing the waiver exists to prevent.
  constraint pcl_waiver_needs_close check (
    close_waiver_reason is null
    or (closed_at is not null and btrim(close_waiver_reason) <> '')
  ),
  -- A score with no date cannot be placed in a sequence of events (060).
  constraint pcl_score_has_date check (
    survey_score is null or survey_taken_on is not null
  )
);

-- ############################################################
-- ###  3. The documentation pack
-- ############################################################
create table if not exists public.closeout_items (
  id uuid primary key default gen_random_uuid(),
  closeout_id uuid not null
    references public.project_closeouts(id) on delete cascade,

  category closeout_category not null default 'other',
  label text not null check (btrim(label) <> ''),

  -- Required items block the close. The seeded pack marks the four the firm
  -- named; anything added afterwards defaults to optional, because a list that
  -- makes everything mandatory is one people learn to force past.
  is_required boolean not null default false,

  received boolean not null default false,
  received_on date,

  -- Nullable ON PURPOSE — see the header. SET NULL, not cascade: deleting the
  -- uploaded file must not delete the record that the item was received (031).
  document_id uuid references public.documents(id) on delete set null,

  note text,
  sort int not null default 100,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Ticking records WHEN. Same reason as everywhere else in this app.
  constraint cli_received_has_date check (
    not received or received_on is not null
  )
);

create index if not exists cli_closeout_idx
  on public.closeout_items (closeout_id, sort);

-- ############################################################
-- ###  4. Triggers
-- ############################################################
create or replace function public.fn_closeout_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists pcl_touch on public.project_closeouts;
create trigger pcl_touch before update on public.project_closeouts
  for each row execute function public.fn_closeout_touch();

drop trigger if exists cli_touch on public.closeout_items;
create trigger cli_touch before update on public.closeout_items
  for each row execute function public.fn_closeout_touch();

-- Both keyed by `id`, so the standard fn_audit applies (051).
drop trigger if exists audit_pcl on public.project_closeouts;
create trigger audit_pcl after insert or update or delete
  on public.project_closeouts for each row execute function public.fn_audit();

drop trigger if exists audit_cli on public.closeout_items;
create trigger audit_cli after insert or update or delete
  on public.closeout_items for each row execute function public.fn_audit();

-- ############################################################
-- ###  5. RLS — founder / pm
-- ############################################################
alter table public.project_closeouts enable row level security;
alter table public.closeout_items    enable row level security;

-- `is_member()` already returns false for a client (065) and for a deactivated
-- profile (078), so neither needs restating.
drop policy if exists pcl_read on public.project_closeouts;
create policy pcl_read on public.project_closeouts for select to authenticated
  using (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm','accounts')
  );

-- Accounts can READ (the final account is their business) and cannot write.
-- Closing a project is a founder/PM act.
drop policy if exists pcl_write on public.project_closeouts;
create policy pcl_write on public.project_closeouts for insert to authenticated
  with check (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm')
  );

drop policy if exists pcl_update on public.project_closeouts;
create policy pcl_update on public.project_closeouts for update to authenticated
  using (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm')
  )
  with check (
    public.is_member(project_id)
    and public.my_role()::text in ('founder','pm')
  );

-- Items inherit the parent's audience through a subquery on the close-out.
drop policy if exists cli_read on public.closeout_items;
create policy cli_read on public.closeout_items for select to authenticated
  using (
    exists (
      select 1 from public.project_closeouts c
      where c.id = closeout_items.closeout_id
        and public.is_member(c.project_id)
        and public.my_role()::text in ('founder','pm','accounts')
    )
  );

drop policy if exists cli_write on public.closeout_items;
create policy cli_write on public.closeout_items for all to authenticated
  using (
    exists (
      select 1 from public.project_closeouts c
      where c.id = closeout_items.closeout_id
        and public.is_member(c.project_id)
        and public.my_role()::text in ('founder','pm')
    )
  )
  with check (
    exists (
      select 1 from public.project_closeouts c
      where c.id = closeout_items.closeout_id
        and public.is_member(c.project_id)
        and public.my_role()::text in ('founder','pm')
    )
  );

-- No DELETE policy on `project_closeouts`. A handover pack is the record that
-- a job ended; it does not get removed.

-- ############################################################
-- ###  6. Open a close-out, seeded with the firm's own pack
-- ############################################################
-- SECURITY DEFINER only so the seed rows land in one transaction with the
-- parent; the role check is the first thing it does, and every INSERT it
-- performs is one the caller's own policies would have allowed.
create or replace function public.fn_open_closeout(p_project uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  if not (public.is_member(p_project)
          and public.my_role()::text in ('founder','pm')) then
    raise exception 'Only a founder or PM on this project may open a close-out.'
      using errcode = '42501';
  end if;

  select id into v_id from public.project_closeouts where project_id = p_project;
  if v_id is not null then
    return v_id;                      -- idempotent: one pack per project
  end if;

  insert into public.project_closeouts (project_id) values (p_project)
  returning id into v_id;

  -- The four the firm named, seeded as REQUIRED. Anything added later is
  -- optional by default (see the header).
  insert into public.closeout_items (closeout_id, category, label, is_required, sort)
  values
    (v_id, 'as_built',    'As-built drawings, all disciplines',        true,  10),
    (v_id, 'warranty',    'Warranties and guarantees',                 true,  20),
    (v_id, 'manual',      'O&M manuals and equipment documentation',   true,  30),
    (v_id, 'certificate', 'Completion certificate',                    true,  40),
    (v_id, 'certificate', 'Statutory approvals and occupancy',         false, 50),
    (v_id, 'other',       'Keys, access cards and handover inventory', false, 60),
    (v_id, 'other',       'Snag list signed off by the client',        false, 70);

  return v_id;
end $$;

revoke all on function public.fn_open_closeout(uuid) from public, anon;
grant execute on function public.fn_open_closeout(uuid) to authenticated;

-- ############################################################
-- ###  7. The final account — both sides, kept apart
-- ############################################################
-- SECURITY DEFINER because it reads `projects.contract_value`, which 010
-- revoked from `authenticated`. The role check in the body IS the access
-- control (the 010 → 038 owner-run pattern).
create or replace function public.fn_project_final_account(p_project uuid)
returns table (
  -- client side: money in
  contract_value      numeric(14,2),
  variations_value    numeric(14,2),
  revised_contract    numeric(14,2),
  invoiced            numeric(14,2),
  received            numeric(14,2),
  still_to_bill       numeric(14,2),
  still_to_collect    numeric(14,2),
  -- contractor side: money out
  certified           numeric(14,2),
  retention_held      numeric(14,2)
)
language plpgsql security definer set search_path = public as $$
begin
  -- THE GATE. Losing this line makes the function a full-table leak of every
  -- project's contract value.
  if not (public.is_member(p_project)
          and public.my_role()::text in ('founder','pm')) then
    return;                            -- ZERO ROWS, never a row of zeros (066)
  end if;

  return query
  with contract as (
    select
      coalesce(p.contract_value, 0)::numeric(14,2) as cv,
      coalesce((
        select sum(v.cost_impact) from public.variation_orders v
        where v.project_id = p.id and v.status::text = 'approved'
      ), 0)::numeric(14,2) as vv
    from public.projects p
    where p.id = p_project
  ),
  billed as (
    -- Cancelled invoices are excluded; a cancelled bill was never billed.
    -- `management_fee` counts — it is money the client owes under the same
    -- contract, and leaving it out would understate what is still to collect.
    select
      coalesce(sum(i.total), 0)::numeric(14,2)                       as inv,
      coalesce(sum(i.paid_amount) filter (where i.paid_on is not null), 0)
        ::numeric(14,2)                                              as rec
    from public.invoices i
    where i.project_id = p_project
      and i.inv_type::text in ('progress','management_fee')
      and i.status::text <> 'cancelled'
  ),
  owed as (
    select
      coalesce(sum(b.net_certified), 0)::numeric(14,2)               as cert,
      coalesce(sum(b.retention_amount), 0)::numeric(14,2)            as ret
    from public.ra_bills b
    where b.project_id = p_project
      and b.status::text = 'certified'
  ),
  released as (
    select coalesce(sum(r.amount), 0)::numeric(14,2) as rel
    from public.retention_releases r
    where r.project_id = p_project
      and r.status::text = 'released'
  )
  select
    c.cv,
    c.vv,
    (c.cv + c.vv)::numeric(14,2),
    b.inv,
    b.rec,
    (c.cv + c.vv - b.inv)::numeric(14,2)   as still_to_bill,
    (b.inv - b.rec)::numeric(14,2)         as still_to_collect,
    o.cert,
    (o.ret - rl.rel)::numeric(14,2)        as retention_held
  from contract c, billed b, owed o, released rl;
end $$;

revoke all on function public.fn_project_final_account(uuid) from public, anon;
grant execute on function public.fn_project_final_account(uuid) to authenticated;

-- ############################################################
-- ###  8. What is blocking the close
-- ############################################################
-- Returns one row PER BLOCKER, so an empty result means ready — and the screen
-- can list them rather than showing one unhelpful "not ready".
create or replace function public.fn_closeout_blockers(p_project uuid)
returns table (blocker text, detail text, waivable boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_member(p_project)
          and public.my_role()::text in ('founder','pm')) then
    return;
  end if;

  -- Required documentation
  return query
  select
    'documents'::text,
    'Still to receive: ' || string_agg(i.label, ', ' order by i.sort),
    false
  from public.closeout_items i
  join public.project_closeouts c on c.id = i.closeout_id
  where c.project_id = p_project
    and i.is_required
    and not i.received
  having count(*) > 0;

  -- Open snags. A job does not hand over with defects outstanding.
  return query
  select
    'snags'::text,
    count(*)::text || ' snag' || case when count(*) = 1 then '' else 's' end
      || ' still open or in progress',
    false
  from public.snags s
  where s.project_id = p_project
    and s.status::text in ('open','in_progress')
  having count(*) > 0;

  -- Money. Waivable by a founder WITH a reason — a job can genuinely close
  -- with a disputed balance, and refusing outright would leave the record
  -- permanently open rather than closed-with-an-explanation.
  return query
  select
    'money'::text,
    case
      when f.still_to_bill <> 0 and f.still_to_collect <> 0
        then 'Rs. ' || f.still_to_bill::text || ' still to bill and Rs. '
             || f.still_to_collect::text || ' still to collect'
      when f.still_to_bill <> 0
        then 'Rs. ' || f.still_to_bill::text || ' of the revised contract is still to bill'
      else 'Rs. ' || f.still_to_collect::text || ' invoiced and not yet received'
    end,
    true
  from public.fn_project_final_account(p_project) f
  where f.still_to_bill <> 0 or f.still_to_collect <> 0;

  -- Retention the firm is still holding from its contractors. Waivable: a
  -- retention period routinely outlives the handover.
  return query
  select
    'retention'::text,
    'Rs. ' || f.retention_held::text || ' of contractor retention is still held',
    true
  from public.fn_project_final_account(p_project) f
  where f.retention_held > 0;
end $$;

revoke all on function public.fn_closeout_blockers(uuid) from public, anon;
grant execute on function public.fn_closeout_blockers(uuid) to authenticated;

-- ############################################################
-- ###  9. Close it — or refuse, naming what is in the way
-- ############################################################
create or replace function public.fn_close_project(
  p_project uuid,
  p_force   boolean default false,
  p_reason  text    default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_hard text;
  v_soft text;
  v_closeout uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  if not (public.is_member(p_project)
          and public.my_role()::text in ('founder','pm')) then
    raise exception 'Only a founder or PM on this project may close it.'
      using errcode = '42501';
  end if;

  select id into v_closeout
  from public.project_closeouts where project_id = p_project;
  if v_closeout is null then
    raise exception 'Open the close-out checklist before closing the project.';
  end if;
  if exists (select 1 from public.project_closeouts
             where id = v_closeout and closed_at is not null) then
    raise exception 'This project is already closed.';
  end if;

  -- Non-waivable blockers first, so the message never offers a force that
  -- would not help.
  select string_agg(b.detail, '; ') into v_hard
  from public.fn_closeout_blockers(p_project) b where not b.waivable;

  if v_hard is not null then
    raise exception 'Cannot close yet — %', v_hard;
  end if;

  select string_agg(b.detail, '; ') into v_soft
  from public.fn_closeout_blockers(p_project) b where b.waivable;

  if v_soft is not null and not p_force then
    raise exception
      'Cannot close yet — %. A founder may close anyway with a written reason.',
      v_soft;
  end if;

  -- Forcing is a founder's call, and it costs a sentence. Waiving with an
  -- empty reason would make the waiver invisible in six months.
  if v_soft is not null then
    if public.my_role()::text <> 'founder' then
      raise exception 'Only a founder may close past an unsettled balance.'
        using errcode = '42501';
    end if;
    if btrim(coalesce(p_reason, '')) = '' then
      raise exception 'Closing with money outstanding needs a written reason.';
    end if;
  end if;

  update public.project_closeouts
     set closed_at = now(),
         closed_by = auth.uid(),
         close_waiver_reason = case when v_soft is null then null
                                    else btrim(p_reason) end
   where id = v_closeout;

  update public.projects set status = 'completed' where id = p_project;
end $$;

revoke all on function public.fn_close_project(uuid, boolean, text) from public, anon;
grant execute on function public.fn_close_project(uuid, boolean, text) to authenticated;

-- Reopening. A close made in error must be undoable, and the audit trigger
-- records both acts.
create or replace function public.fn_reopen_project(p_project uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_founder() then
    raise exception 'Only a founder may reopen a closed project.'
      using errcode = '42501';
  end if;
  update public.project_closeouts
     set closed_at = null, closed_by = null, close_waiver_reason = null
   where project_id = p_project;
  update public.projects set status = 'active' where id = p_project;
end $$;

revoke all on function public.fn_reopen_project(uuid) from public, anon;
grant execute on function public.fn_reopen_project(uuid) to authenticated;

-- ############################################################
-- ###  10. Verify
-- ############################################################
-- One final SELECT — the Supabase SQL editor shows only the LAST result set.
--
-- Expect: tables = 2, enum = 1, policies = 5, no_delete = 0, fns = 5,
--         (3 on project_closeouts + 2 on closeout_items; cli_write is FOR ALL,
--          which pg_policies reports as ONE row with cmd = 'ALL')
--         checks = 4, audit_trgs = 2, idx = 1.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public'
      and table_name in ('project_closeouts','closeout_items'))          as tables,
  (select count(*) from pg_type where typname = 'closeout_category')     as enum,
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('project_closeouts','closeout_items'))           as policies,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'project_closeouts'
      and cmd = 'DELETE')                                                as no_delete,
  (select count(*) from pg_proc
    where proname in ('fn_open_closeout','fn_project_final_account',
                      'fn_closeout_blockers','fn_close_project',
                      'fn_reopen_project'))                              as fns,
  (select count(*) from pg_constraint
    where conname in ('pcl_closed_has_who','pcl_waiver_needs_close',
                      'pcl_score_has_date','cli_received_has_date'))     as checks,
  (select count(*) from pg_trigger
    where tgname in ('audit_pcl','audit_cli') and not tgisinternal)      as audit_trgs,
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'cli_closeout_idx')      as idx;
