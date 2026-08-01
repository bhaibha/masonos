import { supabase } from '@/lib/supabase'
import type {
  ComplianceAlert,
  ComplianceCategory,
  ComplianceDisplayStatus,
  ComplianceRecurrence,
  ComplianceRow,
  ComplianceStatus,
  NewComplianceInput,
} from '@/lib/types'

const COLUMNS =
  'id, title, category, project_id, project_name, due_date, recurrence, ' +
  'responsible, responsible_name, status, notes, proof_path, filed_date, ' +
  'filed_by, filed_at, series_id, days_until, display_status, created_at'

function toRow(r: Record<string, unknown>): ComplianceRow {
  return {
    id: r.id as string,
    title: r.title as string,
    category: r.category as ComplianceCategory,
    project_id: (r.project_id as string | null) ?? null,
    project_name: (r.project_name as string | null) ?? null,
    due_date: r.due_date as string,
    recurrence: r.recurrence as ComplianceRecurrence,
    responsible: (r.responsible as string | null) ?? null,
    responsible_name: (r.responsible_name as string | null) ?? null,
    status: r.status as ComplianceStatus,
    notes: (r.notes as string | null) ?? null,
    proof_path: (r.proof_path as string | null) ?? null,
    filed_date: (r.filed_date as string | null) ?? null,
    filed_by: (r.filed_by as string | null) ?? null,
    filed_at: (r.filed_at as string | null) ?? null,
    series_id: (r.series_id as string | null) ?? null,
    days_until: Number(r.days_until ?? 0),
    display_status: r.display_status as ComplianceDisplayStatus,
    created_at: r.created_at as string,
  }
}

/**
 * The whole calendar, soonest first.
 *
 * Always read through v_compliance_calendar, never the table: the view derives
 * overdue / due_soon from due_date in Asia/Kolkata at query time, so the screen
 * is right even if the nightly pg_cron sweep is disabled or has not run yet.
 */
export async function fetchCompliance(): Promise<ComplianceRow[]> {
  const { data, error } = await supabase
    .from('v_compliance_calendar')
    .select(COLUMNS)
    .order('due_date')
    .limit(500)

  if (error) throw error

  // PostgREST's inference can't see a view the generated types don't know
  // about, so it widens to GenericStringError — assert once, here.
  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  return rows.map(toRow)
}

export async function createComplianceItem(
  input: NewComplianceInput,
): Promise<string> {
  const { data, error } = await supabase
    .from('compliance_items')
    .insert({
      title: input.title.trim(),
      category: input.category,
      project_id: input.project_id,
      due_date: input.due_date,
      recurrence: input.recurrence,
      responsible: input.responsible,
      notes: input.notes.trim() || null,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

export async function updateComplianceItem(
  id: string,
  input: NewComplianceInput,
): Promise<void> {
  const { error } = await supabase
    .from('compliance_items')
    .update({
      title: input.title.trim(),
      category: input.category,
      project_id: input.project_id,
      due_date: input.due_date,
      recurrence: input.recurrence,
      responsible: input.responsible,
      notes: input.notes.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id')
    .single()

  if (error) throw error
}

/**
 * Marks an item filed and, for a recurring one, generates the next occurrence
 * inside the same function. Returns the new occurrence's id, or null for a
 * one-time item.
 *
 * The next due date is computed from the DUE date, not the filing date — a
 * return filed three days late does not move next month's deadline.
 */
export async function fileCompliance(
  id: string,
  filedDate: string,
  proofPath: string | null,
  notes: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('fn_file_compliance', {
    p_id: id,
    p_date: filedDate,
    p_proof: proofPath,
    p_notes: notes.trim() || null,
  })

  if (error) throw error
  return (data as string | null) ?? null
}

/** Undoes a filing recorded in error. Founder/accounts only (enforced in SQL). */
export async function unfileCompliance(id: string): Promise<void> {
  const { error } = await supabase.rpc('fn_unfile_compliance', { p_id: id })
  if (error) throw error
}

/**
 * Active people, for the "responsible" picker. profiles_read is `true` for any
 * signed-in user, so no role gate is needed here.
 */
export async function fetchActivePeople(): Promise<
  { id: string; full_name: string }[]
> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, is_active')
    .eq('is_active', true)
    .order('full_name')

  if (error) throw error
  return (data ?? []).map((p) => ({
    id: p.id as string,
    full_name: p.full_name as string,
  }))
}

/**
 * Counts for the dashboard strip, computed in Postgres. Returns null on any
 * failure — including before migration 028 is applied — so the dashboard hides
 * the strip rather than breaking.
 */
export async function fetchComplianceAlert(): Promise<ComplianceAlert | null> {
  const { data, error } = await supabase.rpc('fn_compliance_alert')
  if (error) return null

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  return {
    overdue_count: Number(row.overdue_count ?? 0),
    due_week_count: Number(row.due_week_count ?? 0),
    next_due_date: (row.next_due_date as string | null) ?? null,
    next_title: (row.next_title as string | null) ?? null,
  }
}
