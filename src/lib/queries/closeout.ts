import { supabase } from '@/lib/supabase'
import type {
  CloseoutBlocker,
  CloseoutCategory,
  CloseoutItem,
  FinalAccount,
  ProjectCloseout,
} from '@/lib/types'

/**
 * M28 Project Close-Out.
 *
 * Every figure on this screen is computed in Postgres. `fn_project_final_account`
 * is SECURITY DEFINER because it reads `projects.contract_value`, which 010
 * revoked from `authenticated` — an invoker-rights function would error for
 * everyone including the founder (the 010 → 038 owner-run pattern). Nothing
 * here adds up invoices in the browser.
 */

const one = <T,>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : v

/* ------------------------------------------------------------------ */
/* The close-out record                                                */
/* ------------------------------------------------------------------ */

/** Null when no pack has been opened for this project yet. */
export async function fetchCloseout(
  projectId: string,
): Promise<ProjectCloseout | null> {
  const { data, error } = await supabase
    .from('project_closeouts')
    .select(
      'id, project_id, survey_score, survey_method, survey_comments, survey_taken_on, lessons, closed_at, closed_by, close_waiver_reason, created_at, profiles(full_name)',
    )
    .eq('project_id', projectId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const items = await fetchCloseoutItems(data.id as string)

  return {
    id: data.id as string,
    project_id: data.project_id as string,
    survey_score: (data.survey_score as number | null) ?? null,
    survey_method: (data.survey_method as string | null) ?? null,
    survey_comments: (data.survey_comments as string | null) ?? null,
    survey_taken_on: (data.survey_taken_on as string | null) ?? null,
    lessons: (data.lessons as string | null) ?? null,
    closed_at: (data.closed_at as string | null) ?? null,
    closed_by: (data.closed_by as string | null) ?? null,
    closed_by_name:
      one(data.profiles as { full_name: string } | { full_name: string }[] | null)
        ?.full_name ?? null,
    close_waiver_reason: (data.close_waiver_reason as string | null) ?? null,
    created_at: data.created_at as string,
    items,
  }
}

async function fetchCloseoutItems(closeoutId: string): Promise<CloseoutItem[]> {
  const { data, error } = await supabase
    .from('closeout_items')
    .select(
      'id, closeout_id, category, label, is_required, received, received_on, document_id, note, sort, documents(title)',
    )
    .eq('closeout_id', closeoutId)
    .order('sort')

  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id as string,
    closeout_id: r.closeout_id as string,
    category: r.category as CloseoutCategory,
    label: r.label as string,
    is_required: Boolean(r.is_required),
    received: Boolean(r.received),
    received_on: (r.received_on as string | null) ?? null,
    document_id: (r.document_id as string | null) ?? null,
    document_title:
      one(r.documents as { title: string } | { title: string }[] | null)?.title ??
      null,
    note: (r.note as string | null) ?? null,
    sort: Number(r.sort),
  }))
}

/**
 * Opens the pack, seeded with the seven standard items (four of them required).
 * Idempotent — calling it twice returns the same row, so a double tap on a slow
 * connection cannot create a second handover pack for one job.
 */
