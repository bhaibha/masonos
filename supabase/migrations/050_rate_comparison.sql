-- ============================================================
-- MASON OS — Migration 050: rate comparison / comparative statement (B3, M05)
--
-- A3 already covers PR -> PO -> GRN -> 3-way match. The piece missing from it
-- is the bit between the requisition and the order: getting three vendors to
-- quote the same list, laying the quotes side by side, choosing, and being able
-- to SHOW why that choice was made. That is what this migration adds.
--
-- ---------- THE WHOLE RECORD IS MONEY ----------
-- A PO is shared with site: the supervisor needs quantities and delivery dates,
-- so 012 revoked `po_lines.rate` column by column and left everything else
-- readable. A comparison has no such half. Every row of it exists to say what
-- somebody would charge, and a comparison with the rates removed is an empty
-- table. So the privacy here is at the ROW level, not the column level:
-- founder / PM / accounts see the record, a supervisor matches no policy and
-- gets zero rows. No column grants, and therefore none of the 027 trap where a
-- column added later is invisible until it is named in a grant.
--
-- Because nothing is revoked, the views are `security_invoker = true` and RLS
-- on the base tables IS the access control — the safest arrangement, since
-- there is no owner-run WHERE clause that could be dropped in a later edit and
-- silently leak the table (the 010/038 foot-gun).
--
-- ---------- THE LOWEST RATE IS COMPUTED, NEVER STORED ----------
-- `v_rc_matrix` flags the cheapest quote per item with a window function at
-- query time. Storing "is lowest" would be wrong the moment a rate is
-- corrected, and computing it in the browser would put the single number this
-- whole screen exists to produce outside Postgres. Same for every line total,
-- vendor subtotal, GST and grand total.
--
-- ---------- THE AWARD IS ALWAYS PER ITEM ----------
-- `rc_items.awarded_quote_id` is the only representation of a decision.
-- "Award everything to Vendor B" is a convenience that writes one row per item,
-- not a second way of recording the same fact — two representations would
-- eventually disagree, and the split award (steel from one, cement from
-- another) is the normal case anyway, not the exception.
--
-- ---------- A REASON IS REQUIRED WHEN THE LOWEST IS NOT CHOSEN ----------
-- Enforced in `fn_rc_award` / `fn_rc_award_item`, not in the form. This is the
-- justification an Open Book client reads: "we did not take the cheapest quote,
-- and here is the sentence written on the day, by name, with a timestamp."
-- A form-only check is a check that disappears the first time anyone calls the
-- API directly.
--
-- ---------- ONCE IT HAS PRODUCED A PO, IT FREEZES ----------
-- The RLS write policies refuse every insert / update / delete on a comparison
-- whose status is `ordered`. A comparative statement is EVIDENCE of how a
-- purchase was decided; if the quotes could still be edited afterwards, the
-- statement would restate itself and stop being evidence. Same argument as the
-- certified-bill snapshot in 032 and the question snapshot in 045.
--
-- ---------- NO CANCEL MECHANISM, BY DECISION ----------
-- The three removal mechanisms are chosen by what a record affects. Before
-- conversion a comparison affects nothing — no money posted, no stock, no
-- number in a vendor's hands — so it is a hard delete via
-- `fn_delete_comparison`. After conversion the thing to cancel is the PO, which
-- already has `fn_cancel_document`; the comparison stays as the record of why
-- that PO existed. Adding a third state here would give two places to look for
-- the same fact.
--
-- Idempotent: enum guarded, tables if-not-exists (with explicit add-column for
-- anything a later edit introduces — the 042 lesson), policies drop-then-create,
-- views drop-then-create (never `create or replace view` — the standing rule),
-- functions dropped by full signature before create (the 045 lesson).
-- ============================================================


-- ############################################################
-- ###  1. ENUM + NUMBER SERIES
-- ############################################################
do $$ begin
  create type rc_status as enum ('draft', 'decided', 'ordered');
exception when duplicate_object then null; end $$;

create sequence if not exists public.rc_number_seq;


