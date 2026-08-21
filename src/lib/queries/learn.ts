import type { ExtractResult } from '@/lib/pdfText'
import {
  removeLibraryFile,
  signedDocumentUrl,
  uploadLibraryFile,
} from '@/lib/storage'
import { supabase } from '@/lib/supabase'
import type {
  DocExtractStatus,
  LearnArticle,
  LearnArticleRow,
  LearnCategory,
  LearnDocumentHit,
  LearnDocumentRow,
  LearnKind,
  LearnPassage,
  LearnSearchHit,
  LearnStatus,
  LearnStep,
  NewLearnArticle,
  NewLearnDocument,
  NewLearnStep,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const n = (v: unknown) => Number(v ?? 0)
const arr = (v: unknown) => ((v as string[] | null) ?? []) as string[]

const LIST_COLUMNS =
  'id, category_code, category_name, kind, status, title, ref_no, summary, ' +
  'is_refs, trades, tags, activity, version, updated_at, attachment_count, step_count'

function toRow(r: Record<string, unknown>): LearnArticleRow {
  return {
    id: r.id as string,
    category_code: r.category_code as string,
    category_name: r.category_name as string,
    kind: r.kind as LearnKind,
    status: r.status as LearnStatus,
    title: r.title as string,
    ref_no: str(r.ref_no),
    summary: str(r.summary),
    is_refs: arr(r.is_refs),
    trades: arr(r.trades),
    tags: arr(r.tags),
    activity: str(r.activity),
    version: n(r.version),
    updated_at: r.updated_at as string,
    attachment_count: n(r.attachment_count),
    step_count: n(r.step_count),
  }
}

/* ---------------- browse ---------------- */

/**
 * The shelves, with counts. Empty categories are still returned — a shelf that
 * disappears when empty is a shelf nobody knows to fill.
 *
 * The count respects who is asking: a supervisor's number covers published
 * articles only, because drafts are hidden from them at RLS.
 */
export async function fetchLearnCategories(): Promise<LearnCategory[]> {
  const { data, error } = await supabase.rpc('fn_learn_category_counts')
  if (error) throw error
  return rows(data).map((r) => ({
    code: r.code as string,
    name: r.name as string,
    description: str(r.description),
    sort_order: n(r.sort_order),
    article_count: n(r.article_count),
    document_count: n(r.document_count),
  }))
}

export async function fetchLearnArticles(
  category: string | null,
): Promise<LearnArticleRow[]> {
  let q = supabase
    .from('v_learn_articles')
    .select(LIST_COLUMNS)
    .order('title')
    .limit(300)
  if (category) q = q.eq('category_code', category)

  const { data, error } = await q
  if (error) throw error
  return rows(data).map(toRow)
}

/* ---------------- search ---------------- */

/**
 * Postgres full-text search across articles AND their steps.
 *
 * Not `ilike '%…%'`: that cannot rank, cannot handle a quoted phrase, and gets
 * slower with every article. The server ranks the hits, halves a step's score
 * so a title match wins, and returns a highlighted snippet — all of which would
 * be guesswork in the browser.
 *
 * An empty query is a browse, not an error: it returns the most recently
 * updated, so the search box is never a dead end.
 */
export async function searchLearn(
  query: string,
  category: string | null,
  kind: LearnKind | null,
): Promise<LearnSearchHit[]> {
  const { data, error } = await supabase.rpc('fn_learn_search', {
    p_q: query,
    p_category: category,
    p_kind: kind,
    p_limit: 60,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    id: r.id as string,
    category_code: r.category_code as string,
    category_name: r.category_name as string,
    kind: r.kind as LearnKind,
    status: r.status as LearnStatus,
    title: r.title as string,
    ref_no: str(r.ref_no),
    summary: str(r.summary),
    is_refs: arr(r.is_refs),
    tags: arr(r.tags),
    step_count: n(r.step_count),
    rank: Number(r.rank ?? 0),
    snippet: str(r.snippet),
    matched_in: (r.matched_in as LearnSearchHit['matched_in']) ?? 'article',
  }))
}

/**
 * Everything in the library that cites a given standard.
 *
 * This is requirement 4 — the link to QA — done by matching a reference rather
 * than by storing a foreign key. `ncrs.standard_ref` already holds strings like
 * "IS 456", so an NCR can surface the method statement that covers it without
 * either table knowing the other exists. Matching normalises case, spaces and a
 * trailing year, so "IS 456", "is456" and "IS 456:2000" all find it.
 */
