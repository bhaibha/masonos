import { supabase } from '@/lib/supabase'
import { DOCUMENTS_BUCKET, SITE_PHOTOS_BUCKET } from '@/lib/storage'

/**
 * THE CLIENT PORTAL'S ONLY DATA ACCESS.
 *
 * Every function below reads a `v_client_*` view or calls `fn_client_decide`.
 * Nothing here touches a base table, and nothing here takes a project id — the
 * views scope themselves through `fn_client_project()`, which reads the caller's
 * own JWT. A project id passed from the browser would be a parameter somebody
 * could change; there is deliberately nothing to change.
 *
 * If a screen in this portal ever needs something these views do not carry, the
 * answer is a new curated view in a migration, never a query against a base
 * table from here.
 */

export interface ClientProject {
  project_id: string
  name: string
  client_name: string | null
  site_address: string | null
  status: string
  start_date: string | null
  target_end_date: string | null
}

export interface ClientProgressRow {
  activity_id: string
  code: string
  name: string
  phase: string | null
  planned_start: string | null
  planned_end: string | null
  actual_start: string | null
  actual_end: string | null
  pct_complete: number
  sort_order: number | null
}

export interface ClientProgressSummary {
  activity_count: number
  completed_count: number
  pct_complete: number | null
  starts: string | null
  ends: string | null
}

export interface ClientPhoto {
  id: string
  photo_path: string
  /**
   * Which bucket the file is in — `site-photos` when published from the daily
   * site log, `documents` when shared from the vault (migration 074). The
   * caller must sign against the right one, and deriving it from the path in
   * the browser would be guessing.
   */
  bucket: string
  caption: string | null
  taken_on: string | null
  shown_since: string
  source: 'site_log' | 'document'
}

export interface ClientDocument {
  id: string
  folder: string
  title: string
  file_path: string
  file_type: string | null
  created_at: string
}

export interface ClientInvoice {
  id: string
  invoice_number: string
  invoice_date: string
  period_from: string | null
  period_to: string | null
  subtotal: number
  gst_amount: number
  total: number
  paid_on: string | null
  paid_amount: number | null
  is_paid: boolean
  outstanding: number
}

export interface ClientApproval {
  id: string
  approval_no: string
  subject: string
  title: string
  details: string | null
  status: string
  decided_on: string | null
  reject_reason: string | null
  created_at: string
}

export interface ClientSpendCategory {
  category: string
  amount: number
  entries: number
}

export interface ClientSpendSummary {
  contract_value: number
  spent: number
  pct_of_contract: number | null
}

export interface ClientMessage {
  id: string
  body: string
  from_client: boolean
  author_name: string | null
  created_at: string
}

/* ---------------- reads ---------------- */

async function one<T>(view: string, cols = '*'): Promise<T | null> {
  const { data, error } = await supabase.from(view).select(cols).maybeSingle()
  if (error) throw error
  return (data as T | null) ?? null
}

async function many<T>(view: string, order?: string): Promise<T[]> {
  let q = supabase.from(view).select('*')
  if (order) q = q.order(order)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as T[]
}

export const fetchClientProject = () => one<ClientProject>('v_client_project')
export const fetchProgressSummary = () =>
  one<ClientProgressSummary>('v_client_progress_summary')
export const fetchSpendSummary = () =>
  one<ClientSpendSummary>('v_client_spend_summary')

export const fetchProgress = () =>
  many<ClientProgressRow>('v_client_progress', 'sort_order')
export const fetchPhotos = () => many<ClientPhoto>('v_client_photos')
/**
 * Documents, MINUS the images — those are shown in the Photos gallery instead
 * (074), and a picture appearing in both tabs looks like a bug.
 *
 * Filtered here rather than in `v_client_documents`, and that is deliberate:
 * 070's storage policy grants a client read on a file BECAUSE a row for it
 * exists in that view. Removing images from the view would silently refuse
 * every image in the gallery. This is a presentation choice, not a security
 * one — nothing is hidden that the client cannot otherwise reach.
 */
export const fetchDocuments = async (): Promise<ClientDocument[]> => {
  const all = await many<ClientDocument>('v_client_documents')
  return all.filter((d) => !(d.file_type ?? '').startsWith('image/'))
}
export const fetchInvoices = () => many<ClientInvoice>('v_client_invoices')
export const fetchApprovals = () => many<ClientApproval>('v_client_approvals')
export const fetchSpendByCategory = () =>
  many<ClientSpendCategory>('v_client_spend_by_category')
export const fetchMessages = () =>
  many<ClientMessage>('v_client_messages', 'created_at')

/* ---------------- files ---------------- */

/**
 * Signed URLs, short-lived. Migration 068 added two storage policies that grant
 * a client read on an object ONLY when a matching published row exists for that
 * exact path — so unsharing a document refuses the file in the same instant it
 * disappears from the list, rather than leaving a working link behind.
 *
 * RETURNS THE ERROR RATHER THAN NULL. The first version returned `string | null`
 * and the screen guessed at a cause ("your team may have unshared it"), which
 * was confidently wrong when the real reason was a migration that had not been
 * run. A caller cannot distinguish "correctly refused" from "we are broken"
 * unless the reason travels with the failure — so it does.
 */
export interface SignedResult {
  url: string | null
  error: string | null
}

async function signed(bucket: string, path: string): Promise<SignedResult> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, 300)

  if (error) {
    return { url: null, error: error.message || 'Storage refused the request' }
  }
  if (!data?.signedUrl) {
    return { url: null, error: 'Storage returned no URL' }
  }
  return { url: data.signedUrl, error: null }
}

export const signedDocumentUrl = (path: string) => signed(DOCUMENTS_BUCKET, path)

/**
 * A gallery photo, signed against whichever bucket it actually lives in (074).
 * The row carries `bucket` for exactly this reason.
 */
export const signedPhotoUrl = (path: string, bucket: string) =>
  signed(bucket || SITE_PHOTOS_BUCKET, path)

/* ---------------- the one write a client may make ---------------- */

/**
 * `fn_client_decide` is SECURITY DEFINER and re-checks everything: that the
 * caller is a client, that the item is on THEIR project, that it is still
 * pending, and that a rejection carries a reason. None of that is trusted from
 * here — this function only carries the intent.
 */
export async function decideApproval(
  id: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_client_decide', {
    p_id: id,
    p_decision: decision,
    p_note: note?.trim() || null,
  })
  if (error) throw error
}

/** Sending a message. `from_client` and `author_id` are stamped by a trigger. */
export async function sendMessage(body: string): Promise<void> {
  const project = await fetchClientProject()
  if (!project) throw new Error('No project is linked to this account.')

  const { error } = await supabase
    .from('client_messages')
    .insert({ project_id: project.project_id, body: body.trim() })
  if (error) throw error
}