export async function openCloseout(projectId: string): Promise<string> {
  const { data, error } = await supabase.rpc('fn_open_closeout', {
    p_project: projectId,
  })
  if (error) throw error
  return data as string
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

/**
 * Ticks or un-ticks an item. `received_on` is set here because
 * `cli_received_has_date` refuses a tick with no date — recording that
 * something arrived without recording when is the thing the constraint exists
 * to stop.
 */
export async function setItemReceived(
  id: string,
  received: boolean,
  receivedOn: string,
): Promise<void> {
  const { error } = await supabase
    .from('closeout_items')
    .update({
      received,
      received_on: received ? receivedOn : null,
      // Un-ticking also clears the evidence link; leaving a document attached
      // to an item marked not-received would read as a contradiction.
      ...(received ? {} : { document_id: null }),
    })
    .eq('id', id)
  if (error) throw error
}

/** Attaches (or clears) the vault document that proves the item. */
export async function setItemDocument(
  id: string,
  documentId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('closeout_items')
    .update({ document_id: documentId })
    .eq('id', id)
  if (error) throw error
}

export async function addCloseoutItem(input: {
  closeout_id: string
  category: CloseoutCategory
  label: string
}): Promise<void> {
  const { error } = await supabase.from('closeout_items').insert({
    closeout_id: input.closeout_id,
    category: input.category,
    label: input.label,
    // Added items are optional by default. A list where everything is
    // mandatory is one people learn to force past.
    is_required: false,
    sort: 200,
  })
  if (error) throw error
}

export async function deleteCloseoutItem(id: string): Promise<void> {
  const { error } = await supabase.from('closeout_items').delete().eq('id', id)
  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* Survey and lessons                                                  */
/* ------------------------------------------------------------------ */

/**
 * `pcl_score_has_date` refuses a score with no date, so the date goes with it.
 * `survey_method` records HOW it was captured — a phone call and a signed form
 * should not look identical on the record (the 060 rule).
 */
export async function saveSurvey(
  closeoutId: string,
  input: {
    score: number | null
    method: string
    comments: string
    takenOn: string
  },
): Promise<void> {
  const { error } = await supabase
    .from('project_closeouts')
    .update({
      survey_score: input.score,
      survey_method: input.method || null,
      survey_comments: input.comments || null,
      survey_taken_on: input.score === null ? null : input.takenOn,
    })
    .eq('id', closeoutId)
  if (error) throw error
}

export async function saveLessons(
  closeoutId: string,
  lessons: string,
): Promise<void> {
  const { error } = await supabase
    .from('project_closeouts')
    .update({ lessons: lessons || null })
    .eq('id', closeoutId)
  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* The final account and the close                                     */
/* ------------------------------------------------------------------ */

/**
 * Null when the caller may not see it — the function returns ZERO ROWS rather
 * than a row of zeros (066), because a final account reading "₹0 outstanding"
 * would be read as settled.
 */
export async function fetchFinalAccount(
  projectId: string,
): Promise<FinalAccount | null> {
  const { data, error } = await supabase
    .rpc('fn_project_final_account', { p_project: projectId })
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const r = data as Record<string, number | null>
  const n = (v: number | null | undefined) => Number(v ?? 0)
  return {
    contract_value: n(r.contract_value),
    variations_value: n(r.variations_value),
    revised_contract: n(r.revised_contract),
    invoiced: n(r.invoiced),
    received: n(r.received),
    still_to_bill: n(r.still_to_bill),
    still_to_collect: n(r.still_to_collect),
    certified: n(r.certified),
    retention_held: n(r.retention_held),
  }
}

/** Empty array means ready to close. */
export async function fetchBlockers(
  projectId: string,
): Promise<CloseoutBlocker[]> {
  const { data, error } = await supabase.rpc('fn_closeout_blockers', {
    p_project: projectId,
  })
  if (error) throw error
  return (data ?? []) as CloseoutBlocker[]
}

/**
 * Closes the project.
 *
 * The function REFUSES while anything is outstanding and names what is in the
 * way — required documents and open snags cannot be waived at all, and money
 * can be waived only by a founder with a written reason, which is stored on the
 * row. The screen mirrors that, but the database is what enforces it.
 */
export async function closeProject(
  projectId: string,
  force = false,
  reason = '',
): Promise<void> {
  const { error } = await supabase.rpc('fn_close_project', {
    p_project: projectId,
    p_force: force,
    p_reason: reason || null,
  })
  if (error) throw error
}

/** Founder only. A close made in error must be undoable; the audit keeps both. */
export async function reopenProject(projectId: string): Promise<void> {
  const { error } = await supabase.rpc('fn_reopen_project', {
    p_project: projectId,
  })
  if (error) throw error
}
