import { supabase } from '@/lib/supabase'
import type {
  DrawingDiscipline,
  DrawingRevisionRow,
  DrawingRow,
  DrawingStatus,
  NewDrawingInput,
  NewRevisionInput,
} from '@/lib/types'

const REGISTER_COLUMNS =
  'id, project_id, drawing_no, title, discipline, created_at, ' +
  'current_revision_id, current_revision, current_issued_date, ' +
  'current_file_path, current_file_type, current_notes, ' +
  'latest_revision, latest_status, wip_count, superseded_count, revision_count'

const REVISION_COLUMNS =
  'id, drawing_id, project_id, revision, status, issued_date, file_path, ' +
  'file_type, notes, issued_by, issued_at, superseded_at, created_at'

/**
 * The register: one row per drawing carrying its Issued-For-Construction sheet.
 *
 * Always read through v_drawing_register, never the tables. The view is
 * security_invoker, so a supervisor's revision policy applies inside it — which
 * means `current_*` can only ever resolve to an IFC revision for them, and
 * drawings with nothing issued don't appear at all.
 */
export async function fetchDrawings(projectId: string): Promise<DrawingRow[]> {
  const { data, error } = await supabase
    .from('v_drawing_register')
    .select(REGISTER_COLUMNS)
    .eq('project_id', projectId)
    .order('drawing_no')
    .limit(500)

  if (error) throw error

  // The generated types don't know this view, so PostgREST widens it.
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    drawing_no: r.drawing_no as string,
    title: r.title as string,
    discipline: r.discipline as DrawingDiscipline,
    created_at: r.created_at as string,
    current_revision_id: (r.current_revision_id as string | null) ?? null,
    current_revision: (r.current_revision as string | null) ?? null,
    current_issued_date: (r.current_issued_date as string | null) ?? null,
    current_file_path: (r.current_file_path as string | null) ?? null,
    current_file_type: (r.current_file_type as string | null) ?? null,
    current_notes: (r.current_notes as string | null) ?? null,
    latest_revision: (r.latest_revision as string | null) ?? null,
    latest_status: (r.latest_status as DrawingStatus | null) ?? null,
    wip_count: Number(r.wip_count ?? 0),
    superseded_count: Number(r.superseded_count ?? 0),
    revision_count: Number(r.revision_count ?? 0),
  }))
}

/** One drawing from the register, or null when RLS hides it. */
export async function fetchDrawing(id: string): Promise<DrawingRow | null> {
  const { data, error } = await supabase
    .from('v_drawing_register')
    .select(REGISTER_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const r = data as unknown as Record<string, unknown>
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    drawing_no: r.drawing_no as string,
    title: r.title as string,
    discipline: r.discipline as DrawingDiscipline,
    created_at: r.created_at as string,
    current_revision_id: (r.current_revision_id as string | null) ?? null,
    current_revision: (r.current_revision as string | null) ?? null,
    current_issued_date: (r.current_issued_date as string | null) ?? null,
    current_file_path: (r.current_file_path as string | null) ?? null,
    current_file_type: (r.current_file_type as string | null) ?? null,
    current_notes: (r.current_notes as string | null) ?? null,
    latest_revision: (r.latest_revision as string | null) ?? null,
    latest_status: (r.latest_status as DrawingStatus | null) ?? null,
    wip_count: Number(r.wip_count ?? 0),
    superseded_count: Number(r.superseded_count ?? 0),
    revision_count: Number(r.revision_count ?? 0),
  }
}

/**
 * Every revision of one drawing, newest first. A supervisor gets only the IFC
 * row back — drawing_rev_read filters it in Postgres, not here.
 */
export async function fetchRevisions(
  drawingId: string,
): Promise<DrawingRevisionRow[]> {
  const { data, error } = await supabase
    .from('drawing_revisions')
    .select(REVISION_COLUMNS)
    .eq('drawing_id', drawingId)
    .order('created_at', { ascending: false })

  if (error) throw error

  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    id: r.id as string,
    drawing_id: r.drawing_id as string,
    project_id: r.project_id as string,
    revision: r.revision as string,
    status: r.status as DrawingStatus,
    issued_date: (r.issued_date as string | null) ?? null,
    file_path: (r.file_path as string | null) ?? null,
    file_type: (r.file_type as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    issued_by: (r.issued_by as string | null) ?? null,
    issued_at: (r.issued_at as string | null) ?? null,
    superseded_at: (r.superseded_at as string | null) ?? null,
    created_at: r.created_at as string,
  }))
}

export async function createDrawing(input: NewDrawingInput): Promise<string> {
  const { data, error } = await supabase
    .from('drawings')
    .insert({
      project_id: input.project_id,
      drawing_no: input.drawing_no.trim(),
      title: input.title.trim(),
      discipline: input.discipline,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Adds a revision as WIP. It becomes the construction issue only through
 * issueRevision — that step also supersedes the previous sheet, and the two
 * have to happen together.
 *
 * `project_id` is stamped from the parent drawing by a trigger, so it isn't
 * sent from here: a client that could choose it could file a revision against
 * another project's drawing.
 */
export async function addRevision(input: NewRevisionInput): Promise<string> {
  const { data, error } = await supabase
    .from('drawing_revisions')
    .insert({
      drawing_id: input.drawing_id,
      revision: input.revision.trim(),
      issued_date: input.issued_date,
      file_path: input.file_path,
      file_type: input.file_type,
      notes: input.notes.trim() || null,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/** Issues a revision for construction, superseding the previous one atomically. */
export async function issueRevision(
  id: string,
  issuedDate: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_issue_revision', {
    p_id: id,
    p_date: issuedDate,
  })
  if (error) throw error
}

/** Pulls the current sheet out of construction without replacing it. */
export async function withdrawRevision(id: string): Promise<void> {
  const { error } = await supabase.rpc('fn_withdraw_revision', { p_id: id })
  if (error) throw error
}

/** Editing the notes on a revision. Status changes never come through here. */
export async function updateRevisionNotes(
  id: string,
  notes: string,
): Promise<void> {
  const { error } = await supabase
    .from('drawing_revisions')
    .update({ notes: notes.trim() || null })
    .eq('id', id)
    .select('id')
    .single()

  if (error) throw error
}
