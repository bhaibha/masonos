-- ============================================================
-- 059 — MASON LEARN: DOCUMENTS (C1, part 2)
-- ============================================================
-- Uploading files into the library, stored so that a future assistant can
-- ANSWER FROM THEM rather than merely link to them.
--
-- ------------------------------------------------------------
-- ONE TABLE, NOT TWO
-- ------------------------------------------------------------
-- The firm wants both: a PDF that stands on its own (a vendor catalogue, a
-- spec sheet, the firm's copy of a standard) and a PDF that is evidence for a
-- method statement. Those are the same object with a different owner, so
-- `article_id` is NULLABLE — null means it sits on a shelf by itself, set means
-- it hangs off that article.
--
-- Two tables would have meant two search indexes, two extraction paths and two
-- places for the assistant to look, which is exactly the split that produces
-- "the bot could not find it" for a document that is plainly in the library.
--
-- `learn_articles.attachments` (a text[] of storage paths, added by 057 and
-- never written to, because the upload UI was never built) is MIGRATED INTO
-- this table and then DROPPED. Two representations of one fact eventually
-- disagree — 050's lesson about the split award, in a smaller key.
--
-- ------------------------------------------------------------
-- WHY EXTRACT TEXT NOW, BEFORE THE ASSISTANT EXISTS
-- ------------------------------------------------------------
-- A file in a bucket is opaque. Every question anybody could ask of it — "what
-- curing period does the waterproofing spec give", "which vendor quoted this
-- admixture" — needs its text. Extracting at upload means:
--
--   * the document is searchable IMMEDIATELY, through the same box that already
--     searches articles and steps, with no assistant involved at all; and
--   * when the assistant is built it reads a column, instead of a batch job
--     re-downloading and re-parsing every file in the library.
--
-- Extraction happens CLIENT-SIDE at upload (pdfjs, dynamically imported so it
-- never enters the main bundle). No Edge Function, no new secret, no deploy
-- step — and after the afternoon 058 cost, that is worth something.
--
-- A SCANNED PDF HAS NO TEXT LAYER and will extract nothing. That is recorded
-- honestly as `no_text` and shown on screen as "scanned — not searchable",
-- rather than stored as an empty string that looks like a successful
-- extraction. A library that silently contains documents nobody can search is
-- worse than one that says which ones they are. OCR is a separate decision.
--
-- ------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ------------------------------------------------------------
-- No embeddings, no pgvector, no chunk table. Postgres full-text search answers
-- "which documents mention this" well, and the retrieval design for an
-- assistant is far easier to get right once there is a real corpus and real
-- questions to test against. `fn_learn_retrieve` below is the seam: it returns
-- ranked passages with their source, which is the shape an assistant needs, and
-- swapping its internals for vector search later changes nothing above it.
--
-- Run AFTER 057 and 058.
-- ============================================================


-- ############################################################
-- ###  1. EXTRACTION STATUS
-- ############################################################
-- Four states, because "we have no text for this" has genuinely different
-- causes and the screen should say which. `pending` exists for a row created
-- before extraction finished, and for a future re-extraction pass.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'doc_extract_status') then
    create type doc_extract_status as enum ('pending', 'ok', 'no_text', 'failed');
  end if;
end $$;

alter type doc_extract_status add value if not exists 'pending';
alter type doc_extract_status add value if not exists 'ok';
alter type doc_extract_status add value if not exists 'no_text';
alter type doc_extract_status add value if not exists 'failed';