export async function fetchLearnByRef(
  ref: string,
): Promise<LearnArticleRow[]> {
  const { data, error } = await supabase.rpc('fn_learn_by_ref', { p_ref: ref })
  if (error) return []
  return rows(data).map((r) => ({
    ...toRow(r),
    status: 'published' as LearnStatus,
    is_refs: [],
    trades: [],
    tags: [],
    version: 0,
    updated_at: '',
    attachment_count: 0,
  }))
}

/* ---------------- one article ---------------- */

export async function fetchLearnArticle(
  id: string,
): Promise<{ article: LearnArticle; steps: LearnStep[] } | null> {
  const [a, s] = await Promise.all([
    supabase
      .from('learn_articles')
      .select(
        'id, category_code, kind, status, title, ref_no, summary, body, ' +
          'is_refs, trades, tags, activity, scope, ppe, version, ' +
          'created_by, updated_by, updated_at',
      )
      .eq('id', id)
      .maybeSingle(),
    supabase
      .from('learn_steps')
      .select('id, article_id, step_no, instruction, safety_note, qa_checkpoint, is_refs')
      .eq('article_id', id)
      .order('step_no'),
  ])

  if (a.error) throw a.error
  if (!a.data) return null
  const r = a.data as unknown as Record<string, unknown>

  // category_name is on the view, not the table — one extra lookup rather than
  // a join, because a single article is one row and this keeps the select list
  // matching the table exactly.
  const { data: cat } = await supabase
    .from('learn_categories')
    .select('name')
    .eq('code', r.category_code as string)
    .maybeSingle()

  return {
    article: {
      ...toRow({
        ...r,
        category_name: (cat as { name?: string } | null)?.name ?? '',
        attachment_count: 0,   // filled from learn_documents by the caller
        step_count: (s.data ?? []).length,
      }),
      body: str(r.body),
      scope: str(r.scope),
      ppe: str(r.ppe),
      created_by: r.created_by as string,
      updated_by: str(r.updated_by),
    },
    steps: rows(s.data).map((x) => ({
      id: x.id as string,
      article_id: x.article_id as string,
      step_no: n(x.step_no),
      instruction: x.instruction as string,
      safety_note: str(x.safety_note),
      qa_checkpoint: str(x.qa_checkpoint),
      is_refs: arr(x.is_refs),
    })),
  }
}

/* ---------------- writing ---------------- */

const articlePayload = (input: NewLearnArticle) => ({
  category_code: input.category_code,
  kind: input.kind,
  title: input.title.trim(),
  ref_no: input.ref_no.trim() || null,
  summary: input.summary.trim() || null,
  body: input.body.trim() || null,
  is_refs: input.is_refs,
  trades: input.trades,
  tags: input.tags,
  activity: input.activity.trim() || null,
  scope: input.scope.trim() || null,
  ppe: input.ppe.trim() || null,
})