-- ############################################################
-- ###  2. THE COMPARISON
-- ############################################################
create table if not exists public.rate_comparisons (
  id uuid primary key default gen_random_uuid(),
  comparison_no text not null unique
    default 'RC-' || lpad(nextval('public.rc_number_seq')::text, 6, '0'),
  project_id uuid not null references public.projects(id) on delete cascade,

  -- The purchase requisition this came from, when it came from one. Nullable
  -- because a comparison is also raised standalone — the founder sourcing tile
  -- rates before anybody has raised a PR is the ordinary case at the start of
  -- a finishes package.
  source_po_id uuid references public.purchase_orders(id) on delete set null,

  title text not null,
  status rc_status not null default 'draft',
  need_by date,
  notes text,

  raised_by uuid not null default auth.uid() references public.profiles(id),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Columns added after the create block first shipped go here, one statement
-- each. `create table if not exists` will NOT add them (the 042 lesson).
alter table public.rate_comparisons
  add column if not exists source_po_id uuid references public.purchase_orders(id) on delete set null;

create index if not exists rc_project_idx
  on public.rate_comparisons (project_id, created_at desc);


-- ############################################################
-- ###  3. THE ITEMS (rows of the statement)
-- ############################################################
-- `material_id` is OPTIONAL and `description` is always present.
--
-- The distinction matters at conversion time and is not arbitrary:
-- `po_lines.material_id` is NOT NULL because a PO feeds stock through the GRN
-- trigger, and stock is kept per material. So an item that is going to become a
-- purchase order must name a material from the master; free text is for the
-- things you compare but never stock — a labour rate, a hire charge, a fixing
-- quote. `fn_rc_to_po` refuses free-text items by name rather than inventing a
-- material record behind the user's back.
create table if not exists public.rc_items (
  id uuid primary key default gen_random_uuid(),
  comparison_id uuid not null
    references public.rate_comparisons(id) on delete cascade,

  material_id uuid references public.materials(id),
  -- Snapshot of what was asked for. Set from the material's name when one is
  -- linked, so renaming a material later never restates a signed statement.
  description text not null,
  unit text not null,
  qty numeric(12,2) not null check (qty > 0),
  spec text,

  -- Provenance when the comparison was generated from a PR.
  po_line_id uuid references public.po_lines(id) on delete set null,

  -- THE decision. Set null-able FK so deleting a quote clears the award rather
  -- than blocking or, worse, leaving a dangling winner.
  awarded_quote_id uuid,
  award_reason text,
  awarded_by uuid references public.profiles(id),
  awarded_at timestamptz,

  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists rc_items_cmp_idx
  on public.rc_items (comparison_id, sort_order);


-- ############################################################
-- ###  4. THE VENDOR COLUMNS
-- ############################################################
-- The 017 flexible-vendor shape: optional link to the registered vendor plus
-- free text, so a quote from somebody not yet on the vendor list can still be
-- compared today and registered later.
create table if not exists public.rc_vendors (
  id uuid primary key default gen_random_uuid(),
  comparison_id uuid not null
    references public.rate_comparisons(id) on delete cascade,

  vendor_id uuid references public.vendors(id),
  vendor_name text,

  quote_ref text,
  quote_date date,
  terms text,
  payment_terms text,
  delivery_days int check (delivery_days is null or delivery_days >= 0),
  gst_pct numeric(5,2) not null default 18 check (gst_pct >= 0 and gst_pct <= 100),

  -- Set by fn_rc_to_po. Its presence is what makes conversion idempotent —
  -- there is no separate "already converted" flag to fall out of step.
  po_id uuid references public.purchase_orders(id) on delete set null,

  sort_order int not null default 100,
  created_at timestamptz not null default now(),

  constraint rc_vendor_named check (
    vendor_id is not null or coalesce(btrim(vendor_name), '') <> ''
  )
);

create index if not exists rc_vendors_cmp_idx
  on public.rc_vendors (comparison_id, sort_order);

-- The same vendor cannot appear twice in one comparison. Two indexes because
-- the duplicate arrives two different ways: picking the registered vendor
-- twice, or typing the same name twice with different spacing or case (the 041
-- lesson — case and a trailing space are how duplicates actually get created).
create unique index if not exists rc_vendor_registered_uk
  on public.rc_vendors (comparison_id, vendor_id) where vendor_id is not null;

create unique index if not exists rc_vendor_freetext_uk
  on public.rc_vendors (comparison_id, lower(btrim(vendor_name)))
  where vendor_id is null;


-- ############################################################
-- ###  5. THE CELLS
-- ############################################################
-- One row per (item, vendor) that was actually quoted. A missing row means
-- "did not quote", which is a different fact from a rate of zero and is shown
-- as such — a vendor who leaves an item out has not given you a comparable
-- total, and `items_missing` on the totals view says so.
--
-- There is deliberately NO generated line_total column here: the quantity lives
-- on rc_items and a generated column cannot reach another table. The arithmetic
-- is in `v_rc_matrix` instead, which is still Postgres — the browser never
-- multiplies a rate by a quantity.
create table if not exists public.rc_quotes (
  id uuid primary key default gen_random_uuid(),
  rc_item_id uuid not null references public.rc_items(id) on delete cascade,
  rc_vendor_id uuid not null references public.rc_vendors(id) on delete cascade,

  rate numeric(14,2) not null check (rate >= 0),
  remark text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (rc_item_id, rc_vendor_id)
);

create index if not exists rc_quotes_vendor_idx
  on public.rc_quotes (rc_vendor_id);

-- Deferred so the two tables can be created in either order on a rebuild.
do $$ begin
  alter table public.rc_items
    add constraint rc_items_awarded_fk
    foreign key (awarded_quote_id) references public.rc_quotes(id)
    on delete set null;
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  6. RLS
-- ############################################################
alter table public.rate_comparisons enable row level security;
alter table public.rc_items         enable row level security;
alter table public.rc_vendors       enable row level security;
alter table public.rc_quotes        enable row level security;

-- One helper predicate, written once and reused by all four tables, so the
-- money-role gate cannot drift between them. STABLE, not volatile, so the
-- planner may cache it within a statement.
create or replace function public.rc_may_read(p_comparison uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.rate_comparisons c
    where c.id = p_comparison
      and public.is_member(c.project_id)
      and public.my_role() in ('founder', 'pm', 'accounts')
  );
$$;

-- Writable only while the comparison has not yet produced a PO. The freeze is
-- here rather than in the RPCs because an ordinary PostgREST update would walk
-- straight past an RPC-only check.
create or replace function public.rc_may_write(p_comparison uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.rate_comparisons c
    where c.id = p_comparison
      and public.is_member(c.project_id)
      and public.my_role() in ('founder', 'pm', 'accounts')
      and c.status::text <> 'ordered'
  );
$$;

revoke all on function public.rc_may_read(uuid)  from public, anon;
revoke all on function public.rc_may_write(uuid) from public, anon;
grant execute on function public.rc_may_read(uuid)  to authenticated;
grant execute on function public.rc_may_write(uuid) to authenticated;

-- ---------- rate_comparisons ----------
drop policy if exists rc_read on public.rate_comparisons;
create policy rc_read on public.rate_comparisons
  for select to authenticated
  using (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'accounts')
  );

drop policy if exists rc_insert on public.rate_comparisons;
create policy rc_insert on public.rate_comparisons
  for insert to authenticated
  with check (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'accounts')
  );

