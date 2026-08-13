import { supabase } from '@/lib/supabase'
import type {
  InspectionComment,
  NcrRow,
  NcrSeverity,
  NcrStatus,
  NewInspectionComment,
  NewNcrInput,
  QaSummary,
  TaskPriority,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const arr = (v: unknown) => ((v as string[] | null) ?? []) as string[]

/* ---------------- inspection comments ---------------- */

const COMMENT_COLUMNS =
  'id, project_id, observed_on, location, comment, priority, photos, ' +
  'raised_for, task_id, raised_by, created_at, ' +
  'tasks(status), profiles(full_name)'

/**
 * Observations from a site walk, newest first.
 *
 * A comment has no status column: the task it created carries that, and this
 * query reads it through the join. One source of truth for "is it done".
 */
export async function fetchComments(
  projectId: string,
): Promise<InspectionComment[]> {
  const { data, error } = await supabase
    .from('inspection_comments')
    .select(COMMENT_COLUMNS)
    .eq('project_id', projectId)
    .order('observed_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(300)

  if (error) throw error

  return rows(data).map((r) => {
    const t = r.tasks as { status: string } | { status: string }[] | null
    const status = (Array.isArray(t) ? t[0]?.status : t?.status) ?? null
    const p = r.profiles as
      | { full_name: string }
      | { full_name: string }[]
      | null

    return {
      id: r.id as string,
      project_id: r.project_id as string,
      observed_on: r.observed_on as string,
      location: r.location as string,
      comment: r.comment as string,
      priority: r.priority as TaskPriority,
      photos: arr(r.photos),
      raised_for: str(r.raised_for),
      task_id: str(r.task_id),
      task_status: status,
      // A deleted task counts as closed: nothing is outstanding against it.
      task_done: status === null || status === 'done',
      raised_by: r.raised_by as string,
      raised_by_name:
        (Array.isArray(p) ? p[0]?.full_name : p?.full_name) ?? null,
      created_at: r.created_at as string,
    }
  })
}

/**
 * Raises the observation AND its task in one call.
 *
 * There is deliberately no direct-insert policy on `inspection_comments`, so
 * this RPC is the only way one can exist — a comment without a task is a note
 * nobody was told about, which is the exact failure the feature exists to fix.
 */
export async function raiseComment(
  projectId: string,
  input: NewInspectionComment,
): Promise<string> {
  const { data, error } = await supabase.rpc('fn_raise_inspection_comment', {
    p_project: projectId,
    p_location: input.location,
    p_comment: input.comment,
    p_priority: input.priority,
    p_photos: input.photos,
    p_raised_for: input.raised_for || null,
    p_assigned_to: input.assigned_to,
    p_due_date: input.due_date,
    p_trade: input.trade || null,
  })
  if (error) throw error
  return data as string
}

/** Founder/PM only, at RLS. The task it created is left alone. */
export async function deleteComment(id: string): Promise<void> {
  const { error } = await supabase
    .from('inspection_comments')
    .delete()
    .eq('id', id)
  if (error) throw error
}

/* ---------------- QA plan documents ---------------- */

/**
 * The QA plans and checklists filed in Docs → QC Certificates.
 *
 * No new table: these are ordinary documents in the folder that already exists
 * for exactly this. The QA screen is a second window onto them, so a plan
 * uploaded here is the same file the Docs module lists.
 *
 * FILED NCRs LIVE IN THAT FOLDER TOO and are deliberately excluded — an NCR
 * belongs in QC Certificates and nowhere else. The filter is on `doc_kind`
 * (049) rather than on the title: matching "NCR-%" would hide a QA plan called
 * "NCR response procedure" and would break the moment a file was renamed.
 */
export async function fetchQaDocs(projectId: string) {
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, file_path, file_type, created_at')
    .eq('project_id', projectId)
    .eq('folder', 'qc_certificates')
    // null covers everything uploaded before 049 existed.
    .or('doc_kind.eq.qa_plan,doc_kind.is.null')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw error
  return rows(data).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    file_path: r.file_path as string,
    file_type: str(r.file_type),
    created_at: r.created_at as string,
  }))
}

/* ---------------- NCRs ---------------- */

const NCR_COLUMNS =
  'id, ncr_no, project_id, area, description, severity, standard_ref, ' +
  'photos, status, assigned_to, corrective_action, corrected_at, closed_at, ' +
  'reject_reason, cancelled_at, cancel_reason, raised_by, created_at'

export async function fetchNcrs(projectId: string): Promise<NcrRow[]> {
  const { data, error } = await supabase
    .from('ncrs')
    .select(NCR_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(300)

  if (error) throw error

  return rows(data).map((r) => ({
    id: r.id as string,
    ncr_no: r.ncr_no as string,
    project_id: r.project_id as string,
    area: r.area as string,
    description: r.description as string,
    severity: r.severity as NcrSeverity,
    standard_ref: str(r.standard_ref),
    photos: arr(r.photos),
    status: r.status as NcrStatus,
    assigned_to: str(r.assigned_to),
    corrective_action: str(r.corrective_action),
    corrected_at: str(r.corrected_at),
    closed_at: str(r.closed_at),
    reject_reason: str(r.reject_reason),
    cancelled_at: str(r.cancelled_at),
    cancel_reason: str(r.cancel_reason),
    raised_by: r.raised_by as string,
    created_at: r.created_at as string,
  }))
}

export async function createNcr(
  projectId: string,
  input: NewNcrInput,
): Promise<void> {
  const { error } = await supabase.from('ncrs').insert({
    project_id: projectId,
    area: input.area.trim(),
    description: input.description.trim(),
    severity: input.severity,
    standard_ref: input.standard_ref.trim() || null,
    photos: input.photos,
    assigned_to: input.assigned_to,
  })
  if (error) throw error
}

/**
 * Every status move. The RPC decides who may do what: corrected is
 * supervisor/PM/founder, closed and rejected are founder/PM only.
 */
export async function setNcrStatus(
  id: string,
  status: NcrStatus,
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_ncr_status', {
    p_id: id,
    p_status: status,
    p_note: note ?? null,
  })
  if (error) throw error
}

/* ---------------- summary ---------------- */

export async function fetchQaSummary(
  projectId: string,
): Promise<QaSummary | null> {
  const { data, error } = await supabase.rpc('fn_qa_summary', {
    p_project: projectId,
  })
  if (error) return null

  const r = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!r) return null

  const n = (v: unknown) => Number(v ?? 0)

  return {
    open_comments: n(r.open_comments),
    urgent_comments: n(r.urgent_comments),
    high_comments: n(r.high_comments),
    total_comments: n(r.total_comments),
    open_ncrs: n(r.open_ncrs),
    ncr_minor: n(r.ncr_minor),
    ncr_major: n(r.ncr_major),
    ncr_critical: n(r.ncr_critical),
    corrected_ncrs: n(r.corrected_ncrs),
    closed_ncrs: n(r.closed_ncrs),
    qa_docs: n(r.qa_docs),
  }
}
