import { supabase } from '@/lib/supabase'
import type {
  Material,
  NewInward,
  NewIssue,
  NewMaterial,
  StockRow,
} from '@/lib/types'

/** Material master is global, not per project. RLS mat_read: everyone. */
export async function fetchMaterials(
  includeInactive = false,
): Promise<Material[]> {
  let q = supabase
    .from('materials')
    .select('id, name, unit, category_id, low_stock_level, is_active')
    .order('name')

  if (!includeInactive) q = q.eq('is_active', true)

  const { data, error } = await q
  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    unit: r.unit as string,
    category_id: r.category_id === null ? null : Number(r.category_id),
    low_stock_level: Number(r.low_stock_level ?? 0),
    is_active: Boolean(r.is_active),
  }))
}

export async function createMaterial(input: NewMaterial): Promise<void> {
  const { error } = await supabase.from('materials').insert({
    name: input.name,
    unit: input.unit,
    category_id: input.category_id,
    low_stock_level: input.low_stock_level,
  })
  if (error) throw error
}

/**
 * Live stock for one project from public.v_stock. Quantities are aggregated in
 * Postgres — the browser only formats them.
 *
 * Note: v_stock inner-joins its lateral movement subquery, so a material with
 * no inward and no issues yet produces no row at all. The register therefore
 * lists materials that have moved, not the whole master.
 */
export async function fetchStock(projectId: string): Promise<StockRow[]> {
  const { data, error } = await supabase
    .from('v_stock')
    .select(
      'material_id, name, unit, low_stock_level, project_id, total_in, total_out, in_stock, low_stock',
    )
    .eq('project_id', projectId)
    .order('name')

  if (error) throw error

  return (data ?? []).map((r) => ({
    material_id: r.material_id as string,
    name: r.name as string,
    unit: r.unit as string,
    low_stock_level: Number(r.low_stock_level ?? 0),
    project_id: r.project_id as string,
    total_in: Number(r.total_in),
    total_out: Number(r.total_out),
    in_stock: Number(r.in_stock),
    low_stock: Boolean(r.low_stock),
  }))
}

export async function createInward(input: NewInward): Promise<void> {
  const { error } = await supabase.from('material_inward').insert({
    project_id: input.project_id,
    material_id: input.material_id,
    inward_date: input.inward_date,
    qty: input.qty,
    vendor_id: input.vendor_id,
    vendor_name: input.vendor_name || null,
    challan_no: input.challan_no || null,
    rate: input.rate,
    challan_photo: input.challan_photo,
    remarks: input.remarks || null,
  })
  if (error) throw error
}

/** Thrown when fn_check_stock rejects an issue. */
export class InsufficientStockError extends Error {
  // Plain fields, not constructor parameter properties — tsconfig has
  // erasableSyntaxOnly, which rejects the shorthand form.
  available: number
  requested: number

  constructor(available: number, requested: number) {
    super(`Insufficient stock: available ${available}, requested ${requested}`)
    this.name = 'InsufficientStockError'
    this.available = available
    this.requested = requested
  }
}

/**
 * The check_stock trigger (003_materials_docs.sql) raises
 * `Insufficient stock: available X, requested Y` before insert. Parse it back
 * into numbers so the UI can phrase it properly instead of dumping a Postgres
 * exception on screen.
 */
export async function createIssue(input: NewIssue): Promise<void> {
  const { error } = await supabase.from('material_issues').insert({
    project_id: input.project_id,
    material_id: input.material_id,
    issue_date: input.issue_date,
    qty: input.qty,
    work_area: input.work_area,
    issued_to: input.issued_to || null,
    remarks: input.remarks || null,
  })

  if (!error) return

  const match = /Insufficient stock: available ([\d.]+), requested ([\d.]+)/i.exec(
    error.message ?? '',
  )
  if (match) {
    throw new InsufficientStockError(Number(match[1]), Number(match[2]))
  }
  throw error
}