-- Header edits (title, need_by, notes) stay open until the comparison is
-- ordered. `status`, `decided_*` and the award columns are moved only by the
-- RPCs; an update policy cannot restrict which columns are written, which is
-- exactly why the award lives behind fn_rc_award rather than behind a form.
drop policy if exists rc_update on public.rate_comparisons;
create policy rc_update on public.rate_comparisons
  for update to authenticated
  using (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'accounts')
    and status::text <> 'ordered'
  )
  with check (
    public.is_member(project_id)
    and public.my_role() in ('founder', 'pm', 'accounts')
  );

-- No DELETE policy — removal goes through fn_delete_comparison, which checks
-- for a generated PO first. RLS is default-deny, so that RPC is the only route.

-- ---------- rc_items ----------
drop policy if exists rc_items_read on public.rc_items;
create policy rc_items_read on public.rc_items
  for select to authenticated using (public.rc_may_read(comparison_id));

drop policy if exists rc_items_write on public.rc_items;
create policy rc_items_write on public.rc_items
  for all to authenticated
  using (public.rc_may_write(comparison_id))
  with check (public.rc_may_write(comparison_id));

-- ---------- rc_vendors ----------
drop policy if exists rc_vendors_read on public.rc_vendors;
create policy rc_vendors_read on public.rc_vendors
  for select to authenticated using (public.rc_may_read(comparison_id));

drop policy if exists rc_vendors_write on public.rc_vendors;
create policy rc_vendors_write on public.rc_vendors
  for all to authenticated
  using (public.rc_may_write(comparison_id))
  with check (public.rc_may_write(comparison_id));

-- ---------- rc_quotes ----------
drop policy if exists rc_quotes_read on public.rc_quotes;
create policy rc_quotes_read on public.rc_quotes
  for select to authenticated
  using (exists (
    select 1 from public.rc_items i
    where i.id = rc_item_id and public.rc_may_read(i.comparison_id)
  ));

drop policy if exists rc_quotes_write on public.rc_quotes;
create policy rc_quotes_write on public.rc_quotes
  for all to authenticated
  using (exists (
    select 1 from public.rc_items i
    where i.id = rc_item_id and public.rc_may_write(i.comparison_id)
  ))
  with check (exists (
    select 1 from public.rc_items i
    where i.id = rc_item_id and public.rc_may_write(i.comparison_id)
  ));


