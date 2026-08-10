import { supabase } from '@/lib/supabase'
import type {
  CompanyNet,
  NewOverheadInput,
  OverheadCategoryRow,
  OverheadRow,
  OverheadSummaryRow,
  PnlPeriod,
} from '@/lib/types'

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))

/* ---------------- period maths ---------------- */

/**
 * Period boundaries, in Asia/Kolkata terms.
 *
 * The Indian financial year runs April to March, so "this FY" in January means
 * the previous April onwards — getting that wrong would misstate every annual
 * figure by nine months.
 */
export function periodRange(p: PnlPeriod): { from: string; to: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() // 0-based

  // Built from the LOCAL parts, never toISOString(): a Date constructed as
  // local midnight in IST is 18:30 UTC the previous day, so toISOString would
  // shift every boundary back one day — silently dropping the 1st of the month
  // out of the month.
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`

  if (p === 'all') return { from: '1900-01-01', to: iso(new Date(y + 50, 0, 1)) }

  if (p === 'month') {
    return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) }
  }

  if (p === 'quarter') {
    const qStart = Math.floor(m / 3) * 3
    return { from: iso(new Date(y, qStart, 1)), to: iso(new Date(y, qStart + 3, 0)) }
  }

  // FY: April of this year if we're past March, otherwise April of last year.
  const fyStartYear = m >= 3 ? y : y - 1
  return {
    from: iso(new Date(fyStartYear, 3, 1)),
    to: iso(new Date(fyStartYear + 1, 2, 31)),
  }
}

export function periodLabel(p: PnlPeriod): string {
  const { from, to } = periodRange(p)
  if (p === 'all') return 'all time'
  return `${from} to ${to}`
}

/* ---------------- headings (041) ---------------- */

/**
 * The chart of overhead headings.
 *
 * `activeOnly` for the entry form — a retired heading must not be pickable for
 * new money. The list screen passes false, so an entry filed under a retired
 * heading still shows its name rather than a blank.
 */
export async function fetchOverheadCategories(
  activeOnly = false,
): Promise<OverheadCategoryRow[]> {
  let q = supabase
    .from('overhead_categories')
    .select('id, name, slug, active, sort_order')
    .order('sort_order')
    .order('name')

  if (activeOnly) q = q.eq('active', true)

  const { data, error } = await q
  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    slug: (r.slug as string | null) ?? null,
    active: Boolean(r.active),
    sort_order: Number(r.sort_order ?? 999),
  }))
}

/**
 * Adds a heading. Founder-only at RLS. A duplicate name differing only by case
 * or trailing space is refused by a unique index on lower(btrim(name)) — the
 * two ways a duplicate heading actually gets created.
 */
export async function createOverheadCategory(name: string): Promise<string> {
  const { data, error } = await supabase
    .from('overhead_categories')
    .insert({ name: name.trim() })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

export async function renameOverheadCategory(
  id: string,
  name: string,
): Promise<void> {
  const { error } = await supabase
    .from('overhead_categories')
    .update({ name: name.trim(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
    .single()

  if (error) throw error
}

/** Retire or restore. Retiring hides a heading from new entries only. */
export async function setOverheadCategoryActive(
  id: string,
  active: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('overhead_categories')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id')
    .single()

  if (error) throw error
}

/**
 * True delete, and only for a heading nothing has ever pointed at — the RPC
 * refuses anything with history and names the count.
 */
export async function deleteOverheadCategory(id: string): Promise<void> {
  const { error } = await supabase.rpc('fn_delete_overhead_category', {
    p_id: id,
  })
  if (error) throw error
}

/* ---------------- overheads ---------------- */

const COLUMNS =
  'id, spend_date, category_id, amount, gst_amount, vendor_id, vendor_name, ' +
  'description, proof_path, voided_at, void_reason, created_at, ' +
  'vendors(name), overhead_categories(name)'

/**
 * Overheads for a period. Voided rows are RETURNED, not filtered — they stay
 * visible marked VOID, and every total excludes them server-side.
 */
export async function fetchOverheads(
  from: string,
  to: string,
  categoryId?: string,
): Promise<OverheadRow[]> {
  let q = supabase
    .from('company_expenses')
    .select(COLUMNS)
    .gte('spend_date', from)
    .lte('spend_date', to)
    .order('spend_date', { ascending: false })
    .limit(500)

  if (categoryId) q = q.eq('category_id', categoryId)

  const { data, error } = await q
  if (error) throw error

  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  const nameOf = (v: unknown): string | null => {
    const o = v as { name: string } | { name: string }[] | null
    return (Array.isArray(o) ? o[0]?.name : o?.name) ?? null
  }

  return rows.map((r) => {
    const linked = nameOf(r.vendors)

    return {
      id: r.id as string,
      spend_date: r.spend_date as string,
      category_id: r.category_id as string,
      category_name: nameOf(r.overhead_categories) ?? 'Uncategorised',
      amount: num(r.amount),
      gst_amount: num(r.gst_amount),
      total: num(r.amount) + num(r.gst_amount),
      vendor_id: (r.vendor_id as string | null) ?? null,
      vendor_display: r.vendor_id
        ? linked
        : ((r.vendor_name as string | null) ?? null),
      description: (r.description as string | null) ?? null,
      proof_path: (r.proof_path as string | null) ?? null,
      voided_at: (r.voided_at as string | null) ?? null,
      void_reason: (r.void_reason as string | null) ?? null,
      created_at: r.created_at as string,
    }
  })
}

export async function createOverhead(input: NewOverheadInput): Promise<string> {
  const { data, error } = await supabase
    .from('company_expenses')
    .insert({
      spend_date: input.spend_date,
      category_id: input.category_id,
      amount: input.amount,
      gst_amount: input.gst_amount,
      vendor_id: input.vendor_id,
      vendor_name: input.vendor_id ? null : input.vendor_name.trim() || null,
      description: input.description.trim() || null,
      proof_path: input.proof_path,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

export async function updateOverhead(
  id: string,
  input: NewOverheadInput,
): Promise<void> {
  const { error } = await supabase
    .from('company_expenses')
    .update({
      spend_date: input.spend_date,
      category_id: input.category_id,
      amount: input.amount,
      gst_amount: input.gst_amount,
      vendor_id: input.vendor_id,
      vendor_name: input.vendor_id ? null : input.vendor_name.trim() || null,
      description: input.description.trim() || null,
      proof_path: input.proof_path,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id')
    .single()

  if (error) throw error
}

/** Voids an overhead. Reason is mandatory — a CHECK constraint backs it up. */
export async function voidOverhead(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('fn_void_company_expense', {
    p_id: id,
    p_reason: reason,
  })
  if (error) throw error
}

/**
 * Copies one month's overheads into another. Refuses when the target month
 * already has rows — the failure mode of a copy button is copying twice.
 */
export async function duplicateOverheads(
  sourceMonth: string,
  targetMonth: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('fn_duplicate_overheads', {
    p_source_month: sourceMonth,
    p_target_month: targetMonth,
  })
  if (error) throw error
  return Number(data ?? 0)
}

export async function fetchOverheadSummary(
  from: string,
  to: string,
): Promise<OverheadSummaryRow[]> {
  const { data, error } = await supabase.rpc('fn_overhead_summary', {
    p_from: from,
    p_to: to,
  })
  if (error) throw error

  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  return rows.map((r) => ({
    category_id: r.category_id as string,
    category_name: r.category_name as string,
    entry_count: Number(r.entry_count ?? 0),
    amount: num(r.amount),
    gst_amount: num(r.gst_amount),
    total: num(r.total),
  }))
}

/**
 * Project margins (lifetime), overheads (period), and the difference.
 * A PM gets their margin with `sees_overheads = false` and a null net.
 */
export async function fetchCompanyNet(
  from: string,
  to: string,
): Promise<CompanyNet | null> {
  const { data, error } = await supabase.rpc('fn_company_net', {
    p_from: from,
    p_to: to,
  })
  if (error) return null

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  return {
    project_margin: num(row.project_margin),
    overheads: row.overheads === null ? null : num(row.overheads),
    net_position: row.net_position === null ? null : num(row.net_position),
    overhead_count: Number(row.overhead_count ?? 0),
    sees_overheads: Boolean(row.sees_overheads),
  }
}
