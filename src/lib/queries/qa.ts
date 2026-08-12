import { supabase } from '@/lib/supabase'
import type {
  CheckAnswer,
  CheckResult,
  InspectionCheckRow,
  InspectionResult,
  InspectionRow,
  ItpCheck,
  ItpTemplateCheck,
  ItpItem,
  ItpStatus,
  ItpTemplate,
  ItpTemplateItem,
  ItpType,
  NcrRow,
  NcrSeverity,
  NcrStatus,
  NewItpItemInput,
  NewNcrInput,
  QaSummary,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const arr = (v: unknown) => ((v as string[] | null) ?? []) as string[]

/* ---------------- checklists (045) ---------------- */

/**
 * The questions under one live inspection point.
 *
 * Every project member reads them: the supervisor works through this list on
 * site and needs to see it BEFORE requesting the inspection, not only during.
 */
export async function fetchItpChecks(itemId: string): Promise<ItpCheck[]> {
  const { data, error } = await supabase
    .from('itp_checks')
    .select('id, itp_item_id, question, guidance, section, sort_order')
    .eq('itp_item_id', itemId)
    .order('sort_order')

  if (error) throw error
  return rows(data).map((r) => ({
    id: r.id as string,
    itp_item_id: r.itp_item_id as string,
    question: r.question as string,
    guidance: str(r.guidance),
    section: str(r.section),
    sort_order: Number(r.sort_order ?? 100),
  }))
}

export async function fetchTemplateChecks(
  templateItemId: string,
): Promise<ItpTemplateCheck[]> {
  const { data, error } = await supabase
    .from('itp_template_checks')
    .select('id, template_item_id, question, guidance, section, sort_order')
    .eq('template_item_id', templateItemId)
    .order('sort_order')

  if (error) throw error
  return rows(data).map((r) => ({
    id: r.id as string,
    template_item_id: r.template_item_id as string,
    question: r.question as string,
    guidance: str(r.guidance),
    section: str(r.section),
    sort_order: Number(r.sort_order ?? 100),
  }))
}

export async function createItpCheck(
  itemId: string,
  question: string,
  guidance: string,
  sortOrder: number,
): Promise<void> {
  const { error } = await supabase.from('itp_checks').insert({
    itp_item_id: itemId,
    question: question.trim(),
    guidance: guidance.trim() || null,
    sort_order: sortOrder,
  })
  if (error) throw error
}

/**
 * Removing a question from the plan. Answers already given to it survive —
 * `inspection_checks.itp_check_id` is ON DELETE SET NULL and the wording was
 * snapshotted, so completed inspections still read correctly.
 */
export async function deleteItpCheck(id: string): Promise<void> {
  const { error } = await supabase.from('itp_checks').delete().eq('id', id)
  if (error) throw error
}

/** The answers on a completed inspection, with the NCR each failure raised. */
export async function fetchInspectionChecks(
  inspectionId: string,
): Promise<InspectionCheckRow[]> {
  const { data, error } = await supabase.rpc('fn_inspection_checks', {
    p_inspection: inspectionId,
  })
  if (error) throw error

  return rows(data).map((r) => ({
    id: r.id as string,
    question: r.question as string,
    section: str(r.section),
    result: r.result as CheckResult,
    remark: str(r.remark),
    photos: arr(r.photos),
    ncr_no: str(r.ncr_no),
  }))
}

/* ---------------- templates ---------------- */

/**
 * The firm's standard inspection plans.
 *
 * Readable by everyone including supervisors: knowing what the firm's standard
 * is helps the person working to it, and there is no figure on these tables.
 */
export async function fetchItpTemplates(): Promise<ItpTemplate[]> {
  // Two plain queries rather than PostgREST's `itp_template_items(count)`
  // aggregate embed: the embed is version-dependent and fails opaquely on an
  // older PostgREST, and the tally of a handful of templates is not worth that
  // fragility.
  const [tpl, items] = await Promise.all([
    supabase
      .from('itp_templates')
      .select('id, name, description, is_active')
      .order('name'),
    supabase.from('itp_template_items').select('template_id'),
  ])

  if (tpl.error) throw tpl.error
  if (items.error) throw items.error

  const counts = new Map<string, number>()
  for (const r of rows(items.data)) {
    const id = r.template_id as string
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  return rows(tpl.data).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: str(r.description),
    is_active: Boolean(r.is_active),
    item_count: counts.get(r.id as string) ?? 0,
  }))
}

export async function fetchTemplateItems(
  templateId: string,
): Promise<ItpTemplateItem[]> {
  const { data, error } = await supabase
    .from('itp_template_items')
    .select(
      'id, template_id, stage, description, acceptance_criteria, ' +
        'inspection_type, reference_standard, required_by_stage, sort_order',
    )
    .eq('template_id', templateId)
    .order('sort_order')

  if (error) throw error

  return rows(data).map((r) => ({
    id: r.id as string,
    template_id: r.template_id as string,
    stage: r.stage as string,
    description: r.description as string,
    acceptance_criteria: str(r.acceptance_criteria),
    inspection_type: r.inspection_type as ItpType,
    reference_standard: str(r.reference_standard),
    required_by_stage: str(r.required_by_stage),
    sort_order: Number(r.sort_order ?? 100),
  }))
}