-- ############################################################
-- ###  6b. THE AWARD IS RPC-ONLY, ENFORCED
-- ############################################################
-- An RLS UPDATE policy cannot say WHICH columns may be written, so the policies
-- above — which exist to let somebody fix a title or a need-by date — would also
-- let a PostgREST PATCH set `status` to 'decided', or stamp `awarded_quote_id`
-- straight onto a line with no reason and no audit row. That is the same hole
-- 021 found on `purchase_orders`, where the RPC alone was not enough and a
-- CHECK constraint had to stand behind it.
--
-- The discriminator here is `current_user`: PostgREST runs as `authenticated`,
-- while every RPC in this migration is SECURITY DEFINER and therefore runs as
-- the table owner. So the decision columns are writable from the functions and
-- refused from the client, with a message that names the way in.
--
-- It RAISES rather than silently restoring the old value: a PATCH sends only
-- the columns that changed, so this fires only when somebody deliberately wrote
-- one of these, and silently ignoring that would hide the mistake.
create or replace function public.fn_rc_guard_decision()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' then
    if new.status is distinct from old.status
       or new.decided_by is distinct from old.decided_by
       or new.decided_at is distinct from old.decided_at then
      raise exception
        'A comparison''s status is a consequence of its award. Use fn_rc_award / fn_rc_award_item / fn_rc_to_po.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists rc_guard_decision on public.rate_comparisons;
create trigger rc_guard_decision
  before update on public.rate_comparisons
  for each row execute function public.fn_rc_guard_decision();

create or replace function public.fn_rc_guard_award()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' then
    if new.awarded_quote_id is distinct from old.awarded_quote_id
       or new.award_reason is distinct from old.award_reason
       or new.awarded_by is distinct from old.awarded_by
       or new.awarded_at is distinct from old.awarded_at then
      raise exception
        'An award carries a reason and a name. Use fn_rc_award_item.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists rc_guard_award on public.rc_items;
create trigger rc_guard_award
  before update on public.rc_items
  for each row execute function public.fn_rc_guard_award();

-- Likewise the generated-PO back-link: it is what makes conversion idempotent,
-- so clearing it by hand would allow a second set of orders off one award.
create or replace function public.fn_rc_guard_po_link()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' and new.po_id is distinct from old.po_id then
    raise exception
      'The purchase-order link is written by fn_rc_to_po and is what stops a second order being raised from the same award.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists rc_guard_po_link on public.rc_vendors;
create trigger rc_guard_po_link
  before update on public.rc_vendors
  for each row execute function public.fn_rc_guard_po_link();


-- ############################################################
-- ###  7. AUDIT
-- ############################################################
-- All four tables: rates are money, and the award is an approval. Rule 5 of
-- CLAUDE.md covers both.
drop trigger if exists audit_rate_comparisons on public.rate_comparisons;
create trigger audit_rate_comparisons
  after insert or update or delete on public.rate_comparisons
  for each row execute function public.fn_audit();

drop trigger if exists audit_rc_items on public.rc_items;
create trigger audit_rc_items
  after insert or update or delete on public.rc_items
  for each row execute function public.fn_audit();

drop trigger if exists audit_rc_vendors on public.rc_vendors;
create trigger audit_rc_vendors
  after insert or update or delete on public.rc_vendors
  for each row execute function public.fn_audit();

drop trigger if exists audit_rc_quotes on public.rc_quotes;
create trigger audit_rc_quotes
  after insert or update or delete on public.rc_quotes
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  8. THE COMPARATIVE STATEMENT — views
-- ############################################################
-- Every figure on the screen and on the PDF comes from these three views.
-- security_invoker, so the RLS above is the only access control in play.

drop view if exists public.v_rc_summary cascade;
drop view if exists public.v_rc_vendor_totals cascade;
drop view if exists public.v_rc_matrix cascade;

-- ---------- one row per cell of the grid ----------
create view public.v_rc_matrix with (security_invoker = true) as
select
  i.comparison_id,
  i.id                              as item_id,
  i.sort_order                      as item_order,
  i.description,
  i.unit,
  i.qty,
  i.material_id,
  i.spec,
  i.awarded_quote_id,
  i.award_reason,

  v.id                              as vendor_col_id,
  v.sort_order                      as vendor_order,
  coalesce(vn.name, v.vendor_name)  as vendor_display,
  v.vendor_id,
  v.gst_pct,
  v.delivery_days,
  v.terms,
  v.payment_terms,
  v.quote_ref,

  q.id                              as quote_id,
  q.rate,
  q.remark,
  case when q.rate is not null
       then round(q.rate * i.qty, 2) end            as line_total,

  -- The one number this whole module exists to produce. A window over the
  -- item's quotes; min() ignores nulls, so a vendor who did not quote cannot
  -- accidentally become the cheapest.
  coalesce(q.rate is not null
           and q.rate = min(q.rate) over (partition by i.id), false)
                                                    as is_lowest,

  coalesce(i.awarded_quote_id = q.id, false)        as is_awarded
from public.rc_items i
join public.rc_vendors v  on v.comparison_id = i.comparison_id
left join public.rc_quotes q
       on q.rc_item_id = i.id and q.rc_vendor_id = v.id
left join public.vendors vn on vn.id = v.vendor_id;

grant select on public.v_rc_matrix to authenticated;

