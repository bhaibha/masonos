import { supabase } from '@/lib/supabase'
import type {
  ClashRow,
  ClashSeverity,
  ClashStatus,
  ClashSummary,
  DrawingDiscipline,
  NewClash,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const n = (v: unknown) => Number(v ?? 0)
const arr = (v: unknown) => ((v as string[] | null) ?? []) as string[]

const COLUMNS =
  'id, clash_no, project_id, system_a, system_b, discipline_a, discipline_b, ' +
  'location, description, severity, status, drawing_a_id, drawing_a_no, ' +
  'drawing_a_title, drawing_b_id, drawing_b_no, drawing_b_title, ' +
  'drawing_refs, photos, assigned_to, assigned_to_name, rfi_id, rfi_number, ' +
  'rfi_status, rfi_answered, resolution, resolved_at, resolved_by_name, ' +
  'verified_at, verified_by_name, raised_by, raised_by_name, created_at, open_days'

function toRow(r: Record<string, unknown>): ClashRow {
  return {
    id: r.id as string,
    clash_no: r.clash_no as string,
    project_id: r.project_id as string,
    system_a: r.system_a as string,
    system_b: r.system_b as string,
    discipline_a: r.discipline_a as DrawingDiscipline,
    discipline_b: r.discipline_b as DrawingDiscipline,
    location: r.location as string,
    description: r.description as string,
    severity: r.severity as ClashSeverity,
    status: r.status as ClashStatus,
    drawing_a_id: str(r.drawing_a_id),
    drawing_a_no: str(r.drawing_a_no),
    drawing_a_title: str(r.drawing_a_title),
    drawing_b_id: str(r.drawing_b_id),
    drawing_b_no: str(r.drawing_b_no),
    drawing_b_title: str(r.drawing_b_title),
    drawing_refs: arr(r.drawing_refs),
    photos: arr(r.photos),
    assigned_to: str(r.assigned_to),
    assigned_to_name: str(r.assigned_to_name),
    rfi_id: str(r.rfi_id),
    rfi_number: str(r.rfi_number),
    rfi_status: str(r.rfi_status),
    rfi_answered: Boolean(r.rfi_answered),
    resolution: str(r.resolution),
    resolved_at: str(r.resolved_at),
    resolved_by_name: str(r.resolved_by_name),
    verified_at: str(r.verified_at),
    verified_by_name: str(r.verified_by_name),
    raised_by: r.raised_by as string,
    raised_by_name: str(r.raised_by_name),
    created_at: r.created_at as string,
    open_days: r.open_days == null ? null : n(r.open_days),
  }
}

/**
 * The register for one project.
 *
 * Open first and oldest-first within that, because an open clash is the only
 * kind anybody has to act on and the oldest is the one about to be built over.
 */
export async function fetchClashes(
  projectId: string,
  status: ClashStatus | null,
): Promise<ClashRow[]> {
  let q = supabase
    .from('v_clashes')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('status', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(300)
  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) throw error
  return rows(data).map(toRow)
}

export async function fetchClashSummary(
  projectId: string,
): Promise<ClashSummary | null> {
  const { data, error } = await supabase.rpc('fn_project_clash_summary', {
    p_project: projectId,
  })
  if (error) throw error
  const r = rows(data)[0]
  if (!r) return null
  return {
    open_count: n(r.open_count),
    resolved_count: n(r.resolved_count),
    verified_count: n(r.verified_count),
    open_high: n(r.open_high),
    oldest_open_days:
      r.oldest_open_days == null ? null : n(r.oldest_open_days),
    awaiting_rfi: n(r.awaiting_rfi),
  }
}

export async function createClash(input: NewClash): Promise<string> {
  const { data, error } = await supabase
    .from('clashes')
    .insert({
      project_id: input.project_id,
      system_a: input.system_a.trim(),
      system_b: input.system_b.trim(),
      discipline_a: input.discipline_a,
      discipline_b: input.discipline_b,
      location: input.location.trim(),
      description: input.description.trim(),
      severity: input.severity,
      drawing_a_id: input.drawing_a_id,
      drawing_b_id: input.drawing_b_id,
      drawing_refs: input.drawing_refs,
      photos: input.photos,
      assigned_to: input.assigned_to,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

/**
 * Moves a clash. Through the RPC, never a plain update: a BEFORE UPDATE trigger
 * refuses the status and resolution columns when the caller is PostgREST, so
 * the who and the when cannot be forgotten or forged (migration 062).
 *
 * The server also refuses self-verification — the person who recorded the
 * resolution does not get to confirm their own work.
 */
export async function setClashStatus(
  id: string,
  status: ClashStatus,
  note: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_clash_status', {
    p_id: id,
    p_status: status,
    p_note: note,
  })
  if (error) throw error
}

/**
 * Creates a real RFI from the clash and links the two in one transaction.
 *
 * Not two steps: a clash marked "sent to the consultant" with no RFI behind it
 * is the failure this exists to prevent. The drawing references are appended
 * server-side, because the consultant's first reply is otherwise "which
 * drawings?" and that round trip costs a week.
 */
export async function raiseRfiFromClash(
  clashId: string,
  question: string,
  addressedTo: string | null,
  category: string,
  requiredBy: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc('fn_raise_rfi_from_clash', {
    p_clash: clashId,
    p_question: question,
    p_addressed_to: addressedTo,
    p_category: category,
    p_vendor: null,
    p_required_by: requiredBy,
  })
  if (error) throw error
  return data as string
}

/** Only while open, only with no RFI attached, and a supervisor only their own. */
export async function deleteClash(id: string): Promise<void> {
  const { error } = await supabase.rpc('fn_delete_clash', { p_id: id })
  if (error) throw error
}

/** Registered drawings on the project, for the two pickers and the overlay. */
export async function fetchClashDrawings(
  projectId: string,
): Promise<
  { id: string; label: string; filePath: string | null; discipline: string }[]
> {
  const { data, error } = await supabase
    .from('v_drawing_register')
    .select('id, drawing_no, title, discipline, current_file_path')
    .eq('project_id', projectId)
    .order('drawing_no')
    .limit(300)
  if (error) return []
  return rows(data).map((r) => ({
    id: r.id as string,
    label: `${r.drawing_no as string} · ${r.title as string}`,
    filePath: str(r.current_file_path),
    discipline: (r.discipline as string) ?? 'other',
  }))
}

/** Project members, for the assignee picker. */
export async function fetchAssignableUsers(
  projectId: string,
): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase
    .from('project_members')
    .select('user_id, profiles!inner(id, full_name, is_active)')
    .eq('project_id', projectId)
  if (error) return []
  return rows(data)
    .map((r) => {
      const p = r.profiles as { id: string; full_name: string; is_active?: boolean }
      return p && p.is_active !== false
        ? { id: p.id, name: p.full_name }
        : null
    })
    .filter((x): x is { id: string; name: string } => x !== null)
}
