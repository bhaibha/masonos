import { supabase } from '@/lib/supabase'
import type {
  DeadlineSignal,
  HealthFlag,
  HealthTrendPoint,
  SignalBasis,
  SignalCategory,
  SignalLevel,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const num = (v: unknown) => (v == null ? null : Number(v))
const n = (v: unknown) => Number(v ?? 0)
const str = (v: unknown) => (v as string | null) ?? null

/**
 * Every flag the caller can see.
 *
 * The server decides which categories to compute: founder and PM get all four,
 * accounts gets cost and deadline, a supervisor gets ZERO ROWS — not a row of
 * zeros, which on a health panel would read as "the job is fine".
 */
export async function fetchHealthFlags(
  projectId: string | null,
): Promise<HealthFlag[]> {
  const { data, error } = await supabase.rpc('fn_project_health_flags', {
    p_project: projectId,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    project_id: r.project_id as string,
    project_name: (r.project_name as string) ?? '',
    code: r.code as string,
    category: r.category as SignalCategory,
    level: r.level as SignalLevel,
    headline: r.headline as string,
    detail: r.detail as string,
    metric_value: num(r.metric_value),
    metric_label: (r.metric_label as string) ?? '',
    basis: (r.basis as SignalBasis) ?? 'point_in_time',
    sample_n: n(r.sample_n),
    snoozed_until: str(r.snoozed_until),
  }))
}

/**
 * Company-wide deadline signals — compliance, bank guarantees, insurance.
 *
 * Composed server-side from the three alert functions that already exist
 * (028/033/034), each carrying its own role gate. Nothing restates a rule here.
 */
export async function fetchDeadlineSignals(): Promise<DeadlineSignal[]> {
  const { data, error } = await supabase.rpc('fn_deadline_signals')
  if (error) throw error
  return rows(data).map((r) => ({
    code: r.code as string,
    level: r.level as SignalLevel,
    headline: r.headline as string,
    detail: r.detail as string,
    metric_value: num(r.metric_value),
    metric_label: (r.metric_label as string) ?? '',
  }))
}

/** The nightly series behind a flag, so the shape can be seen not just asserted. */
export async function fetchHealthTrend(
  projectId: string,
  days = 60,
): Promise<HealthTrendPoint[]> {
  const { data, error } = await supabase.rpc('fn_health_trend', {
    p_project: projectId,
    p_days: days,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    snap_date: r.snap_date as string,
    pct_spend: num(r.pct_spend),
    progress_pct: num(r.progress_pct),
    cpi: num(r.cpi),
    spi: num(r.spi),
    open_snags: n(r.open_snags),
    open_ncrs: n(r.open_ncrs),
  }))
}

/**
 * Sets a signal aside for a bounded period.
 *
 * The server refuses anything over 90 days: a signal that can be silenced
 * permanently will be, and the condition it describes does not go away because
 * somebody clicked.
 */
export async function ackHealthFlag(
  projectId: string,
  code: string,
  days: number,
  note: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_ack_health_flag', {
    p_project: projectId,
    p_code: code,
    p_days: days,
    p_note: note,
  })
  if (error) throw error
}

export async function unackHealthFlag(
  projectId: string,
  code: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_unack_health_flag', {
    p_project: projectId,
    p_code: code,
  })
  if (error) throw error
}

/**
 * Captures tonight's numbers now rather than waiting for the cron job.
 *
 * Useful on the day the module goes live, when there is no history at all and
 * every trend flag is correctly refusing to fire.
 */
export async function captureSnapshotNow(): Promise<number> {
  const { data, error } = await supabase.rpc('fn_capture_health_snapshot')
  if (error) throw error
  return Number(data ?? 0)
}
