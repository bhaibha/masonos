-- ============================================================
-- MASON OS — Migration 001: core (roles, projects, tasks, site log)
-- Run in Supabase SQL Editor or `supabase db push`
-- ============================================================

-- ---------- ENUMS ----------
create type user_role as enum ('founder','pm','supervisor','accounts');
create type project_status as enum ('active','on_hold','completed');
create type task_status as enum ('pending','done','partial','not_done');

-- ---------- PROFILES ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role user_role not null default 'supervisor',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- auto-create profile on signup (role assigned later by founder)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- ROLE HELPERS (used by all RLS policies) ----------
create or replace function public.my_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_founder()
returns boolean language sql stable as $$ select public.my_role() = 'founder' $$;

-- ---------- PROJECTS ----------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_name text,
  site_address text,
  status project_status not null default 'active',
  start_date date,
  target_end_date date,
  contract_value numeric(14,2),
  management_fee_pct numeric(5,2) default 0,
  created_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (project_id, user_id)
);

create or replace function public.is_member(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_founder()
      or public.my_role() = 'accounts'
      or exists (select 1 from public.project_members
                 where project_id = p_project and user_id = auth.uid())
$$;

-- ---------- TASKS (with rollover) ----------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  trade text,                          -- mason / electrician / plumber ...
  work_area text,                      -- e.g. "First floor slab"
  planned_date date not null,
  target_qty numeric(12,2),
  qty_unit text,                       -- sqft / rmt / nos / cum
  status task_status not null default 'pending',
  done_qty numeric(12,2),
  not_done_reason text,
  rolled_from uuid references public.tasks(id), -- rollover chain
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.tasks (project_id, planned_date);

-- rollover: call nightly (pg_cron) or on-demand — copies unfinished tasks to next day
create or replace function public.rollover_tasks(p_date date default current_date)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with src as (
    select * from public.tasks
    where planned_date = p_date
      and status in ('pending','partial','not_done')
      and not exists (select 1 from public.tasks c where c.rolled_from = tasks.id)
  ),
  ins as (
    insert into public.tasks
      (project_id, title, trade, work_area, planned_date, target_qty, qty_unit, rolled_from, created_by)
    select project_id, title, trade, work_area, p_date + 1,
           case when status='partial' then greatest(coalesce(target_qty,0)-coalesce(done_qty,0),0)
                else target_qty end,
           qty_unit, id, created_by
    from src returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;

-- ---------- DAILY SITE LOG ----------
create table public.site_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  log_date date not null default current_date,
  weather text,
  labour_mason int default 0,
  labour_helper int default 0,
  labour_other int default 0,
  work_summary text,
  issues text,
  photos text[] default '{}',          -- storage paths
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (project_id, log_date, created_by)
);

-- ---------- AUDIT LOG (append-only, trigger-fed) ----------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  table_name text not null,
  action text not null,               -- INSERT/UPDATE/DELETE
  row_id text,
  old_data jsonb,
  new_data jsonb
);

create or replace function public.fn_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (table_name, action, row_id, old_data, new_data)
  values (tg_table_name, tg_op,
          coalesce(new.id::text, old.id::text),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger audit_tasks     after insert or update or delete on public.tasks     for each row execute function public.fn_audit();
create trigger audit_site_logs after insert or update or delete on public.site_logs for each row execute function public.fn_audit();

-- ---------- RLS ----------
alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks           enable row level security;
alter table public.site_logs       enable row level security;
alter table public.audit_log       enable row level security;

-- profiles: everyone reads (need names in UI); only founder changes roles
create policy profiles_read  on public.profiles for select to authenticated using (true);
create policy profiles_self  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));
create policy profiles_admin on public.profiles for update to authenticated
  using (public.is_founder()) with check (public.is_founder());

-- projects: members see; founder writes
create policy projects_read  on public.projects for select to authenticated using (public.is_member(id));
create policy projects_write on public.projects for all    to authenticated
  using (public.is_founder()) with check (public.is_founder());

create policy members_read  on public.project_members for select to authenticated using (true);
create policy members_write on public.project_members for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

-- tasks: project members (founder/pm/supervisor) read+write; accounts read-only via is_member
create policy tasks_read  on public.tasks for select to authenticated using (public.is_member(project_id));
create policy tasks_write on public.tasks for insert to authenticated
  with check (public.is_member(project_id) and public.my_role() in ('founder','pm','supervisor'));
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_member(project_id) and public.my_role() in ('founder','pm','supervisor'));

-- site logs: same pattern
create policy logs_read  on public.site_logs for select to authenticated using (public.is_member(project_id));
create policy logs_write on public.site_logs for insert to authenticated
  with check (public.is_member(project_id) and public.my_role() in ('founder','pm','supervisor'));
create policy logs_update on public.site_logs for update to authenticated
  using (created_by = auth.uid() or public.is_founder());

-- audit: founder read-only; nobody writes directly (trigger is security definer)
create policy audit_read on public.audit_log for select to authenticated using (public.is_founder());
