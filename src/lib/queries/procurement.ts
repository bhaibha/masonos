import { supabase } from '@/lib/supabase'
import type {
  NewPurchaseOrder,
  PoLine,
  PurchaseOrder,
} from '@/lib/types'

/**
 * Purchase orders for a project, newest first, with vendor name and totals.
 * `ordered_value` comes from v_po_totals which is security_invoker — but the
 * value is derived from po_lines.rate, so supervisors (rate revoked) see the
 * totals view return 0. We surface null for them instead by checking role at
 * the call site via `withValues`.
 */
export async function fetchPurchaseOrders(
  projectId: string,
  withValues: boolean,
): Promise<PurchaseOrder[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select(
      'id, po_number, project_id, vendor_id, status, need_by, notes, raised_by, approved_by, created_at, vendors(name)',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw error

  const pos = (data ?? []).map((r) => {
    const row = r as Record<string, unknown>
    const v = row.vendors as { name: string } | { name: string }[] | null
    return {
      id: row.id as string,
      po_number: row.po_number as string,
      project_id: row.project_id as string,
      vendor_id: (row.vendor_id as string | null) ?? null,
      status: row.status as PurchaseOrder['status'],
      need_by: (row.need_by as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      raised_by: row.raised_by as string,
      approved_by: (row.approved_by as string | null) ?? null,
      created_at: row.created_at as string,
      vendor_name: (Array.isArray(v) ? v[0]?.name : v?.name) ?? null,
      line_count: 0,
      ordered_value: null as number | null,
    }
  })

  if (pos.length === 0) return pos

  // Line counts (and values, if permitted) from v_po_totals.
  const ids = pos.map((p) => p.id)
  const { data: totals } = await supabase
    .from('v_po_totals')
    .select('po_id, line_count, ordered_value')
    .in('po_id', ids)

  const byId = new Map(
    (totals ?? []).map((t) => [t.po_id as string, t as Record<string, unknown>]),
  )
  for (const p of pos) {
    const t = byId.get(p.id)
    p.line_count = t ? Number(t.line_count) : 0
    p.ordered_value = withValues && t ? Number(t.ordered_value) : null
  }

  return pos
}

/** Lines for one PO. Rated view for money-roles, qty-only otherwise. */
export async function fetchPoLines(
  poId: string,
  withRates: boolean,
): Promise<PoLine[]> {
  const source = withRates ? 'v_po_lines_rated' : 'po_lines'
  const cols = withRates
    ? 'id, po_id, material_id, qty_ordered, rate, line_total'
    : 'id, po_id, material_id, qty_ordered'

  const { data, error } = await supabase
    .from(source)
    .select(cols)
    .eq('po_id', poId)

  if (error) throw error

  // Resolve material names/units for display. Cast via unknown: the column
  // list is built dynamically, so PostgREST's typed parser can't narrow it.
  const rows = ((data ?? []) as unknown[]).map((r) => r as Record<string, unknown>)
  const matIds = [...new Set(rows.map((r) => r.material_id as string))]
  const names = new Map<string, { name: string; unit: string }>()
  if (matIds.length > 0) {
    const { data: mats } = await supabase
      .from('materials')
      .select('id, name, unit')
      .in('id', matIds)
    for (const m of mats ?? [])
      names.set(m.id as string, { name: m.name as string, unit: m.unit as string })
  }

  return rows.map((r) => ({
    id: r.id as string,
    po_id: r.po_id as string,
    material_id: r.material_id as string,
    qty_ordered: Number(r.qty_ordered),
    rate: r.rate === undefined || r.rate === null ? null : Number(r.rate),
    line_total:
      r.line_total === undefined || r.line_total === null
        ? null
        : Number(r.line_total),
    material_name: names.get(r.material_id as string)?.name,
    material_unit: names.get(r.material_id as string)?.unit,
  }))
}

/** Raise a purchase request (status starts at 'requested', quantities only). */
export async function createPurchaseOrder(
  input: NewPurchaseOrder,
): Promise<void> {
  const { data: po, error } = await supabase
    .from('purchase_orders')
    .insert({
      project_id: input.project_id,
      vendor_id: input.vendor_id,
      need_by: input.need_by,
      notes: input.notes || null,
    })
    .select('id')
    .single()

  if (error) throw error

  const lines = input.lines.map((l) => ({
    po_id: po.id as string,
    material_id: l.material_id,
    qty_ordered: l.qty_ordered,
  }))
  const { error: lineErr } = await supabase.from('po_lines').insert(lines)
  if (lineErr) throw lineErr
}

/**
 * Approve a request into a PO: set each line's rate, then flip status.
 * Rates are money — written straight to po_lines (the browser never computes
 * line_total, which is a generated column).
 */
export async function approvePurchaseOrder(
  poId: string,
  rates: { lineId: string; rate: number }[],
): Promise<void> {
  for (const r of rates) {
    const { error } = await supabase
      .from('po_lines')
      .update({ rate: r.rate })
      .eq('id', r.lineId)
    if (error) throw error
  }

  const { error } = await supabase
    .from('purchase_orders')
    .update({
      status: 'approved',
      approved_by: (await supabase.auth.getUser()).data.user?.id ?? null,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', poId)
  if (error) throw error
}

export async function setPoStatus(
  poId: string,
  status: PurchaseOrder['status'],
): Promise<void> {
  const { error } = await supabase
    .from('purchase_orders')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', poId)
  if (error) throw error
}
