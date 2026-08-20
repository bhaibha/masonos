import { supabase } from '@/lib/supabase'
import type {
  MisCategory,
  MisCompany,
  MisException,
  MisExceptionKind,
  MisProject,
  MisTrendPoint,
  ProjectHealth,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const n = (v: unknown) => Number(v ?? 0)
const optN = (v: unknown) => (v === null || v === undefined ? null : Number(v))

/**
 * Every function here reads a figure Postgres already worked out. Nothing in
 * this file adds, averages or ranks anything — if a number is missing from the
 * server's shape, the answer is a migration, not a reduce().
 *
 * Scoping is inherited, not applied: `v_mis_projects` sits on `v_project_pnl`,
 * which carries `is_member(...) and my_role() in (founder, pm, accounts)`. So a
 * founder and accounts get every project, a PM gets their own, and a supervisor
 * gets an empty array from all five calls.
 */

/* ---------------- cross-project table ---------------- */

export async function fetchMisProjects(): Promise<MisProject[]> {
  const { data, error } = await supabase
    .from('v_mis_projects')
    .select(
      'project_id, project_name, project_status, revenue, total_cost, ' +
        'gross_margin, margin_pct, budget_total, budget_remaining, ' +
        'budget_pct_used, over_budget, committed_open, retention_held, ' +
        'activity_count, spi, cpi, pct_complete, bac, evm_actual_cost, ' +
        'open_ncrs, critical_ncrs, open_snags, pos_pending, bills_awaiting, health',
    )
    .order('project_name')

  if (error) throw error

  return rows(data).map((r) => ({
    project_id: r.project_id as string,
    project_name: r.project_name as string,
    project_status: r.project_status as string,
    revenue: n(r.revenue),
    total_cost: n(r.total_cost),
    gross_margin: n(r.gross_margin),
    margin_pct: optN(r.margin_pct),
    budget_total: n(r.budget_total),
    budget_remaining: n(r.budget_remaining),
    budget_pct_used: optN(r.budget_pct_used),
    over_budget: Boolean(r.over_budget),
    committed_open: n(r.committed_open),
    retention_held: n(r.retention_held),
    activity_count: optN(r.activity_count),
    spi: optN(r.spi),
    cpi: optN(r.cpi),
    pct_complete: optN(r.pct_complete),
    bac: optN(r.bac),
    evm_actual_cost: optN(r.evm_actual_cost),
    open_ncrs: n(r.open_ncrs),
    critical_ncrs: n(r.critical_ncrs),
    open_snags: n(r.open_snags),
    pos_pending: n(r.pos_pending),
    bills_awaiting: n(r.bills_awaiting),
    health: r.health as ProjectHealth,
  }))
}

/* ---------------- company KPIs ---------------- */

export async function fetchMisCompany(
  from: string,
  to: string,
): Promise<MisCompany | null> {
  const { data, error } = await supabase.rpc('fn_mis_company', {
    p_from: from,
    p_to: to,
  })
  if (error) throw error

  // Zero rows means "not for your role" — deliberately not a row of zeros,
  // which would read as "the company has no projects".
  const r = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!r) return null

  return {
    project_count: n(r.project_count),
    active_count: n(r.active_count),
    contract_value: n(r.contract_value),
    total_cost: n(r.total_cost),
    gross_margin: n(r.gross_margin),
    blended_margin_pct: optN(r.blended_margin_pct),
    over_budget_count: n(r.over_budget_count),
    bleeding_count: n(r.bleeding_count),
    overheads: optN(r.overheads),
    net_position: optN(r.net_position),
    sees_overheads: Boolean(r.sees_overheads),
    overhead_from: str(r.overhead_from),
    overhead_to: str(r.overhead_to),
    retention_held: n(r.retention_held),
    committed_open: n(r.committed_open),
    bills_awaiting: n(r.bills_awaiting),
    overdue_compliance: n(r.overdue_compliance),
    open_ncrs: n(r.open_ncrs),
    critical_ncrs: n(r.critical_ncrs),
    open_snags: n(r.open_snags),
    pos_pending: n(r.pos_pending),
  }
}

/* ---------------- trend ---------------- */

export async function fetchMisTrend(months = 12): Promise<MisTrendPoint[]> {
  const { data, error } = await supabase.rpc('fn_mis_trend', {
    p_months: months,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    month: r.month as string,
    monthly_cost: n(r.monthly_cost),
    cumulative_cost: n(r.cumulative_cost),
    revenue_to_date: n(r.revenue_to_date),
    margin_to_date: n(r.margin_to_date),
    margin_pct_to_date: optN(r.margin_pct_to_date),
  }))
}

export async function fetchMisByCategory(
  from: string | null,
  to: string | null,
): Promise<MisCategory[]> {
  const { data, error } = await supabase.rpc('fn_mis_by_category', {
    p_from: from,
    p_to: to,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    category_id: n(r.category_id),
    category_name: r.category_name as string,
    amount: n(r.amount),
    pct_of_total: optN(r.pct_of_total),
    entry_count: n(r.entry_count),
  }))
}

/* ---------------- exceptions ---------------- */

/**
 * Eight sources — budget, margin, CPI, SPI, critical NCRs, compliance, bank
 * guarantees, insurance, contractor bills and purchase requests — arriving in
 * ONE shape, already sorted critical-first by the server.
 *
 * A dashboard with eight separate warning boxes is a dashboard where the eighth
 * is never read.
 */
export async function fetchMisExceptions(): Promise<MisException[]> {
  const { data, error } = await supabase.rpc('fn_mis_exceptions')
  if (error) throw error
  return rows(data).map((r) => ({
    kind: r.kind as MisExceptionKind,
    severity: r.severity as MisException['severity'],
    project_id: str(r.project_id),
    project_name: str(r.project_name),
    title: r.title as string,
    detail: str(r.detail),
    due_date: str(r.due_date),
    amount: optN(r.amount),
  }))
}
