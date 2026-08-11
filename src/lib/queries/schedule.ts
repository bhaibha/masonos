import { supabase } from '@/lib/supabase'
import type {
  ActivityDependency,
  ActivityEvm,
  ActivityFloat,
  GenerateScheduleInput,
  GenerateScheduleResult,
  NewActivityInput,
  ProjectEvm,
  ScheduleActivity,
} from '@/lib/types'

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))
const numOrNull = (v: unknown) =>
  v === null || v === undefined ? null : Number(v)

/**
 * Everything a supervisor is allowed: dates, sequence, progress. Never the
 * budget — 042 revoked that column from `authenticated`, so asking for it here
 * would fail the request outright rather than quietly returning null.
 */
const ACTIVITY_COLUMNS =
  'id, project_id, code, name, planned_start, planned_end, planned_qty, ' +
  'qty_unit, pct_complete, actual_start, actual_end, notes, sort_order, phase'

export async function fetchActivities(
  projectId: string,
): Promise<ScheduleActivity[]> {
  const { data, error } = await supabase
    .from('schedule_activities')
    .select(ACTIVITY_COLUMNS)
    .eq('project_id', projectId)
    .order('sort_order')
    .order('planned_start')
    .order('code')

  if (error) throw error

  // Cast because the generated Database types predate 042 — the same pattern
  // every module here uses for a table added after the last type generation.
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    code: r.code as string,
    name: r.name as string,
    planned_start: r.planned_start as string,
    planned_end: r.planned_end as string,
    planned_qty: numOrNull(r.planned_qty),
    qty_unit: (r.qty_unit as string | null) ?? null,
    pct_complete: num(r.pct_complete),
    actual_start: (r.actual_start as string | null) ?? null,
    actual_end: (r.actual_end as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    sort_order: Number(r.sort_order ?? 100),
    phase: (r.phase as string | null) ?? null,
  }))
}

/**
 * Builds the whole WBS from start date, finish date, floors and plot area.
 *
 * Refuses outright if the project already has activities unless `replace` is
 * set, and refuses even then if any expense or certified bill is tagged to the
 * current programme — regenerating would detach money from the work it paid
 * for. Both refusals come back as readable messages; surface them as-is.
 */
export async function generateSchedule(
  projectId: string,
  input: GenerateScheduleInput,
): Promise<GenerateScheduleResult> {
  const { data, error } = await supabase.rpc('fn_generate_schedule', {
    p_project: projectId,
    p_start: input.start,
    p_end: input.end,
    p_floors: input.floors,
    p_plot_area: input.plot_area_sqft,
    p_replace: input.replace ?? false,
  })
  if (error) throw error

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined

  return {
    activities_created: Number(row?.activities_created ?? 0),
    links_created: Number(row?.links_created ?? 0),
    natural_days: Number(row?.natural_days ?? 0),
    target_days: Number(row?.target_days ?? 0),
    compression: Number(row?.compression ?? 1),
  }
}

export async function createActivity(
  projectId: string,
  input: NewActivityInput,
): Promise<string> {
  const { data, error } = await supabase
    .from('schedule_activities')
    .insert({
      project_id: projectId,
      code: input.code.trim(),
      name: input.name.trim(),
      planned_start: input.planned_start,
      planned_end: input.planned_end,
      budget_amount: input.budget_amount,
      planned_qty: input.planned_qty,
      qty_unit: input.qty_unit.trim() || null,
      notes: input.notes.trim() || null,
      phase: input.phase.trim() || null,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

export async function updateActivity(
  id: string,
  input: NewActivityInput,
): Promise<void> {
  const { error } = await supabase
    .from('schedule_activities')
    .update({
      code: input.code.trim(),
      name: input.name.trim(),
      planned_start: input.planned_start,
      planned_end: input.planned_end,
      budget_amount: input.budget_amount,
      planned_qty: input.planned_qty,
      qty_unit: input.qty_unit.trim() || null,
      notes: input.notes.trim() || null,
      phase: input.phase.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id')
    .single()

  if (error) throw error
}

/**
 * Progress goes through the RPC even for a founder, so there is exactly one
 * code path that can move this number and one place the rules live.
 */
export async function setActivityProgress(
  id: string,
  pct: number,
  actualStart?: string | null,
  actualEnd?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_activity_progress', {
    p_id: id,
    p_pct: pct,
    p_actual_start: actualStart ?? null,
    p_actual_end: actualEnd ?? null,
  })
  if (error) throw error
}

export async function deleteActivity(id: string): Promise<void> {
  const { error } = await supabase.rpc('fn_delete_activity', { p_id: id })
  if (error) throw error
}

/**
 * Moves an expense to a different schedule activity, or to none.
 *
 * NOT a void-and-re-enter: no total on the ledger, the P&L or the dashboard
 * moves when a tag changes — only earned value does, and only to become
 * correct. Voiding would stamp VOID on a record whose payment was fine and
 * leave the audit log implying otherwise.
 *
 * A narrow RPC rather than a direct update, because `exp_update` would also
 * let the caller rewrite `amount`.
 */
export async function retagExpense(
  expenseId: string,
  activityId: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_retag_expense', {
    p_expense_id: expenseId,
    p_activity_id: activityId,
  })
  if (error) throw error
}

/** Same for a certified contractor bill — the tag is not part of its frozen value. */
export async function retagRaBill(
  billId: string,
  activityId: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_retag_ra_bill', {
    p_bill_id: billId,
    p_activity_id: activityId,
  })
  if (error) throw error
}

