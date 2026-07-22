import { supabase } from '@/lib/supabase'
import type {
  ChecklistItemState,
  IncidentRow,
  IncidentStatus,
  NewIncident,
  SafetyChecklistMeta,
  SafetyResult,
  SafetySummary,
} from '@/lib/types'

export interface LoadedChecklist {
  meta: SafetyChecklistMeta | null
  /** item_key → saved state; empty when no checklist exists for the day yet */
  items: Record<string, ChecklistItemState>
}

/** The checklist for one project on one date (RLS: sc_read → is_member). */
export async function fetchChecklist(
  projectId: string,
  date: string,
): Promise<LoadedChecklist> {
  const { data: cl, error } = await supabase
    .from('safety_checklists')
    .select('id, check_date, created_by, updated_at')
    .eq('project_id', projectId)
    .eq('check_date', date)
    .maybeSingle()

  if (error) throw error
  if (!cl) return { meta: null, items: {} }

  const { data: rows, error: itemErr } = await supabase
    .from('safety_checklist_items')
    .select('item_key, result, remark, photo_path')
    .eq('checklist_id', cl.id)

  if (itemErr) throw itemErr

  const items: Record<string, ChecklistItemState> = {}
  for (const r of rows ?? []) {
    items[r.item_key as string] = {
      result: r.result as SafetyResult,
      remark: (r.remark as string | null) ?? '',
      photo_path: (r.photo_path as string | null) ?? null,
    }
  }

  return {
    meta: {
      id: cl.id as string,
      check_date: cl.check_date as string,
      created_by: cl.created_by as string,
      updated_at: cl.updated_at as string,
    },
    items,
  }
}

/**
 * Upserts the day's checklist (one per project per date) then upserts its
 * items. Two-step because items need the checklist id; the unique constraints
 * on (project_id, check_date) and (checklist_id, item_key) make both idempotent.
 */
export async function saveChecklist(
  projectId: string,
  date: string,
  items: { item_key: string; state: ChecklistItemState }[],
): Promise<void> {
  const { data: cl, error } = await supabase
    .from('safety_checklists')
    .upsert(
      { project_id: projectId, check_date: date, updated_at: new Date().toISOString() },
      { onConflict: 'project_id,check_date' },
    )
    .select('id')
    .single()

  if (error) throw error
  const checklistId = cl.id as string

  const payload = items.map((i) => ({
    checklist_id: checklistId,
    item_key: i.item_key,
    result: i.state.result,
    remark: i.state.remark || null,
    photo_path: i.state.photo_path,
  }))

  const { error: itemErr } = await supabase
    .from('safety_checklist_items')
    .upsert(payload, { onConflict: 'checklist_id,item_key' })

  if (itemErr) throw itemErr
}

// ---------- Incidents ----------

const INCIDENT_COLUMNS =
  'id, project_id, occurred_at, incident_type, description, people_involved, immediate_action, photos, status, created_by'

export async function fetchIncidents(
  projectId: string,
): Promise<IncidentRow[]> {
  const { data, error } = await supabase
    .from('incidents')
    .select(INCIDENT_COLUMNS)
    .eq('project_id', projectId)
    .order('occurred_at', { ascending: false })
    .limit(200)

  if (error) throw error
  return (data ?? []).map((r) => {
    const row = r as unknown as IncidentRow
    return { ...row, photos: row.photos ?? [] }
  })
}

export async function createIncident(input: NewIncident): Promise<void> {
  const { error } = await supabase.from('incidents').insert({
    project_id: input.project_id,
    occurred_at: input.occurred_at,
    incident_type: input.incident_type,
    description: input.description,
    people_involved: input.people_involved || null,
    immediate_action: input.immediate_action || null,
    photos: input.photos,
  })
  if (error) throw error
}

export async function setIncidentStatus(
  id: string,
  status: IncidentStatus,
): Promise<void> {
  const { error } = await supabase
    .from('incidents')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// ---------- Summary ----------

/** Reads fn_safety_summary (migration 011). null before the migration runs. */
export async function fetchSafetySummary(
  projectId: string,
): Promise<SafetySummary | null> {
  const { data, error } = await supabase.rpc('fn_safety_summary', {
    p_project: projectId,
  })
  if (error) return null

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return {
    last_incident_at: (row.last_incident_at as string | null) ?? null,
    days_since_incident: n(row.days_since_incident),
    open_incidents: Number(row.open_incidents ?? 0),
    week_checklist_days: Number(row.week_checklist_days ?? 0),
    week_days_elapsed: Number(row.week_days_elapsed ?? 0),
  }
}