-- ---------- one row per vendor column ----------
create view public.v_rc_vendor_totals with (security_invoker = true) as
with per_vendor as (
  select
    m.comparison_id,
    m.vendor_col_id,
    m.vendor_display,
    m.vendor_id,
    m.gst_pct,
    m.delivery_days,
    m.terms,
    m.payment_terms,
    m.quote_ref,
    m.vendor_order,
    count(*) filter (where m.rate is not null)::int  as items_quoted,
    count(*) filter (where m.rate is null)::int      as items_missing,
    coalesce(sum(m.line_total), 0)::numeric(14,2)    as subtotal,
    coalesce(sum(m.line_total) filter (where m.is_awarded), 0)::numeric(14,2)
                                                     as awarded_value
  from public.v_rc_matrix m
  group by m.comparison_id, m.vendor_col_id, m.vendor_display, m.vendor_id,
           m.gst_pct, m.delivery_days, m.terms, m.payment_terms, m.quote_ref,
           m.vendor_order
),
priced as (
  select
    p.*,
    round(p.subtotal * p.gst_pct / 100, 2)                as gst_amount,
    round(p.subtotal * (1 + p.gst_pct / 100), 2)          as grand_total
  from per_vendor p
)
select
  pr.*,
  -- Only a vendor who priced EVERY item can be called the lowest: a total
  -- built from eight of ten items is cheaper for a reason that has nothing to
  -- do with being cheap.
  coalesce(
    pr.items_missing = 0
    and pr.grand_total = min(case when pr.items_missing = 0 then pr.grand_total end)
                             over (partition by pr.comparison_id),
    false)                                               as is_lowest_total
from priced pr;

grant select on public.v_rc_vendor_totals to authenticated;

-- ---------- one row per comparison ----------
create view public.v_rc_summary with (security_invoker = true) as
select
  c.id            as comparison_id,
  c.project_id,
  c.comparison_no,
  c.title,
  c.status,
  c.need_by,
  c.source_po_id,
  c.created_at,
  (select count(*)::int from public.rc_items i
    where i.comparison_id = c.id)                          as item_count,
  (select count(*)::int from public.rc_vendors v
    where v.comparison_id = c.id)                          as vendor_count,
  (select count(*)::int from public.rc_items i
    where i.comparison_id = c.id
      and i.awarded_quote_id is not null)                  as items_awarded,
  (select min(t.grand_total) from public.v_rc_vendor_totals t
    where t.comparison_id = c.id and t.items_missing = 0)  as lowest_total,
  (select max(t.grand_total) from public.v_rc_vendor_totals t
    where t.comparison_id = c.id and t.items_missing = 0)  as highest_total,
  (select coalesce(sum(m.line_total), 0)::numeric(14,2)
     from public.v_rc_matrix m
    where m.comparison_id = c.id and m.is_awarded)         as awarded_subtotal,
  -- How many lines went to somebody other than the cheapest. This is the
  -- number an Open Book client counts, so it is computed rather than claimed.
  (select count(*)::int from public.v_rc_matrix m
    where m.comparison_id = c.id and m.is_awarded and not m.is_lowest)
                                                           as awarded_off_lowest
from public.rate_comparisons c;

grant select on public.v_rc_summary to authenticated;


