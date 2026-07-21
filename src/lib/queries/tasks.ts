import { supabase } from '@/lib/supabase'
import type { NewTask, TaskRow, TaskStatus } from '@/lib/types'

const COLUMNS =
  'id, project_id, title, trade, work_area, planned_date, target_qty, qty_unit, status, done_qty, not_done_reason, rolled_from'

type RawTask = Omit<TaskRow, 'rolled_from_date'>

/** Tasks for one project on one date. RLS: tasks_read → is_member. */
export async function fetchTasks(
  projectId: string,
  date: string,
): Promise<TaskRow[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .eq('planned_date', date)
    .order('created_at')

  if (error) throw error

  const rows = (data ?? []).map((r) => {
    const t = r as unknown as RawTask
    return {
      ...t,
      target_qty: t.target_qty === null ? null : Number(t.target_qty),
      done_qty: t.done_qty === null ? null : Number(t.done_qty),
    }
  })

  // Resolve the planned_date of each parent task so the list can show
  // "rolled from 21 Jul" rather than a bare uuid.
  const parentIds = [...new Set(rows.map((r) => r.rolled_from).filter(Boolean))]
  const parentDates = new Map<string, string>()

  if (parentIds.length > 0) {
    const { data: parents } = await supabase
      .from('tasks')
      .select('id, planned_date')
      .in('id', parentIds as string[])

    for (const p of parents ?? []) {
      parentDates.set(p.id as string, p.planned_date as string)
    }
  }

  return rows.map((r) => ({
    ...r,
    rolled_from_date: r.rolled_from
      ? (parentDates.get(r.rolled_from) ?? null)
      : null,
  }))
}

export async function createTask(input: NewTask): Promise<void> {
  const { error } = await supabase.from('tasks').insert({
    project_id: input.project_id,
    title: input.title,
    trade: input.trade || null,
    work_area: input.work_area || null,
    planned_date: input.planned_date,
    target_qty: input.target_qty,
    qty_unit: input.qty_unit || null,
  })
  if (error) throw error
}

interface StatusUpdate {
  status: TaskStatus
  done_qty?: number | null
  not_done_reason?: string | null
}

export async function updateTaskStatus(
  taskId: string,
  update: StatusUpdate,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: update.status,
    updated_at: new Date().toISOString(),
  }

  // Clear the fields that don't apply, so a task changed from Partial to Done
  // doesn't keep a stale done_qty.
  patch.done_qty = update.status === 'partial' ? (update.done_qty ?? null) : null
  patch.not_done_reason =
    update.status === 'not_done' ? (update.not_done_reason ?? null) : null

  const { error } = await supabase.from('tasks').update(patch).eq('id', taskId)
  if (error) throw error
}

/**
 * Copies this project's unfinished tasks from `date` to the next day and
 * returns how many were copied.
 *
 * Requires migration 005: the original 001_core.sql signature took only p_date
 * and rolled over every project in the database. 005 drops that overload, so
 * omitting p_project now fails loudly rather than doing too much.
 */
export async function rolloverTasks(
  projectId: string,
  date: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('rollover_tasks', {
    p_project: projectId,
    p_date: date,
  })
  if (error) throw error
  return Number(data ?? 0)
}
