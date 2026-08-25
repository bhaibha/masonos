import { supabase } from '@/lib/supabase'
import type {
  AnalysisState,
  PhotoAnalysis,
  PhotoAnalysisSummary,
  PhotoConcern,
  PhotoSource,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const n = (v: unknown) => Number(v ?? 0)

const COLUMNS =
  'id, project_id, photo_path, source, description, concerns, model, ' +
  'analysed_at, status, acted_by, acted_at, dismiss_note, ' +
  'accepted_snag_id, accepted_ncr_id, created_at'

function toRow(r: Record<string, unknown>): PhotoAnalysis {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    photo_path: r.photo_path as string,
    source: (r.source as PhotoSource) ?? 'other',
    description: str(r.description),
    concerns: Array.isArray(r.concerns) ? (r.concerns as PhotoConcern[]) : [],
    model: str(r.model),
    analysed_at: r.analysed_at as string,
    status: (r.status as AnalysisState) ?? 'suggested',
    acted_by: str(r.acted_by),
    acted_at: str(r.acted_at),
    dismiss_note: str(r.dismiss_note),
    accepted_snag_id: str(r.accepted_snag_id),
    accepted_ncr_id: str(r.accepted_ncr_id),
    created_at: r.created_at as string,
  }
}

/**
 * The stored analysis for one photo, or null.
 *
 * Called when a photo is opened, so the suggestion and the decision taken on it
 * stay attached to the picture rather than living in a separate list nobody
 * visits.
 */
export async function fetchPhotoAnalysis(
  photoPath: string,
): Promise<PhotoAnalysis | null> {
  const { data, error } = await supabase
    .from('photo_analyses')
    .select(COLUMNS)
    .eq('photo_path', photoPath)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return toRow(data as unknown as Record<string, unknown>)
}

/** Every analysis on a project, newest first — for a review list. */
export async function fetchProjectAnalyses(
  projectId: string,
  status: AnalysisState | null,
): Promise<PhotoAnalysis[]> {
  let q = supabase
    .from('photo_analyses')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(200)
  if (status) q = q.eq('status', status)
  const { data, error } = await q
  if (error) throw error
  return rows(data).map(toRow)
}

export async function fetchPhotoAnalysisSummary(
  projectId: string,
): Promise<PhotoAnalysisSummary | null> {
  const { data, error } = await supabase.rpc('fn_photo_analysis_summary', {
    p_project: projectId,
  })
  if (error) throw error
  const r = rows(data)[0]
  if (!r) return null
  return {
    total_count: n(r.total_count),
    suggested_count: n(r.suggested_count),
    accepted_count: n(r.accepted_count),
    dismissed_count: n(r.dismissed_count),
    accept_rate_pct: r.accept_rate_pct == null ? null : Number(r.accept_rate_pct),
  }
}

/**
 * Asks Gemini to look at one photo. EXPLICIT ACT ONLY — never called on upload.
 *
 * The Edge Function holds the API key, downloads the image as the caller (so
 * storage RLS decides access) and writes the row itself, which is what makes
 * the stored text provably model output rather than a claim.
 */
export async function analysePhoto(input: {
  projectId: string
  photoPath: string
  source: PhotoSource
  siteLogId?: string | null
  snagId?: string | null
  commentId?: string | null
}): Promise<PhotoAnalysis> {
  const { data, error } = await supabase.functions.invoke('photo-analyse', {
    body: {
      project_id: input.projectId,
      photo_path: input.photoPath,
      source: input.source,
      site_log_id: input.siteLogId ?? null,
      snag_id: input.snagId ?? null,
      comment_id: input.commentId ?? null,
    },
  })

  if (error) {
    // A fetch that never happened and an endpoint that does not exist produce
    // the SAME sentence from supabase-js. The class separates them:
    // FunctionsFetchError means the browser never reached the function — CORS,
    // the wrong project URL, or offline.
    if (error.name === 'FunctionsFetchError') {
      throw new Error(
        'The browser could not reach the photo helper. Check that the ' +
          '"photo-analyse" function is deployed and that you are online.',
      )
    }
    // The function returns its own message in the body on a non-2xx. Surface
    // that rather than "non-2xx status code", which tells nobody whether the
    // key is missing or the quota is spent.
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

  const d = data as { id?: string; error?: string }
  if (d?.error) throw new Error(d.error)

  // Read the row back rather than trusting the response shape: the row is what
  // every other screen will show, so it is the thing worth returning.
  const saved = await fetchPhotoAnalysis(input.photoPath)
  if (!saved) throw new Error('The analysis was not saved. Try again.')
  return saved
}

/**
 * Turns a suggestion into a real snag or NCR.
 *
 * The created record carries the ACTING USER as its author, never the model —
 * a snag is somebody's assertion that something is wrong, and it does not get
 * to be nobody's. Severity is the person's judgement; the model never supplies
 * one, because it has nowhere to put one.
 */
export async function acceptPhotoAnalysis(
  id: string,
  target: 'snag' | 'ncr',
  area: string,
  text: string | null,
  severity: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc('fn_accept_photo_analysis', {
    p_id: id,
    p_target: target,
    p_area: area,
    p_text: text,
    p_severity: severity,
  })
  if (error) throw error
  return data as string
}

/**
 * Dismisses a suggestion. The row is KEPT — "the model flagged this and a
 * person looked and said no" is a more useful record than silence, and it is
 * the only way anybody can tell whether this feature earns its API calls.
 */
export async function dismissPhotoAnalysis(
  id: string,
  note: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_dismiss_photo_analysis', {
    p_id: id,
    p_note: note,
  })
  if (error) throw error
}

/** Clears a suggestion so the photo can be looked at again. Refused once accepted. */
export async function reanalysePhoto(photoPath: string): Promise<void> {
  const { error } = await supabase.rpc('fn_reanalyse_photo', {
    p_path: photoPath,
  })
  if (error) throw error
}