export async function createLearnArticle(
  input: NewLearnArticle,
): Promise<string> {
  const { data, error } = await supabase
    .from('learn_articles')
    .insert(articlePayload(input))
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

export async function updateLearnArticle(
  id: string,
  input: NewLearnArticle,
): Promise<void> {
  const { error } = await supabase
    .from('learn_articles')
    .update(articlePayload(input))
    .eq('id', id)
  if (error) throw error
}

export async function deleteLearnArticle(id: string): Promise<void> {
  const { error } = await supabase.from('learn_articles').delete().eq('id', id)
  if (error) throw error
}

/**
 * Publish / unpublish / archive.
 *
 * Through an RPC rather than a plain update, so the version bump cannot be
 * forgotten and a method statement with no steps cannot be published — an
 * empty procedure in front of somebody about to do the work is worse than no
 * procedure at all.
 */
export async function setLearnStatus(
  id: string,
  status: LearnStatus,
): Promise<void> {
  const { error } = await supabase.rpc('fn_learn_set_status', {
    p_id: id,
    p_status: status,
  })
  if (error) throw error
}

/**
 * Replaces the whole step list in one statement each way.
 *
 * Steps are ordered and renumbered constantly while a procedure is being
 * written; diffing them row by row would be more code and more ways to end up
 * with two step 3s. The delete and the insert are each a single statement.
 */
export async function saveLearnSteps(
  articleId: string,
  steps: NewLearnStep[],
): Promise<void> {
  const { error: delErr } = await supabase
    .from('learn_steps')
    .delete()
    .eq('article_id', articleId)
  if (delErr) throw delErr

  const clean = steps
    .filter((s) => s.instruction.trim() !== '')
    .map((s, i) => ({
      article_id: articleId,
      step_no: i + 1,
      instruction: s.instruction.trim(),
      safety_note: s.safety_note.trim() || null,
      qa_checkpoint: s.qa_checkpoint.trim() || null,
      is_refs: s.is_refs,
    }))

  if (clean.length === 0) return
  const { error } = await supabase.from('learn_steps').insert(clean)
  if (error) throw error
}

/* ---------------- AI skeleton (Edge Function, migration 058) ---------------- */

export interface LearnDraftSkeleton {
  model: string
  summary_prompt: string
  scope_prompt: string
  ppe_prompt: string
  suggested_is_refs: string[]
  suggested_tags: string[]
  steps: { instruction: string; safety_note: string; qa_checkpoint: string }[]
}

/**
 * Asks Gemini for the SHAPE of a procedure — the step sequence, and where a
 * safety note and a QA checkpoint belong on each step.
 *
 * It deliberately does not return values. The Edge Function's response schema
 * has no field for a tolerance or a cover figure, the prompt forbids stating
 * one, and anything that still looks like a requirement is replaced with "___"
 * before it comes back. A model is good at the order of work and confidently
 * wrong about the numbers, and the numbers are the part that reaches a bar
 * bender.
 *
 * The key lives in the Edge Function, never in this bundle.
 */
export async function draftLearnSkeleton(input: {
  title: string
  activity: string
  trades: string[]
}): Promise<LearnDraftSkeleton> {
  const { data, error } = await supabase.functions.invoke('learn-draft', {
    body: input,
  })

  if (error) {
    // A fetch that never happened and an endpoint that does not exist produce
    // the SAME sentence from supabase-js. The class is what separates them:
    // FunctionsFetchError means the browser never reached the function — CORS,
    // the wrong project URL, or offline — and cost hours once because it reads
    // exactly like "not deployed".
    if (error.name === 'FunctionsFetchError') {
      throw new Error(
        'The browser could not reach the drafting function. It is deployed as ' +
          '"learn-draft", or the request was blocked before it left — check the ' +
          "function's CORS headers and that you are online.",
      )
    }

    // The function returns its own message in the body on a non-2xx; surface
    // that rather than "Edge Function returned a non-2xx status code", which
    // tells nobody whether the key is missing or the quota is spent.
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try {
        const body = await ctx.json()
        if (body?.error) throw new Error(String(body.error))
      } catch (inner) {
        if (inner instanceof Error && inner.message) throw inner
      }
    }
    throw error
  }

  const d = data as LearnDraftSkeleton | { error?: string }
  if ('error' in d && d.error) throw new Error(String(d.error))
  return d as LearnDraftSkeleton
}

/** Stamps provenance once a skeleton has been generated into an article. */
export async function markAiDrafted(
  id: string,
  model: string,
): Promise<void> {
  const { error } = await supabase
    .from('learn_articles')
    .update({ ai_drafted_at: new Date().toISOString(), ai_model: model })
    .eq('id', id)
  if (error) throw error
}

/* ================================================================
   LIBRARY DOCUMENTS (migration 059)
   ================================================================ */

const DOC_COLUMNS =
  'id, article_id, article_title, shelf_code, shelf_name, status, title, ' +
  'description, ref_no, is_refs, trades, tags, file_path, file_name, ' +
  'file_type, file_size, page_count, extract_status, extract_note, ' +
  'has_text, text_length, created_at, updated_at'

function toDoc(r: Record<string, unknown>): LearnDocumentRow {
  return {
    id: r.id as string,
    article_id: str(r.article_id),
    article_title: str(r.article_title),
    shelf_code: str(r.shelf_code),
    shelf_name: str(r.shelf_name),
    status: r.status as LearnStatus,
    title: r.title as string,
    description: str(r.description),
    ref_no: str(r.ref_no),
    is_refs: arr(r.is_refs),
    trades: arr(r.trades),
    tags: arr(r.tags),
    file_path: r.file_path as string,
    file_name: r.file_name as string,
    file_type: str(r.file_type),
    file_size: r.file_size == null ? null : n(r.file_size),
    page_count: r.page_count == null ? null : n(r.page_count),
    extract_status: (r.extract_status as DocExtractStatus) ?? 'pending',
    extract_note: str(r.extract_note),
    has_text: Boolean(r.has_text),
    text_length: n(r.text_length),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  }
}

/** Documents on a shelf, or every document when no shelf is given. */
export async function fetchLearnDocuments(
  shelf: string | null,
): Promise<LearnDocumentRow[]> {
  let q = supabase
    .from('v_learn_documents')
    .select(DOC_COLUMNS)
    .order('title')
    .limit(300)
  if (shelf) q = q.eq('shelf_code', shelf)

  const { data, error } = await q
  if (error) throw error
  return rows(data).map(toDoc)
}

/** The files attached to one article. */
export async function fetchArticleDocuments(
  articleId: string,
): Promise<LearnDocumentRow[]> {
  const { data, error } = await supabase
    .from('v_learn_documents')
    .select(DOC_COLUMNS)
    .eq('article_id', articleId)
    .order('title')
  if (error) throw error
  return rows(data).map(toDoc)
}

