import { supabase } from '@/lib/supabase'
import type {
  CalcConstant,
  CalcMix,
  CalcResult,
  EstimateKind,
  EstimateVsActual,
  MasonryUnit,
  SavedEstimate,
  SavedEstimateLine,
} from '@/lib/types'

/**
 * M13-A Material Quantity Calculator.
 *
 * NOTHING IS MULTIPLIED IN THIS FILE. Every figure comes back from an
 * `fn_calc_*` in migration 086, which also returns the working that is printed
 * under the result. A TypeScript copy of the arithmetic would be faster and
 * would be the copy nobody re-checks after somebody edits the dry-volume
 * factor — the 051 decision, unchanged.
 *
 * Every parameter here is metric. The metres/feet toggle is converted in the
 * form by `toMetres`, and feet never reach this file.
 */

const one = <T,>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : v

/** Postgres hands back a jsonb; this is the only place it is given a shape. */
function asResult(data: unknown): CalcResult {
  const r = (data ?? {}) as Record<string, unknown>
  return {
    ok: Boolean(r.ok),
    error: (r.error as string | undefined) ?? undefined,
    warning: (r.warning as string | null | undefined) ?? null,
    lines: ((r.lines as CalcResult['lines'] | undefined) ?? []).map((l) => ({
      item: String(l.item),
      qty: Number(l.qty),
      unit: String(l.unit),
      orderable: Boolean(l.orderable),
    })),
    detail: (r.detail as Record<string, unknown>) ?? {},
    working: (r.working as string | undefined) ?? '',
  }
}

/* ------------------------------------------------------------------ */
/* Reference data                                                     */
/* ------------------------------------------------------------------ */

export async function fetchCalcConstants(): Promise<CalcConstant[]> {
  const { data, error } = await supabase
    .from('calc_constants')
    .select('code, label, value, unit, ref, note, updated_at')
    .order('code')
  if (error) throw error
  return (data ?? []).map((r) => ({ ...r, value: Number(r.value) }) as CalcConstant)
}

export async function fetchMixes(): Promise<CalcMix[]> {
  const { data, error } = await supabase
    .from('calc_mixes')
    .select('code, kind, label, cement, sand, aggregate, is_nominal, note, sort')
    .order('sort')
  if (error) throw error
  return (data ?? []).map((r) => ({
    ...r,
    cement: Number(r.cement),
    sand: Number(r.sand),
    aggregate: Number(r.aggregate),
  }) as CalcMix)
}

export async function fetchMasonryUnits(): Promise<MasonryUnit[]> {
  const { data, error } = await supabase
    .from('masonry_units')
    .select('code, label, length_mm, height_mm, width_mm, default_joint_mm, is_active, note, sort')
    .eq('is_active', true)
    .order('sort')
  if (error) throw error
  return (data ?? []).map((r) => ({
    ...r,
    length_mm: Number(r.length_mm),
    height_mm: Number(r.height_mm),
    width_mm: Number(r.width_mm),
    default_joint_mm: r.default_joint_mm === null ? null : Number(r.default_joint_mm),
  }) as MasonryUnit)
}

/** Founder only — `calc_const_write` refuses everybody else. */
export async function setConstant(code: string, value: number): Promise<void> {
  const { error } = await supabase
    .from('calc_constants')
    .update({ value })
    .eq('code', code)
  if (error) throw error
}

export interface SelftestRow {
  case_no: number
  scenario: string
  measure: string
  expected: number
  computed: number
  diff: number
  passed: boolean
}

/**
 * Twelve worked examples re-derived through the same functions the screen uses.
 * Exposed on the Reference tab so that editing a constant is a safe thing to
 * do: change the dry factor and three cases go red immediately.
 */
export async function runSelftest(): Promise<SelftestRow[]> {
  const { data, error } = await supabase.rpc('fn_calc_selftest')
  if (error) throw error
  return ((data ?? []) as SelftestRow[]).map((r) => ({
    ...r,
    expected: Number(r.expected),
    computed: Number(r.computed),
    diff: Number(r.diff),
  }))
}

/* ------------------------------------------------------------------ */
/* The eight calculators                                              */
/* ------------------------------------------------------------------ */

export async function calcConcrete(a: {
  length_m: number
  width_m: number
  depth_m: number
  mix: string
  wastage_pct?: number | null
}): Promise<CalcResult> {
  const { data, error } = await supabase.rpc('fn_calc_concrete', {
    p_length_m: a.length_m,
    p_width_m: a.width_m,
    p_depth_m: a.depth_m,
    p_mix: a.mix,
    p_wastage_pct: a.wastage_pct ?? null,
  })
  if (error) throw error
  return asResult(data)
}

