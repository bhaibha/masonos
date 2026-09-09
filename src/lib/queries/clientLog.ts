import { supabase } from '@/lib/supabase'
import type {
  CommAttention,
  CommEntry,
  Commitment,
  Complaint,
  NewCommEntry,
} from '@/lib/types'

/**
 * M36 Client Communication Log — the firm's record OF the client.
 *
 * NOT the client's thread. `client_messages` (065) is what the client writes in
 * and reads. This holds entries the client would disagree with, and no
 * `v_client_*` view exposes it; every policy here is `is_internal()`-based, so
 * a client account gets zero rows.
 *
 * Nothing in this file filters by role. `cce_read` (083) hides commercial
 * entries from supervisors in Postgres — a second copy of that rule in the
 * browser would be one more place for it to drift, and the one that drifts is
 * always the copy nobody re-checks.
 */

const one = <T,>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : v

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

export async function fetchCommEntries(projectId: string): Promise<CommEntry[]> {
  const { data, error } = await supabase
    .from('client_comm_entries')
    .select(
      'id, comm_no, project_id, channel, occurred_on, occurred_at, client_person, summary, is_commercial, approval_id, variation_id, document_id, logged_by, created_at, updated_at, client_approvals(approval_no), variation_orders(vo_number), documents(title), profiles(full_name)',
    )
    .eq('project_id', projectId)
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id as string,
    comm_no: r.comm_no as string,
    project_id: r.project_id as string,
    channel: r.channel as CommEntry['channel'],
    occurred_on: r.occurred_on as string,
    occurred_at: (r.occurred_at as string | null) ?? null,
    client_person: (r.client_person as string | null) ?? null,
    summary: r.summary as string,
    is_commercial: Boolean(r.is_commercial),
    approval_id: (r.approval_id as string | null) ?? null,
    approval_no:
      one(r.client_approvals as { approval_no: string } | { approval_no: string }[] | null)
        ?.approval_no ?? null,
    variation_id: (r.variation_id as string | null) ?? null,
    vo_number:
      one(r.variation_orders as { vo_number: string } | { vo_number: string }[] | null)
        ?.vo_number ?? null,
    document_id: (r.document_id as string | null) ?? null,
    document_title:
      one(r.documents as { title: string } | { title: string }[] | null)?.title ?? null,
    logged_by: r.logged_by as string,
    logged_by_name:
      one(r.profiles as { full_name: string } | { full_name: string }[] | null)
        ?.full_name ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  }))
}

