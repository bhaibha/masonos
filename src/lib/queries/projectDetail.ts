import { supabase } from '@/lib/supabase'
import { fetchFolderCounts } from '@/lib/queries/documents'
import { weekStartIst } from '@/lib/queries/dashboard'
import type { ActivityItem, ProjectSummary } from '@/lib/types'
import { addDays, todayIst } from '@/lib/useSelectedDate'

/**
 * Counters for the detail screen. Every count is produced by Postgres —
 * `head: true` with an exact count returns the number without shipping rows.
 * These are counts, not money, so rule 2 isn't in play; it's just cheaper.
 */
export async function fetchProjectSummary(
  projectId: string,
): Promise<ProjectSummary> {
  const from = weekStartIst()
  const to = addDays(from, 6)
  const today = todayIst()
  const OPEN = ['pending', 'partial', 'not_done']

  const base = () => supabase.from('tasks').select('*', {
    count: 'exact',
    head: true,
  })

  const [weekTotal, weekDone, open, overdue, stock, docCounts] =
    await Promise.all([
      base().eq('project_id', projectId).gte('planned_date', from).lte('planned_date', to),
      base()
        .eq('project_id', projectId)
        .gte('planned_date', from)
        .lte('planned_date', to)
        .eq('status', 'done'),
      base().eq('project_id', projectId).in('status', OPEN),
      base()
        .eq('project_id', projectId)
        .in('status', OPEN)
        .lt('planned_date', today),
      supabase
        .from('v_stock')
        .select('low_stock')
        .eq('project_id', projectId)
        .eq('low_stock', true),
      fetchFolderCounts(projectId).catch(() => ({}) as Record<string, number>),
    ])

  const wTotal = weekTotal.count ?? 0
  const wDone = weekDone.count ?? 0

  const doc_counts = docCounts
  const doc_total = Object.values(doc_counts).reduce((a, b) => a + b, 0)

  return {
    tasks_week_total: wTotal,
    tasks_week_done: wDone,
    task_pct: wTotal > 0 ? Math.round((wDone / wTotal) * 100) : null,
    tasks_open: open.count ?? 0,
    tasks_overdue: overdue.count ?? 0,
    low_stock_count: stock.data?.length ?? 0,
    doc_counts,
    doc_total,
  }
}

/**
 * Newest-first feed across three tables. Each query is ordered and limited in
 * Postgres; the client only interleaves the three already-sorted lists, which
 * is ordering rather than aggregation — no figure is derived here.
 *
 * Expenses come back empty for supervisors because `exp_read` excludes them,
 * so the feed degrades to tasks and site logs without any client-side check.
 */
export async function fetchRecentActivity(
  projectId: string,
  limit = 8,
): Promise<ActivityItem[]> {
  const [expenses, tasks, logs] = await Promise.all([
    supabase
      .from('expenses')
      .select('id, created_at, amount, description, expense_categories(name)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('tasks')
      .select('id, created_at, title, status, work_area')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('site_logs')
      .select('id, created_at, log_date, work_summary')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit),
  ])

  const items: ActivityItem[] = []

  type Named = { name: string } | { name: string }[] | null
  const nameOf = (v: Named) =>
    (Array.isArray(v) ? v[0]?.name : v?.name) ?? null

  for (const e of expenses.data ?? []) {
    const row = e as Record<string, unknown>
    items.push({
      id: row.id as string,
      kind: 'expense',
      at: row.created_at as string,
      title: nameOf(row.expense_categories as Named) ?? 'Expense',
      subtitle: (row.description as string | null) ?? null,
      amount: Number(row.amount),
    })
  }

  for (const t of tasks.data ?? []) {
    const row = t as Record<string, unknown>
    items.push({
      id: row.id as string,
      kind: 'task',
      at: row.created_at as string,
      title: row.title as string,
      subtitle: (row.work_area as string | null) ?? null,
      amount: null,
    })
  }

  for (const l of logs.data ?? []) {
    const row = l as Record<string, unknown>
    items.push({
      id: row.id as string,
      kind: 'site_log',
      at: row.created_at as string,
      title: `Site log — ${row.log_date as string}`,
      subtitle: (row.work_summary as string | null) ?? null,
      amount: null,
    })
  }

  return items
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit)
}