export async function calcMasonry(a: {
  area_sqm: number
  thickness_m: number
  unit_code: string
  mortar_mix: string
  joint_mm?: number | null
  wastage_pct?: number | null
}): Promise<CalcResult> {
  const { data, error } = await supabase.rpc('fn_calc_masonry', {
    p_area_sqm: a.area_sqm,
    p_thickness_m: a.thickness_m,
    p_unit_code: a.unit_code,
    p_mortar_mix: a.mortar_mix,
    p_joint_mm: a.joint_mm ?? null,
    p_wastage_pct: a.wastage_pct ?? null,
  })
  if (error) throw error
  return asResult(data)
}

export async function calcPlaster(a: {
  area_sqm: number
  thickness_mm: number
  mortar_mix: string
  wastage_pct?: number | null
}): Promise<CalcResult> {
  const { data, error } = await supabase.rpc('fn_calc_plaster', {
    p_area_sqm: a.area_sqm,
    p_thickness_mm: a.thickness_mm,
    p_mortar_mix: a.mortar_mix,
    p_wastage_pct: a.wastage_pct ?? null,
  })
  if (error) throw error
  return asResult(data)
}

export async function calcTiling(a: {
  area_sqm: number
  tile_l_mm: number
  tile_w_mm: number
  bed_mm: number
  joint_mm?: number | null
  wastage_pct?: number | null
}): Promise<CalcResult> {
  const { data, error } = await supabase.rpc('fn_calc_tiling', {
    p_area_sqm: a.area_sqm,
    p_tile_l_mm: a.tile_l_mm,
    p_tile_w_mm: a.tile_w_mm,
    p_bed_mm: a.bed_mm,
    p_joint_mm: a.joint_mm ?? null,
    p_wastage_pct: a.wastage_pct ?? null,
  })
  if (error) throw error
  return asResult(data)
}

export async function calcSteel(a: {
  dia_mm: number
  length_m: number
  qty: number
}): Promise<CalcResult> {
  const { data, error } = await supabase.rpc('fn_calc_steel', {
    p_dia_mm: a.dia_mm,
    p_length_m: a.length_m,
    p_qty: a.qty,
  })
  if (error) throw error
  return asResult(data)
}

export async function calcPaint(a: {
  area_sqm: number
  coats: number
  coverage_sqm_l?: number | null
  primer_coverage_sqm_l?: number | null
  with_primer: boolean
  wastage_pct?: number | null
}): Promise<CalcResult> {
  const { data, error } = await supabase.rpc('fn_calc_paint', {
    p_area_sqm: a.area_sqm,
    p_coats: a.coats,
    p_coverage_sqm_l: a.coverage_sqm_l ?? null,
    p_primer_coverage_sqm_l: a.primer_coverage_sqm_l ?? null,
    p_with_primer: a.with_primer,
    p_wastage_pct: a.wastage_pct ?? null,
  })
  if (error) throw error
  return asResult(data)
}

export async function calcWaterproofing(a: {
  area_sqm: number
  coats: number
  consumption_kg_sqm?: number | null
  wastage_pct?: number | null
}): Promise<CalcResult> {
  const { data, error } = await supabase.rpc('fn_calc_waterproofing', {
    p_area_sqm: a.area_sqm,
    p_coats: a.coats,
    p_consumption_kg_sqm: a.consumption_kg_sqm ?? null,
    p_wastage_pct: a.wastage_pct ?? null,
  })
  if (error) throw error
  return asResult(data)
}

export async function calcExcavation(a: {
  length_m: number
  width_m: number
  depth_m: number
  pits: number
  bulking_pct?: number | null
}): Promise<CalcResult> {
  const { data, error } = await supabase.rpc('fn_calc_excavation', {
    p_length_m: a.length_m,
    p_width_m: a.width_m,
    p_depth_m: a.depth_m,
    p_pits: a.pits,
    p_bulking_pct: a.bulking_pct ?? null,
  })
  if (error) throw error
  return asResult(data)
}

/* ------------------------------------------------------------------ */
/* Steel straight off the bar bending schedule                        */
/* ------------------------------------------------------------------ */

export interface BbsSteelRow {
  dia_mm: number
  total_bars: number
  total_weight_kg: number
  total_tonnes: number
}

/**
 * The BBS already knows the answer for a project that has one, so the steel
 * calculator offers it rather than asking somebody to re-type a schedule that
 * exists. Empty array is the normal case for a project with no BBS.
 */
