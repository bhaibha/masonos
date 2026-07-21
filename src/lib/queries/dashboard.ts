import { supabase } from '@/lib/supabase'
import type { PortfolioSummary, ProjectPulse } from '@/lib/types'
import { addDays, todayIst } from '@/lib/useSelectedDate'

/**
 * All-projects roll-up from v_portfolio_summary (migration 009).
 * Returns null when the view isn't there yet, so the dashboard hides the
 * overview strip rather than breaking.
 */
export async function fetchPortfolioSummary(): Promise<PortfolioSummary | null> {
  const { data, error } = await supabase
    .from('v_portfolio_summary')
    .select(
      'project_count, active_count, over_budget_count, total_spent, total_budget, remaining, pct_used',
    )
    .maybeSingle()

  if (error || !data) return null

  const r = data as Record<string, unknown>
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))

  return {
    project_count: Number(r.project_count ?? 0),
    active_count: Number(r.active_count ?? 0),
    over_budget_count: Number(r.over_budget_count ?? 0),
    total_spent: Number(r.total_spent ?? 0),
    total_budget: Number(r.total_budget ?? 0),
    remaining: Number(r.remaining ?? 0),
    pct_used: n(r.pct_used),
  }
}

/** Monday of the current week, in Asia/Kolkata, as YYYY-MM-DD. */
export function weekStartIst(): string {
  const today = todayIst()
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1
  return addDays(today, -backToMonday)
}

/**
 * Per-project counters for the dashboard stats row: task completion this week
 * and how many materials are at or below their low-stock level.
 *
 * These are counts, not money — no rule-2 concern. Two queries total rather
 * than two per project; RLS narrows both to what the caller may see.
 */
export async function fetchProjectPulse(): Promise<Map<string, ProjectPulse>> {
  const from = weekStartIst()
  const to = addDays(from, 6)

  const [tasks, stock] = await Promise.all([
    supabase
      .from('tasks')
      .select('project_id, status')
      .gte('planned_date', from)
      .lte('planned_date', to),
    supabase.from('v_stock').select('project_id, low_stock'),
  ])

  const out = new Map<string, ProjectPulse>()

  const ensure = (id: string): ProjectPulse => {
    let row = out.get(id)
    if (!row) {
      row = {
        project_id: id,
        tasks_total: 0,
        tasks_done: 0,
        task_pct: null,
        low_stock_count: 0,
      }
      out.set(id, row)
    }
    return row
  }

  if (!tasks.error) {
    for (const t of tasks.data ?? []) {
      const row = ensure(t.project_id as string)
      row.tasks_total += 1
      if (t.status === 'done') row.tasks_done += 1
    }
  }

  if (!stock.error) {
    for (const s of stock.data ?? []) {
      const row = ensure(s.project_id as string)
      if (s.low_stock) row.low_stock_count += 1
    }
  }

  for (const row of out.values()) {
    row.task_pct =
      row.tasks_total > 0
        ? Math.round((row.tasks_done / row.tasks_total) * 100)
        : null
  }

  return out
}
