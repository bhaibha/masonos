import { supabase } from '@/lib/supabase'
import type {
  InvoiceLineInput,
  MatchRow,
  NewPurchaseOrder,
  PoInvoiceRow,
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
      'id, po_number, project_id, vendor_id, vendor_name, status, need_by, notes, raised_by, approved_by, created_at, cancelled_at, cancelled_by, cancel_reason, vendors(name)',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw error

  const pos = (data ?? []).map((r) => {
    const row = r as Record<string, unknown>
    const v = row.vendors as { name: string } | { name: string }[] | null
    const registered = (Array.isArray(v) ? v[0]?.name : v?.name) ?? null
    const vendorId = (row.vendor_id as string | null) ?? null
    return {
      id: row.id as string,
      po_number: row.po_number as string,
      project_id: row.project_id as string,
      vendor_id: vendorId,
      status: row.status as PurchaseOrder['status'],
      need_by: (row.need_by as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      raised_by: row.raised_by as string,
      approved_by: (row.approved_by as string | null) ?? null,
      created_at: row.created_at as string,
      vendor_display: vendorId
        ? registered
        : ((row.vendor_name as string | null) ?? null),
      vendor_registered: vendorId !== null,
      line_count: 0,
      ordered_value: null as number | null,
      cancelled_at: (row.cancelled_at as string | null) ?? null,
      cancelled_by: (row.cancelled_by as string | null) ?? null,
      cancel_reason: (row.cancel_reason as string | null) ?? null,
    }
  })

  if (pos.length === 0) return pos

  const ids = pos.map((p) => p.id)

  // Counts are visible to everyone (v_po_totals reads only granted columns).
  const { data: totals } = await supabase
    .from('v_po_totals')
    .select('po_id, line_count')
    .in('po_id', ids)

  const countById = new Map(
    (totals ?? []).map((t) => [t.po_id as string, Number(t.line_count)]),
  )
  for (const p of pos) p.line_count = countById.get(p.id) ?? 0

  // Ordered value comes from the role-gated v_po_value (migration 013) — only
  // for money-roles. Supervisors keep ordered_value null.
  if (withValues) {
    const { data: values } = await supabase
      .from('v_po_value')
      .select('po_id, ordered_value')
      .in('po_id', ids)

    const valueById = new Map(
      (values ?? []).map((v) => [v.po_id as string, Number(v.ordered_value)]),
    )
    for (const p of pos) p.ordered_value = valueById.get(p.id) ?? null
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
      vendor_name: input.vendor_name || null,
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
 * Approve a request into a PO: assign the vendor, set each line's rate, then
 * flip status. Vendor and rates are decided together here because a
 * supervisor-raised request carries neither (they can't see vendors or rates).
 * line_total is a generated column — the browser never computes it.
 */
export async function approvePurchaseOrder(
  poId: string,
  vendor: { vendorId: string | null; vendorName: string },
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
      vendor_id: vendor.vendorId,
      vendor_name: vendor.vendorName || null,
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

// ---------- Part 2: receiving, invoicing, 3-way match ----------

/** qty already received per po_line, summed from grn_lines (members can read). */
export async function fetchReceivedByLine(
  lineIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (lineIds.length === 0) return out

  const { data, error } = await supabase
    .from('grn_lines')
    .select('po_line_id, qty_received')
    .in('po_line_id', lineIds)

  if (error) throw error
  for (const r of data ?? []) {
    const id = r.po_line_id as string
    out.set(id, (out.get(id) ?? 0) + Number(r.qty_received))
  }
  return out
}

/**
 * Records a goods receipt via fn_receive_goods (migration 015). The function
 * inserts the GRN + lines (which posts to stock through a trigger) and flips
 * the PO status, all with the receiver's membership + role checked server-side.
 * Returns the new GRN id.
 */
export async function receiveGoods(
  poId: string,
  date: string,
  note: string,
  lines: { po_line_id: string; qty: number }[],
): Promise<string> {
  const { data, error } = await supabase.rpc('fn_receive_goods', {
    p_po: poId,
    p_date: date,
    p_note: note || null,
    p_lines: lines,
  })
  if (error) throw error
  return data as string
}

/** 3-way match rows for a PO from v_po_match (money-roles only). */
export async function fetchMatch(poId: string): Promise<MatchRow[]> {
  const { data, error } = await supabase
    .from('v_po_match')
    .select(
      'po_line_id, po_id, material_id, qty_ordered, rate_ordered, qty_received, qty_invoiced, rate_invoiced, match_status',
    )
    .eq('po_id', poId)

  if (error) throw error

  const rows = (data ?? []).map((r) => r as Record<string, unknown>)
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
    po_line_id: r.po_line_id as string,
    po_id: r.po_id as string,
    material_id: r.material_id as string,
    qty_ordered: Number(r.qty_ordered),
    rate_ordered: r.rate_ordered === null ? null : Number(r.rate_ordered),
    qty_received: Number(r.qty_received),
    qty_invoiced: Number(r.qty_invoiced),
    rate_invoiced: r.rate_invoiced === null ? null : Number(r.rate_invoiced),
    match_status: r.match_status as MatchRow['match_status'],
    material_name: names.get(r.material_id as string)?.name,
    material_unit: names.get(r.material_id as string)?.unit,
  }))
}

export async function fetchInvoices(poId: string): Promise<PoInvoiceRow[]> {
  const { data, error } = await supabase
    .from('po_invoices')
    .select(
      'id, invoice_no, invoice_date, gst_amount, approved, voided_at, voided_by, void_reason',
    )
    .eq('po_id', poId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    invoice_no: (r.invoice_no as string | null) ?? null,
    invoice_date: r.invoice_date as string,
    gst_amount: Number(r.gst_amount),
    approved: Boolean(r.approved),
    voided_at: (r.voided_at as string | null) ?? null,
    voided_by: (r.voided_by as string | null) ?? null,
    void_reason: (r.void_reason as string | null) ?? null,
  }))
}

/** Records a vendor invoice + its lines. Returns the invoice id. */
export async function createInvoice(
  poId: string,
  header: { invoice_no: string; invoice_date: string; gst_amount: number },
  lines: InvoiceLineInput[],
): Promise<string> {
  const { data: inv, error } = await supabase
    .from('po_invoices')
    .insert({
      po_id: poId,
      invoice_no: header.invoice_no || null,
      invoice_date: header.invoice_date,
      gst_amount: header.gst_amount,
    })
    .select('id')
    .single()

  if (error) throw error
  const invoiceId = inv.id as string

  const payload = lines
    .filter((l) => l.qty_invoiced > 0)
    .map((l) => ({
      invoice_id: invoiceId,
      po_line_id: l.po_line_id,
      qty_invoiced: l.qty_invoiced,
      rate_invoiced: l.rate_invoiced,
    }))

  const { error: lineErr } = await supabase.from('invoice_lines').insert(payload)
  if (lineErr) throw lineErr
  return invoiceId
}

/** Posts a matched invoice to Open Book via fn_post_invoice (founder/accounts). */
export async function postInvoice(invoiceId: string): Promise<void> {
  const { error } = await supabase.rpc('fn_post_invoice', {
    p_invoice: invoiceId,
  })
  if (error) throw error
}
