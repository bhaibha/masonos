import { supabase } from '@/lib/supabase'
import type { InvoiceRow, InvoiceType, NewInvoiceInput } from '@/lib/types'

const COLUMNS =
  'id, invoice_number, project_id, inv_type, status, invoice_date, ' +
  'period_from, period_to, vendor_id, vendor_name, subtotal, gst_pct, ' +
  'gst_amount, less_previously_billed, total, notes, created_at, '
  + 'cancelled_at, cancelled_by, ' +
  'cancel_reason, invoice_items(id, sort, description, qty, unit, rate, amount)'

/**
 * Invoices for one project, newest first, with their line items.
 *
 * Every figure here was computed by Postgres at issue time and written down —
 * nothing is recalculated on read, and nothing is summed in the browser. That
 * is deliberate: an invoice is a snapshot, and must not drift as later
 * expenses land.
 *
 * RLS restricts the whole table to founder/accounts, so a PM or supervisor
 * gets an empty list rather than an error.
 */
export async function fetchInvoices(projectId: string): Promise<InvoiceRow[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('invoice_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw error

  // The embedded items join defeats PostgREST's type inference — assert once.
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((row) => ({
    id: row.id as string,
    invoice_number: row.invoice_number as string,
    project_id: row.project_id as string,
    inv_type: row.inv_type as InvoiceType,
    status: row.status as InvoiceRow['status'],
    invoice_date: row.invoice_date as string,
    period_from: (row.period_from as string | null) ?? null,
    period_to: (row.period_to as string | null) ?? null,
    vendor_id: (row.vendor_id as string | null) ?? null,
    vendor_name: (row.vendor_name as string | null) ?? null,
    subtotal: Number(row.subtotal),
    gst_pct: Number(row.gst_pct),
    gst_amount: Number(row.gst_amount),
    less_previously_billed: Number(row.less_previously_billed ?? 0),
    total: Number(row.total),
    notes: (row.notes as string | null) ?? null,
    created_at: row.created_at as string,
    cancelled_at: (row.cancelled_at as string | null) ?? null,
    cancelled_by: (row.cancelled_by as string | null) ?? null,
    cancel_reason: (row.cancel_reason as string | null) ?? null,
    items: ((row.invoice_items as Record<string, unknown>[] | null) ?? [])
      .map((i) => ({
        id: i.id as string,
        sort: Number(i.sort),
        description: i.description as string,
        qty: Number(i.qty),
        unit: (i.unit as string | null) ?? null,
        rate: Number(i.rate),
        amount: Number(i.amount),
      }))
      .sort((a, b) => a.sort - b.sort),
  }))
}

/**
 * Issues an invoice through fn_issue_invoice (migration 024).
 *
 * The browser sends only the parameters — project, type, period, vendor, GST
 * rate. Every amount is derived in Postgres from expenses / projects /
 * po_invoices and written down as a snapshot. There is no write policy on
 * `invoices`, so this RPC is the only way one can come into existence.
 */
export async function issueInvoice(input: NewInvoiceInput): Promise<string> {
  const { data, error } = await supabase.rpc('fn_issue_invoice', {
    p_project: input.project_id,
    p_type: input.inv_type,
    p_from: input.period_from,
    p_to: input.period_to,
    p_vendor: input.vendor_id,
    p_gst_pct: input.gst_pct,
    p_notes: input.notes.trim() || null,
  })

  if (error) throw error
  return data as string
}

/** Vendors with posted, un-voided invoices on this project — voucher targets. */
export async function fetchPayableVendors(
  projectId: string,
): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('vendor_id, vendors(name), po_invoices!inner(id, approved, voided_at)')
    .eq('project_id', projectId)
    .not('vendor_id', 'is', null)

  if (error) return []

  const seen = new Map<string, string>()
  for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
    const id = r.vendor_id as string | null
    if (!id || seen.has(id)) continue
    const v = r.vendors as { name: string } | { name: string }[] | null
    const name = (Array.isArray(v) ? v[0]?.name : v?.name) ?? null
    if (name) seen.set(id, name)
  }
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