/** Copies the template's points onto a project. Refuses a second application. */
export async function applyItpTemplate(
  projectId: string,
  templateId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('fn_apply_itp_template', {
    p_project: projectId,
    p_template: templateId,
  })
  if (error) throw error
  return Number(data ?? 0)
}

/** Turns a project's plan into a reusable firm template. */
export async function saveItpTemplate(
  projectId: string,
  name: string,
  description: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('fn_save_itp_template', {
    p_project: projectId,
    p_name: name,
    p_description: description || null,
  })
  if (error) throw error
  return data as string
}

/* ---------------- ITP items ---------------- */

const ITEM_COLUMNS =
  'id, project_id, activity_id, stage, description, acceptance_criteria, ' +
  'inspection_type, reference_standard, required_by_stage, status, ' +
  'template_id, sort_order, notes, requested_at, requested_by, ' +
  'signed_off_at, signed_off_by, schedule_activities(code, name)'

export async function fetchItpItems(projectId: string): Promise<ItpItem[]> {
  const { data, error } = await supabase
    .from('itp_items')
    .select(ITEM_COLUMNS)
    .eq('project_id', projectId)
    .order('sort_order')
    .order('stage')

  if (error) throw error

  return rows(data).map((r) => {
    const a = r.schedule_activities as
      | { code: string; name: string }
      | { code: string; name: string }[]
      | null
    const act = Array.isArray(a) ? a[0] : a

    return {
      id: r.id as string,
      project_id: r.project_id as string,
      activity_id: str(r.activity_id),
      activity_label: act ? `${act.code} ${act.name}` : null,
      stage: r.stage as string,
      description: r.description as string,
      acceptance_criteria: str(r.acceptance_criteria),
      inspection_type: r.inspection_type as ItpType,
      reference_standard: str(r.reference_standard),
      required_by_stage: str(r.required_by_stage),
      status: r.status as ItpStatus,
      template_id: str(r.template_id),
      sort_order: Number(r.sort_order ?? 100),
      notes: str(r.notes),
      requested_at: str(r.requested_at),
      requested_by: str(r.requested_by),
      signed_off_at: str(r.signed_off_at),
      signed_off_by: str(r.signed_off_by),
    }
  })
}

export async function createItpItem(
  projectId: string,
  input: NewItpItemInput,
): Promise<void> {
  const { error } = await supabase.from('itp_items').insert({
    project_id: projectId,
    activity_id: input.activity_id,
    stage: input.stage.trim(),
    description: input.description.trim(),
    acceptance_criteria: input.acceptance_criteria.trim() || null,
    inspection_type: input.inspection_type,
    reference_standard: input.reference_standard.trim() || null,
    required_by_stage: input.required_by_stage.trim() || null,
    notes: input.notes.trim() || null,
  })
  if (error) throw error
}

