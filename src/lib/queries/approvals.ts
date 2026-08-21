import { supabase } from '@/lib/supabase'
import type {
  ApprovalMethod,
  ApprovalState,
  ApprovalSubject,
  ApprovalSummary,
  ClientApprovalRow,
  NewClientApproval,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const n = (v: unknown) => Number(v ?? 0)
const arr = (v: unknown) => ((v as string[] | null) ?? []) as string[]

const COLUMNS =
  'id, approval_no, project_id, project_name, subject, title, details, ' +
  'approved_by_name, client_role, method, status, decided_on, reject_reason, ' +
  'decided_at, decided_by_name, raised_by_name, variation_id, vo_number, ' +
  'variation_title, document_id, document_title, material_id, material_name, ' +
  'evidence, evidence_count, evidence_missing, created_at'

function toRow(r: Record<string, unknown>): ClientApprovalRow {
  return {
    id: r.id as string,
    approval_no: r.approval_no as string,
    project_id: r.project_id as string,
    project_name: (r.project_name as string) ?? '',
    subject: r.subject as ApprovalSubject,
    title: r.title as string,
    details: str(r.details),
    approved_by_name: r.approved_by_name as string,
    client_role: str(r.client_role),
    method: r.method as ApprovalMethod,
    status: r.status as ApprovalState,
    decided_on: str(r.decided_on),
    reject_reason: str(r.reject_reason),
    decided_at: str(r.decided_at),
    decided_by_name: str(r.decided_by_name),
    raised_by_name: str(r.raised_by_name),
    variation_id: str(r.variation_id),
    vo_number: str(r.vo_number),
    variation_title: str(r.variation_title),
    document_id: str(r.document_id),
    document_title: str(r.document_title),
    material_id: str(r.material_id),
    material_name: str(r.material_name),
    evidence: arr(r.evidence),
    evidence_count: n(r.evidence_count),
    evidence_missing: Boolean(r.evidence_missing),
    created_at: r.created_at as string,
  }
}

/**
 * The register for one project.
 *
 * Pending first, then most recently decided — the undecided ones are the only
 * rows anybody has to act on, and burying them under a year of history is how a
 * client decision sits unchased for two months.
 */
export async function fetchApprovals(
  projectId: string,
  status: ApprovalState | null,
): Promise<ClientApprovalRow[]> {
  let q = supabase
    .from('v_client_approvals')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('status', { ascending: true })
    .order('decided_on', { ascending: false, nullsFirst: true })
    .order('created_at', { ascending: false })
    .limit(300)

  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) throw error
  return rows(data).map(toRow)
}

/** Counts for the project detail card. */
export async function fetchApprovalSummary(
  projectId: string,
): Promise<ApprovalSummary | null> {
  const { data, error } = await supabase.rpc('fn_project_approval_summary', {
    p_project: projectId,
  })
  if (error) throw error
  const r = rows(data)[0]
  if (!r) return null
  return {
    pending_count: n(r.pending_count),
    approved_count: n(r.approved_count),
    rejected_count: n(r.rejected_count),
    oldest_pending_days:
      r.oldest_pending_days == null ? null : n(r.oldest_pending_days),
    no_evidence_count: n(r.no_evidence_count),
  }
}

export async function createApproval(
  input: NewClientApproval,
): Promise<string> {
  const { data, error } = await supabase
    .from('client_approvals')
    .insert({
      project_id: input.project_id,
      subject: input.subject,
      title: input.title.trim(),
      details: input.details.trim() || null,
      approved_by_name: input.approved_by_name.trim(),
      client_role: input.client_role.trim() || null,
      method: input.method,
      variation_id: input.variation_id,
      document_id: input.document_id,
      material_id: input.material_id,
      evidence: input.evidence,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

/**
 * Records what the client decided.
 *
 * Through the RPC, never a plain update: a BEFORE UPDATE trigger on the table
 * refuses the decision columns when the caller is PostgREST, so the status, the
 * date, and who recorded it can only ever move together (migration 060).
 *
 * `decidedOn` is the day the CLIENT decided, which is usually earlier than the
 * day somebody got round to typing it in.
 */
export async function setApprovalStatus(
  id: string,
  status: ApprovalState,
  decidedOn: string | null,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_approval_status', {
    p_id: id,
    p_status: status,
    p_on: decidedOn,
    p_reason: reason,
  })
  if (error) throw error
}

/**
 * Removes an approval that was logged in error.
 *
 * The server refuses once it has been decided — a decided approval is a record
 * of something the client said, and the fix for a mistake is to set it back to
 * pending and correct it, which leaves the whole sequence in the audit log.
 */
export async function deleteApproval(id: string): Promise<void> {
  const { error } = await supabase.rpc('fn_delete_approval', { p_id: id })
  if (error) throw error
}

/** Pickers for the "what does this refer to" field. */
export async function fetchApprovalLinkOptions(projectId: string): Promise<{
  variations: { id: string; label: string }[]
  documents: { id: string; label: string }[]
  materials: { id: string; label: string }[]
}> {
  // allSettled, not all: a supervisor cannot read variation_orders at all, and
  // one refused picker must not empty the other two (the 056 lesson).
  const [vo, doc, mat] = await Promise.allSettled([
    supabase
      .from('variation_orders')
      .select('id, vo_number, title')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('documents')
      .select('id, title')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.from('materials').select('id, name').order('name').limit(300),
  ])

  const ok = (r: PromiseSettledResult<{ data: unknown; error: unknown }>) =>
    r.status === 'fulfilled' && !r.value.error ? rows(r.value.data) : []

  return {
    variations: ok(vo).map((r) => ({
      id: r.id as string,
      label: `${r.vo_number as string} · ${r.title as string}`,
    })),
    documents: ok(doc).map((r) => ({
      id: r.id as string,
      label: r.title as string,
    })),
    materials: ok(mat).map((r) => ({
      id: r.id as string,
      label: r.name as string,
    })),
  }
}
