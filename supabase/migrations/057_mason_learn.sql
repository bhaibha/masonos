-- ============================================================
-- MASON OS — Migration 057: Mason Learn (C1, Module 11)
--
-- The firm's own reference library: IS code index, method statements,
-- Bengaluru bylaws, materials guidance, QA standards. Internal, read by
-- everyone, written by founder/PM.
--
-- ---------- THE ITP IT WAS MEANT TO LINK TO NO LONGER EXISTS ----------
-- The brief asked for method statements to link to QA-QC ITP items. Migration
-- 048 DELETED that machinery — `itp_templates`, `itp_items`, `inspections`,
-- `inspection_checks` and nine functions — when the founder replaced the
-- structured ITP with inspection comments. There is nothing left to point a
-- foreign key at.
--
-- So the connection is made by MATCHING A REFERENCE, not by storing a link:
--   * an article carries `ref_no` (its own, e.g. MS-014) and `is_refs`
--     (the standards it cites, e.g. {'IS 456','IS 1200'})
--   * `ncrs.standard_ref` already exists and already holds exactly that kind of
--     string
--   * `fn_learn_by_ref('IS 456')` returns every article that cites it
--
-- Nothing to maintain, nothing to re-attach when a schedule is regenerated, and
-- it reaches every module that records a reference rather than the one module
-- that got a join table. A link table would have been a second place to keep
-- the same fact in step — the objection that has come up in every module this
-- far.
--
-- ---------- NO SEEDED CONTENT, ON PURPOSE ----------
-- 044 seeded five IS-referenced ITP templates and 045 seeded 627 checklist
-- questions. 048 deleted all of it, because it was not how the firm works.
-- Content nobody wrote is content nobody trusts, so this ships with the
-- structure and an empty library. The categories are seeded — those are
-- labels, not content, and the module needs somewhere to put the first article.
--
-- ---------- IS CODES ARE CITED, NEVER TRANSCRIBED ----------
-- Same rule as 044. IS standards are copyrighted and sold by BIS. An article
-- may carry a standard's NUMBER and TITLE and say what the firm does about it;
-- pasting clause text into `body` would be republishing it. That is a rule for
-- whoever writes the content, and the screen says so on the editor.
--
-- ---------- SEARCH IS POSTGRES FTS, NOT ILIKE ----------
-- A generated tsvector with weighted fields (title and reference heaviest,
-- body lightest) plus a GIN index. `websearch_to_tsquery` so somebody can type
-- "concrete cover -precast" and have it mean something. Steps are searched too,
-- through the same function, because the useful sentence in a method statement
-- is usually inside a step rather than in its title.
--
-- Idempotent: enums guarded, tables if-not-exists with explicit add-column,
-- views/functions dropped before create, policies drop-then-create.
-- ============================================================


-- ############################################################
-- ###  1. ENUMS
-- ############################################################
do $$ begin
  -- An article is prose; a method statement additionally has ordered steps.
  -- One table for both, because they share every other field and a search that
  -- had to union two tables would be slower and easier to get wrong.
  create type learn_kind as enum ('article', 'method_statement');
exception when duplicate_object then null; end $$;

do $$ begin
  create type learn_status as enum ('draft', 'published', 'archived');
exception when duplicate_object then null; end $$;