/**
 * Full-text search over uploaded documents, including their extracted text.
 *
 * Separate from searchLearn() rather than merged into it: fn_learn_search
 * returns rows keyed to v_learn_articles and a document is not an article.
 * Widening that result to carry both would have put a nullable half in every
 * row, for a screen that wants two labelled lists anyway.
 */
export async function searchLearnDocuments(
  query: string,
  shelf: string | null,
): Promise<LearnDocumentHit[]> {
  const { data, error } = await supabase.rpc('fn_learn_doc_search', {
    p_q: query,
    p_category: shelf,
    p_limit: 60,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    ...toDoc(r),
    // fn_learn_doc_search does not return these two; the list does not use them.
    created_at: '',
    updated_at: '',
    text_length: 0,
    trades: [],
    rank: Number(r.rank ?? 0),
    snippet: str(r.snippet),
  }))
}

/**
 * Ranked passages across articles, steps AND documents — the seam a future
 * assistant reads. Nothing in the UI calls it yet; it exists so that when the
 * assistant is built, retrieval is a function call rather than a project.
 *
 * `security invoker` on the server means RLS decides what each caller sees, so
 * a supervisor's question can never be answered out of a draft.
 */
export async function retrieveLearnPassages(
  question: string,
  limit = 12,
): Promise<LearnPassage[]> {
  const { data, error } = await supabase.rpc('fn_learn_retrieve', {
    p_q: question,
    p_limit: limit,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    source_type: r.source_type as LearnPassage['source_type'],
    source_id: r.source_id as string,
    article_id: str(r.article_id),
    title: r.title as string,
    ref_no: str(r.ref_no),
    is_refs: arr(r.is_refs),
    passage: (r.passage as string) ?? '',
    rank: Number(r.rank ?? 0),
  }))
}

/**
 * Files a document: uploads the object, then writes the row with whatever text
 * could be extracted from it.
 *
 * ORDER MATTERS. The object goes up first, because a row pointing at a file
 * that failed to upload is a broken link somebody has to clean up by hand,
 * whereas an orphaned object is invisible and costs a few kilobytes. If the row
 * insert fails, the object is removed again so a retry is not refused by the
 * unique index on file_path.
 */
export async function uploadLearnDocument(
  file: File,
  meta: NewLearnDocument,
  extracted: ExtractResult,
): Promise<string> {
  const { path, fileType } = await uploadLibraryFile(file)

  const { data, error } = await supabase
    .from('learn_documents')
    .insert({
      article_id: meta.article_id,
      category_code: meta.category_code,
      title: meta.title.trim() || file.name,
      description: meta.description.trim() || null,
      ref_no: meta.ref_no.trim() || null,
      is_refs: meta.is_refs,
      trades: meta.trades,
      tags: meta.tags,
      file_path: path,
      file_name: file.name,
      file_type: fileType,
      file_size: file.size,
      page_count: extracted.pageCount,
      extracted_text: extracted.text || null,
      extract_status: extracted.status,
      extract_note: extracted.note,
      extracted_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    await removeLibraryFile(path).catch(() => {})
    throw error
  }
  return data.id as string
}

export async function updateLearnDocument(
  id: string,
  meta: Partial<NewLearnDocument> & { status?: LearnStatus },
): Promise<void> {
  const { error } = await supabase
    .from('learn_documents')
    .update({
      ...(meta.title !== undefined ? { title: meta.title.trim() } : {}),
      ...(meta.description !== undefined
        ? { description: meta.description.trim() || null }
        : {}),
      ...(meta.ref_no !== undefined
        ? { ref_no: meta.ref_no.trim() || null }
        : {}),
      ...(meta.is_refs !== undefined ? { is_refs: meta.is_refs } : {}),
      ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
      ...(meta.category_code !== undefined
        ? { category_code: meta.category_code }
        : {}),
      ...(meta.status !== undefined ? { status: meta.status } : {}),
    })
    .eq('id', id)
  if (error) throw error
}

/**
 * Row first, then the object. A stored file whose row is gone is unreachable
 * and harmless; a row whose file is gone is a download button that fails.
 */
export async function deleteLearnDocument(
  id: string,
  path: string,
): Promise<void> {
  const { error } = await supabase.from('learn_documents').delete().eq('id', id)
  if (error) throw error
  await removeLibraryFile(path).catch(() => {})
}

/** Short-lived signed URL — the documents bucket is private. */
export async function learnDocumentUrl(path: string): Promise<string | null> {
  return signedDocumentUrl(path, 300)
}