-- ############################################################
-- ###  2. THE TABLE
-- ############################################################
create table if not exists public.learn_documents (
  id uuid primary key default gen_random_uuid(),

  -- Null = a document on a shelf in its own right.
  -- Set  = an attachment on that article, and it inherits the article's
  --        visibility (see the read policy).
  article_id uuid references public.learn_articles(id) on delete cascade,

  -- The shelf. Required for a standalone document; an attachment takes its
  -- article's shelf, so it may be null there.
  category_code text references public.learn_categories(code),

  status learn_status not null default 'draft',

  title text not null,
  description text,
  -- The firm's own reference, same idea as learn_articles.ref_no.
  ref_no text,

  is_refs text[] not null default '{}',
  trades  text[] not null default '{}',
  tags    text[] not null default '{}',

  -- Storage: `library/<uuid>.<ext>` in the documents bucket. 057's
  -- documents_library_* policies key off that leading segment.
  file_path text not null,
  file_name text not null,
  file_type text,
  file_size bigint,
  page_count int,

  -- ---- extraction ----
  -- The full text, kept whole: the assistant reads this, and truncating it here
  -- would silently make the second half of every long document unanswerable.
  -- Only the SEARCH INDEX is capped (see fn_learn_doc_touch).
  extracted_text text,
  extract_status doc_extract_status not null default 'pending',
  extracted_at timestamptz,
  -- Why extraction produced nothing, in words, for the screen.
  extract_note text,

  search tsvector,

  created_by uuid not null default auth.uid() references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A document belongs SOMEWHERE: on a shelf, or on an article. Without this a
  -- row can exist that no screen in the app will ever list.
  constraint learn_doc_placed check (
    article_id is not null or category_code is not null)
);

-- Columns added after this create block first shipped go here, one statement
-- each — `create table if not exists` will not add them (the 042 lesson).
alter table public.learn_documents add column if not exists extract_note text;
alter table public.learn_documents add column if not exists page_count int;

-- One row per stored object. Without this, a slow connection and a second tap
-- files the same PDF twice and the assistant quotes it twice as if two sources
-- agreed — the same reasoning as labour_att_uk in 054, where a duplicate meant
-- duplicated money. Here a duplicate means false corroboration.
create unique index if not exists learn_doc_path_uk
  on public.learn_documents (file_path);

create index if not exists learn_doc_article_idx
  on public.learn_documents (article_id) where article_id is not null;
create index if not exists learn_doc_cat_idx
  on public.learn_documents (category_code, status, title);
create index if not exists learn_doc_isrefs_idx
  on public.learn_documents using gin (is_refs);
create index if not exists learn_doc_tags_idx
  on public.learn_documents using gin (tags);