-- ############################################################
-- ###  2. CATEGORIES — one editable list, one editor
-- ############################################################
-- A table rather than an enum, for the 041 reason: the risk is not that the
-- list changes, it is that two people change it and the library ends up with
-- "Bylaws" and "Bye-laws" as separate shelves.
create table if not exists public.learn_categories (
  code        text primary key,
  name        text not null,
  description text,
  sort_order  int not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create unique index if not exists learn_category_name_uk
  on public.learn_categories (lower(btrim(name)));

insert into public.learn_categories (code, name, description, sort_order) values
  ('is_codes',   'IS codes',
   'Indian Standards the firm builds to — number, title, and what we do about it. Clause text is never reproduced.', 10),
  ('method',     'Method statements',
   'How a piece of work is done, step by step, with the safety and QA checks that belong to each step.', 20),
  ('regulatory', 'Bengaluru regulatory & bylaws',
   'BBMP / BDA / BWSSB / KSPCB requirements, approvals and local bylaws.', 30),
  ('materials',  'Materials guide',
   'Specifications, acceptance criteria, storage and handling for the materials the firm buys.', 40),
  ('qa',         'QA standards',
   'The firm''s own quality expectations — tolerances, finishes, what a snag is and is not.', 50)
on conflict (code) do nothing;


-- ############################################################
-- ###  3. ARTICLES
-- ############################################################
create table if not exists public.learn_articles (
  id uuid primary key default gen_random_uuid(),
  category_code text not null references public.learn_categories(code),
  kind learn_kind not null default 'article',
  status learn_status not null default 'draft',

  title text not null,
  -- The firm's own reference for this document: MS-014, QA-03, IS-INDEX-456.
  -- Optional, because not every note needs a number.
  ref_no text,
  summary text,
  -- Markdown. Rendered read-only on the screen; no HTML is stored, so nothing
  -- from this table can inject markup into the app.
  body text,

  -- Standards this article cites, as written on a drawing: {'IS 456','IS 1200'}.
  -- This is the join to everything else in the app — see the header.
  is_refs text[] not null default '{}',
  trades  text[] not null default '{}',
  tags    text[] not null default '{}',

  -- Method-statement header fields. Null on an ordinary article.
  activity text,
  scope text,
  ppe text,

  -- Storage paths under the `library/` prefix of the documents bucket.
  attachments text[] not null default '{}',

  -- Bumped on each publish. There is no separate revisions table: audit_log
  -- already stores old_data and new_data as jsonb on every edit, which IS the
  -- revision history, and a second copy would drift from it.
  version int not null default 1,

  created_by uuid not null default auth.uid() references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A method statement without an activity is a note filed in the wrong place.
  constraint learn_ms_activity check (
    kind <> 'method_statement' or coalesce(btrim(activity), '') <> '')
);

-- Columns added after this create block first shipped go here, one statement
-- each — `create table if not exists` will not add them (the 042 lesson).
alter table public.learn_articles add column if not exists ppe text;
alter table public.learn_articles add column if not exists scope text;

create unique index if not exists learn_article_ref_uk
  on public.learn_articles (lower(btrim(ref_no))) where ref_no is not null;

create index if not exists learn_article_cat_idx
  on public.learn_articles (category_code, status, title);
create index if not exists learn_article_isrefs_idx
  on public.learn_articles using gin (is_refs);
create index if not exists learn_article_tags_idx
  on public.learn_articles using gin (tags);


-- ############################################################
-- ###  4. METHOD STATEMENT STEPS
-- ############################################################
-- Safety notes and QA checkpoints sit ON THE STEP, not in one blob per
-- statement. A safety note attached to the whole document is read once and
-- forgotten; attached to "step 4 — strike the side shutters" it is read at the
-- moment it matters.
create table if not exists public.learn_steps (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.learn_articles(id) on delete cascade,

  step_no int not null check (step_no > 0),
  instruction text not null,
  safety_note text,
  qa_checkpoint text,
  -- Standards this particular step cites, where they differ from the article's.
  is_refs text[] not null default '{}',

  created_at timestamptz not null default now()
);

create unique index if not exists learn_step_no_uk
  on public.learn_steps (article_id, step_no);


-- ############################################################
-- ###  5. FULL-TEXT SEARCH
-- ############################################################
-- The weights matter: a hit in the title or the reference number should
-- outrank a passing mention in the body, or searching "456" returns every
-- article that happens to say it somewhere.
--
-- ---------- WHY A TRIGGER AND NOT A GENERATED COLUMN ----------
-- A generated column would be the obvious choice and Postgres REFUSES it here:
--
--   ERROR:  generation expression is not immutable
--
-- `to_tsvector(regconfig, text)` and `setweight` are both immutable, but
-- `array_to_string` is marked STABLE (so is `text[]::text`), and the array
-- fields — is_refs and tags — are exactly the ones that most need to be
-- searchable. Verified by isolating each subexpression against a real
-- PostgreSQL: the two text functions are accepted, both array-to-text paths are
-- refused.
--
-- So the vector is maintained by a BEFORE INSERT OR UPDATE trigger, which is
-- what tsvector columns did before generated columns existed. A BEFORE trigger
-- fires on every insert and every update, so the column cannot drift from the
-- row any more than a generated one could.
alter table public.learn_articles add column if not exists search tsvector;
alter table public.learn_steps    add column if not exists search tsvector;

create or replace function public.fn_learn_article_search()
returns trigger language plpgsql set search_path = public as $$
begin
  new.search :=
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.ref_no, '')), 'A') ||
    setweight(to_tsvector('english',
      array_to_string(coalesce(new.is_refs, '{}'), ' ')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.summary, '')), 'B') ||
    setweight(to_tsvector('english',
      array_to_string(coalesce(new.tags, '{}'), ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.activity, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.body, '')), 'C');
  return new;
end $$;

drop trigger if exists learn_article_search on public.learn_articles;
create trigger learn_article_search
  before insert or update on public.learn_articles
  for each row execute function public.fn_learn_article_search();