-- ############################################################
-- ###  9. BUILD A COMPARISON FROM A PURCHASE REQUISITION
-- ############################################################
-- Copies the PR's lines rather than linking to them, for the same reason
-- fn_apply_itp_template copied and 032 snapshotted: the statement must still
-- read correctly if somebody later edits the requisition.
drop function if exists public.fn_rc_from_pr(uuid, text);
create function public.fn_rc_from_pr(p_po uuid, p_title text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_status  text;
  v_needby  date;
  v_id      uuid;
  v_n       int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm', 'accounts') then
    raise exception 'Your role cannot build a rate comparison.'
      using errcode = '42501';
  end if;

  select po.project_id, po.status::text, po.need_by
    into v_project, v_status, v_needby
  from public.purchase_orders po where po.id = p_po;

  if v_project is null then
    raise exception 'That purchase request no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  -- Only a PR still awaiting rates. Once a PO is approved the rate decision has
  -- already been taken, and a comparison raised afterwards would be a rationale
  -- written after the fact — the one thing this record must never be.
  if v_status <> 'requested' then
    raise exception
      'That order is already %. A comparison is raised BEFORE rates are approved, not after.',
      v_status;
  end if;

  select count(*) into v_n from public.po_lines where po_id = p_po;
  if v_n = 0 then
    raise exception 'That request has no lines to compare.';
  end if;

  insert into public.rate_comparisons (project_id, source_po_id, title, need_by)
  values (v_project, p_po,
          coalesce(nullif(btrim(p_title), ''), 'Rate comparison'), v_needby)
  returning id into v_id;

  insert into public.rc_items
    (comparison_id, material_id, description, unit, qty, po_line_id, sort_order)
  select v_id, m.id, m.name, m.unit, pl.qty_ordered, pl.id,
         (row_number() over (order by m.name))::int
  from public.po_lines pl
  join public.materials m on m.id = pl.material_id
  where pl.po_id = p_po;

  return v_id;
end $$;

revoke all on function public.fn_rc_from_pr(uuid, text) from public, anon;
grant execute on function public.fn_rc_from_pr(uuid, text) to authenticated;


-- ############################################################
-- ### 10. AWARDING
-- ############################################################
-- Founder/PM only, mirroring `canApprovePO` in 012: choosing the rate that will
-- be ordered IS the approval, and accounts do not approve POs. Accounts build
-- and read comparisons — they are usually the ones chasing the quotes — but the
-- decision sits with the person who signs the order.

-- ---------- one item ----------
drop function if exists public.fn_rc_award_item(uuid, uuid, text);
create function public.fn_rc_award_item(
  p_item   uuid,
  p_quote  uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cmp     uuid;
  v_project uuid;
  v_status  text;
  v_desc    text;
  v_rate    numeric(14,2);
  v_low     numeric(14,2);
  v_vendor  text;
  v_reason  text := nullif(btrim(p_reason), '');
  v_left    int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may award a rate comparison.'
      using errcode = '42501';
  end if;

  select i.comparison_id, i.description, c.project_id, c.status::text
    into v_cmp, v_desc, v_project, v_status
  from public.rc_items i
  join public.rate_comparisons c on c.id = i.comparison_id
  where i.id = p_item;

  if v_cmp is null then
    raise exception 'That comparison line no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_status = 'ordered' then
    raise exception
      'This comparison has already been converted to a purchase order. Cancel the order to change the award.';
  end if;

  select q.rate, coalesce(vn.name, v.vendor_name)
    into v_rate, v_vendor
  from public.rc_quotes q
  join public.rc_vendors v on v.id = q.rc_vendor_id
  left join public.vendors vn on vn.id = v.vendor_id
  where q.id = p_quote and q.rc_item_id = p_item;

  if v_rate is null then
    raise exception 'That quote does not belong to this line.';
  end if;

  select min(q.rate) into v_low
  from public.rc_quotes q where q.rc_item_id = p_item;

  -- The audit justification. Demanded here so it cannot be skipped by anything
  -- that talks to the database, form or not.
  if v_rate > v_low and v_reason is null then
    raise exception
      '% quoted % for "%" but the lowest is %. Give a reason for not taking the lowest rate.',
      v_vendor, v_rate, v_desc, v_low;
  end if;

  update public.rc_items
     set awarded_quote_id = p_quote,
         -- A reason on the cheapest quote would be noise; the field means
         -- "why not the lowest", so it is cleared when it does not apply.
         award_reason     = case when v_rate > v_low then v_reason end,
         awarded_by       = auth.uid(),
         awarded_at       = now()
   where id = p_item;

  select count(*) into v_left from public.rc_items
   where comparison_id = v_cmp and awarded_quote_id is null;

  update public.rate_comparisons
     set status     = case when v_left = 0 then 'decided' else 'draft' end::rc_status,
         decided_by = case when v_left = 0 then auth.uid() end,
         decided_at = case when v_left = 0 then now() end,
         updated_at = now()
   where id = v_cmp;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values ('rc_items', 'AWARD', p_item::text,
          jsonb_build_object('lowest_rate', v_low),
          jsonb_build_object('quote_id', p_quote, 'vendor', v_vendor,
                             'rate', v_rate, 'reason', v_reason,
                             'awarded_by', auth.uid()));
end $$;

revoke all on function public.fn_rc_award_item(uuid, uuid, text) from public, anon;
grant execute on function public.fn_rc_award_item(uuid, uuid, text) to authenticated;


-- ---------- the whole comparison to one vendor ----------
-- A convenience over the per-item award, not a second representation of it:
-- it writes exactly the same rows fn_rc_award_item would, one per line.
drop function if exists public.fn_rc_award(uuid, uuid, text);
create function public.fn_rc_award(
  p_comparison uuid,
  p_vendor_col uuid,
  p_reason     text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_status  text;
  v_vendor  text;
  v_missing int;
  v_total   numeric(14,2);
  v_low     numeric(14,2);
  v_reason  text := nullif(btrim(p_reason), '');
  v_n       int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may award a rate comparison.'
      using errcode = '42501';
  end if;

  select c.project_id, c.status::text into v_project, v_status
  from public.rate_comparisons c where c.id = p_comparison;

  if v_project is null then
    raise exception 'That comparison no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_status = 'ordered' then
    raise exception
      'This comparison has already been converted to a purchase order. Cancel the order to change the award.';
  end if;

  select t.vendor_display, t.items_missing, t.grand_total
    into v_vendor, v_missing, v_total
  from public.v_rc_vendor_totals t
  where t.comparison_id = p_comparison and t.vendor_col_id = p_vendor_col;

  if v_vendor is null then
    raise exception 'That vendor is not part of this comparison.';
  end if;

  -- A whole-comparison award to somebody who left items unpriced would quietly
  -- leave those lines unawarded and the total meaningless. Award per item
  -- instead — the split award is the normal answer here.
  if v_missing > 0 then
    select count(*) into v_n from public.rc_items
     where comparison_id = p_comparison;
    raise exception
      '% has not quoted % of the % item(s). Award those lines individually, or get the missing rates.',
      v_vendor, v_missing, v_n;
  end if;

  select min(t.grand_total) into v_low
  from public.v_rc_vendor_totals t
  where t.comparison_id = p_comparison and t.items_missing = 0;

  if v_total > v_low and v_reason is null then
    raise exception
      '% totals % against the lowest complete quote of %. Give a reason for not taking the lowest.',
      v_vendor, v_total, v_low;
  end if;

  -- One row per item, exactly as the per-item path writes them. The reason is
  -- stamped only on the lines that actually went above the cheapest quote.
  -- The per-line "is this the cheapest quote" test is a correlated subquery
  -- rather than a LATERAL in the FROM clause: a lateral there would have to
  -- reach back into the UPDATE target, which is exactly the sort of thing that
  -- parses on one Postgres version and not the next.
  update public.rc_items i
     set awarded_quote_id = q.id,
         award_reason     = case
           when q.rate > (select min(x.rate) from public.rc_quotes x
                           where x.rc_item_id = i.id)
           then v_reason end,
         awarded_by       = auth.uid(),
         awarded_at       = now()
  from public.rc_quotes q
  where i.comparison_id = p_comparison
    and q.rc_item_id    = i.id
    and q.rc_vendor_id  = p_vendor_col;

  get diagnostics v_n = row_count;

  update public.rate_comparisons
     set status = 'decided'::rc_status,
         decided_by = auth.uid(),
         decided_at = now(),
         updated_at = now()
   where id = p_comparison;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values ('rate_comparisons', 'AWARD', p_comparison::text,
          jsonb_build_object('lowest_complete_total', v_low),
          jsonb_build_object('vendor_col_id', p_vendor_col, 'vendor', v_vendor,
                             'grand_total', v_total, 'reason', v_reason,
                             'lines', v_n, 'awarded_by', auth.uid()));
  return v_n;
end $$;

revoke all on function public.fn_rc_award(uuid, uuid, text) from public, anon;
grant execute on function public.fn_rc_award(uuid, uuid, text) to authenticated;


-- ---------- undo ----------
drop function if exists public.fn_rc_clear_award(uuid);
create function public.fn_rc_clear_award(p_comparison uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_project uuid; v_status text;
begin
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may change an award.'
      using errcode = '42501';
  end if;

  select c.project_id, c.status::text into v_project, v_status
  from public.rate_comparisons c where c.id = p_comparison;

  if v_project is null then
    raise exception 'That comparison no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  if v_status = 'ordered' then
    raise exception
      'A purchase order has already been raised from this comparison. Cancel the order first.';
  end if;

  update public.rc_items
     set awarded_quote_id = null, award_reason = null,
         awarded_by = null, awarded_at = null
   where comparison_id = p_comparison;

  update public.rate_comparisons
     set status = 'draft'::rc_status, decided_by = null, decided_at = null,
         updated_at = now()
   where id = p_comparison;
end $$;

revoke all on function public.fn_rc_clear_award(uuid) from public, anon;
grant execute on function public.fn_rc_clear_award(uuid) to authenticated;


-- ############################################################
-- ### 11. CONVERT TO PURCHASE ORDER
-- ############################################################
-- Reuses the A3 flow rather than reinventing it: the rows written here are
-- ordinary `purchase_orders` at status 'approved' with rated `po_lines`, so
-- receiving, the 3-way match, the PO PDF and cancellation all work on them
-- untouched. A split award produces one PO per vendor, which is what a vendor
-- expects to receive.
--
-- Idempotent by construction: `rc_vendors.po_id` records the order raised for
-- that column, and its presence is the refusal. No second "converted" flag to
-- fall out of step with reality.
drop function if exists public.fn_rc_to_po(uuid, date);
create function public.fn_rc_to_po(p_comparison uuid, p_need_by date default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_status  text;
  v_no      text;
  v_needby  date;
  v_free    text;
  v_n       int;
  v_pos     int := 0;
  r         record;
  v_po      uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may raise a purchase order.'
      using errcode = '42501';
  end if;

  select c.project_id, c.status::text, c.comparison_no, c.need_by
    into v_project, v_status, v_no, v_needby
  from public.rate_comparisons c where c.id = p_comparison;

  if v_project is null then
    raise exception 'That comparison no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  if exists (select 1 from public.rc_vendors
              where comparison_id = p_comparison and po_id is not null) then
    raise exception
      'A purchase order has already been raised from %. Cancel it if the award was wrong.', v_no;
  end if;

  select count(*) into v_n from public.rc_items
   where comparison_id = p_comparison and awarded_quote_id is not null;
  if v_n = 0 then
    raise exception 'Nothing has been awarded yet — choose a rate for at least one line first.';
  end if;

  -- A PO line feeds stock through the GRN trigger, and stock is kept per
  -- material, so `po_lines.material_id` is NOT NULL. Rather than invent a
  -- material master record silently, name the lines that need one.
  select string_agg(i.description, ', ' order by i.sort_order)
    into v_free
  from public.rc_items i
  where i.comparison_id = p_comparison
    and i.awarded_quote_id is not null
    and i.material_id is null;

  if v_free is not null then
    raise exception
      'These awarded lines are free text and have no material linked, so they cannot become purchase-order lines: %. Link a material to each, or drop them from the order and record them as an expense.',
      v_free;
  end if;

  -- One PO per vendor who won something.
  for r in
    select v.id as vendor_col_id, v.vendor_id,
           coalesce(vn.name, v.vendor_name) as vendor_display
    from public.rc_vendors v
    left join public.vendors vn on vn.id = v.vendor_id
    where v.comparison_id = p_comparison
      and exists (
        select 1 from public.rc_items i
        join public.rc_quotes q on q.id = i.awarded_quote_id
        where i.comparison_id = p_comparison and q.rc_vendor_id = v.id)
    order by v.sort_order
  loop
    insert into public.purchase_orders
      (project_id, vendor_id, vendor_name, status, need_by, notes,
       approved_by, approved_at)
    values
      (v_project, r.vendor_id, r.vendor_display, 'approved'::po_status,
       coalesce(p_need_by, v_needby),
       'Raised from comparative statement ' || v_no,
       auth.uid(), now())
    returning id into v_po;

    insert into public.po_lines (po_id, material_id, qty_ordered, rate)
    select v_po, i.material_id, i.qty, q.rate
    from public.rc_items i
    join public.rc_quotes q on q.id = i.awarded_quote_id
    where i.comparison_id = p_comparison and q.rc_vendor_id = r.vendor_col_id;

    update public.rc_vendors set po_id = v_po where id = r.vendor_col_id;
    v_pos := v_pos + 1;
  end loop;

  update public.rate_comparisons
     set status = 'ordered'::rc_status, updated_at = now()
   where id = p_comparison;

  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values ('rate_comparisons', 'CONVERT', p_comparison::text,
          jsonb_build_object('status', v_status),
          jsonb_build_object('purchase_orders', v_pos, 'by', auth.uid()));

  return v_pos;
end $$;

revoke all on function public.fn_rc_to_po(uuid, date) from public, anon;
grant execute on function public.fn_rc_to_po(uuid, date) to authenticated;


-- ############################################################
-- ### 12. DELETE
-- ############################################################
-- Its own RPC rather than a branch in fn_delete_record, following
-- fn_delete_activity (042): the reference check is specific to this module and
-- bolting it onto a 700-line function that every other module also edits is how
-- that function eventually breaks for somebody else.
drop function if exists public.fn_delete_comparison(uuid);
create function public.fn_delete_comparison(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_project uuid; v_no text; v_n int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may delete a rate comparison.'
      using errcode = '42501';
  end if;

  select c.project_id, c.comparison_no into v_project, v_no
  from public.rate_comparisons c where c.id = p_id;

  if v_project is null then
    raise exception 'That comparison no longer exists.';
  end if;
  if not public.is_member(v_project) then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;

  select count(*) into v_n from public.rc_vendors
   where comparison_id = p_id and po_id is not null;
  if v_n > 0 then
    raise exception
      '% has produced % purchase order(s). It is the record of why they were raised, so it stays — cancel the order instead.',
      v_no, v_n;
  end if;

  delete from public.rate_comparisons where id = p_id;
end $$;

revoke all on function public.fn_delete_comparison(uuid) from public, anon;
grant execute on function public.fn_delete_comparison(uuid) to authenticated;


-- ############################################################
-- ### 13. VERIFY
-- ############################################################
-- Counts arities as well as names: two rows for one function means a drop was
-- missed and a later call becomes ambiguous (the 035 lesson).
select p.proname, count(*)::int as arities
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_rc_from_pr', 'fn_rc_award', 'fn_rc_award_item',
                    'fn_rc_clear_award', 'fn_rc_to_po', 'fn_delete_comparison',
                    'rc_may_read', 'rc_may_write', 'fn_rc_guard_decision',
                    'fn_rc_guard_award', 'fn_rc_guard_po_link')
group by p.proname
order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('rate_comparisons', 'rc_items', 'rc_vendors', 'rc_quotes',
                     'v_rc_matrix', 'v_rc_vendor_totals', 'v_rc_summary')
order by table_name;