export async function createCommEntry(input: NewCommEntry): Promise<string> {
  const { data, error } = await supabase
    .from('client_comm_entries')
    .insert({
      project_id: input.project_id,
      channel: input.channel,
      occurred_on: input.occurred_on,
      client_person: input.client_person || null,
      summary: input.summary,
      // The trigger forces this true when a VO or approval is linked, so what
      // is sent here is a floor rather than the final word.
      is_commercial: input.is_commercial,
      approval_id: input.approval_id,
      variation_id: input.variation_id,
      document_id: input.document_id,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Corrects an entry inside the 24-hour window.
 *
 * `fn_comm_entry_freeze` refuses this after that, with a sentence saying to log
 * a new entry instead — so the error a user sees is the rule, not a constraint
 * name. The app hides the button using `commEntryEditable`, and the trigger is
 * what actually enforces it.
 *
 * `project_id` is deliberately not updatable: moving an entry to another
 * project would move evidence, and the policy checks membership on the row as
 * it lands.
 */
export async function updateCommEntry(
  id: string,
  patch: {
    channel: NewCommEntry['channel']
    occurred_on: string
    client_person: string
    summary: string
    is_commercial: boolean
  },
): Promise<void> {
  const { error } = await supabase
    .from('client_comm_entries')
    .update({
      channel: patch.channel,
      occurred_on: patch.occurred_on,
      client_person: patch.client_person || null,
      summary: patch.summary,
      is_commercial: patch.is_commercial,
    })
    .eq('id', id)

  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* Commitments                                                         */
/* ------------------------------------------------------------------ */

/** Open ones first and oldest due date at the top — what is late leads. */
export async function fetchCommitments(projectId: string): Promise<Commitment[]> {
  const { data, error } = await supabase
    .from('client_commitments')
    .select(
      'id, project_id, entry_id, promise, due_on, state, closed_on, closing_note, owner_id, created_by, created_at, profiles!client_commitments_owner_id_fkey(full_name)',
    )
    .eq('project_id', projectId)
    .order('state')
    .order('due_on', { ascending: true, nullsFirst: false })

  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    entry_id: (r.entry_id as string | null) ?? null,
    promise: r.promise as string,
    due_on: (r.due_on as string | null) ?? null,
    state: r.state as Commitment['state'],
    closed_on: (r.closed_on as string | null) ?? null,
    closing_note: (r.closing_note as string | null) ?? null,
    owner_id: (r.owner_id as string | null) ?? null,
    owner_name:
      one(r.profiles as { full_name: string } | { full_name: string }[] | null)
        ?.full_name ?? null,
    created_by: r.created_by as string,
    created_at: r.created_at as string,
  }))
}

export async function createCommitment(input: {
  project_id: string
  entry_id: string | null
  promise: string
  due_on: string | null
  owner_id: string | null
}): Promise<void> {
  const { error } = await supabase.from('client_commitments').insert({
    project_id: input.project_id,
    entry_id: input.entry_id,
    promise: input.promise,
    due_on: input.due_on,
    owner_id: input.owner_id,
  })
  if (error) throw error
}

/**
 * Closes a commitment. `closed_on` is set here because a CHECK constraint
 * (`ccm_closed_has_date`) refuses anything not pending without one — a promise
 * marked done with no date is a claim nobody can check.
 */
export async function closeCommitment(
  id: string,
  state: 'done' | 'dropped',
  note: string,
  closedOn: string,
): Promise<void> {
  const { error } = await supabase
    .from('client_commitments')
    .update({ state, closed_on: closedOn, closing_note: note || null })
    .eq('id', id)
  if (error) throw error
}

/** Reopens one that was closed in error. Clears the closure, keeps the audit. */
export async function reopenCommitment(id: string): Promise<void> {
  const { error } = await supabase
    .from('client_commitments')
    .update({ state: 'pending', closed_on: null, closing_note: null })
    .eq('id', id)
  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* Complaints                                                          */
/* ------------------------------------------------------------------ */

export async function fetchComplaints(projectId: string): Promise<Complaint[]> {
  const { data, error } = await supabase
    .from('client_complaints')
    .select(
      'id, project_id, entry_id, raised_on, subject, detail, state, resolved_on, resolution, created_by, created_at',
    )
    .eq('project_id', projectId)
    .order('state')
    .order('raised_on', { ascending: false })

  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    entry_id: (r.entry_id as string | null) ?? null,
    raised_on: r.raised_on as string,
    subject: r.subject as string,
    detail: (r.detail as string | null) ?? null,
    state: r.state as Complaint['state'],
    resolved_on: (r.resolved_on as string | null) ?? null,
    resolution: (r.resolution as string | null) ?? null,
    created_by: r.created_by as string,
    created_at: r.created_at as string,
  }))
}

export async function createComplaint(input: {
  project_id: string
  entry_id: string | null
  subject: string
  detail: string
  raised_on: string
}): Promise<void> {
  const { error } = await supabase.from('client_complaints').insert({
    project_id: input.project_id,
    entry_id: input.entry_id,
    subject: input.subject,
    detail: input.detail || null,
    raised_on: input.raised_on,
  })
  if (error) throw error
}

/**
 * Resolves or withdraws a complaint.
 *
 * `ccp_resolved_needs_both` refuses a resolved complaint with no resolution
 * text — "resolved" with no account of HOW is exactly what a register exists to
 * prevent. The form asks for it, the constraint enforces it, so anything
 * talking to the API directly gets the same rule.
 */
export async function closeComplaint(
  id: string,
  state: 'resolved' | 'withdrawn',
  resolution: string,
  resolvedOn: string,
): Promise<void> {
  const { error } = await supabase
    .from('client_complaints')
    .update({
      state,
      resolved_on: resolvedOn,
      resolution: resolution || null,
    })
    .eq('id', id)
  if (error) throw error
}

export async function reopenComplaint(id: string): Promise<void> {
  const { error } = await supabase
    .from('client_complaints')
    .update({ state: 'open', resolved_on: null, resolution: null })
    .eq('id', id)
  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* Attention strip                                                     */
/* ------------------------------------------------------------------ */

/**
 * Returns null when nothing is waiting — the function returns ZERO ROWS in
 * that case by design (the 073 rule), so the strip vanishes rather than
 * rendering "0 overdue". A component that renders zeros is how a real one gets
 * ignored.
 */
export async function fetchCommAttention(
  projectId: string,
): Promise<CommAttention | null> {
  const { data, error } = await supabase
    .rpc('fn_client_comm_attention', { p_project: projectId })
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as Record<string, number | null>
  return {
    overdue_commitments: Number(row.overdue_commitments ?? 0),
    due_soon_commitments: Number(row.due_soon_commitments ?? 0),
    open_complaints: Number(row.open_complaints ?? 0),
    oldest_complaint_days:
      row.oldest_complaint_days === null ? null : Number(row.oldest_complaint_days),
  }
}
