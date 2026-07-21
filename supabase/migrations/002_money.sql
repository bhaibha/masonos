-- ============================================================
-- MASON OS — Migration 002: money (expenses, budgets, petty cash)
-- Money math lives HERE, never in the browser.
-- ============================================================

create type expense_source as enum ('bank','upi','petty_cash','credit');

-- ---------- CATEGORIES (seeded, editable by founder) ----------
create table public.expense_categories (
  id serial primary key,
  name text not null unique,
  sort int default 100
);
insert into public.expense_categories (name, sort) values
 ('Cement',10),('Steel',20),('Sand & Aggregate',30),('Bricks/Blocks',40),
 ('RMC',50),('Electrical',60),('Plumbing',70),('Tiles & Stone',80),
 ('Wood & Joinery',90),('Paint & Finishes',100),('Waterproofing',110),
 ('Labour - Mason',120),('Labour - Other',130),('Equipment Hire',140),
 ('Transport',150),('Site Consumables',160),('Fees & Approvals',170),('Misc',999);

-- ---------- BUDGETS (per project per category) ----------
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  category_id int not null references public.expense_categories(id),
  amount numeric(14,2) not null check (amount >= 0),
  unique (project_id, category_id)
);

-- ---------- VENDORS (minimal for v1) ----------
create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  gstin text,
  category text,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- ---------- EXPENSES ----------
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  expense_date date not null default current_date,
  category_id int not null references public.expense_categories(id),
  vendor_id uuid references public.vendors(id),
  description text,
  amount numeric(14,2) not null check (amount > 0),
  gst_amount numeric(14,2) default 0 check (gst_amount >= 0),
  source expense_source not null default 'bank',
  invoice_no text,
  receipt_path text,                    -- storage path of receipt photo
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
create index on public.expenses (project_id, expense_date);
create index on public.expenses (project_id, category_id);

-- ---------- PETTY CASH ----------
create table public.petty_cash_accounts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  holder uuid not null references public.profiles(id),
  imprest_amount numeric(14,2) not null default 0,
  unique (project_id, holder)
);

create type pc_entry_type as enum ('top_up','spend','return');

create table public.petty_cash_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.petty_cash_accounts(id) on delete cascade,
  entry_date date not null default current_date,
  entry_type pc_entry_type not null,
  amount numeric(14,2) not null check (amount > 0),
  category_id int references public.expense_categories(id),
  description text,
  receipt_path text,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
create index on public.petty_cash_entries (account_id, entry_date);

-- petty cash SPEND auto-creates an expense row (single source of truth in ledger)
create or replace function public.fn_pc_to_expense()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.entry_type = 'spend' then
    insert into public.expenses (project_id, expense_date, category_id, description,
                                 amount, source, receipt_path, created_by)
    select a.project_id, new.entry_date, coalesce(new.category_id, 999), new.description,
           new.amount, 'petty_cash', new.receipt_path, new.created_by
    from public.petty_cash_accounts a where a.id = new.account_id;
  end if;
  return new;
end $$;
create trigger pc_spend_to_expense after insert on public.petty_cash_entries
  for each row execute function public.fn_pc_to_expense();

-- ---------- VIEWS (all money aggregation server-side) ----------
create or replace view public.v_project_spend with (security_invoker = true) as
select p.id as project_id, p.name,
       coalesce(sum(e.amount + e.gst_amount),0) as total_spent,
       coalesce((select sum(b.amount) from public.budgets b where b.project_id = p.id),0) as total_budget
from public.projects p
left join public.expenses e on e.project_id = p.id
group by p.id, p.name;

create or replace view public.v_budget_vs_actual with (security_invoker = true) as
select b.project_id, c.name as category,
       b.amount as budget,
       coalesce(sum(e.amount + e.gst_amount),0) as actual,
       b.amount - coalesce(sum(e.amount + e.gst_amount),0) as remaining
from public.budgets b
join public.expense_categories c on c.id = b.category_id
left join public.expenses e on e.project_id = b.project_id and e.category_id = b.category_id
group by b.project_id, c.name, b.amount;

create or replace view public.v_petty_cash_balance with (security_invoker = true) as
select a.id as account_id, a.project_id, a.holder,
       a.imprest_amount
       + coalesce(sum(case e.entry_type when 'top_up' then e.amount
                                        when 'spend' then -e.amount
                                        when 'return' then -e.amount end),0) as balance
from public.petty_cash_accounts a
left join public.petty_cash_entries e on e.account_id = a.id
group by a.id;

-- ---------- AUDIT ----------
create trigger audit_expenses after insert or update or delete on public.expenses
  for each row execute function public.fn_audit();
create trigger audit_pc after insert or update or delete on public.petty_cash_entries
  for each row execute function public.fn_audit();
create trigger audit_budgets after insert or update or delete on public.budgets
  for each row execute function public.fn_audit();

-- ---------- RLS ----------
alter table public.expense_categories  enable row level security;
alter table public.budgets             enable row level security;
alter table public.vendors             enable row level security;
alter table public.expenses            enable row level security;
alter table public.petty_cash_accounts enable row level security;
alter table public.petty_cash_entries  enable row level security;

-- categories: all read; founder writes
create policy cat_read  on public.expense_categories for select to authenticated using (true);
create policy cat_write on public.expense_categories for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

-- SUPERVISOR MUST NOT SEE MONEY: expenses/budgets/vendors restricted to founder/pm/accounts
create policy budgets_read on public.budgets for select to authenticated
  using (public.my_role() in ('founder','accounts') or (public.my_role()='pm' and public.is_member(project_id)));
create policy budgets_write on public.budgets for all to authenticated
  using (public.my_role() in ('founder','accounts')) with check (public.my_role() in ('founder','accounts'));

create policy vendors_read on public.vendors for select to authenticated
  using (public.my_role() in ('founder','pm','accounts'));
create policy vendors_write on public.vendors for all to authenticated
  using (public.my_role() in ('founder','pm','accounts'))
  with check (public.my_role() in ('founder','pm','accounts'));

create policy exp_read on public.expenses for select to authenticated
  using (public.my_role() in ('founder','accounts') or (public.my_role()='pm' and public.is_member(project_id)));
create policy exp_insert on public.expenses for insert to authenticated
  with check (public.my_role() in ('founder','accounts') or (public.my_role()='pm' and public.is_member(project_id)));
create policy exp_update on public.expenses for update to authenticated
  using (public.my_role() = 'founder' or created_by = auth.uid());

-- petty cash: holder (any role incl. supervisor) sees own account; founder/accounts see all
create policy pca_read on public.petty_cash_accounts for select to authenticated
  using (holder = auth.uid() or public.my_role() in ('founder','accounts'));
create policy pca_write on public.petty_cash_accounts for all to authenticated
  using (public.my_role() in ('founder','accounts')) with check (public.my_role() in ('founder','accounts'));

create policy pce_read on public.petty_cash_entries for select to authenticated
  using (exists (select 1 from public.petty_cash_accounts a
                 where a.id = account_id
                   and (a.holder = auth.uid() or public.my_role() in ('founder','accounts'))));
create policy pce_insert on public.petty_cash_entries for insert to authenticated
  with check (exists (select 1 from public.petty_cash_accounts a
                      where a.id = account_id
                        and (a.holder = auth.uid() or public.my_role() in ('founder','accounts'))));
