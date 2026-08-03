import { supabase } from '@/lib/supabase'
import type {
  NewRaBillInput,
  NewRaLineInput,
  RaBillLine,
  RaBillRow,
  RaPayable,
  RaStatus,
} from '@/lib/types'

const BILL_COLUMNS =
  'id, bill_no, project_id, vendor_id, vendor_name, contractor_name, ' +
  'contractor_bill_no, period_from, period_to, claimed_amount, retention_pct, ' +
  'status, notes, line_count, gross_work_value, less_previously_certified, ' +
  'value_this_bill, retention_amount, net_certified, is_frozen, certified_at, ' +
  'certified_by, rejected_at, reject_reason, cancelled_at, cancel_reason, created_at'

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))
const numOrNull = (v: unknown) =>
  v === null || v === undefined ? null : Number(v)

function toBill(r: Record<string, unknown>): RaBillRow {
  return {
    id: r.id as string,
    bill_no: r.bill_no as string,
    project_id: r.project_id as string,
    vendor_id: (r.vendor_id as string | null) ?? null,
    vendor_name: (r.vendor_name as string | null) ?? null,
    contractor_name: (r.contractor_name as string | null) ?? null,
    contractor_bill_no: (r.contractor_bill_no as string | null) ?? null,
    period_from: (r.period_from as string | null) ?? null,
    period_to: r.period_to as string,
    claimed_amount: numOrNull(r.claimed_amount),
    retention_pct: num(r.retention_pct),
    status: r.status as RaStatus,
    notes: (r.notes as string | null) ?? null,
    line_count: Number(r.line_count ?? 0),
    gross_work_value: num(r.gross_work_value),
    less_previously_certified: num(r.less_previously_certified),
    value_this_bill: num(r.value_this_bill),
    retention_amount: num(r.retention_amount),
    net_certified: num(r.net_certified),
    is_frozen: Boolean(r.is_frozen),
    certified_at: (r.certified_at as string | null) ?? null,
    certified_by: (r.certified_by as string | null) ?? null,
    rejected_at: (r.rejected_at as string | null) ?? null,
    reject_reason: (r.reject_reason as string | null) ?? null,
    cancelled_at: (r.cancelled_at as string | null) ?? null,
    cancel_reason: (r.cancel_reason as string | null) ?? null,
    created_at: r.created_at as string,
  }
}

/**
 * Bills for one project, newest period first.
 *
 * Always read through v_ra_bill_totals, never the table. For a bill still in
 * review the view previews the arithmetic from the lines; once certified the
 * STORED snapshot wins, so a certified bill can never restate itself because
 * somebody edited a measurement afterwards.
 */
export async function fetchRaBills(projectId: string): Promise<RaBillRow[]> {
  const { data, error } = await supabase
    .from('v_ra_bill_totals')
    .select(BILL_COLUMNS)
    .eq('project_id', projectId)
    .order('period_to', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(300)

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  return rows.map(toBill)
}

export async function fetchRaBill(id: string): Promise<RaBillRow | null> {
  const { data, error } = await supabase
    .from('v_ra_bill_totals')
    .select(BILL_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data ? toBill(data as unknown as Record<string, unknown>) : null
}

export async function fetchRaLines(billId: string): Promise<RaBillLine[]> {
  const { data, error } = await supabase
    .from('ra_bill_lines')
    .select('id, bill_id, description, unit, qty_to_date, rate, amount, category_id, sort')
    .eq('bill_id', billId)
    .order('sort')
    .order('created_at')

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    id: r.id as string,
    bill_id: r.bill_id as string,
    description: r.description as string,
    unit: (r.unit as string | null) ?? null,
    qty_to_date: num(r.qty_to_date),
    rate: num(r.rate),
    // Generated column — Postgres multiplies, never the browser.
    amount: num(r.amount),
    category_id: (r.category_id as number | null) ?? null,
    sort: Number(r.sort ?? 100),
  }))
}

export async function createRaBill(input: NewRaBillInput): Promise<string> {
  const { data, error } = await supabase
    .from('ra_bills')
    .insert({
      project_id: input.project_id,
      vendor_id: input.vendor_id,
      contractor_name: input.vendor_id ? null : input.contractor_name.trim() || null,
      contractor_bill_no: input.contractor_bill_no.trim() || null,
      period_from: input.period_from,
      period_to: input.period_to,
      claimed_amount: input.claimed_amount,
      retention_pct: input.retention_pct,
      notes: input.notes.trim() || null,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Adds a measurement line. `project_id` is stamped from the parent bill by a
 * trigger, so it isn't sent — a client that could choose it could file a line
 * against another project's bill.
 */
export async function addRaLine(input: NewRaLineInput): Promise<void> {
  const { error } = await supabase.from('ra_bill_lines').insert({
    bill_id: input.bill_id,
    description: input.description.trim(),
    unit: input.unit.trim() || null,
    qty_to_date: input.qty_to_date,
    rate: input.rate,
    sort: input.sort,
  })
  if (error) throw error
}

export async function deleteRaLine(id: string): Promise<void> {
  const { error } = await supabase.from('ra_bill_lines').delete().eq('id', id)
  if (error) throw error
}

/**
 * Certifies the bill. The RPC computes gross, previously-certified, retention
 * and net, then freezes all four on the row. Nothing is passed in except an
 * optional retention override.
 */
export async function certifyRaBill(
  id: string,
  retentionPct: number | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_certify_ra_bill', {
    p_id: id,
    p_pct: retentionPct,
  })
  if (error) throw error
}

export async function rejectRaBill(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('fn_reject_ra_bill', {
    p_id: id,
    p_reason: reason,
  })
  if (error) throw error
}

export async function setRaStatus(
  id: string,
  status: 'submitted' | 'under_review',
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_ra_status', {
    p_id: id,
    p_status: status,
  })
  if (error) throw error
}

/** Certified value, retention held and net payable per contractor. */
export async function fetchRaPayables(
  projectId: string,
): Promise<RaPayable[]> {
  const { data, error } = await supabase
    .from('v_ra_payables')
    .select(
      'project_id, vendor_id, contractor, certified_bills, gross_certified, retention_held, net_certified, last_certified_at',
    )
    .eq('project_id', projectId)
    .order('contractor')

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    project_id: r.project_id as string,
    vendor_id: (r.vendor_id as string | null) ?? null,
    contractor: r.contractor as string,
    certified_bills: Number(r.certified_bills ?? 0),
    gross_certified: num(r.gross_certified),
    retention_held: num(r.retention_held),
    net_certified: num(r.net_certified),
    last_certified_at: (r.last_certified_at as string | null) ?? null,
  }))
}
