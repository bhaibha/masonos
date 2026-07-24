-- ============================================================
-- MASON OS — Migration 016: Variation Orders (Module 26)
--
--   variation_orders     — scope changes with a cost impact (+/-)
--   v_project_contract    — original + approved variations = revised value
--
-- The whole table is a money surface, so RLS restricts it to founder/pm/
-- accounts (supervisors see NOTHING — no per-column tricks needed here, unlike
-- po_lines). PM raises, founder approves. Revised contract value is computed in
-- Postgres (CLAUDE.md rule 2), never in the browser.
--
-- Idempotent: enum guarded, table if-not-exists, policies drop-then-create,
-- views drop/replace, enum casts explicit.
-- ============================================================

do $$ begin
  create type vo_status as enum ('submitted', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

create sequence if not exists public.vo_number_seq;

create table if not exists public.variation_orders (
  id uuid primary key default gen_random_uuid(),
  vo_number text not null unique default 'VO-' || lpad(nextval('public.vo_number_seq')::text, 4, '0'),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  description text,
  -- positive = extra scope/cost, negative = omission/credit
  cost_impact numeric(14,2) not null,
  status vo_status not null default 'submitted',
  raised_by uuid not null default auth.uid() references public.profiles(id),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vo_project_idx on public.variation_orders (project_id, created_at desc);

-- ---------- REVISED CONTRACT VALUE ----------
-- Owner-run (reads projects.contract_value, which 010 revoked from
-- authenticated) with its own role check, like v_project_commercials.
create or replace view public.v_project_contract as
select
  p.id as project_id,
  coalesce(p.contract_value, 0)::numeric(14,2)                 as contract_value,
  coalesce(v.approved_value, 0)::numeric(14,2)                 as variations_value,
  coalesce(v.pending_value, 0)::numeric(14,2)                  as pending_value,
  (coalesce(p.contract_value, 0) + coalesce(v.approved_value, 0))::numeric(14,2) as revised_contract_value
from public.projects p
left join (
  select project_id,
         sum(cost_impact) filter (where status = 'approved') as approved_value,
         sum(cost_impact) filter (where status = 'submitted') as pending_value
  from public.variation_orders
  group by project_id
) v on v.project_id = p.id
where public.is_member(p.id)
  and public.my_role() in ('founder', 'pm', 'accounts');

grant select on public.v_project_contract to authenticated;

-- ---------- AUDIT ----------
drop trigger if exists audit_variation_orders on public.variation_orders;
create trigger audit_variation_orders
  after insert or update or delete on public.variation_orders
  for each row execute function public.fn_audit();

-- ---------- RLS ----------
alter table public.variation_orders enable row level security;

-- money-gated read: founder/pm/accounts only
drop policy if exists vo_read on public.variation_orders;
create policy vo_read on public.variation_orders for select to authenticated
  using (public.is_member(project_id)
         and public.my_role() in ('founder', 'pm', 'accounts'));

-- PM (or founder) raises
drop policy if exists vo_insert on public.variation_orders;
create policy vo_insert on public.variation_orders for insert to authenticated
  with check (public.is_member(project_id)
              and public.my_role() in ('founder', 'pm'));

-- founder approves/rejects; the raiser may still edit their own while submitted
drop policy if exists vo_update on public.variation_orders;
create policy vo_update on public.variation_orders for update to authenticated
  using (public.is_member(project_id)
         and (public.my_role() = 'founder'
              or (raised_by = auth.uid() and status = 'submitted')));
