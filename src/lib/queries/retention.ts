import { supabase } from '@/lib/supabase'
import type {
  BgAlert,
  BgDisplayStatus,
  BgRow,
  BgStatus,
  BgType,
  NewBgInput,
  NewTrancheInput,
  RetentionLedgerRow,
  RetentionMilestone,
  RetentionState,
  RetentionTranche,
} from '@/lib/types'

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))

/* ---------------- Retention ---------------- */

/**
 * The ledger: held, released and balance per contractor.
 *
 * `retention_held` is summed from CERTIFIED ra_bills inside the view — there is
 * no way to type it in, because the moment it becomes editable it starts
 * disagreeing with what was actually certified.
 */
export async function fetchRetentionLedger(
  projectId: string,
): Promise<RetentionLedgerRow[]> {
  const { data, error } = await supabase
    .from('v_retention_ledger')
    .select(
      'project_id, party_key, vendor_id, contractor, certified_bills, retention_held, released, planned, balance_held, next_due',
    )
    .eq('project_id', projectId)
    .order('contractor')

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    project_id: r.project_id as string,
    party_key: r.party_key as string,
    vendor_id: (r.vendor_id as string | null) ?? null,
    contractor: r.contractor as string,
    certified_bills: Number(r.certified_bills ?? 0),
    retention_held: num(r.retention_held),
    released: num(r.released),
    planned: num(r.planned),
    balance_held: num(r.balance_held),
    next_due: (r.next_due as string | null) ?? null,
  }))
}

export async function fetchTranches(
  projectId: string,
): Promise<RetentionTranche[]> {
  const { data, error } = await supabase
    .from('retention_releases')
    .select(
      'id, project_id, vendor_id, contractor_name, milestone, status, amount, due_date, released_date, notes, created_at',
    )
    .eq('project_id', projectId)
    .order('due_date', { nullsFirst: false })
    .order('created_at')

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    vendor_id: (r.vendor_id as string | null) ?? null,
    contractor_name: (r.contractor_name as string | null) ?? null,
    milestone: r.milestone as RetentionMilestone,
    status: r.status as RetentionState,
    amount: num(r.amount),
    due_date: (r.due_date as string | null) ?? null,
    released_date: (r.released_date as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    created_at: r.created_at as string,
  }))
}

/** Plans a tranche ("half on completion"). Releasing it is a separate step. */
export async function planTranche(input: NewTrancheInput): Promise<string> {
  const { data, error } = await supabase
    .from('retention_releases')
    .insert({
      project_id: input.project_id,
      vendor_id: input.vendor_id,
      contractor_name: input.vendor_id ? null : input.contractor_name.trim() || null,
      milestone: input.milestone,
      amount: input.amount,
      due_date: input.due_date,
      notes: input.notes.trim() || null,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Releases a planned tranche. The RPC refuses to release more than is actually
 * held for that contractor — retention cannot go negative — and is founder /
 * accounts only, because it moves money out.
 */
export async function releaseRetention(
  id: string,
  amount: number,
  date: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_release_retention', {
    p_id: id,
    p_amount: amount,
    p_date: date,
  })
  if (error) throw error
}

/* ---------------- Bank guarantees ---------------- */

const BG_COLUMNS =
  'id, project_id, vendor_id, counterparty_name, bg_type, bg_number, ' +
  'issuing_bank, amount, issue_date, expiry_date, claim_expiry_date, status, ' +
  'file_path, notes, released_at, days_to_expiry, display_status, created_at'

/**
 * Always read through v_bg_register: it derives expiring/expired from
 * expiry_date in Asia/Kolkata at query time, so the register is right whether
 * or not the nightly sweep has run.
 */
export async function fetchBgs(projectId: string): Promise<BgRow[]> {
  const { data, error } = await supabase
    .from('v_bg_register')
    .select(BG_COLUMNS)
    .eq('project_id', projectId)
    .order('expiry_date')

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    vendor_id: (r.vendor_id as string | null) ?? null,
    counterparty_name: r.counterparty_name as string,
    bg_type: r.bg_type as BgType,
    bg_number: r.bg_number as string,
    issuing_bank: r.issuing_bank as string,
    amount: num(r.amount),
    issue_date: (r.issue_date as string | null) ?? null,
    expiry_date: r.expiry_date as string,
    claim_expiry_date: (r.claim_expiry_date as string | null) ?? null,
    status: r.status as BgStatus,
    file_path: (r.file_path as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    released_at: (r.released_at as string | null) ?? null,
    days_to_expiry: Number(r.days_to_expiry ?? 0),
    display_status: r.display_status as BgDisplayStatus,
    created_at: r.created_at as string,
  }))
}

export async function createBg(input: NewBgInput): Promise<string> {
  const { data, error } = await supabase
    .from('bank_guarantees')
    .insert({
      project_id: input.project_id,
      vendor_id: input.vendor_id,
      counterparty: input.vendor_id ? null : input.counterparty.trim() || null,
      bg_type: input.bg_type,
      bg_number: input.bg_number.trim(),
      issuing_bank: input.issuing_bank.trim(),
      amount: input.amount,
      issue_date: input.issue_date,
      expiry_date: input.expiry_date,
      claim_expiry_date: input.claim_expiry_date,
      file_path: input.file_path,
      notes: input.notes.trim() || null,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/** active / released / returned. "Expired" is derived, never set by hand. */
export async function setBgStatus(
  id: string,
  status: 'active' | 'released' | 'returned',
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_bg_status', {
    p_id: id,
    p_status: status,
  })
  if (error) throw error
}

/** Counts for the dashboard strip. Null on any failure, so the strip hides. */
export async function fetchBgAlert(): Promise<BgAlert | null> {
  const { data, error } = await supabase.rpc('fn_bg_alert')
  if (error) return null

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  return {
    expiring_count: Number(row.expiring_count ?? 0),
    expired_count: Number(row.expired_count ?? 0),
    next_expiry: (row.next_expiry as string | null) ?? null,
    next_bg_number: (row.next_bg_number as string | null) ?? null,
  }
}
