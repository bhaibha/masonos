import { supabase } from '@/lib/supabase'
import type {
  InsuranceAlert,
  InsuranceDisplayStatus,
  InsuranceStatus,
  InsuranceType,
  NewPolicyInput,
  PolicyRow,
} from '@/lib/types'

const COLUMNS =
  'id, project_id, project_name, policy_type, policy_number, insurer, broker, ' +
  'sum_insured, premium, start_date, expiry_date, status, file_path, notes, ' +
  'renewed_from, has_successor, days_to_expiry, display_status, created_at'

const numOrNull = (v: unknown) =>
  v === null || v === undefined ? null : Number(v)

/**
 * The register, soonest expiry first.
 *
 * Always read through v_insurance_register: it derives expiring/expired from
 * expiry_date in Asia/Kolkata at query time, so the screen is correct whether
 * or not the nightly sweep has run. Cover that lapses because a cron job didn't
 * fire is the exact failure this module exists to prevent.
 */
export async function fetchPolicies(): Promise<PolicyRow[]> {
  const { data, error } = await supabase
    .from('v_insurance_register')
    .select(COLUMNS)
    .order('expiry_date')
    .limit(300)

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    id: r.id as string,
    project_id: (r.project_id as string | null) ?? null,
    project_name: (r.project_name as string | null) ?? null,
    policy_type: r.policy_type as InsuranceType,
    policy_number: r.policy_number as string,
    insurer: r.insurer as string,
    broker: (r.broker as string | null) ?? null,
    sum_insured: numOrNull(r.sum_insured),
    premium: numOrNull(r.premium),
    start_date: (r.start_date as string | null) ?? null,
    expiry_date: r.expiry_date as string,
    status: r.status as InsuranceStatus,
    file_path: (r.file_path as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    renewed_from: (r.renewed_from as string | null) ?? null,
    has_successor: Boolean(r.has_successor),
    days_to_expiry: Number(r.days_to_expiry ?? 0),
    display_status: r.display_status as InsuranceDisplayStatus,
    created_at: r.created_at as string,
  }))
}

export async function createPolicy(input: NewPolicyInput): Promise<string> {
  const { data, error } = await supabase
    .from('insurance_policies')
    .insert({
      project_id: input.project_id,
      policy_type: input.policy_type,
      policy_number: input.policy_number.trim(),
      insurer: input.insurer.trim(),
      broker: input.broker.trim() || null,
      sum_insured: input.sum_insured,
      premium: input.premium,
      start_date: input.start_date,
      expiry_date: input.expiry_date,
      file_path: input.file_path,
      notes: input.notes.trim() || null,
      renewed_from: input.renewed_from,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * active / renewed / cancelled. "Expired" is derived from the date and cannot
 * be set by hand — the RPC refuses it.
 */
export async function setPolicyStatus(
  id: string,
  status: 'active' | 'renewed' | 'cancelled',
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_policy_status', {
    p_id: id,
    p_status: status,
  })
  if (error) throw error
}

/** Counts for the dashboard strip. Null on any failure, so the strip hides. */
export async function fetchInsuranceAlert(): Promise<InsuranceAlert | null> {
  const { data, error } = await supabase.rpc('fn_insurance_alert')
  if (error) return null

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  return {
    expiring_count: Number(row.expiring_count ?? 0),
    expired_count: Number(row.expired_count ?? 0),
    next_expiry: (row.next_expiry as string | null) ?? null,
    next_policy: (row.next_policy as string | null) ?? null,
  }
}