export async function fetchBbsSteel(projectId: string): Promise<BbsSteelRow[]> {
  const { data, error } = await supabase
    .from('v_bbs_project_steel')
    .select('dia_mm, total_bars, total_weight_kg, total_tonnes')
    .eq('project_id', projectId)
    .order('dia_mm')
  if (error) throw error
  return (data ?? []).map((r) => ({
    dia_mm: Number(r.dia_mm),
    total_bars: Number(r.total_bars),
    total_weight_kg: Number(r.total_weight_kg),
    total_tonnes: Number(r.total_tonnes),
  }))
}

/* ------------------------------------------------------------------ */
/* Saved estimates                                                    */
/* ------------------------------------------------------------------ */

export async function fetchEstimates(projectId: string): Promise<SavedEstimate[]> {
  const { data, error } = await supabase
    .from('material_estimates')
    .select(
      'id, project_id, kind, title, work_area, inputs, working, notes, created_by, created_at, profiles(full_name), estimate_lines(id, material_id, item, qty, unit, is_orderable, sort)',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    kind: r.kind as EstimateKind,
    title: r.title as string,
    work_area: (r.work_area as string | null) ?? null,
    inputs: (r.inputs as Record<string, unknown>) ?? {},
    working: (r.working as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    created_by: r.created_by as string,
    created_by_name:
      one(r.profiles as { full_name: string } | { full_name: string }[] | null)
        ?.full_name ?? null,
    created_at: r.created_at as string,
    lines: ((r.estimate_lines ?? []) as Record<string, unknown>[])
      .slice()
      .sort((a, b) => Number(a.sort) - Number(b.sort))
      .map(
        (l): SavedEstimateLine => ({
          id: l.id as string,
          material_id: (l.material_id as string | null) ?? null,
          item: l.item as string,
          qty: Number(l.qty),
          unit: l.unit as string,
          is_orderable: Boolean(l.is_orderable),
        }),
      ),
  }))
}

/**
 * Saves the result AS COMPUTED — a frozen snapshot, not a stored set of inputs
 * to be re-run later. If somebody changes the dry-volume factor next year, what
 * was ordered this year must still read as it did. Same rule as the certified
 * bill (032).
 *
 * The inputs and the working are kept alongside so the estimate can still be
 * explained and checked by hand.
 */
export async function saveEstimate(input: {
  project_id: string
  kind: EstimateKind
  title: string
  work_area: string
  notes: string
  inputs: Record<string, unknown>
  working: string
  lines: { item: string; qty: number; unit: string; orderable: boolean }[]
  /** item label -> materials.id, for the lines somebody chose to map */
  materialByItem: Record<string, string | null>
}): Promise<string> {
  const { data, error } = await supabase
    .from('material_estimates')
    .insert({
      project_id: input.project_id,
      kind: input.kind,
      title: input.title,
      work_area: input.work_area || null,
      notes: input.notes || null,
      inputs: input.inputs,
      working: input.working,
    })
    .select('id')
    .single()
  if (error) throw error

  const id = data.id as string
  const rows = input.lines.map((l, i) => ({
    estimate_id: id,
    material_id: input.materialByItem[l.item] ?? null,
    item: l.item,
    qty: l.qty,
    unit: l.unit,
    is_orderable: l.orderable,
    sort: (i + 1) * 10,
  }))

  const { error: lineErr } = await supabase.from('estimate_lines').insert(rows)
  if (lineErr) {
    // The header without its lines is a record of nothing. Roll it back by hand
    // — there is no transaction across two PostgREST calls, and a half-saved
    // estimate is worse than a failed one.
    await supabase.from('material_estimates').delete().eq('id', id)
    throw lineErr
  }
  return id
}

export async function deleteEstimate(id: string): Promise<void> {
  const { error } = await supabase.from('material_estimates').delete().eq('id', id)
  if (error) throw error
}

/** Empty array means nothing has been estimated for this project yet (073). */
export async function fetchEstimateVsActual(
  projectId: string,
): Promise<EstimateVsActual[]> {
  const { data, error } = await supabase.rpc('fn_estimate_vs_actual', {
    p_project: projectId,
  })
  if (error) throw error
  return ((data ?? []) as EstimateVsActual[]).map((r) => ({
    ...r,
    estimated: Number(r.estimated),
    received: Number(r.received),
    issued: Number(r.issued),
    variance: Number(r.variance),
  }))
}

/** For mapping a calculated line onto something the store actually tracks. */
export async function fetchMaterialOptions(): Promise<
  { id: string; name: string; unit: string }[]
> {
  const { data, error } = await supabase
    .from('materials')
    .select('id, name, unit')
    .eq('is_active', true)
    .order('name')
  if (error) throw error
  return (data ?? []) as { id: string; name: string; unit: string }[]
}