export async function updateItpItem(
  id: string,
  input: NewItpItemInput,
): Promise<void> {
  const { error } = await supabase
    .from('itp_items')
    .update({
      activity_id: input.activity_id,
      stage: input.stage.trim(),
      description: input.description.trim(),
      acceptance_criteria: input.acceptance_criteria.trim() || null,
      inspection_type: input.inspection_type,
      reference_standard: input.reference_standard.trim() || null,
      required_by_stage: input.required_by_stage.trim() || null,
      notes: input.notes.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id')
    .single()

  if (error) throw error
}

export async function deleteItpItem(id: string): Promise<void> {
  const { error } = await supabase.rpc('fn_delete_itp_item', { p_id: id })
  if (error) throw error
}

/**
 * The supervisor's act. A real, timestamped request against their name — not a
 * sign-off, and not nothing either.
 */
export async function requestInspection(itemId: string): Promise<void> {
  const { error } = await supabase.rpc('fn_request_inspection', {
    p_item: itemId,
  })
  if (error) throw error
}

/**
 * Founder/PM only. Writes the inspection, moves the ITP status and raises an
 * NCR on a fail or conditional — one act, one transaction, so a failure can
 * never exist without its NCR.
 */
export async function recordInspection(
  itemId: string,
  result: InspectionResult,
  date: string | null,
  remarks: string,
  photos: string[],
  checks: CheckAnswer[] = [],
  location = '',
): Promise<void> {
  const { error } = await supabase.rpc('fn_record_inspection', {
    p_item: itemId,
    p_result: result,
    p_date: date,
    p_remarks: remarks || null,
    p_photos: photos,
    // The server derives the headline from these and overrules a contradictory
    // `result`, so what is sent here is the evidence, not a suggestion.
    p_checks: checks.map((c) => ({
      check_id: c.check_id,
      question: c.question,
      section: c.section,
      result: c.result,
      remark: c.remark || null,
      photos: c.photos,
    })),
    p_location: location || null,
  })
  if (error) throw error
}

export async function fetchInspections(
  itemId: string,
): Promise<InspectionRow[]> {
  const { data, error } = await supabase
    .from('inspections')
    .select(
      'id, itp_item_id, inspected_on, result, remarks, photos, location, inspector, ' +
        'created_at, profiles(full_name)',
    )
    .eq('itp_item_id', itemId)
    .order('inspected_on', { ascending: false })

  if (error) throw error

  return rows(data).map((r) => {
    const p = r.profiles as
      | { full_name: string }
      | { full_name: string }[]
      | null
    return {
      id: r.id as string,
      itp_item_id: r.itp_item_id as string,
      inspected_on: r.inspected_on as string,
      location: str(r.location),
      result: r.result as InspectionResult,
      remarks: str(r.remarks),
      photos: arr(r.photos),
      inspector: r.inspector as string,
      inspector_name:
        (Array.isArray(p) ? p[0]?.full_name : p?.full_name) ?? null,
      created_at: r.created_at as string,
    }
  })
}

/* ---------------- NCRs ---------------- */

const NCR_COLUMNS =
  'id, ncr_no, project_id, itp_item_id, inspection_id, area, description, ' +
  'severity, standard_ref, photos, status, assigned_to, corrective_action, ' +
  'corrected_at, closed_at, reject_reason, cancelled_at, cancel_reason, ' +
  'raised_by, created_at'

export async function fetchNcrs(projectId: string): Promise<NcrRow[]> {
  const { data, error } = await supabase
    .from('ncrs')
    .select(NCR_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(300)

  if (error) throw error

  return rows(data).map((r) => ({
    id: r.id as string,
    ncr_no: r.ncr_no as string,
    project_id: r.project_id as string,
    itp_item_id: str(r.itp_item_id),
    inspection_id: str(r.inspection_id),
    area: r.area as string,
    description: r.description as string,
    severity: r.severity as NcrSeverity,
    standard_ref: str(r.standard_ref),
    photos: arr(r.photos),
    status: r.status as NcrStatus,
    assigned_to: str(r.assigned_to),
    corrective_action: str(r.corrective_action),
    corrected_at: str(r.corrected_at),
    closed_at: str(r.closed_at),
    reject_reason: str(r.reject_reason),
    cancelled_at: str(r.cancelled_at),
    cancel_reason: str(r.cancel_reason),
    raised_by: r.raised_by as string,
    created_at: r.created_at as string,
  }))
}

export async function createNcr(
  projectId: string,
  input: NewNcrInput,
): Promise<void> {
  const { error } = await supabase.from('ncrs').insert({
    project_id: projectId,
    area: input.area.trim(),
    description: input.description.trim(),
    severity: input.severity,
    standard_ref: input.standard_ref.trim() || null,
    photos: input.photos,
    itp_item_id: input.itp_item_id,
    assigned_to: input.assigned_to,
  })
  if (error) throw error
}

/**
 * Every status move, including the supervisor's corrective action.
 *
 * The RPC decides who may do what: corrected is supervisor/PM/founder, closed
 * and rejected are founder/PM only. Nobody closes their own NCR.
 */
export async function setNcrStatus(
  id: string,
  status: NcrStatus,
  note?: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_ncr_status', {
    p_id: id,
    p_status: status,
    p_note: note ?? null,
  })
  if (error) throw error
}

/* ---------------- summary ---------------- */

export async function fetchQaSummary(
  projectId: string,
): Promise<QaSummary | null> {
  const { data, error } = await supabase.rpc('fn_qa_summary', {
    p_project: projectId,
  })
  if (error) return null

  const r = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!r) return null

  const n = (v: unknown) => Number(v ?? 0)

  return {
    open_ncrs: n(r.open_ncrs),
    ncr_minor: n(r.ncr_minor),
    ncr_major: n(r.ncr_major),
    ncr_critical: n(r.ncr_critical),
    corrected_ncrs: n(r.corrected_ncrs),
    closed_ncrs: n(r.closed_ncrs),
    itp_total: n(r.itp_total),
    itp_passed: n(r.itp_passed),
    itp_failed: n(r.itp_failed),
    holds_pending: n(r.holds_pending),
    holds_blocking: n(r.holds_blocking),
    inspections_done: n(r.inspections_done),
    // Null, not 0 — "0% pass rate" and "nothing inspected yet" are different
    // findings and only one of them is alarming.
    pass_rate: r.pass_rate === null || r.pass_rate === undefined
      ? null
      : Number(r.pass_rate),
  }
}
