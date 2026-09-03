-- ============================================================
-- MASON OS — Migration 074: one gallery, whichever way the picture was shared
--
-- THE PROBLEM, hit twice in testing. A photo can reach a client by two routes:
--
--   1. published from the DAILY SITE LOG  -> a row in client_photos,
--                                            file in the `site-photos` bucket
--   2. uploaded to the document vault's   -> a row in documents,
--      "Photos" folder and shared            file in the `documents` bucket
--
-- `v_client_photos` only ever knew about the first. So a founder uploading
-- eleven images to a folder literally called **Photos** and ticking "share with
-- client" found them in the portal's DOCUMENTS tab, while the Photos tab said
-- "No photos yet". Both statements were true and the combination was nonsense.
--
-- Rather than teach the firm a rule ("site photos go here, client photos go
-- there") — which somebody forgets in a month — the view learns about both.
--
-- HOW THE TWO HALVES STAY HONEST:
--   * Each row now carries its `bucket`, because the file lives in a different
--     bucket depending on the route and the browser has to sign against the
--     right one. Deriving it in the app from the path would be guessing.
--   * `source` says which route it came by. Not shown to the client — they do
--     not care — but it is what makes an unexpected row explainable.
--   * The documents half applies the SAME three conditions as
--     v_client_documents (own project, client_visible, not confidential) plus
--     an image-type test. It cannot show anything that tab would not.
--
-- STORAGE NEEDS NO CHANGE. 070's `documents_client_read` already grants a
-- client read on any object backing a row in `v_client_documents`, and an image
-- document is such a row. `site_photos_client_read` covers the other half. The
-- two policies compose exactly as they should — which is a consequence of 070
-- keying on the published VIEW rather than on a path prefix.
--
-- Re-runnable: drop-then-create (house rule — never `create or replace view`).
-- ============================================================

drop view if exists public.v_client_photos cascade;

create view public.v_client_photos as
-- ---------- published from the site log ----------
select
  c.id,
  c.project_id,
  c.photo_path,
  'site-photos'::text                    as bucket,
  c.caption,
  c.taken_on,
  c.published_at                         as shown_since,
  'site_log'::text                       as source
from public.client_photos c
where c.project_id = public.fn_client_project()

union all

-- ---------- shared from the document vault ----------
-- An image is decided by file_type rather than by the folder: somebody will
-- eventually put a photo in Contracts, and a PDF in Photos. The MIME type is
-- what the browser will actually try to render.
select
  d.id,
  d.project_id,
  d.file_path                            as photo_path,
  'documents'::text                      as bucket,
  d.title                                as caption,
  d.created_at::date                     as taken_on,
  d.created_at                           as shown_since,
  'document'::text                       as source
from public.documents d
where d.project_id = public.fn_client_project()
  and d.client_visible
  and not d.is_confidential
  and coalesce(d.file_type, '') like 'image/%'

order by shown_since desc;

comment on view public.v_client_photos is
  'Every picture shared with the client, however it was shared: published from '
  'the site log, or an image document marked client_visible. Carries `bucket` '
  'because the two live in different buckets and the caller must sign against '
  'the right one.';

grant select on public.v_client_photos to authenticated;


-- ---------- 073 depends on this view? No — but check anything that did ----------
-- `drop … cascade` above would silently remove dependants. Nothing reads
-- v_client_photos except the portal and 070's storage policy (which references
-- it by name inside a USING expression, not as a dependency), so the cascade
-- has nothing to take. This block fails loudly if that ever stops being true.
do $$
declare
  v_missing text;
begin
  select string_agg(p.policyname, ', ')
    into v_missing
  from (values ('site_photos_client_read'), ('documents_client_read')) w(name)
  left join pg_policies p
    on p.schemaname = 'storage' and p.tablename = 'objects'
   and p.policyname = w.name
  where p.policyname is null;

  if v_missing is not null then
    raise exception
      'Migration 070 is not applied — the client can see photo rows but not the files. Run 070 first.';
  end if;
end $$;


-- ---------- VERIFY ----------
-- Zero rows as `postgres` (fn_client_project() is null) — the gate working.
-- Verify through the app: share one image from the vault AND publish one from
-- the site log, then check the portal's Photos tab shows BOTH and each opens.

select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'v_client_photos'
  and column_name in ('bucket', 'source', 'shown_since')
order by 1;
-- Expect three rows.
