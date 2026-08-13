-- ============================================================
-- MASON OS — Migration 049: tell a QA plan apart from a filed NCR
--
-- 048's QA plan docs tab lists everything in the QC Certificates folder, and
-- an NCR filed from the NCRs tab lands in that same folder — so a filed NCR
-- appeared in both places. The founder wants NCRs in QC Certificates and
-- NOWHERE ELSE: the folder is the right home for them, the QA plan list is not.
--
-- ---------- WHY A COLUMN AND NOT A TITLE MATCH ----------
-- The obvious shortcut is to hide anything whose title starts "NCR-". That
-- works until somebody renames a document, or writes a QA plan called
-- "NCR response procedure", and then a file quietly vanishes from a list with
-- no way to work out why. What a row IS should be stored, not inferred from
-- how it happens to be spelled.
--
-- `doc_kind` is deliberately open text rather than an enum: it labels where a
-- document came from, more sources will want labelling later (PO, SI, VO and
-- the handover archive all file documents today), and an enum would mean a
-- migration every time one is added. NULL means "uploaded by hand", which is
-- what every existing row is.
--
-- Requires 048. Additive and re-runnable.
-- ============================================================


-- ############################################################
-- ###  1. WHERE A DOCUMENT CAME FROM
-- ############################################################
alter table public.documents add column if not exists doc_kind text;

comment on column public.documents.doc_kind is
  'What produced this document: qa_plan, ncr, and later po / si / vo. NULL '
  'means somebody uploaded it by hand. Used to filter a folder by source '
  'without matching on the title, which breaks the moment a file is renamed.';

-- Only the QA plan list filters on this today, and only within one folder.
create index if not exists documents_kind_idx
  on public.documents (project_id, folder, doc_kind);


-- ############################################################
-- ###  2. THE QA SUMMARY COUNTS PLANS, NOT NCRs
-- ############################################################
-- 048's version counted every document in QC Certificates, so filing an NCR
-- bumped the "QA documents" figure. It now counts the plans a person actually
-- uploaded there.
drop function if exists public.fn_qa_summary(uuid);

create function public.fn_qa_summary(p_project uuid)
returns table (
  open_comments     int,
  urgent_comments   int,
  high_comments     int,
  total_comments    int,
  open_ncrs         int,
  ncr_minor         int,
  ncr_major         int,
  ncr_critical      int,
  corrected_ncrs    int,
  closed_ncrs       int,
  qa_docs           int
)
language sql
stable
security invoker
set search_path = public
as $$
  with c as (
    select
      count(*) filter (where t.id is not null and t.status <> 'done')::int as open_c,
      count(*) filter (where t.id is not null and t.status <> 'done'
                         and ic.priority = 'urgent')::int                 as urgent_c,
      count(*) filter (where t.id is not null and t.status <> 'done'
                         and ic.priority = 'high')::int                   as high_c,
      count(*)::int                                                       as total_c
    from public.inspection_comments ic
    left join public.tasks t on t.id = ic.task_id
    where ic.project_id = p_project
  ),
  n as (
    select
      count(*) filter (where status in ('open', 'corrected'))::int as open_n,
      count(*) filter (where status in ('open', 'corrected') and severity = 'minor')::int as minor_n,
      count(*) filter (where status in ('open', 'corrected') and severity = 'major')::int as major_n,
      count(*) filter (where status in ('open', 'corrected') and severity = 'critical')::int as crit_n,
      count(*) filter (where status = 'corrected')::int as corr_n,
      count(*) filter (where status = 'closed')::int    as closed_n
    from public.ncrs where project_id = p_project
  ),
  d as (
    -- Plans and checklists only. A filed NCR lives in the same folder and is
    -- not a QA plan.
    select count(*)::int as docs
    from public.documents
    where project_id = p_project
      and folder = 'qc_certificates'
      and coalesce(doc_kind, 'qa_plan') = 'qa_plan'
  )
  select c.open_c, c.urgent_c, c.high_c, c.total_c,
         n.open_n, n.minor_n, n.major_n, n.crit_n, n.corr_n, n.closed_n,
         d.docs
  from c, n, d;
$$;

revoke all on function public.fn_qa_summary(uuid) from public, anon;
grant execute on function public.fn_qa_summary(uuid) to authenticated;


-- ############################################################
-- ###  3. LABEL THE NCRs ALREADY FILED
-- ############################################################
-- Anything in QC Certificates whose title starts with this project's NCR
-- number is one that was filed before this column existed. The title match is
-- acceptable HERE and only here — it is a one-off backfill over rows that
-- nobody has had a chance to rename, not a rule the app reads at run time.
update public.documents d
   set doc_kind = 'ncr'
 where d.folder = 'qc_certificates'
   and d.doc_kind is null
   and exists (
     select 1 from public.ncrs n
     where n.project_id = d.project_id
       and d.title like n.ncr_no || '%'
   );


-- ############################################################
-- ###  4. VERIFY
-- ############################################################
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'documents'
  and column_name = 'doc_kind';

-- What is in QC Certificates, by source. NULL = uploaded by hand before 049.
select coalesce(doc_kind, '(unlabelled)') as kind, count(*)
from public.documents
where folder = 'qc_certificates'
group by 1
order by 1;

-- Expect ONE arity.
select count(*) as qa_summary_arities from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'fn_qa_summary';
