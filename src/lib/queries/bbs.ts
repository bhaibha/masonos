import { supabase } from '@/lib/supabase'
import type {
  BbsBar,
  BbsCalloutLine,
  BbsConstant,
  BbsGeometry,
  BbsMarkAudit,
  BbsMember,
  BbsMemberType,
  BbsShape,
  BbsSteelByDia,
  BbsTestCase,
  NewBbsBar,
  NewBbsMember,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const n = (v: unknown) => Number(v ?? 0)

/* ---------------- reference data ---------------- */

/**
 * The IS-2502 constants. Read by everyone — the working printed beside each
 * cutting length cites them, and a figure whose basis you cannot look up is a
 * figure you have to take on trust.
 */
export async function fetchConstants(): Promise<BbsConstant[]> {
  const { data, error } = await supabase
    .from('bbs_constants')
    .select('code, label, value, unit, is_ref, note, updated_at')
    .order('code')

  if (error) throw error
  return rows(data).map((r) => ({
    code: r.code as string,
    label: r.label as string,
    value: n(r.value),
    unit: r.unit as string,
    is_ref: str(r.is_ref),
    note: str(r.note),
    updated_at: r.updated_at as string,
  }))
}

/** Founder only, at RLS. Every schedule in the database is restated by this. */
export async function setConstant(code: string, value: number): Promise<void> {
  const { error } = await supabase
    .from('bbs_constants')
    .update({ value })
    .eq('code', code)
  if (error) throw error
}

export async function fetchShapes(): Promise<BbsShape[]> {
  const { data, error } = await supabase
    .from('bbs_shapes')
    .select(
      'code, name, formula_kind, label_a, label_b, label_c, label_d, formula, sort_order',
    )
    .eq('is_active', true)
    .order('sort_order')

  if (error) throw error
  return rows(data).map((r) => ({
    code: r.code as string,
    name: r.name as string,
    formula_kind: r.formula_kind as BbsShape['formula_kind'],
    label_a: str(r.label_a),
    label_b: str(r.label_b),
    label_c: str(r.label_c),
    label_d: str(r.label_d),
    formula: r.formula as string,
    sort_order: n(r.sort_order),
  }))
}

/**
 * The eight worked examples with known IS-2502 answers, run inside Postgres by
 * the same function the schedule uses.
 *
 * This is not decoration. Editing a constant silently restates every cutting
 * length in the database, so the module ships with a way to prove itself on
 * demand — and the screen shows the result rather than asking anyone to
 * take it on trust.
 */
export async function runSelfTest(): Promise<BbsTestCase[]> {
  const { data, error } = await supabase.rpc('fn_bbs_selftest')
  if (error) throw error
  return rows(data).map((r) => ({
    case_no: n(r.case_no),
    case_name: r.case_name as string,
    hand_working: r.hand_working as string,
    expected_mm: n(r.expected_mm),
    computed_mm: n(r.computed_mm),
    diff_mm: n(r.diff_mm),
    passed: Boolean(r.passed),
  }))
}

/**
 * Cutting length for dimensions not yet saved, so the form can show the answer
 * AND its working while somebody types.
 *
 * Deliberately a server round trip rather than the same formula reimplemented
 * in TypeScript. Two implementations of a safety-critical calculation is one
 * more than can ever be kept in step, and the browser copy would be the one
 * nobody re-checked after a constant changed.
 */
export async function previewCuttingLength(input: {
  shape: string
  dia: number
  a: number
  b: number
  c: number
  d: number
  cranks: number
}): Promise<{
  cutting_length_mm: number
  working: string
  warning: string | null
  error: string | null
} | null> {
  const { data, error } = await supabase.rpc('fn_bbs_cutting_length', {
    p_shape: input.shape,
    p_dia: input.dia,
    p_a: input.a,
    p_b: input.b,
    p_c: input.c,
    p_d: input.d,
    p_cranks: input.cranks,
  })
  if (error) throw error
  const r = data as Record<string, unknown> | null
  if (!r) return null
  return {
    cutting_length_mm: n(r.cutting_length_mm),
    working: (str(r.working) ?? '') as string,
    warning: str(r.warning),
    error: str(r.error),
  }
}

/* ---------------- members ---------------- */

export async function fetchMembers(projectId: string): Promise<BbsMember[]> {
  const { data, error } = await supabase
    .from('v_bbs_member_totals')
    .select(
      'member_id, project_id, member_type, mark, description, level, ' +
        'drawing_ref, member_count, bar_marks, total_bars, total_length_m, ' +
        'total_weight_kg, warnings, created_at',
    )
    .eq('project_id', projectId)
    .order('member_type')
    .order('mark')

  if (error) throw error
  return rows(data).map((r) => ({
    member_id: r.member_id as string,
    project_id: r.project_id as string,
    member_type: r.member_type as BbsMemberType,
    mark: r.mark as string,
    description: str(r.description),
    level: str(r.level),
    drawing_ref: str(r.drawing_ref),
    member_count: n(r.member_count),
    bar_marks: n(r.bar_marks),
    total_bars: n(r.total_bars),
    total_length_m: n(r.total_length_m),
    total_weight_kg: n(r.total_weight_kg),
    warnings: n(r.warnings),
    created_at: r.created_at as string,
  }))
}

export async function createMember(input: NewBbsMember): Promise<string> {
  const { data, error } = await supabase
    .from('bbs_members')
    .insert({
      project_id: input.project_id,
      member_type: input.member_type,
      mark: input.mark.trim(),
      description: input.description.trim() || null,
      level: input.level.trim() || null,
      drawing_ref: input.drawing_ref.trim() || null,
      member_count: input.member_count,
      notes: input.notes.trim() || null,
      length_mm: input.length_mm,
      width_mm: input.width_mm,
      depth_mm: input.depth_mm,
      cover_mm: input.cover_mm,
      anchorage_mm: input.anchorage_mm,
      is_circular: input.is_circular,
      diameter_mm: input.diameter_mm,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Ordinary DELETE, not fn_delete_record: a schedule line is a statement about
 * a drawing, not a record of something that happened. Bars cascade — they have
 * no meaning without their member.
 */
export async function deleteMember(id: string): Promise<void> {
  const { error } = await supabase.from('bbs_members').delete().eq('id', id)
  if (error) throw error
}

/* ---------------- bars ---------------- */

export async function fetchBars(memberId: string): Promise<BbsBar[]> {
  const { data, error } = await supabase
    .from('v_bbs_bars')
    .select(
      'bar_id, member_id, bar_mark, dia_mm, shape_code, shape_name, ' +
        'a_mm, b_mm, c_mm, d_mm, n_cranks, qty_per_member, total_qty, ' +
        'cutting_length_mm, cutting_length_m, total_length_m, ' +
        'unit_weight_kg_m, total_weight_kg, working, warning, remarks, sort_order',
    )
    .eq('member_id', memberId)
    .order('sort_order')

  if (error) throw error
  return rows(data).map(toBar)
}

/** Every bar on the project, for the printable schedule. */
export async function fetchProjectBars(projectId: string): Promise<BbsBar[]> {
  const { data, error } = await supabase
    .from('v_bbs_bars')
    .select(
      'bar_id, member_id, bar_mark, dia_mm, shape_code, shape_name, ' +
        'a_mm, b_mm, c_mm, d_mm, n_cranks, qty_per_member, total_qty, ' +
        'cutting_length_mm, cutting_length_m, total_length_m, ' +
        'unit_weight_kg_m, total_weight_kg, working, warning, remarks, sort_order',
    )
    .eq('project_id', projectId)
    .order('member_type')
    .order('member_mark')
    .order('sort_order')
    .limit(2000)

  if (error) throw error
  return rows(data).map(toBar)
}

function toBar(r: Record<string, unknown>): BbsBar {
  return {
    bar_id: r.bar_id as string,
    member_id: r.member_id as string,
    bar_mark: r.bar_mark as string,
    dia_mm: n(r.dia_mm),
    shape_code: r.shape_code as string,
    shape_name: r.shape_name as string,
    a_mm: n(r.a_mm),
    b_mm: n(r.b_mm),
    c_mm: n(r.c_mm),
    d_mm: n(r.d_mm),
    n_cranks: n(r.n_cranks),
    qty_per_member: n(r.qty_per_member),
    total_qty: n(r.total_qty),
    cutting_length_mm: n(r.cutting_length_mm),
    cutting_length_m: n(r.cutting_length_m),
    total_length_m: n(r.total_length_m),
    unit_weight_kg_m: n(r.unit_weight_kg_m),
    total_weight_kg: n(r.total_weight_kg),
    working: str(r.working),
    warning: str(r.warning),
    remarks: str(r.remarks),
    sort_order: n(r.sort_order),
  }
}

export async function addBar(input: NewBbsBar): Promise<void> {
  const { error } = await supabase.from('bbs_bars').insert({
    member_id: input.member_id,
    bar_mark: input.bar_mark.trim(),
    dia_mm: input.dia_mm,
    shape_code: input.shape_code,
    a_mm: input.a_mm,
    b_mm: input.b_mm,
    c_mm: input.c_mm,
    d_mm: input.d_mm,
    n_cranks: input.n_cranks,
    qty_per_member: input.qty_per_member,
    remarks: input.remarks.trim() || null,
    sort_order: input.sort_order,
  })
  if (error) throw error
}

export async function deleteBar(id: string): Promise<void> {
  const { error } = await supabase.from('bbs_bars').delete().eq('id', id)
  if (error) throw error
}

/* ---------------- roll-up ---------------- */

/**
 * Steel by diameter for the whole project — the figure that turns into an
 * order. Summed in Postgres, never in the browser.
 */
export async function fetchSteelByDia(
  projectId: string,
): Promise<BbsSteelByDia[]> {
  const { data, error } = await supabase
    .from('v_bbs_project_steel')
    .select(
      'dia_mm, bar_marks, total_bars, total_length_m, unit_weight_kg_m, ' +
        'total_weight_kg, total_tonnes, pieces_required',
    )
    .eq('project_id', projectId)
    .order('dia_mm')

  if (error) throw error
  return rows(data).map((r) => ({
    dia_mm: n(r.dia_mm),
    bar_marks: n(r.bar_marks),
    total_bars: n(r.total_bars),
    total_length_m: n(r.total_length_m),
    unit_weight_kg_m: n(r.unit_weight_kg_m),
    total_weight_kg: n(r.total_weight_kg),
    total_tonnes: n(r.total_tonnes),
    pieces_required: n(r.pieces_required),
  }))
}

/**
 * The last bar mark and any numbers skipped — the two boxes at the head of the
 * firm's sheet. A gap in the sequence is usually a bar somebody deleted and
 * forgot to re-issue, so it is computed rather than typed.
 */
export async function fetchMarkAudit(
  projectId: string,
): Promise<BbsMarkAudit | null> {
  const { data, error } = await supabase.rpc('fn_bbs_mark_audit', {
    p_project: projectId,
  })
  if (error) return null
  const r = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return {
    numeric_marks: n(r.numeric_marks),
    total_marks: n(r.total_marks),
    last_mark: str(r.last_mark),
    omitted: str(r.omitted),
  }
}

/* ---------------- callout expansion (migration 052) ---------------- */

/** The member's geometry and its stored callout text. */
export async function fetchGeometry(
  memberId: string,
): Promise<BbsGeometry | null> {
  const { data, error } = await supabase
    .from('bbs_members')
    .select(
      'length_mm, width_mm, depth_mm, cover_mm, anchorage_mm, is_circular, diameter_mm, callout_text',
    )
    .eq('id', memberId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null
  const r = data as unknown as Record<string, unknown>
  const opt = (v: unknown) =>
    v === null || v === undefined ? null : Number(v)
  return {
    length_mm: opt(r.length_mm),
    width_mm: opt(r.width_mm),
    depth_mm: opt(r.depth_mm),
    cover_mm: opt(r.cover_mm),
    anchorage_mm: opt(r.anchorage_mm),
    is_circular: Boolean(r.is_circular),
    diameter_mm: opt(r.diameter_mm),
    callout_text: str(r.callout_text),
  }
}

export async function saveGeometry(
  memberId: string,
  g: Omit<BbsGeometry, 'callout_text'>,
): Promise<void> {
  const { error } = await supabase
    .from('bbs_members')
    .update({
      length_mm: g.length_mm,
      width_mm: g.width_mm,
      depth_mm: g.depth_mm,
      cover_mm: g.cover_mm,
      anchorage_mm: g.anchorage_mm,
      is_circular: g.is_circular,
      diameter_mm: g.diameter_mm,
    })
    .eq('id', memberId)
  if (error) throw error
}

/**
 * What the callouts WOULD produce — no writes.
 *
 * The same parser the apply uses, so the preview cannot promise bars the apply
 * would not create. Lines it cannot read come back with ok = false and a
 * reason; they are shown, not silently dropped.
 */
export async function previewCallouts(
  memberId: string,
  text: string,
): Promise<BbsCalloutLine[]> {
  const { data, error } = await supabase.rpc('fn_bbs_preview_callouts', {
    p_member: memberId,
    p_text: text,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    line_no: n(r.line_no),
    source_line: r.source_line as string,
    ok: Boolean(r.ok),
    problem: str(r.problem),
    bar_mark: r.bar_mark as string,
    dia_mm: r.dia_mm === null ? null : n(r.dia_mm),
    shape_code: r.shape_code as string,
    a_mm: n(r.a_mm),
    b_mm: n(r.b_mm),
    n_cranks: n(r.n_cranks),
    qty: r.qty === null ? null : n(r.qty),
    remarks: str(r.remarks),
    cutting_length_mm:
      r.cutting_length_mm === null ? null : n(r.cutting_length_mm),
    working: str(r.working),
    warning: str(r.warning),
  }))
}

/**
 * Writes the bar marks. All or nothing: one unreadable line refuses the whole
 * expansion, because a schedule missing a callout is short of steel with
 * nothing on screen to say which.
 *
 * Replaces only bars a previous expansion generated — anything added by hand
 * at a support survives.
 */
export async function applyCallouts(
  memberId: string,
  text: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('fn_bbs_apply_callouts', {
    p_member: memberId,
    p_text: text,
  })
  if (error) throw error
  return Number(data ?? 0)
}
