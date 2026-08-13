import { supabase } from '@/lib/supabase'
import type {
  ComparisonCell,
  ComparisonItem,
  ComparisonSummary,
  ComparisonVendor,
  ComparisonVendorTotal,
  NewComparison,
  RcStatus,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

/* ---------------- list ---------------- */

/**
 * Comparisons for a project, newest first, straight off v_rc_summary.
 *
 * Every count and total on the card is computed in Postgres — the item count,
 * the cheapest complete quote, the awarded value, and how many lines went to
 * somebody other than the lowest. The browser only formats them.
 *
 * A supervisor never reaches this: RLS on rate_comparisons matches no
 * supervisor, so the query returns an empty array rather than a blanked one.
 */
export async function fetchComparisons(
  projectId: string,
): Promise<ComparisonSummary[]> {
  const { data, error } = await supabase
    .from('v_rc_summary')
    .select(
      'comparison_id, project_id, comparison_no, title, status, need_by, ' +
        'source_po_id, created_at, item_count, vendor_count, items_awarded, ' +
        'lowest_total, highest_total, awarded_subtotal, awarded_off_lowest',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw error

  return rows(data).map((r) => ({
    comparison_id: r.comparison_id as string,
    project_id: r.project_id as string,
    comparison_no: r.comparison_no as string,
    title: r.title as string,
    status: r.status as RcStatus,
    need_by: str(r.need_by),
    source_po_id: str(r.source_po_id),
    created_at: r.created_at as string,
    item_count: Number(r.item_count ?? 0),
    vendor_count: Number(r.vendor_count ?? 0),
    items_awarded: Number(r.items_awarded ?? 0),
    lowest_total: num(r.lowest_total),
    highest_total: num(r.highest_total),
    awarded_subtotal: Number(r.awarded_subtotal ?? 0),
    awarded_off_lowest: Number(r.awarded_off_lowest ?? 0),
  }))
}

export async function fetchComparison(
  id: string,
): Promise<ComparisonSummary | null> {
  const { data, error } = await supabase
    .from('v_rc_summary')
    .select(
      'comparison_id, project_id, comparison_no, title, status, need_by, ' +
        'source_po_id, created_at, item_count, vendor_count, items_awarded, ' +
        'lowest_total, highest_total, awarded_subtotal, awarded_off_lowest',
    )
    .eq('comparison_id', id)
    .maybeSingle()

  if (error) throw error
  if (!data) return null
  // Cast via unknown: the column list is a built string, so PostgREST's typed
  // parser can't narrow it and infers its error shape instead.
  const r = data as unknown as Record<string, unknown>
  return {
    comparison_id: r.comparison_id as string,
    project_id: r.project_id as string,
    comparison_no: r.comparison_no as string,
    title: r.title as string,
    status: r.status as RcStatus,
    need_by: str(r.need_by),
    source_po_id: str(r.source_po_id),
    created_at: r.created_at as string,
    item_count: Number(r.item_count ?? 0),
    vendor_count: Number(r.vendor_count ?? 0),
    items_awarded: Number(r.items_awarded ?? 0),
    lowest_total: num(r.lowest_total),
    highest_total: num(r.highest_total),
    awarded_subtotal: Number(r.awarded_subtotal ?? 0),
    awarded_off_lowest: Number(r.awarded_off_lowest ?? 0),
  }
}

/* ---------------- the grid ---------------- */

export interface ComparisonGrid {
  items: ComparisonItem[]
  vendors: ComparisonVendor[]
  cells: ComparisonCell[]
  totals: ComparisonVendorTotal[]
}

/**
 * The whole comparative statement in one round trip.
 *
 * `v_rc_matrix` already carries the item and vendor attributes on every cell,
 * so the rows and columns are folded out of it rather than fetched separately —
 * one query, and no chance of the grid disagreeing with its own axes.
 */
export async function fetchGrid(comparisonId: string): Promise<ComparisonGrid> {
  const [matrix, totals] = await Promise.all([
    supabase
      .from('v_rc_matrix')
      .select(
        'comparison_id, item_id, item_order, description, unit, qty, ' +
          'material_id, spec, awarded_quote_id, award_reason, ' +
          'vendor_col_id, vendor_order, vendor_display, vendor_id, gst_pct, ' +
          'delivery_days, terms, payment_terms, quote_ref, ' +
          'quote_id, rate, remark, line_total, is_lowest, is_awarded',
      )
      .eq('comparison_id', comparisonId),
    supabase
      .from('v_rc_vendor_totals')
      .select(
        'comparison_id, vendor_col_id, vendor_display, vendor_id, gst_pct, ' +
          'delivery_days, terms, payment_terms, quote_ref, items_quoted, ' +
          'items_missing, subtotal, gst_amount, grand_total, awarded_value, ' +
          'is_lowest_total',
      )
      .eq('comparison_id', comparisonId),
  ])

  if (matrix.error) throw matrix.error
  if (totals.error) throw totals.error

  const cellRows = rows(matrix.data)

  const itemById = new Map<string, ComparisonItem>()
  const vendorById = new Map<string, ComparisonVendor>()
  const cells: ComparisonCell[] = []

  for (const r of cellRows) {
    const itemId = r.item_id as string
    const vendorId = r.vendor_col_id as string

    if (!itemById.has(itemId)) {
      itemById.set(itemId, {
        id: itemId,
        comparison_id: comparisonId,
        material_id: str(r.material_id),
        description: r.description as string,
        unit: r.unit as string,
        qty: Number(r.qty),
        spec: str(r.spec),
        awarded_quote_id: str(r.awarded_quote_id),
        award_reason: str(r.award_reason),
        sort_order: Number(r.item_order ?? 0),
      })
    }

    if (!vendorById.has(vendorId)) {
      vendorById.set(vendorId, {
        id: vendorId,
        comparison_id: comparisonId,
        vendor_id: str(r.vendor_id),
        vendor_display: (str(r.vendor_display) ?? '—') as string,
        quote_ref: str(r.quote_ref),
        quote_date: null,
        terms: str(r.terms),
        payment_terms: str(r.payment_terms),
        delivery_days:
          r.delivery_days === null || r.delivery_days === undefined
            ? null
            : Number(r.delivery_days),
        gst_pct: Number(r.gst_pct ?? 0),
        po_id: null,
        sort_order: Number(r.vendor_order ?? 0),
      })
    }

    cells.push({
      item_id: itemId,
      vendor_col_id: vendorId,
      quote_id: str(r.quote_id),
      rate: num(r.rate),
      line_total: num(r.line_total),
      remark: str(r.remark),
      is_lowest: Boolean(r.is_lowest),
      is_awarded: Boolean(r.is_awarded),
    })
  }

  // A comparison with vendors but no items (or the reverse) produces no matrix
  // rows at all — the view is a join. Fill the missing axis directly so a
  // half-built statement still renders what it has.
  if (itemById.size === 0 || vendorById.size === 0) {
    const [it, vd] = await Promise.all([
      supabase
        .from('rc_items')
        .select(
          'id, comparison_id, material_id, description, unit, qty, spec, ' +
            'awarded_quote_id, award_reason, sort_order',
        )
        .eq('comparison_id', comparisonId),
      supabase
        .from('rc_vendors')
        .select(
          'id, comparison_id, vendor_id, vendor_name, quote_ref, quote_date, ' +
            'terms, payment_terms, delivery_days, gst_pct, po_id, sort_order, ' +
            'vendors(name)',
        )
        .eq('comparison_id', comparisonId),
    ])

    for (const r of rows(it.data)) {
      if (itemById.has(r.id as string)) continue
      itemById.set(r.id as string, {
        id: r.id as string,
        comparison_id: comparisonId,
        material_id: str(r.material_id),
        description: r.description as string,
        unit: r.unit as string,
        qty: Number(r.qty),
        spec: str(r.spec),
        awarded_quote_id: str(r.awarded_quote_id),
        award_reason: str(r.award_reason),
        sort_order: Number(r.sort_order ?? 0),
      })
    }

    for (const r of rows(vd.data)) {
      if (vendorById.has(r.id as string)) continue
      const v = r.vendors as { name: string } | { name: string }[] | null
      const registered = (Array.isArray(v) ? v[0]?.name : v?.name) ?? null
      vendorById.set(r.id as string, {
        id: r.id as string,
        comparison_id: comparisonId,
        vendor_id: str(r.vendor_id),
        vendor_display: registered ?? (str(r.vendor_name) ?? '—'),
        quote_ref: str(r.quote_ref),
        quote_date: str(r.quote_date),
        terms: str(r.terms),
        payment_terms: str(r.payment_terms),
        delivery_days:
          r.delivery_days === null || r.delivery_days === undefined
            ? null
            : Number(r.delivery_days),
        gst_pct: Number(r.gst_pct ?? 0),
        po_id: str(r.po_id),
        sort_order: Number(r.sort_order ?? 0),
      })
    }
  }

  // po_id is not on the matrix view (it is a vendor attribute, not a cell one),
  // so it is fetched alongside and merged in — the Convert button needs it.
  const { data: poRows } = await supabase
    .from('rc_vendors')
    .select('id, po_id, quote_date')
    .eq('comparison_id', comparisonId)
  for (const r of rows(poRows)) {
    const v = vendorById.get(r.id as string)
    if (v) {
      v.po_id = str(r.po_id)
      v.quote_date = str(r.quote_date)
    }
  }

  return {
    items: [...itemById.values()].sort((a, b) => a.sort_order - b.sort_order),
    vendors: [...vendorById.values()].sort((a, b) => a.sort_order - b.sort_order),
    cells,
    totals: rows(totals.data).map((r) => ({
      comparison_id: r.comparison_id as string,
      vendor_col_id: r.vendor_col_id as string,
      vendor_display: (str(r.vendor_display) ?? '—') as string,
      vendor_id: str(r.vendor_id),
      gst_pct: Number(r.gst_pct ?? 0),
      delivery_days:
        r.delivery_days === null || r.delivery_days === undefined
          ? null
          : Number(r.delivery_days),
      terms: str(r.terms),
      payment_terms: str(r.payment_terms),
      quote_ref: str(r.quote_ref),
      items_quoted: Number(r.items_quoted ?? 0),
      items_missing: Number(r.items_missing ?? 0),
      subtotal: Number(r.subtotal ?? 0),
      gst_amount: Number(r.gst_amount ?? 0),
      grand_total: Number(r.grand_total ?? 0),
      awarded_value: Number(r.awarded_value ?? 0),
      is_lowest_total: Boolean(r.is_lowest_total),
    })),
  }
}

/* ---------------- building ---------------- */

export async function createComparison(input: NewComparison): Promise<string> {
  const { data, error } = await supabase
    .from('rate_comparisons')
    .insert({
      project_id: input.project_id,
      title: input.title.trim(),
      need_by: input.need_by,
      notes: input.notes.trim() || null,
    })
    .select('id')
    .single()

  if (error) throw error
  const id = data.id as string

  if (input.items.length > 0) {
    const { error: itemErr } = await supabase.from('rc_items').insert(
      input.items.map((it, i) => ({
        comparison_id: id,
        material_id: it.material_id,
        description: it.description.trim(),
        unit: it.unit.trim(),
        qty: it.qty,
        spec: it.spec?.trim() || null,
        sort_order: (i + 1) * 10,
      })),
    )
    if (itemErr) throw itemErr
  }

  return id
}

/** Copies a still-`requested` PR's lines into a new comparison. */
export async function comparisonFromPr(
  poId: string,
  title: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('fn_rc_from_pr', {
    p_po: poId,
    p_title: title,
  })
  if (error) throw error
  return data as string
}

export async function addItem(
  comparisonId: string,
  item: {
    material_id: string | null
    description: string
    unit: string
    qty: number
    spec?: string | null
  },
  sortOrder: number,
): Promise<void> {
  const { error } = await supabase.from('rc_items').insert({
    comparison_id: comparisonId,
    material_id: item.material_id,
    description: item.description.trim(),
    unit: item.unit.trim(),
    qty: item.qty,
    spec: item.spec?.trim() || null,
    sort_order: sortOrder,
  })
  if (error) throw error
}

export async function removeItem(id: string): Promise<void> {
  const { error } = await supabase.from('rc_items').delete().eq('id', id)
  if (error) throw error
}

export async function addVendorColumn(
  comparisonId: string,
  v: {
    vendor_id: string | null
    vendor_name: string
    quote_ref?: string
    quote_date?: string | null
    terms?: string
    payment_terms?: string
    delivery_days?: number | null
    gst_pct: number
  },
  sortOrder: number,
): Promise<void> {
  const { error } = await supabase.from('rc_vendors').insert({
    comparison_id: comparisonId,
    vendor_id: v.vendor_id,
    vendor_name: v.vendor_name.trim() || null,
    quote_ref: v.quote_ref?.trim() || null,
    quote_date: v.quote_date || null,
    terms: v.terms?.trim() || null,
    payment_terms: v.payment_terms?.trim() || null,
    delivery_days: v.delivery_days ?? null,
    gst_pct: v.gst_pct,
    sort_order: sortOrder,
  })
  if (error) throw error
}

export async function removeVendorColumn(id: string): Promise<void> {
  const { error } = await supabase.from('rc_vendors').delete().eq('id', id)
  if (error) throw error
}

/**
 * Sets or clears one cell.
 *
 * A blank rate DELETES the row rather than storing zero: "did not quote" and
 * "quoted nothing" are different facts, and only the first one should keep a
 * vendor out of the lowest-rate comparison.
 */
export async function setQuote(
  itemId: string,
  vendorColId: string,
  rate: number | null,
  remark?: string | null,
): Promise<void> {
  if (rate === null) {
    const { error } = await supabase
      .from('rc_quotes')
      .delete()
      .eq('rc_item_id', itemId)
      .eq('rc_vendor_id', vendorColId)
    if (error) throw error
    return
  }

  const { error } = await supabase.from('rc_quotes').upsert(
    {
      rc_item_id: itemId,
      rc_vendor_id: vendorColId,
      rate,
      remark: remark?.trim() || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'rc_item_id,rc_vendor_id' },
  )
  if (error) throw error
}

/* ---------------- awarding ---------------- */

/**
 * Awards one line. The RPC demands a reason when the chosen quote is not the
 * cheapest for that line — the refusal is server-side, so the justification
 * cannot be skipped by anything that talks to the database.
 */
export async function awardItem(
  itemId: string,
  quoteId: string,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_rc_award_item', {
    p_item: itemId,
    p_quote: quoteId,
    p_reason: reason?.trim() || null,
  })
  if (error) throw error
}

