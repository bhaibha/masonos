import { supabase } from '@/lib/supabase'
import type {
  NewSiteVisit,
  SiteVisit,
  VisitAction,
  VisitAttention,
} from '@/lib/types'

/**
 * M18 Site Visits.
 *
 * THE ACTION ITEMS ARE TASKS. There is no `visit_actions` table and there
 * should never be one — `tasks` (001, extended in 048) already has the title,
 * the due date, the status and the assignee, and around it sit the daily list,
 * the rollover chain and the push digest. Migration 084 adds one nullable
 * `tasks.visit_id`; everything below reads and writes ordinary tasks through
 * that link.
 *
 * Nothing here filters by role. `svt_read` is `is_member(project_id)`, and
 * `is_member()` already returns false for a client (065) and for a deactivated
 * profile (078).
 */

const one = <T,>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : v

/* ------------------------------------------------------------------ */
/* Visits                                                              */
/* ------------------------------------------------------------------ */

export async function fetchSiteVisits(projectId: string): Promise<SiteVisit[]> {
  // Two calls rather than a nested select: the actions come from `tasks`, a
  // different table with its own RLS, and asking for them as an embedded
  // relationship would make one refusal empty the whole visit list.
  const [visits, actions] = await Promise.all([
    supabase
      .from('site_visits')
      .select(
        'id, visit_no, project_id, visit_type, visit_date, visit_time, visitor_name, visitor_org, purpose, observations, photos, comm_entry_id, logged_by, created_at, profiles(full_name)',
      )
      .eq('project_id', projectId)
      .order('visit_date', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase
      .from('tasks')
      .select(
        'id, title, planned_date, status, assigned_to, visit_id, profiles!tasks_assigned_to_fkey(full_name)',
      )
      .eq('project_id', projectId)
      .not('visit_id', 'is', null)
      .order('planned_date'),
  ])

  if (visits.error) throw visits.error
  if (actions.error) throw actions.error

  const byVisit = new Map<string, VisitAction[]>()
  for (const t of actions.data ?? []) {
    const vid = t.visit_id as string
    const list = byVisit.get(vid) ?? []
    list.push({
      id: t.id as string,
      title: t.title as string,
      planned_date: t.planned_date as string,
      status: t.status as VisitAction['status'],
      assigned_to: (t.assigned_to as string | null) ?? null,
      assigned_to_name:
        one(t.profiles as { full_name: string } | { full_name: string }[] | null)
          ?.full_name ?? null,
    })
    byVisit.set(vid, list)
  }

  return (visits.data ?? []).map((r) => ({
    id: r.id as string,
    visit_no: r.visit_no as string,
    project_id: r.project_id as string,
    visit_type: r.visit_type as SiteVisit['visit_type'],
    visit_date: r.visit_date as string,
    visit_time: (r.visit_time as string | null) ?? null,
    visitor_name: r.visitor_name as string,
    visitor_org: (r.visitor_org as string | null) ?? null,
    purpose: (r.purpose as string | null) ?? null,
    observations: (r.observations as string | null) ?? null,
    photos: (r.photos as string[] | null) ?? [],
    comm_entry_id: (r.comm_entry_id as string | null) ?? null,
    logged_by: r.logged_by as string,
    logged_by_name:
      one(r.profiles as { full_name: string } | { full_name: string }[] | null)
        ?.full_name ?? null,
    created_at: r.created_at as string,
    actions: byVisit.get(r.id as string) ?? [],
  }))
}

/**
 * Logs a visit and returns its id, so the caller can attach action items and —
 * for a client visit — offer to record the conversation in the M36 log.
 *
 * A client visit with empty observations is refused by
 * `svt_client_needs_observations`, not only by the form.
 */
export async function createSiteVisit(input: NewSiteVisit): Promise<string> {
  const { data, error } = await supabase
    .from('site_visits')
    .insert({
      project_id: input.project_id,
      visit_type: input.visit_type,
      visit_date: input.visit_date,
      visitor_name: input.visitor_name,
      visitor_org: input.visitor_org || null,
      purpose: input.purpose || null,
      observations: input.observations || null,
      photos: input.photos,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/** Links a visit to the M36 entry recording the conversation it produced. */
export async function linkVisitToCommEntry(
  visitId: string,
  commEntryId: string,
): Promise<void> {
  const { error } = await supabase
    .from('site_visits')
    .update({ comm_entry_id: commEntryId })
    .eq('id', visitId)
  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* Action items — ordinary tasks with a visit_id                       */
/* ------------------------------------------------------------------ */

/**
 * Writes a visit action as a TASK.
 *
 * `planned_date` is the due date — that is what `tasks` has always called it,
 * and reusing it is what puts the action on the site's daily list and into the
 * rollover chain. `tasks_write` is founder/pm/supervisor, the same three that
 * may log a visit, so no caller can create a visit and then be refused its
 * actions.
 */
export async function createVisitAction(input: {
  project_id: string
  visit_id: string
  title: string
  due_on: string
  assigned_to: string | null
}): Promise<void> {
  const { error } = await supabase.from('tasks').insert({
    project_id: input.project_id,
    visit_id: input.visit_id,
    title: input.title,
    planned_date: input.due_on,
    assigned_to: input.assigned_to,
  })
  if (error) throw error
}

/**
 * Closes a visit action. Goes through the ordinary task columns rather than
 * anything visit-specific — it is a task, and the task screens must be able to
 * close it too.
 */
export async function completeVisitAction(taskId: string): Promise<void> {
  const { error } = await supabase
    .from('tasks')
    .update({ status: 'done', updated_at: new Date().toISOString() })
    .eq('id', taskId)
  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* Project-detail strip                                                */
/* ------------------------------------------------------------------ */

/**
 * Null when there is nothing to say. `fn_visit_open_actions` returns ZERO ROWS
 * when no action is open and no visit happened in the last 30 days, so the
 * strip disappears instead of rendering "0 open" — the 073 rule.
 */
export async function fetchVisitAttention(
  projectId: string,
): Promise<VisitAttention | null> {
  const { data, error } = await supabase
    .rpc('fn_visit_open_actions', { p_project: projectId })
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as Record<string, number | string | null>
  return {
    open_actions: Number(row.open_actions ?? 0),
    overdue_actions: Number(row.overdue_actions ?? 0),
    visits_30d: Number(row.visits_30d ?? 0),
    last_visit_on: (row.last_visit_on as string | null) ?? null,
  }
}
