-- ============================================================
-- MASON OS — Migration 058: AI-draft provenance on Mason Learn
--
-- The library can now have its STRUCTURE drafted by Gemini: given "RCC slab
-- pour", it proposes the step sequence, where a safety note and a QA checkpoint
-- belong on each step, and which IS standards are likely relevant — by NUMBER
-- ONLY. The engineer writes every actual value, tolerance and site practice.
--
-- ---------- WHY THE FLAG EXISTS ----------
-- A skeleton reads like a document. Six weeks later nobody can tell, by looking,
-- whether a draft was written by the Planning Engineer or generated in four
-- seconds and never touched. `ai_drafted_at` answers that, and the editor shows
-- it as a standing reminder until the article is published — because publishing
-- is the deliberate human act that says somebody checked it.
--
-- It is provenance, not a warning label to be cleared: it stays on the row, and
-- audit_log has the whole edit history alongside it. Anyone auditing the library
-- can ask "which of these started as a machine skeleton" and get an answer.
--
-- ---------- WHAT THE MODEL IS NOT ALLOWED TO PRODUCE ----------
-- No clause text from an IS standard, no numeric requirement, no tolerance, no
-- curing period, no cover value. IS codes are copyrighted and sold by BIS, and
-- more importantly a hallucinated cover value published under the firm's name
-- reaches a bar bender. The Edge Function's prompt forbids it and the response
-- schema has no field to put it in — the model is asked for the SHAPE of a
-- procedure, and the shape is not copyrightable and cannot be wrong in a way
-- that hurts anybody.
--
-- The existing safety machinery does the rest and needed no changes:
--   * everything lands as `draft`
--   * drafts are invisible to supervisors at RLS
--   * `fn_learn_set_status` refuses to publish a method statement with no steps
--
-- Two columns. No new tables, no policy changes.
-- Requires 057.
-- ============================================================

alter table public.learn_articles
  add column if not exists ai_drafted_at timestamptz;

-- Which model produced the skeleton, so a future "that one was drafted by an
-- older model, re-check it" is answerable rather than guesswork.
alter table public.learn_articles
  add column if not exists ai_model text;

comment on column public.learn_articles.ai_drafted_at is
  'When an AI skeleton was generated into this article. Provenance, not a '
  'warning to be cleared: the engineer writes the substance, and publishing is '
  'the human act that says it was checked.';


-- ---------- verify ----------
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'learn_articles'
  and column_name in ('ai_drafted_at', 'ai_model')
order by column_name;