/* ---------------- dependencies ---------------- */

/**
 * Links are fetched by the activity ids already on screen rather than by
 * embedding the parent to reach its project.
 *
 * The table has TWO foreign keys to `schedule_activities`, so any embed needs
 * a constraint-name hint — and a query that breaks when Postgres names a
 * constraint differently is a query waiting to break. RLS already limits the
 * rows to the caller's projects; this filter is just scoping.
 */
export async function fetchDependencies(
  activityIds: string[],
): Promise<ActivityDependency[]> {
  if (activityIds.length === 0) return []

  const { data, error } = await supabase
    .from('activity_dependencies')
    .select('id, predecessor_id, successor_id, lag_days')
    .in('predecessor_id', activityIds)

  if (error) throw error

  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    predecessor_id: r.predecessor_id as string,
    successor_id: r.successor_id as string,
    lag_days: Number(r.lag_days ?? 0),
  }))
}

export async function createDependency(
  predecessorId: string,
  successorId: string,
  lagDays = 0,
): Promise<void> {
  const { error } = await supabase.from('activity_dependencies').insert({
    predecessor_id: predecessorId,
    successor_id: successorId,
    lag_days: lagDays,
  })
  if (error) throw error
}

export async function deleteDependency(id: string): Promise<void> {
  const { error } = await supabase
    .from('activity_dependencies')
    .delete()
    .eq('id', id)
  if (error) throw error
}

/* ---------------- float / critical path ---------------- */

export async function fetchActivityFloat(
  projectId: string,
): Promise<ActivityFloat[]> {
  const { data, error } = await supabase.rpc('fn_activity_float', {
    p_project: projectId,
  })
  if (error) throw error

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    activity_id: r.activity_id as string,
    early_start: r.early_start as string,
    early_finish: r.early_finish as string,
    late_start: r.late_start as string,
    late_finish: r.late_finish as string,
    total_float: Number(r.total_float ?? 0),
    is_critical: Boolean(r.is_critical),
  }))
}

/* ---------------- EVM ---------------- */

/**
 * Both EVM calls return ZERO ROWS for a supervisor rather than an error — the
 * gate lives in the function's WHERE clause. The screen reads that as "no cost
 * figures for your role" and renders the schedule alone.
 */
export async function fetchActivityEvm(
  projectId: string,
  dataDate: string | null,
): Promise<ActivityEvm[]> {
  const { data, error } = await supabase.rpc('fn_activity_evm', {
    p_project: projectId,
    p_data_date: dataDate,
  })
  if (error) throw error

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    activity_id: r.activity_id as string,
    code: r.code as string,
    name: r.name as string,
    planned_start: r.planned_start as string,
    planned_end: r.planned_end as string,
    pct_complete: num(r.pct_complete),
    bac: num(r.bac),
    planned_pct: num(r.planned_pct),
    pv: num(r.pv),
    ev: num(r.ev),
    ac: num(r.ac),
    sv: num(r.sv),
    cv: num(r.cv),
    spi: numOrNull(r.spi),
    cpi: numOrNull(r.cpi),
    eac: numOrNull(r.eac),
    etc: numOrNull(r.etc),
    vac: numOrNull(r.vac),
  }))
}

export async function fetchProjectEvm(
  projectId: string,
  dataDate: string | null,
): Promise<ProjectEvm | null> {
  const { data, error } = await supabase.rpc('fn_project_evm', {
    p_project: projectId,
    p_data_date: dataDate,
  })
  if (error) return null

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  return {
    data_date: row.data_date as string,
    activity_count: Number(row.activity_count ?? 0),
    bac: num(row.bac),
    pv: num(row.pv),
    ev: num(row.ev),
    ac: num(row.ac),
    sv: num(row.sv),
    cv: num(row.cv),
    spi: numOrNull(row.spi),
    cpi: numOrNull(row.cpi),
    eac: numOrNull(row.eac),
    etc: numOrNull(row.etc),
    vac: numOrNull(row.vac),
    pct_complete: numOrNull(row.pct_complete),
  }
}
