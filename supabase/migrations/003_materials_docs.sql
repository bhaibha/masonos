-- ============================================================
-- MASON OS — Migration 003: materials (in/out/stock) + document vault
-- ============================================================

-- ---------- MATERIAL MASTER ----------
create table public.materials (
  id uuid primary key default gen_random_uuid(),
  name text not null,                  -- "OPC 53 Cement", "TMT 12mm Fe550D"
  unit text not null,                  -- bag / kg / cum / sqft / nos / ltr
  category_id int references public.expense_categories(id),
  low_stock_level numeric(12,2) default 0,
  is_active boolean default true,
  unique (name, unit)
);

-- ---------- INWARD (deliveries) ----------
create table public.material_inward (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  material_id uuid not null references public.materials(id),
  inward_date date not null default current_date,
  qty numeric(12,2) not null check (qty > 0),
  vendor_id uuid references public.vendors(id),
  challan_no text,
  rate numeric(14,2),                  -- per unit; nullable so supervisor can log delivery without price
  challan_photo text,
  remarks text,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
create index on public.material_inward (project_id, material_id);

-- ---------- ISSUANCE (to work area) ----------
create table public.material_issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  material_id uuid not null references public.materials(id),
  issue_date date not null default current_date,
  qty numeric(12,2) not null check (qty > 0),
  work_area text not null,             -- "GF slab", "FF bathroom 2"
  issued_to text,                      -- contractor / gang name
  remarks text,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
create index on public.material_issues (project_id, material_id);

-- issuance cannot exceed stock — enforced in DB, not UI
create or replace function public.fn_check_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare cur numeric;
begin
  select coalesce((select sum(qty) from public.material_inward
                   where project_id = new.project_id and material_id = new.material_id),0)
       - coalesce((select sum(qty) from public.material_issues
                   where project_id = new.project_id and material_id = new.material_id
                     and id <> new.id),0)
  into cur;
  if new.qty > cur then
    raise exception 'Insufficient stock: available %, requested %', cur, new.qty;
  end if;
  return new;
end $$;
create trigger check_stock before insert or update on public.material_issues
  for each row execute function public.fn_check_stock();

-- ---------- STOCK VIEW ----------
create or replace view public.v_stock with (security_invoker = true) as
select m.id as material_id, m.name, m.unit, m.low_stock_level, x.project_id,
       coalesce(sum(x.inward),0)  as total_in,
       coalesce(sum(x.issued),0)  as total_out,
       coalesce(sum(x.inward),0) - coalesce(sum(x.issued),0) as in_stock,
       (coalesce(sum(x.inward),0) - coalesce(sum(x.issued),0)) <= m.low_stock_level as low_stock
from public.materials m
join lateral (
  select project_id, qty as inward, 0::numeric as issued from public.material_inward where material_id = m.id
  union all
  select project_id, 0, qty from public.material_issues where material_id = m.id
) x on true
group by m.id, x.project_id;

-- ---------- DOCUMENT VAULT ----------
create type doc_folder as enum
  ('contracts','drawings','permits','invoices','qc_certificates','photos','other');

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  folder doc_folder not null default 'other',
  title text not null,
  file_path text not null,             -- Supabase Storage path
  file_type text,
  is_confidential boolean not null default false,  -- hidden from supervisors
  uploaded_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
create index on public.documents (project_id, folder);

-- ---------- AUDIT ----------
create trigger audit_inward after insert or update or delete on public.material_inward
  for each row execute function public.fn_audit();
create trigger audit_issues after insert or update or delete on public.material_issues
  for each row execute function public.fn_audit();
create trigger audit_docs after insert or update or delete on public.documents
  for each row execute function public.fn_audit();

-- ---------- RLS ----------
alter table public.materials       enable row level security;
alter table public.material_inward enable row level security;
alter table public.material_issues enable row level security;
alter table public.documents       enable row level security;

create policy mat_read  on public.materials for select to authenticated using (true);
create policy mat_write on public.materials for all to authenticated
  using (public.my_role() in ('founder','pm')) with check (public.my_role() in ('founder','pm'));

-- supervisors CAN log inward/issue (their core job) but rate column exposure is fine
-- (they see qty; keep vendor rates minimal — omit rate in supervisor UI)
create policy inward_read on public.material_inward for select to authenticated
  using (public.is_member(project_id));
create policy inward_write on public.material_inward for insert to authenticated
  with check (public.is_member(project_id) and public.my_role() in ('founder','pm','supervisor'));

create policy issue_read on public.material_issues for select to authenticated
  using (public.is_member(project_id));
create policy issue_write on public.material_issues for insert to authenticated
  with check (public.is_member(project_id) and public.my_role() in ('founder','pm','supervisor'));

-- documents: confidential docs hidden from supervisors
create policy docs_read on public.documents for select to authenticated
  using (public.is_member(project_id)
         and (not is_confidential or public.my_role() in ('founder','pm','accounts')));
create policy docs_write on public.documents for insert to authenticated
  with check (public.is_member(project_id) and public.my_role() in ('founder','pm','accounts'));
create policy docs_delete on public.documents for delete to authenticated
  using (public.is_founder() or uploaded_by = auth.uid());

-- ---------- STORAGE BUCKETS (run once) ----------
insert into storage.buckets (id, name, public) values
  ('receipts','receipts', false),
  ('site-photos','site-photos', false),
  ('documents','documents', false)
on conflict do nothing;

create policy storage_rw on storage.objects for all to authenticated
  using (bucket_id in ('receipts','site-photos','documents'))
  with check (bucket_id in ('receipts','site-photos','documents'));
