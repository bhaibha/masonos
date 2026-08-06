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

/**
 * Tasks for one project across a date range, oldest first — the history view.
 *
 * Deliberately capped at 2000 rows: a year of a busy site is a few hundred, and
 * an unbounded query that quietly starts taking six seconds is worse than one
 * that tells you to narrow the range.
 */
export async function fetchTaskHistory(
  projectId: string,
  from: string,
  to: string,
): Promise<TaskRow[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .gte('planned_date', from)
    .lte('planned_date', to)
    .order('planned_date', { ascending: false })
    .order('created_at')
    .limit(2000)

  if (error) throw error

  const rows = (data ?? []).map((r) => {
    const t = r as unknown as RawTask
    return {
      ...t,
      target_qty: t.target_qty === null ? null : Number(t.target_qty),
      done_qty: t.done_qty === null ? null : Number(t.done_qty),
    }
  })

  // Same parent-date resolution as fetchTasks, so a rolled-over row can say
  // where it came from instead of showing a uuid.
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

/**
 * The people assigned to a project, for the "send today's list" picker.
 *
 * `profiles_read` is true for any signed-in user and `members_read` likewise,
 * so this needs no special role — it returns names and phone numbers, which
 * everyone in the business already has.
 */
export async function fetchProjectTeam(
  projectId: string,
): Promise<{ id: string; full_name: string; phone: string | null; role: string }[]> {
  const { data, error } = await supabase
    .from('project_members')
    .select('user_id, profiles(id, full_name, phone, role, is_active)')
    .eq('project_id', projectId)

  if (error) throw error

  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows
    .map((r) => {
      const p = r.profiles as
        | { id: string; full_name: string; phone: string | null; role: string; is_active: boolean }
        | null
      return p
    })
    .filter(
      (p): p is {
        id: string
        full_name: string
        phone: string | null
        role: string
        is_active: boolean
      } => Boolean(p) && p!.is_active,
    )
    .map((p) => ({
      id: p.id,
      full_name: p.full_name,
      phone: p.phone,
      role: p.role,
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
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
