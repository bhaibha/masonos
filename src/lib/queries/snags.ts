import { supabase } from '@/lib/supabase'
import type {
  NewSnagInput,
  SnagRow,
  SnagSeverity,
  SnagStatus,
  SnagSummary,
} from '@/lib/types'

const COLUMNS =
  'id, snag_number, project_id, raised_date, work_area, trade, description, ' +
  'severity, photos, assigned_vendor_id, assigned_to, status, resolution_note, ' +
  'resolution_photos, resolved_at, resolved_by, verified_at, verified_by, ' +
  'raised_during_dlp, raised_by, created_at, vendors(name)'

/**
 * Snags for one project, worst and newest first.
 *
 * `snag_read` is plain is_member() — no figures on this table, so supervisors
 * see the full list. They're the ones raising and fixing.
 */
export async function fetchSnags(projectId: string): Promise<SnagRow[]> {
  const { data, error } = await supabase
    .from('snags')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('raised_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) throw error

  // The embedded vendors join defeats PostgREST's inference — assert once.
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  const peopleIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.raised_by, r.resolved_by, r.verified_by])
        .filter((v): v is string => typeof v === 'string'),
    ),
  ]
  const people = peopleIds.length
    ? await supabase.from('profiles').select('id, full_name').in('id', peopleIds)
    : { data: [] as { id: string; full_name: string }[] }

  const nameById = new Map(
    (people.data ?? []).map((p) => [p.id as string, p.full_name as string]),
  )

  return rows.map((row) => {
    const v = row.vendors as { name: string } | { name: string }[] | null
    const registered = (Array.isArray(v) ? v[0]?.name : v?.name) ?? null
    const vendorId = (row.assigned_vendor_id as string | null) ?? null

    return {
      id: row.id as string,
      snag_number: row.snag_number as string,
      project_id: row.project_id as string,
      raised_date: row.raised_date as string,
      work_area: row.work_area as string,
      trade: (row.trade as string | null) ?? null,
      description: row.description as string,
      severity: row.severity as SnagSeverity,
      photos: (row.photos as string[] | null) ?? [],
      assigned_vendor_id: vendorId,
      assigned_display: vendorId
        ? registered
        : ((row.assigned_to as string | null) ?? null),
      assigned_registered: vendorId !== null,
      status: row.status as SnagStatus,
      resolution_note: (row.resolution_note as string | null) ?? null,
      resolution_photos: (row.resolution_photos as string[] | null) ?? [],
      resolved_at: (row.resolved_at as string | null) ?? null,
      resolved_by: (row.resolved_by as string | null) ?? null,
      verified_at: (row.verified_at as string | null) ?? null,
      verified_by: (row.verified_by as string | null) ?? null,
      raised_during_dlp: Boolean(row.raised_during_dlp),
      raised_by: row.raised_by as string,
      raised_by_name: nameById.get(row.raised_by as string) ?? null,
      created_at: row.created_at as string,
    }
  })
}

/** Raises a snag. `raised_during_dlp` is stamped by a trigger, not sent. */
export async function createSnag(input: NewSnagInput): Promise<string> {
  const { data, error } = await supabase
    .from('snags')
    .insert({
      project_id: input.project_id,
      raised_date: input.raised_date,
      work_area: input.work_area.trim(),
      trade: input.trade.trim() || null,
      description: input.description.trim(),
      severity: input.severity,
      photos: input.photos,
      assigned_vendor_id: input.assigned_vendor_id,
      assigned_to: input.assigned_vendor_id ? null : input.assigned_to.trim() || null,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Claims a fix. The RPC refuses evidence-free resolutions — a snag closed with
 * neither a photo nor a note is worth nothing, and a CHECK constraint backs
 * that up.
 */
export async function resolveSnag(
  id: string,
  note: string,
  photos: string[],
): Promise<void> {
  const { error } = await supabase.rpc('fn_resolve_snag', {
    p_id: id,
    p_note: note,
    p_photos: photos,
  })
  if (error) throw error
}

/** Signs off a resolved snag. Founder/PM only — enforced in the RPC. */
export async function verifySnag(id: string): Promise<void> {
  const { error } = await supabase.rpc('fn_verify_snag', { p_id: id })
  if (error) throw error
}

/**
 * Open / in-progress, or reopening one that came back. Reopening deliberately
 * clears the old resolution — the evidence for a fix that didn't hold no
 * longer stands.
 */
export async function setSnagStatus(
  id: string,
  status: 'open' | 'in_progress',
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_snag_status', {
    p_id: id,
    p_status: status,
  })
  if (error) throw error
}

/**
 * Counts and DLP position for the project, all computed in Postgres
 * (fn_project_snag_summary). Nothing is tallied in the browser.
 */
export async function fetchSnagSummary(
  projectId: string,
): Promise<SnagSummary | null> {
  const { data, error } = await supabase.rpc('fn_project_snag_summary', {
    p_project: projectId,
  })
  if (error) return null

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

  return {
    open_count: Number(row.open_count ?? 0),
    in_progress_count: Number(row.in_progress_count ?? 0),
    resolved_count: Number(row.resolved_count ?? 0),
    verified_count: Number(row.verified_count ?? 0),
    open_low: Number(row.open_low ?? 0),
    open_medium: Number(row.open_medium ?? 0),
    open_high: Number(row.open_high ?? 0),
    dlp_snag_count: Number(row.dlp_snag_count ?? 0),
    dlp_start: (row.dlp_start as string | null) ?? null,
    dlp_end: (row.dlp_end as string | null) ?? null,
    dlp_active: Boolean(row.dlp_active),
    dlp_days_left: num(row.dlp_days_left),
  }
}

/** DLP window for a project — founder/PM set this on Manage → Projects. */
export async function setProjectDlp(
  projectId: string,
  start: string | null,
  end: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ dlp_start_date: start, dlp_end_date: end })
    .eq('id', projectId)
    // 010 revoked SELECT on the commercial columns, so the default
    // return=representation would 400. Only granted columns come back.
    .select('id, name')
    .single()

  if (error) throw error
}