-- ############################################################
-- ###  3. THE SEARCH VECTOR
-- ############################################################
-- Maintained by a trigger, not a generated column: 057 learned that
-- `array_to_string` is STABLE rather than IMMUTABLE, so a generated tsvector
-- over is_refs/tags is refused at create time. A BEFORE trigger fires on every
-- write and therefore cannot drift any more than a generated column could.
--
-- WEIGHTS MATTER HERE. The extracted body is weight D — the lowest — because a
-- 200-page standard mentions "concrete" four hundred times and would otherwise
-- outrank the one-page article actually titled "Concrete". Title and reference
-- stay at A.
--
-- The index input is CAPPED at 500k characters. A tsvector has a hard 1 MB
-- limit and exceeding it raises "string is too long for tsvector", which would
-- abort the upload of exactly the large reference documents this feature is
-- for. `extracted_text` itself is untouched — the cap costs deep-page search on
-- a very long document, and refusing the whole upload would cost the document.
create or replace function public.fn_learn_doc_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.search :=
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.ref_no, '')), 'A') ||
    setweight(to_tsvector('english',
      coalesce(array_to_string(new.is_refs, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.description, '')), 'B') ||
    setweight(to_tsvector('english',
      coalesce(array_to_string(new.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('english',
      left(coalesce(new.extracted_text, ''), 500000)), 'D');

  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists learn_doc_touch on public.learn_documents;
create trigger learn_doc_touch
  before insert or update on public.learn_documents
  for each row execute function public.fn_learn_doc_touch();

create index if not exists learn_doc_search_idx
  on public.learn_documents using gin (search);


-- ############################################################
-- ###  4. MIGRATE learn_articles.attachments, THEN DROP IT
-- ############################################################
-- 057 gave articles a text[] of storage paths. No UI ever wrote to it, so this
-- is expected to move zero rows — but it runs anyway, because "expected to be
-- empty" is not the same as empty, and finding out later means finding out from
-- a file somebody cannot see.
--
-- Guarded on the column still existing so the migration is re-runnable.
do $$
declare
  v_moved int := 0;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'learn_articles'
      and column_name = 'attachments'
  ) then
    insert into public.learn_documents
      (article_id, category_code, status, title, file_path, file_name,
       extract_status, extract_note, created_by)
    select a.id,
           a.category_code,
           a.status,
           -- The path is all 057 stored; the filename is the best title
           -- available and the office can rename it.
           regexp_replace(p, '^.*/', ''),
           p,
           regexp_replace(p, '^.*/', ''),
           'pending'::doc_extract_status,
           'Carried over from the old attachments list. '
             || 'Re-upload it to make the text searchable.',
           a.created_by
    from public.learn_articles a
    cross join lateral unnest(a.attachments) as p
    where coalesce(p, '') <> ''
    on conflict (file_path) do nothing;

    get diagnostics v_moved = row_count;
    raise notice 'Carried % attachment path(s) into learn_documents.', v_moved;
  end if;
end $$;

-- v_learn_articles reads `attachments`, so it must go first — dropping a column
-- a view depends on is refused, and the error names the view rather than the
-- column, which reads like an unrelated problem.
drop view if exists public.v_learn_articles cascade;

alter table public.learn_articles drop column if exists attachments;


-- ############################################################
-- ###  5. VIEWS
-- ############################################################
-- Rebuilt: attachment_count now counts rows in learn_documents.
-- NEVER `create or replace view` — it cannot change the column list, and this
-- has bitten three times (013, 018, and once more since).
create view public.v_learn_articles with (security_invoker = true) as
select
  a.id,
  a.category_code,
  c.name as category_name,
  a.kind,
  a.status,
  a.title,
  a.ref_no,
  a.summary,
  a.is_refs,
  a.trades,
  a.tags,
  a.activity,
  a.version,
  a.updated_at,
  a.updated_by,
  (select count(*) from public.learn_documents d
    where d.article_id = a.id)::int                    as attachment_count,
  (select count(*) from public.learn_steps s
    where s.article_id = a.id)::int                    as step_count
from public.learn_articles a
join public.learn_categories c on c.code = a.category_code;

grant select on public.v_learn_articles to authenticated;


-- The document list. `shelf_code` resolves an attachment's shelf from its
-- article, so every document has one on screen whether or not it stores one.
drop view if exists public.v_learn_documents cascade;
create view public.v_learn_documents with (security_invoker = true) as
select
  d.id,
  d.article_id,
  a.title                                   as article_title,
  coalesce(d.category_code, a.category_code) as shelf_code,
  c.name                                    as shelf_name,
  d.status,
  d.title,
  d.description,
  d.ref_no,
  d.is_refs,
  d.trades,
  d.tags,
  d.file_path,
  d.file_name,
  d.file_type,
  d.file_size,
  d.page_count,
  d.extract_status,
  d.extract_note,
  d.extracted_at,
  -- The text itself is NOT in this view. It is bulk — a 200-page standard is
  -- megabytes — and a list screen that ships it to a site phone on every load
  -- would be unusable. The assistant reads learn_documents directly.
  (d.extracted_text is not null
    and length(btrim(d.extracted_text)) > 0)  as has_text,
  length(coalesce(d.extracted_text, ''))      as text_length,
  d.created_by,
  d.created_at,
  d.updated_at
from public.learn_documents d
left join public.learn_articles a   on a.id = d.article_id
left join public.learn_categories c
       on c.code = coalesce(d.category_code, a.category_code);

grant select on public.v_learn_documents to authenticated;


-- ############################################################
-- ###  6. RLS
-- ############################################################
alter table public.learn_documents enable row level security;

-- Two conditions, both required:
--   * the document's own status is published, or you write the library; AND
--   * if it hangs off an article, that article is visible to you too.
-- The second is not redundant. Without it, publishing a document attached to a
-- draft method statement would leak the draft's contents through its evidence.
drop policy if exists learn_doc_read on public.learn_documents;
create policy learn_doc_read on public.learn_documents
  for select to authenticated
  using (
    (status::text = 'published' or public.my_role() in ('founder', 'pm'))
    and (
      article_id is null
      or exists (
        select 1 from public.learn_articles a
        where a.id = article_id
          and (a.status::text = 'published'
               or public.my_role() in ('founder', 'pm'))
      )
    )
  );

drop policy if exists learn_doc_write on public.learn_documents;
create policy learn_doc_write on public.learn_documents
  for all to authenticated
  using (public.my_role() in ('founder', 'pm'))
  with check (public.my_role() in ('founder', 'pm'));


-- ############################################################
-- ###  7. AUDIT
-- ############################################################
-- learn_documents is keyed by `id`, so the ordinary fn_audit applies — the
-- code-keyed variant from 051 is not needed here. Worth stating, because
-- attaching the wrong one aborts the write and reports it as a missing field
-- on `new`.
drop trigger if exists learn_doc_audit on public.learn_documents;
create trigger learn_doc_audit
  after insert or update or delete on public.learn_documents
  for each row execute function public.fn_audit();


-- ############################################################
-- ###  8. CATEGORY COUNTS — now including documents
-- ############################################################
-- A shelf holding five PDFs and no article was showing zero, which reads as an
-- empty shelf. Return type changes, so the drop is mandatory: `create or
-- replace function` cannot widen a return type (42P13), and in a
-- multi-statement script that abort leaves everything below it unrun while
-- everything above it stands (the 045→046 lesson, found in production).
drop function if exists public.fn_learn_category_counts();
create function public.fn_learn_category_counts()
returns table (
  code text,
  name text,
  description text,
  sort_order int,
  article_count int,
  document_count int
)
language sql
stable
security invoker
set search_path = public
as $$
  select c.code,
         c.name,
         c.description,
         c.sort_order,
         (select count(*) from public.v_learn_articles v
           where v.category_code = c.code)::int,
         (select count(*) from public.v_learn_documents d
           where d.shelf_code = c.code)::int
  from public.learn_categories c
  order by c.sort_order, c.name;
$$;

revoke all on function public.fn_learn_category_counts() from public, anon;
grant execute on function public.fn_learn_category_counts() to authenticated;


-- ############################################################
-- ###  9. DOCUMENT SEARCH — for the search box
-- ############################################################
-- Kept separate from fn_learn_search rather than bolted onto it. That function
-- returns rows keyed to v_learn_articles and every caller joins on it; a
-- document is not an article, and widening the result to carry both would have
-- meant a nullable half in every row and a return-type change on a function
-- that currently works. Two functions, one screen that shows both lists.
drop function if exists public.fn_learn_doc_search(text, text, int);
create function public.fn_learn_doc_search(
  p_q        text,
  p_category text default null,
  p_limit    int  default 40
)
returns table (
  id             uuid,
  article_id     uuid,
  article_title  text,
  shelf_code     text,
  shelf_name     text,
  status         learn_status,
  title          text,
  description    text,
  ref_no         text,
  is_refs        text[],
  tags           text[],
  file_name      text,
  file_type      text,
  file_size      bigint,
  page_count     int,
  extract_status doc_extract_status,
  has_text       boolean,
  rank           real,
  snippet        text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  q tsquery;
begin
  -- An empty search is a browse, not an error — same rule as fn_learn_search.
  if coalesce(btrim(p_q), '') = '' then
    return query
    select v.id, v.article_id, v.article_title, v.shelf_code, v.shelf_name,
           v.status, v.title, v.description, v.ref_no, v.is_refs, v.tags,
           v.file_name, v.file_type, v.file_size, v.page_count,
           v.extract_status, v.has_text,
           0::real, coalesce(v.description, '')
    from public.v_learn_documents v
    where (p_category is null or v.shelf_code = p_category)
    order by v.updated_at desc
    limit greatest(least(coalesce(p_limit, 40), 200), 1);
    return;
  end if;

  q := websearch_to_tsquery('english', p_q);

  return query
  select v.id, v.article_id, v.article_title, v.shelf_code, v.shelf_name,
         v.status, v.title, v.description, v.ref_no, v.is_refs, v.tags,
         v.file_name, v.file_type, v.file_size, v.page_count,
         v.extract_status, v.has_text,
         -- Cast explicitly. ts_rank_cd returns real, but arithmetic on it
         -- promotes to double precision and a RETURNS TABLE column declared
         -- `real` then fails at CALL time with "structure of query does not
         -- match function result type" — clean at create, broken on first use.
         ts_rank_cd(d.search, q)::real,
         -- The snippet comes from the extracted text where there is any, so a
         -- hit shows the sentence it matched rather than a filename.
         ts_headline('english',
           coalesce(nullif(btrim(d.extracted_text), ''),
                    d.description,
                    d.file_name),
           q,
           'MaxWords=34, MinWords=14, ShortWord=3, MaxFragments=2, '
             || 'FragmentDelimiter= … ')
  from public.learn_documents d
  join public.v_learn_documents v on v.id = d.id
  where d.search @@ q
    and (p_category is null or v.shelf_code = p_category)
  order by ts_rank_cd(d.search, q) desc, v.title
  limit greatest(least(coalesce(p_limit, 40), 200), 1);
end $$;

revoke all on function public.fn_learn_doc_search(text, text, int) from public, anon;
grant execute on function public.fn_learn_doc_search(text, text, int) to authenticated;


-- ############################################################
-- ### 10. fn_learn_retrieve — THE SEAM FOR THE ASSISTANT
-- ############################################################
-- One call, one ranked list of PASSAGES, each carrying where it came from.
-- That is the shape a question-answering assistant needs: text to read, plus a
-- citation to show, so an answer can always be traced back to the document it
-- came from. An assistant that cannot cite is an assistant nobody on a site
-- should act on.
--
-- Deliberately NOT wired to any AI yet. It is a plain search function today,
-- useful on its own, and it is where vector retrieval would be substituted
-- later without changing a single caller.
--
-- `security invoker` — so RLS decides what the assistant can see, per caller.
-- A supervisor asking a question must not be answered out of a draft method
-- statement. Putting the gate anywhere else would mean maintaining a second
-- copy of the visibility rules, which is how a reporting screen leaks a whole
-- company at once (the 056 lesson).
drop function if exists public.fn_learn_retrieve(text, int);
create function public.fn_learn_retrieve(
  p_q     text,
  p_limit int default 12
)
returns table (
  source_type text,      -- 'article' | 'step' | 'document'
  source_id   uuid,      -- the row to open
  article_id  uuid,      -- set for a step or an attached document
  title       text,
  ref_no      text,
  is_refs     text[],
  passage     text,      -- what to read
  rank        real
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  q tsquery;
begin
  if coalesce(btrim(p_q), '') = '' then
    return;                       -- no question, no passages
  end if;

  q := websearch_to_tsquery('english', p_q);

  return query
  -- Article bodies.
  select 'article'::text, a.id, null::uuid, a.title, a.ref_no, a.is_refs,
         ts_headline('english',
           coalesce(nullif(btrim(a.body), ''), coalesce(a.summary, a.title)), q,
           'MaxWords=90, MinWords=40, ShortWord=3, MaxFragments=3, '
             || 'FragmentDelimiter= … '),
         ts_rank_cd(a.search, q)::real
  from public.learn_articles a
  where a.search @@ q

  union all

  -- Procedure steps, carrying the safety note and QA checkpoint with them —
  -- an instruction quoted without its safety note is the most dangerous thing
  -- this function could return.
  select 'step'::text, s.id, s.article_id,
         a2.title || ' — step ' || s.step_no::text, a2.ref_no, s.is_refs,
         concat_ws(E'\n',
           s.instruction,
           nullif('Safety: ' || coalesce(s.safety_note, ''), 'Safety: '),
           nullif('QA: ' || coalesce(s.qa_checkpoint, ''), 'QA: ')),
         (ts_rank_cd(s.search, q) * 0.9)::real
  from public.learn_steps s
  join public.learn_articles a2 on a2.id = s.article_id
  where s.search @@ q

  union all

  -- Uploaded documents. Ranked slightly below written content on purpose: what
  -- the firm WROTE about how it works outranks a passage lifted out of a
  -- supplier's brochure that happens to share a word.
  select 'document'::text, d.id, d.article_id, d.title, d.ref_no, d.is_refs,
         ts_headline('english',
           coalesce(nullif(btrim(d.extracted_text), ''),
                    d.description, d.file_name),
           q,
           'MaxWords=90, MinWords=40, ShortWord=3, MaxFragments=3, '
             || 'FragmentDelimiter= … '),
         (ts_rank_cd(d.search, q) * 0.8)::real
  from public.learn_documents d
  where d.search @@ q

  order by 8 desc, 4
  limit greatest(least(coalesce(p_limit, 12), 50), 1);
end $$;

revoke all on function public.fn_learn_retrieve(text, int) from public, anon;
grant execute on function public.fn_learn_retrieve(text, int) to authenticated;


-- ############################################################
-- ### 11. fn_learn_by_ref — now answers with documents too
-- ############################################################
-- An NCR citing "IS 456" should surface the firm's uploaded copy of its notes
-- on IS 456, not only the article about it. Return type is unchanged, but the
-- drop stays for the re-runnability rule.
drop function if exists public.fn_learn_by_ref(text);
create function public.fn_learn_by_ref(p_ref text)
returns table (
  id uuid,
  category_code text,
  category_name text,
  kind learn_kind,
  title text,
  ref_no text,
  summary text,
  activity text,
  step_count int
)
language sql
stable
security invoker
set search_path = public
as $$
  select v.id, v.category_code, v.category_name, v.kind, v.title, v.ref_no,
         v.summary, v.activity, v.step_count
  from public.v_learn_articles v
  where v.status::text = 'published'
    and exists (
      select 1 from unnest(v.is_refs) r
      where public.fn_learn_normalise_ref(r)
          = public.fn_learn_normalise_ref(p_ref)
    )

  union all

  -- A document has no kind, no activity and no steps. Rather than invent
  -- values, it is reported as an 'article' of the same shape with zero steps
  -- and its shelf as the category — the caller lists titles, and a document
  -- that cites the standard is exactly as relevant as an article that does.
  select d.id, d.shelf_code, d.shelf_name, 'article'::learn_kind, d.title,
         d.ref_no, d.description, null::text, 0
  from public.v_learn_documents d
  where d.status::text = 'published'
    and exists (
      select 1 from unnest(d.is_refs) r
      where public.fn_learn_normalise_ref(r)
          = public.fn_learn_normalise_ref(p_ref)
    )

  order by 5;
$$;

revoke all on function public.fn_learn_by_ref(text) from public, anon;
grant execute on function public.fn_learn_by_ref(text) to authenticated;


-- ############################################################
-- ### 12. VERIFY
-- ############################################################
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_learn_doc_search', 'fn_learn_retrieve',
                    'fn_learn_by_ref', 'fn_learn_category_counts',
                    'fn_learn_doc_touch')
group by p.proname order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('learn_documents', 'v_learn_documents', 'v_learn_articles')
order by table_name;

-- Must return zero rows: the old attachments column is gone.
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'learn_articles'
  and column_name = 'attachments';
