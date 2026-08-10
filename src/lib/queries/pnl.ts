import { supabase } from '@/lib/supabase'
import type {
  CompanyPnl,
  PnlCategoryRow,
  ProjectPnl,
  ProjectStatus,
} from '@/lib/types'

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))
const numOrNull = (v: unknown) =>
  v === null || v === undefined ? null : Number(v)

const COLUMNS =
  'project_id, name, project_status, contract_value, variations_value, ' +
  'pending_variations, revenue, expense_cost, contractor_cost, total_cost, ' +
  'gross_margin, margin_pct, retention_held, budget_total, budget_remaining, ' +
  'committed_open, projected_cost, projected_margin'

/**
 * P&L for every project the caller may see.
 *
 * `v_project_pnl` is owner-run rather than security_invoker, because it reads
 * `projects.contract_value` which migration 010 revoked from `authenticated`.
 * Its WHERE clause is the access control — a supervisor gets zero rows, not an
 * error, so this never needs a role check in front of it.
 */
export async function fetchProjectPnl(): Promise<ProjectPnl[]> {
  const { data, error } = await supabase
    .from('v_project_pnl')
    .select(COLUMNS)
    .order('name')

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    project_id: r.project_id as string,
    name: r.name as string,
    project_status: r.project_status as ProjectStatus,
    contract_value: num(r.contract_value),
    variations_value: num(r.variations_value),
    pending_variations: num(r.pending_variations),
    revenue: num(r.revenue),
    expense_cost: num(r.expense_cost),
    contractor_cost: num(r.contractor_cost),
    total_cost: num(r.total_cost),
    gross_margin: num(r.gross_margin),
    margin_pct: numOrNull(r.margin_pct),
    retention_held: num(r.retention_held),
    budget_total: num(r.budget_total),
    budget_remaining: num(r.budget_remaining),
    committed_open: num(r.committed_open),
    projected_cost: numOrNull(r.projected_cost),
    projected_margin: numOrNull(r.projected_margin),
  }))
}

/** Cost lines for one project, worst overspend first. */
export async function fetchPnlCategories(
  projectId: string,
): Promise<PnlCategoryRow[]> {
  const { data, error } = await supabase
    .from('v_pnl_by_category')
    .select('project_id, category, budget, actual, variance, pct_used, over_budget')
    .eq('project_id', projectId)

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows
    .map((r) => ({
      project_id: r.project_id as string,
      category: r.category as string,
      budget: num(r.budget),
      actual: num(r.actual),
      variance: num(r.variance),
      pct_used: numOrNull(r.pct_used),
      over_budget: Boolean(r.over_budget),
    }))
    // Ranked by overspend, because a list sorted alphabetically buries the one
    // line you opened the screen to find.
    .sort((a, b) => a.variance - b.variance)
}

/**
 * Company totals. Founder only — the function returns zero rows for anyone
 * else, so this resolves to null and the card simply doesn't render.
 */
export async function fetchCompanyPnl(): Promise<CompanyPnl | null> {
  const { data, error } = await supabase.rpc('fn_company_pnl')
  if (error) return null

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  return {
    project_count: Number(row.project_count ?? 0),
    active_count: Number(row.active_count ?? 0),
    revenue: num(row.revenue),
    total_cost: num(row.total_cost),
    gross_margin: num(row.gross_margin),
    blended_margin_pct: numOrNull(row.blended_margin_pct),
    retention_held: num(row.retention_held),
    committed_open: num(row.committed_open),
    profitable_count: Number(row.profitable_count ?? 0),
    bleeding_count: Number(row.bleeding_count ?? 0),
  }
}
