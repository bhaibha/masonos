import { supabase } from '@/lib/supabase'
import type {
  LabourActivity,
  LabourConstantStatus,
  LabourSource,
  ManpowerResult,
  ManpowerVsActual,
  ManpowerVsSchedule,
  SavedManpowerEstimate,
} from '@/lib/types'

/**
 * M14 Manpower Calculator.
 *
 * NOTHING IS DIVIDED IN THIS FILE. `fn_manpower` (087) returns the gang, the
 * man-days, the duration and the working in one jsonb — the 051 decision, same
 * as M13-A. A TypeScript copy would be faster and would be the copy nobody
 * re-checks after somebody corrects an output constant.
 */

const one = <T,>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : v

const num = (v: unknown, d = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/* ------------------------------------------------------------------ */
/* The constants                                                      */
/* ------------------------------------------------------------------ */

export async function fetchLabourActivities(): Promise<LabourActivity[]> {
  const { data, error } = await supabase
    .from('labour_activities')
    .select(
      'code, label, category, unit, output_per_gang_day, source, is_ref, verified, verified_by, verified_on, note, is_active, sort, profiles(full_name), labour_gang_lines(trade, persons, sort)',
    )
    .eq('is_active', true)
    .order('sort')

  if (error) throw error

  return (data ?? []).map((r) => ({
    code: r.code as string,
    label: r.label as string,
    category: r.category as string,
    unit: r.unit as string,
    output_per_gang_day:
      r.output_per_gang_day === null ? null : num(r.output_per_gang_day),
    source: r.source as LabourSource,
    is_ref: (r.is_ref as string | null) ?? null,
    verified: Boolean(r.verified),
    verified_by: (r.verified_by as string | null) ?? null,
    verified_by_name:
      one(r.profiles as { full_name: string } | { full_name: string }[] | null)
        ?.full_name ?? null,
    verified_on: (r.verified_on as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    is_active: Boolean(r.is_active),
    sort: num(r.sort),
    gang: ((r.labour_gang_lines ?? []) as Record<string, unknown>[])
      .map((g) => ({
        trade: g.trade as string,
        persons: num(g.persons),
        sort: num(g.sort),
      }))
      .sort((a, b) => a.sort - b.sort || a.trade.localeCompare(b.trade)),
  }))
}

/**
 * Founder only — `la_write` refuses everybody else.
 *
 * `verified_by` and `verified_on` are NOT sent: the 087 trigger stamps them
 * from `auth.uid()`, because "who confirmed this" is worth nothing if the
 * client can choose the answer.
 */
export async function updateLabourActivity(
  code: string,
  patch: {
    output_per_gang_day?: number | null
    source?: LabourSource
    is_ref?: string | null
    verified?: boolean
    note?: string | null
  },
): Promise<void> {
  const { error } = await supabase
    .from('labour_activities')
    .update(patch)
    .eq('code', code)
  if (error) throw error
}

export async function fetchConstantStatus(): Promise<LabourConstantStatus> {
  const { data, error } = await supabase.rpc('fn_labour_constant_status').maybeSingle()
  if (error) throw error
  const r = (data ?? {}) as Record<string, unknown>
  return {
    total: num(r.total),
    verified: num(r.verified),
    unfilled: num(r.unfilled),
    from_code: num(r.from_code),
  }
}

export interface ManpowerSelftestRow {
  case_no: number
  scenario: string
  measure: string
  expected: number
  computed: number
  diff: number
  passed: boolean
}

export async function runManpowerSelftest(): Promise<ManpowerSelftestRow[]> {
  const { data, error } = await supabase.rpc('fn_manpower_selftest')
  if (error) throw error
  return ((data ?? []) as ManpowerSelftestRow[]).map((r) => ({
    ...r,
    expected: num(r.expected),
    computed: num(r.computed),
    diff: num(r.diff),
  }))
}

/* ------------------------------------------------------------------ */
/* The calculator                                                     */
/* ------------------------------------------------------------------ */

export async function calcManpower(a: {
  activity_code: string
  qty: number
  gangs: number
  efficiency_pct: number
  /** The backwards question: how many gangs to finish in this many days. */
  target_days?: number | null
}): Promise<ManpowerResult> {
  const { data, error } = await supabase.rpc('fn_manpower', {
    p_activity_code: a.activity_code,
    p_qty: a.qty,
    p_gangs: a.gangs,
    p_efficiency_pct: a.efficiency_pct,
    p_target_days: a.target_days ?? null,
  })
  if (error) throw error

  const r = (data ?? {}) as Record<string, unknown>
  const d = (r.detail ?? {}) as Record<string, unknown>
  const act = r.activity as Record<string, unknown> | null

  return {
    ok: Boolean(r.ok),
    error: (r.error as string | undefined) ?? undefined,
    warning: (r.warning as string | null | undefined) ?? null,
    activity: act
      ? {
          code: act.code as string,
          label: act.label as string,
          unit: act.unit as string,
          category: act.category as string,
          output_per_gang_day: num(act.output_per_gang_day),
          source: act.source as LabourSource,
          is_ref: (act.is_ref as string | null) ?? null,
          verified: Boolean(act.verified),
          note: (act.note as string | null) ?? null,
        }
      : null,
    lines: ((r.lines as Record<string, unknown>[] | undefined) ?? []).map((l) => ({
      trade: l.trade as string,
      persons_per_gang: num(l.persons_per_gang),
      persons_total: num(l.persons_total),
      man_days: num(l.man_days),
    })),
    detail: {
      gang_days: num(d.gang_days),
      duration_days: num(d.duration_days),
      gang_size: num(d.gang_size),
      people_on_site: num(d.people_on_site),
      total_man_days: num(d.total_man_days),
      effective_output: num(d.effective_output),
      gangs_for_target:
        d.gangs_for_target === null || d.gangs_for_target === undefined
          ? null
          : num(d.gangs_for_target),
      target_days:
        d.target_days === null || d.target_days === undefined
          ? null
          : num(d.target_days),
    },
    working: (r.working as string | undefined) ?? '',
  }
}

/* ------------------------------------------------------------------ */
/* Saved estimates                                                    */
/* ------------------------------------------------------------------ */

/**
 * Saves the result AS COMPUTED, including `from_unverified` — so the record
 * says what the figure was worth at the time rather than borrowing today's
 * confidence. Correcting a constant next year must not silently upgrade a plan
 * made this year (the 032/045 snapshot rule).
 */
export async function saveManpowerEstimate(input: {
  project_id: string
  activity_code: string
  title: string
  work_area: string
  notes: string
  qty: number
  gangs: number
  efficiency_pct: number
  activity_id: string | null
  result: ManpowerResult
}): Promise<string> {
  const { data, error } = await supabase
    .from('manpower_estimates')
    .insert({
      project_id: input.project_id,
      activity_code: input.activity_code,
      title: input.title,
      work_area: input.work_area || null,
      notes: input.notes || null,
      qty: input.qty,
      gangs: input.gangs,
      efficiency_pct: input.efficiency_pct,
      gang_days: input.result.detail.gang_days,
      duration_days: input.result.detail.duration_days,
      total_man_days: input.result.detail.total_man_days,
      from_unverified: !(input.result.activity?.verified ?? false),
      activity_id: input.activity_id,
      working: input.result.working,
    })
    .select('id')
    .single()
  if (error) throw error

  const id = data.id as string
  const rows = input.result.lines.map((l, i) => ({
    estimate_id: id,
    trade: l.trade,
    persons_per_gang: l.persons_per_gang,
    man_days: l.man_days,
    sort: (i + 1) * 10,
  }))

  const { error: lineErr } = await supabase.from('manpower_estimate_lines').insert(rows)
  if (lineErr) {
    // A header with no lines is a record of nothing, and there is no
    // transaction across two PostgREST calls. Roll it back by hand.
    await supabase.from('manpower_estimates').delete().eq('id', id)
    throw lineErr
  }
  return id
}

export async function fetchManpowerEstimates(
  projectId: string,
): Promise<SavedManpowerEstimate[]> {
  const { data, error } = await supabase
    .from('manpower_estimates')
    .select(
      'id, project_id, activity_code, title, work_area, qty, gangs, efficiency_pct, gang_days, duration_days, total_man_days, from_unverified, activity_id, working, notes, created_at, profiles(full_name), labour_activities(label), manpower_estimate_lines(id, trade, persons_per_gang, man_days, sort)',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    activity_code: r.activity_code as string,
    activity_label:
      one(r.labour_activities as { label: string } | { label: string }[] | null)
        ?.label ?? (r.activity_code as string),
    title: r.title as string,
    work_area: (r.work_area as string | null) ?? null,
    qty: num(r.qty),
    gangs: num(r.gangs),
    efficiency_pct: num(r.efficiency_pct),
    gang_days: num(r.gang_days),
    duration_days: num(r.duration_days),
    total_man_days: num(r.total_man_days),
    from_unverified: Boolean(r.from_unverified),
    activity_id: (r.activity_id as string | null) ?? null,
    working: (r.working as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    created_by_name:
      one(r.profiles as { full_name: string } | { full_name: string }[] | null)
        ?.full_name ?? null,
    created_at: r.created_at as string,
    lines: ((r.manpower_estimate_lines ?? []) as Record<string, unknown>[])
      .slice()
      .sort((a, b) => num(a.sort) - num(b.sort))
      .map((l) => ({
        id: l.id as string,
        trade: l.trade as string,
        persons_per_gang: num(l.persons_per_gang),
        man_days: num(l.man_days),
      })),
  }))
}

export async function deleteManpowerEstimate(id: string): Promise<void> {
  const { error } = await supabase.from('manpower_estimates').delete().eq('id', id)
  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* The two comparisons                                                */
/* ------------------------------------------------------------------ */

/** Null when the estimate is not linked to a programme row (073 zero rows). */
export async function fetchManpowerVsSchedule(
  estimateId: string,
): Promise<ManpowerVsSchedule | null> {
  const { data, error } = await supabase
    .rpc('fn_manpower_vs_schedule', { p_estimate: estimateId })
    .maybeSingle()
  if (error) throw error
  if (!data) return null

  const r = data as Record<string, unknown>
  return {
    activity_code: r.activity_code as string,
    activity_name: r.activity_name as string,
    planned_start: r.planned_start as string,
    planned_end: r.planned_end as string,
    days_allowed: num(r.days_allowed),
    days_needed: num(r.days_needed),
    shortfall_days: num(r.shortfall_days),
    gangs_planned: num(r.gangs_planned),
    gangs_needed: num(r.gangs_needed),
  }
}

/**
 * Planned man-days against what attendance actually recorded, per trade.
 * Empty array means nothing has been planned for this activity yet.
 */
export async function fetchManpowerVsActual(
  activityId: string,
): Promise<ManpowerVsActual[]> {
  const { data, error } = await supabase.rpc('fn_manpower_vs_actual', {
    p_activity: activityId,
  })
  if (error) throw error
  return ((data ?? []) as ManpowerVsActual[]).map((r) => ({
    trade: r.trade,
    planned_days: num(r.planned_days),
    actual_days: num(r.actual_days),
    variance_days: num(r.variance_days),
    estimates_n: num(r.estimates_n),
  }))
}
