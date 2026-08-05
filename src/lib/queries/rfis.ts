import { supabase } from '@/lib/supabase'
import type { NewRfiInput, RfiCategory, RfiRow, RfiStatus } from '@/lib/types'

const COLUMNS =
  'id, rfi_number, project_id, raised_date, vendor_id, addressed_to, category, ' +
  'question, attachments, required_by, response, response_date, responded_by, ' +
  'response_attachments, ' +
  'status, raised_by, closed_at, created_at, cancelled_at, cancelled_by, ' +
  'cancel_reason, vendors(name, phone)'

/**
 * RFIs for one project, newest first.
 *
 * `rfi_read` is plain is_member() with no role check — supervisors included,
 * because they're usually the ones who hit the problem and need to know whether
 * an answer has landed before proceeding. Safe: the table holds no figures.
 */
export async function fetchRfis(projectId: string): Promise<RfiRow[]> {
  const { data, error } = await supabase
    .from('rfis')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('raised_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(300)

  if (error) throw error

  // The embedded vendors join defeats PostgREST's inference — assert once.
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  const raiserIds = [...new Set(rows.map((r) => r.raised_by as string))]
  const people = raiserIds.length
    ? await supabase.from('profiles').select('id, full_name').in('id', raiserIds)
    : { data: [] as { id: string; full_name: string }[] }

  const nameById = new Map(
    (people.data ?? []).map((p) => [p.id as string, p.full_name as string]),
  )

  return rows.map((row) => {
    type V = { name: string; phone: string | null }
    const v = row.vendors as V | V[] | null
    const joined = Array.isArray(v) ? (v[0] ?? null) : v
    const registered = joined?.name ?? null
    const vendorId = (row.vendor_id as string | null) ?? null

    return {
      id: row.id as string,
      rfi_number: row.rfi_number as string,
      project_id: row.project_id as string,
      raised_date: row.raised_date as string,
      vendor_id: vendorId,
      addressed_display: vendorId
        ? registered
        : ((row.addressed_to as string | null) ?? null),
      addressed_registered: vendorId !== null,
      // Only a linked vendor has a number on file; free text is just a name.
      addressed_phone: vendorId ? (joined?.phone ?? null) : null,
      category: row.category as RfiCategory,
      question: row.question as string,
      attachments: (row.attachments as string[] | null) ?? [],
      required_by: (row.required_by as string | null) ?? null,
      response: (row.response as string | null) ?? null,
      response_date: (row.response_date as string | null) ?? null,
      response_attachments: (row.response_attachments as string[] | null) ?? [],
      responded_by: (row.responded_by as string | null) ?? null,
      status: row.status as RfiStatus,
      raised_by: row.raised_by as string,
      raised_by_name: nameById.get(row.raised_by as string) ?? null,
      closed_at: (row.closed_at as string | null) ?? null,
      created_at: row.created_at as string,
      cancelled_at: (row.cancelled_at as string | null) ?? null,
      cancelled_by: (row.cancelled_by as string | null) ?? null,
      cancel_reason: (row.cancel_reason as string | null) ?? null,
    }
  })
}

/** Raises a new RFI. rfi_number comes from the sequence. */
export async function createRfi(input: NewRfiInput): Promise<string> {
  const { data, error } = await supabase
    .from('rfis')
    .insert({
      project_id: input.project_id,
      raised_date: input.raised_date,
      vendor_id: input.vendor_id,
      addressed_to: input.addressed_to.trim() || null,
      category: input.category,
      question: input.question.trim(),
      attachments: input.attachments,
      required_by: input.required_by,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Records the consultant's answer via fn_answer_rfi — response text, date, who
 * logged it and the status move all in one statement, so the record can never
 * read "answered" with a blank answer. A CHECK constraint backs that up.
 */
/**
 * Records the answer. `files` are paths in the `documents` bucket — a
 * consultant usually replies with a marked-up PDF, and the RPC APPENDS them, so
 * correcting the wording later doesn't drop the sketch that came with it.
 */
export async function answerRfi(
  id: string,
  response: string,
  date: string,
  files: string[] = [],
): Promise<void> {
  const { error } = await supabase.rpc('fn_answer_rfi', {
    p_id: id,
    p_response: response,
    p_date: date,
    p_files: files,
  })
  if (error) throw error
}

/**
 * Closes or reopens. Closing an unanswered RFI is refused by the RPC — that
 * would quietly lose the question, which is what cancel is for.
 */
export async function setRfiStatus(
  id: string,
  status: 'open' | 'closed',
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_rfi_status', {
    p_id: id,
    p_status: status,
  })
  if (error) throw error
}