/** Awards every line to one vendor. Returns the number of lines written. */
export async function awardAll(
  comparisonId: string,
  vendorColId: string,
  reason?: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('fn_rc_award', {
    p_comparison: comparisonId,
    p_vendor_col: vendorColId,
    p_reason: reason?.trim() || null,
  })
  if (error) throw error
  return Number(data ?? 0)
}

export async function clearAward(comparisonId: string): Promise<void> {
  const { error } = await supabase.rpc('fn_rc_clear_award', {
    p_comparison: comparisonId,
  })
  if (error) throw error
}

/* ---------------- conversion + removal ---------------- */

/**
 * Raises the purchase order(s). One per winning vendor, at status `approved`
 * with rates already on the lines, so the existing A3 receiving, 3-way match
 * and PO PDF work on them untouched. Returns how many were created.
 */
export async function convertToPo(
  comparisonId: string,
  needBy: string | null,
): Promise<number> {
  const { data, error } = await supabase.rpc('fn_rc_to_po', {
    p_comparison: comparisonId,
    p_need_by: needBy,
  })
  if (error) throw error
  return Number(data ?? 0)
}

/** Founder/PM. Refused once the comparison has produced a purchase order. */
export async function deleteComparison(id: string): Promise<void> {
  const { error } = await supabase.rpc('fn_delete_comparison', { p_id: id })
  if (error) throw error
}

/** Still-`requested` PRs, for the "build from a requisition" picker. */
export async function fetchOpenRequests(
  projectId: string,
): Promise<{ id: string; po_number: string; line_count: number }[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('id, po_number, created_at')
    .eq('project_id', projectId)
    .eq('status', 'requested')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw error
  const prs = rows(data)
  if (prs.length === 0) return []

  const { data: totals } = await supabase
    .from('v_po_totals')
    .select('po_id, line_count')
    .in(
      'po_id',
      prs.map((p) => p.id as string),
    )
  const countById = new Map(
    rows(totals).map((t) => [t.po_id as string, Number(t.line_count)]),
  )

  return prs.map((p) => ({
    id: p.id as string,
    po_number: p.po_number as string,
    line_count: countById.get(p.id as string) ?? 0,
  }))
}