create or replace function public.fn_learn_step_search()
returns trigger language plpgsql set search_path = public as $$
begin
  new.search :=
    setweight(to_tsvector('english', coalesce(new.instruction, '')), 'B') ||
    setweight(to_tsvector('english',
      array_to_string(coalesce(new.is_refs, '{}'), ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.safety_note, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(new.qa_checkpoint, '')), 'C');
  return new;
end $$;

drop trigger if exists learn_step_search on public.learn_steps;
create trigger learn_step_search
  before insert or update on public.learn_steps
  for each row execute function public.fn_learn_step_search();

-- Backfill anything written before the trigger existed. No-op on a fresh
-- install; matters if this migration is re-run after content exists.
update public.learn_articles set title = title where search is null;
update public.learn_steps    set instruction = instruction where search is null;

create index if not exists learn_article_search_idx
  on public.learn_articles using gin (search);
create index if not exists learn_step_search_idx
  on public.learn_steps using gin (search);


-- ############################################################
-- ###  6. RLS
-- ############################################################
alter table public.learn_categories enable row level security;
alter table public.learn_articles   enable row level security;
alter table public.learn_steps      enable row level security;

drop policy if exists learn_cat_read on public.learn_categories;
create policy learn_cat_read on public.learn_categories
  for select to authenticated using (true);

drop policy if exists learn_cat_write on public.learn_categories;
create policy learn_cat_write on public.learn_categories
  for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

-- EVERY role reads a published article — that is the whole point of a reference
-- library, and there is not a rupee anywhere in these tables. Drafts are
-- visible only to the people who write them, so a half-finished method
-- statement is never followed on site.
drop policy if exists learn_article_read on public.learn_articles;
create policy learn_article_read on public.learn_articles
  for select to authenticated
  using (
    status::text = 'published'
    or public.my_role() in ('founder', 'pm')
  );

drop policy if exists learn_article_write on public.learn_articles;
create policy learn_article_write on public.learn_articles
  for all to authenticated
  using (public.my_role() in ('founder', 'pm'))
  with check (public.my_role() in ('founder', 'pm'));

-- Steps inherit their article's visibility. A supervisor must not read the
-- steps of a draft they cannot read the header of.
drop policy if exists learn_step_read on public.learn_steps;
create policy learn_step_read on public.learn_steps
  for select to authenticated
  using (exists (
    select 1 from public.learn_articles a
    where a.id = article_id
      and (a.status::text = 'published' or public.my_role() in ('founder', 'pm'))
  ));

drop policy if exists learn_step_write on public.learn_steps;
create policy learn_step_write on public.learn_steps
  for all to authenticated
  using (public.my_role() in ('founder', 'pm'))
  with check (public.my_role() in ('founder', 'pm'));


-- ############################################################
-- ###  7. AUDIT
-- ############################################################
-- A method statement is a safety document. "Who changed step 4, and when" is a
-- question somebody will ask after an incident, and audit_log's old_data /
-- new_data jsonb is what answers it — which is also why there is no separate
-- revisions table.
drop trigger if exists audit_learn_articles on public.learn_articles;
create trigger audit_learn_articles
  after insert or update or delete on public.learn_articles
  for each row execute function public.fn_audit();

drop trigger if exists audit_learn_steps on public.learn_steps;
create trigger audit_learn_steps
  after insert or update or delete on public.learn_steps
  for each row execute function public.fn_audit();

-- learn_categories is keyed by `code`, so it needs the code-keyed audit
-- function from 051 — fn_audit would raise "record new has no field id" and
-- ABORT the write (the 051 lesson, found in production).
drop trigger if exists audit_learn_categories on public.learn_categories;
create trigger audit_learn_categories
  after insert or update or delete on public.learn_categories
  for each row execute function public.fn_audit_by_code();

-- Stamp who last touched an article, so the row and the audit trail agree.
create or replace function public.fn_learn_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists learn_article_touch on public.learn_articles;
create trigger learn_article_touch
  before update on public.learn_articles
  for each row execute function public.fn_learn_touch();


-- ############################################################
-- ###  8. BROWSE
-- ############################################################
drop view if exists public.v_learn_articles cascade;

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
  cardinality(a.attachments)                          as attachment_count,
  (select count(*) from public.learn_steps s
    where s.article_id = a.id)::int                    as step_count
from public.learn_articles a
join public.learn_categories c on c.code = a.category_code;

grant select on public.v_learn_articles to authenticated;


-- Counts per category, for the shelf list. A category with nothing in it still
-- appears, with a zero — a shelf that vanishes when empty is a shelf nobody
-- knows to fill.
drop function if exists public.fn_learn_category_counts();
create function public.fn_learn_category_counts()
returns table (
  code text,
  name text,
  description text,
  sort_order int,
  article_count int
)
language sql
stable
security invoker
set search_path = public
as $$
  select c.code, c.name, c.description, c.sort_order,
         (select count(*) from public.learn_articles a
           where a.category_code = c.code
             and (a.status::text = 'published'
                  or public.my_role() in ('founder', 'pm')))::int
  from public.learn_categories c
  where c.is_active
  order by c.sort_order, c.name;
$$;

revoke all on function public.fn_learn_category_counts() from public, anon;
grant execute on function public.fn_learn_category_counts() to authenticated;


-- ############################################################
-- ###  9. SEARCH
-- ############################################################
-- Articles AND steps, through one function. The sentence somebody remembers
-- from a method statement is usually inside a step ("cure for seven days"), not
-- in its title, so a search that only looked at headers would miss the thing
-- they are actually looking for.
--
-- `websearch_to_tsquery` rather than plainto_: it understands quoted phrases
-- and a leading minus, which is what people type without being told to.
drop function if exists public.fn_learn_search(text, text, text, int);
create function public.fn_learn_search(
  p_q        text,
  p_category text default null,
  p_kind     text default null,
  p_limit    int  default 40
)
returns table (
  id            uuid,
  category_code text,
  category_name text,
  kind          learn_kind,
  status        learn_status,
  title         text,
  ref_no        text,
  summary       text,
  is_refs       text[],
  tags          text[],
  step_count    int,
  rank          real,
  snippet       text,
  matched_in    text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  q tsquery;
begin
  -- An empty search is a browse, not a search: return the most recently
  -- updated, rather than nothing.
  if coalesce(btrim(p_q), '') = '' then
    return query
    select v.id, v.category_code, v.category_name, v.kind, v.status, v.title,
           v.ref_no, v.summary, v.is_refs, v.tags, v.step_count,
           0::real, coalesce(v.summary, ''), 'recent'::text
    from public.v_learn_articles v
    where (p_category is null or v.category_code = p_category)
      and (p_kind is null or v.kind::text = p_kind)
    order by v.updated_at desc
    limit greatest(least(coalesce(p_limit, 40), 200), 1);
    return;
  end if;

  q := websearch_to_tsquery('english', p_q);

  return query
  with hits as (
    -- Header hit.
    -- Cast to real explicitly. ts_rank_cd returns real, but `* 0.5` in the
    -- second arm promotes it to double precision, and a RETURNS TABLE column
    -- declared `real` then fails at run time with "structure of query does not
    -- match function result type" — a create-time-clean, query-time error.
    select a.id,
           ts_rank_cd(a.search, q)::real as r,
           ts_headline('english',
             coalesce(a.summary, left(coalesce(a.body, ''), 600)), q,
             'MaxWords=28, MinWords=12, ShortWord=3, MaxFragments=1') as sn,
           'article'::text as src
    from public.learn_articles a
    where a.search @@ q
    union all
    -- Step hit, attributed to its article. The rank is halved so a header match
    -- outranks a body match on the same word — otherwise a long procedure wins
    -- every search simply by having more text in it.
    select s.article_id,
           (ts_rank_cd(s.search, q) * 0.5)::real,
           ts_headline('english', s.instruction, q,
             'MaxWords=28, MinWords=12, ShortWord=3, MaxFragments=1'),
           'step'
    from public.learn_steps s
    where s.search @@ q
  ),
  best as (
    select hits.id,
           max(hits.r) as r,
           -- The snippet from the highest-ranked hit for that article.
           (array_agg(hits.sn order by hits.r desc))[1] as sn,
           (array_agg(hits.src order by hits.r desc))[1] as src
    from hits
    group by hits.id
  )
  select v.id, v.category_code, v.category_name, v.kind, v.status, v.title,
         v.ref_no, v.summary, v.is_refs, v.tags, v.step_count,
         best.r, best.sn, best.src
  from best
  join public.v_learn_articles v on v.id = best.id
  where (p_category is null or v.category_code = p_category)
    and (p_kind is null or v.kind::text = p_kind)
  order by best.r desc, v.title
  limit greatest(least(coalesce(p_limit, 40), 200), 1);
end $$;

revoke all on function public.fn_learn_search(text, text, text, int) from public, anon;
grant execute on function public.fn_learn_search(text, text, text, int) to authenticated;


-- ############################################################
-- ### 10. THE REFERENCE JOIN — requirement 4, without a link table
-- ############################################################
-- Given a standard as it is written on a drawing or typed into an NCR's
-- `standard_ref`, return every library article that cites it.
--
-- Matching is normalised on BOTH sides — case, spaces and a colon — because
-- "IS 456", "IS456" and "is 456:2000" are the same standard and all three get
-- typed. The year suffix is stripped: an article about IS 456 should answer a
-- reference to IS 456:2000.
drop function if exists public.fn_learn_normalise_ref(text);
create function public.fn_learn_normalise_ref(p_ref text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      upper(regexp_replace(coalesce(p_ref, ''), '[\s:_-]', '', 'g')),
      '(\d{3,5})\d{4}$', '\1'          -- drop a trailing 4-digit year
    ), '');
$$;

drop function if exists public.fn_learn_by_ref(text);
create function public.fn_learn_by_ref(p_ref text)
returns table (
  id            uuid,
  category_code text,
  category_name text,
  kind          learn_kind,
  title         text,
  ref_no        text,
  summary       text,
  step_count    int
)
language sql
stable
security invoker
set search_path = public
as $$
  select v.id, v.category_code, v.category_name, v.kind, v.title, v.ref_no,
         v.summary, v.step_count
  from public.v_learn_articles v
  where public.fn_learn_normalise_ref(p_ref) is not null
    and (
      public.fn_learn_normalise_ref(v.ref_no) = public.fn_learn_normalise_ref(p_ref)
      or exists (
        select 1 from unnest(v.is_refs) r
        where public.fn_learn_normalise_ref(r) = public.fn_learn_normalise_ref(p_ref)
      )
    )
  order by v.kind, v.title;
$$;

revoke all on function public.fn_learn_by_ref(text) from public, anon;
grant execute on function public.fn_learn_by_ref(text) to authenticated;


-- ############################################################
-- ### 11. PUBLISH / ARCHIVE
-- ############################################################
-- Status moves go through an RPC so the version bump cannot be forgotten and a
-- method statement cannot be published with no steps in it.
drop function if exists public.fn_learn_set_status(uuid, text);
create function public.fn_learn_set_status(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text; v_status text; v_steps int;
begin
  if public.my_role() not in ('founder', 'pm') then
    raise exception 'Only a founder or PM may publish library content.'
      using errcode = '42501';
  end if;
  if p_status not in ('draft', 'published', 'archived') then
    raise exception 'Unknown status "%".', p_status;
  end if;

  select kind::text, status::text into v_kind, v_status
  from public.learn_articles where id = p_id;
  if v_kind is null then
    raise exception 'That article no longer exists.';
  end if;

  -- A method statement with no steps is a title. Publishing it would put an
  -- empty procedure in front of somebody about to do the work.
  if p_status = 'published' and v_kind = 'method_statement' then
    select count(*) into v_steps from public.learn_steps where article_id = p_id;
    if v_steps = 0 then
      raise exception
        'This method statement has no steps yet. Add the procedure before publishing it.';
    end if;
  end if;

  update public.learn_articles
     set status = p_status::learn_status,
         -- Bump only on a fresh publish, so re-publishing an unchanged article
         -- does not inflate the version.
         version = case when p_status = 'published' and v_status <> 'published'
                        then version + 1 else version end
   where id = p_id;
end $$;

revoke all on function public.fn_learn_set_status(uuid, text) from public, anon;
grant execute on function public.fn_learn_set_status(uuid, text) to authenticated;


-- ############################################################
-- ### 12. STORAGE — the `library/` prefix
-- ############################################################
-- Library attachments belong to no project, so the standing rule that every
-- path starts `${projectId}/` cannot apply. They go under a `library/` prefix
-- of the existing documents bucket, with policies that say the rule out loud
-- rather than relying on is_member() happening to return true — the same shape
-- as the `company/` prefix in 040.
drop policy if exists documents_library_read on storage.objects;
create policy documents_library_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'library'
  );

drop policy if exists documents_library_write on storage.objects;
create policy documents_library_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'library'
    and public.my_role() in ('founder', 'pm')
  );

drop policy if exists documents_library_delete on storage.objects;
create policy documents_library_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'library'
    and public.my_role() in ('founder', 'pm')
  );


-- ############################################################
-- ### 13. VERIFY
-- ############################################################
select p.proname, count(*)::int as arities
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fn_learn_search', 'fn_learn_by_ref',
                    'fn_learn_category_counts', 'fn_learn_set_status',
                    'fn_learn_normalise_ref', 'fn_learn_touch')
group by p.proname order by p.proname;

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('learn_categories', 'learn_articles', 'learn_steps',
                     'v_learn_articles')
order by table_name;

select code, name from public.learn_categories order by sort_order;
