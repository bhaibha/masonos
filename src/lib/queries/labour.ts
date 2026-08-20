import { supabase } from '@/lib/supabase'
import type {
  AttendanceRow,
  LabourContractor,
  LabourCostRow,
  LabourEffortRow,
  LabourRate,
  LabourReconcile,
  LicenceAlert,
  MusterRow,
  NewAttendance,
  NewLabourContractor,
  NewLabourRate,
  OvertimeRow,
  WageRegisterRow,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]
const str = (v: unknown) => (v as string | null) ?? null
const n = (v: unknown) => Number(v ?? 0)
const optN = (v: unknown) => (v === null || v === undefined ? null : Number(v))

/* ---------------- trades ---------------- */

export async function fetchLabourTrades(): Promise<string[]> {
  const { data, error } = await supabase
    .from('labour_trades')
    .select('name')
    .eq('is_active', true)
    .order('sort_order')

  if (error) throw error
  return rows(data).map((r) => r.name as string)
}

/* ---------------- contractors ---------------- */

/**
 * The contractor register. Readable by everyone — a supervisor has to pick one
 * at the gate — because no rate lives on this table. Wage rates are a separate
 * table that supervisors match no policy on.
 */
export async function fetchContractors(
  activeOnly = true,
): Promise<LabourContractor[]> {
  let q = supabase
    .from('labour_contractors')
    .select(
      'id, name, contact_person, phone, licence_no, licence_authority, ' +
        'licence_valid_to, licensed_strength, pf_code, esi_code, gstin, ' +
        'trades, vendor_id, notes, is_active',
    )
    .order('name')
  if (activeOnly) q = q.eq('is_active', true)

  const { data, error } = await q
  if (error) throw error

  return rows(data).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    contact_person: str(r.contact_person),
    phone: str(r.phone),
    licence_no: str(r.licence_no),
    licence_authority: str(r.licence_authority),
    licence_valid_to: str(r.licence_valid_to),
    licensed_strength: optN(r.licensed_strength),
    pf_code: str(r.pf_code),
    esi_code: str(r.esi_code),
    gstin: str(r.gstin),
    trades: ((r.trades as string[] | null) ?? []) as string[],
    vendor_id: str(r.vendor_id),
    notes: str(r.notes),
    is_active: Boolean(r.is_active),
  }))
}

/** Returns the new id, so a caller adding one mid-flow can select it. */
export async function createContractor(
  input: NewLabourContractor,
): Promise<string> {
  const { data, error } = await supabase.from('labour_contractors').insert({
    name: input.name.trim(),
    contact_person: input.contact_person.trim() || null,
    phone: input.phone.trim() || null,
    licence_no: input.licence_no.trim() || null,
    licence_authority: input.licence_authority.trim() || null,
    licence_valid_to: input.licence_valid_to,
    licensed_strength: input.licensed_strength,
    pf_code: input.pf_code.trim() || null,
    esi_code: input.esi_code.trim() || null,
    gstin: input.gstin.trim() || null,
    trades: input.trades,
    notes: input.notes.trim() || null,
  })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

export async function setContractorActive(
  id: string,
  active: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('labour_contractors')
    .update({ is_active: active, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

/** Licences expiring within 30 days, or already expired. */
export async function fetchLicenceAlerts(): Promise<LicenceAlert[]> {
  const { data, error } = await supabase.rpc('fn_labour_licence_alert')
  if (error) return []
  return rows(data).map((r) => ({
    contractor_id: r.contractor_id as string,
    name: r.name as string,
    licence_no: str(r.licence_no),
    licence_valid_to: r.licence_valid_to as string,
    days_left: n(r.days_left),
    display_status: r.display_status as LicenceAlert['display_status'],
  }))
}

/* ---------------- attendance ---------------- */

const ATT_COLUMNS =
  'attendance_id, project_id, work_date, contractor_id, contractor_name, ' +
  'licence_no, licence_valid_to, trade, workers_present, overtime_hours, ' +
  'work_area, activity_id, remarks, voided_at, void_reason, created_by, over_licence'

function toAttendance(r: Record<string, unknown>): AttendanceRow {
  return {
    attendance_id: r.attendance_id as string,
    project_id: r.project_id as string,
    work_date: r.work_date as string,
    contractor_id: r.contractor_id as string,
    contractor_name: r.contractor_name as string,
    licence_no: str(r.licence_no),
    licence_valid_to: str(r.licence_valid_to),
    trade: r.trade as string,
    workers_present: n(r.workers_present),
    overtime_hours: n(r.overtime_hours),
    work_area: str(r.work_area),
    activity_id: str(r.activity_id),
    remarks: str(r.remarks),
    voided_at: str(r.voided_at),
    void_reason: str(r.void_reason),
    created_by: r.created_by as string,
    over_licence: Boolean(r.over_licence),
  }
}

/** One day's gangs. The supervisor's screen. */
export async function fetchAttendance(
  projectId: string,
  date: string,
): Promise<AttendanceRow[]> {
  const { data, error } = await supabase
    .from('v_labour_attendance')
    .select(ATT_COLUMNS)
    .eq('project_id', projectId)
    .eq('work_date', date)
    .order('contractor_name')
    .order('trade')

  if (error) throw error
  return rows(data).map(toAttendance)
}

export async function fetchAttendanceRange(
  projectId: string,
  from: string,
  to: string,
): Promise<AttendanceRow[]> {
  const { data, error } = await supabase
    .from('v_labour_attendance')
    .select(ATT_COLUMNS)
    .eq('project_id', projectId)
    .gte('work_date', from)
    .lte('work_date', to)
    .order('work_date', { ascending: false })
    .limit(1000)

  if (error) throw error
  return rows(data).map(toAttendance)
}

const attendanceRow = (input: NewAttendance) => ({
  project_id: input.project_id,
  work_date: input.work_date,
  contractor_id: input.contractor_id,
  trade: input.trade,
  workers_present: input.workers_present,
  overtime_hours: input.overtime_hours,
  work_area: input.work_area.trim() || null,
  activity_id: input.activity_id,
  remarks: input.remarks.trim() || null,
})

export async function logAttendance(input: NewAttendance): Promise<void> {
  const { error } = await supabase
    .from('labour_attendance')
    .insert(attendanceRow(input))
  if (error) throw error
}

/**
 * One contractor, several trades, in one go — 14 masons, 6 helpers and 2 bar
 * benders from the same gang on the same day.
 *
 * It still writes ONE ROW PER TRADE, exactly as the single form does. That is
 * not a detail: wage rates are per trade, so a row that lumped trades together
 * could not be priced. This is a convenience over the existing shape, never a
 * second representation of it — the 050 rule.
 *
 * A single insert with an array is ONE statement, so it is all-or-nothing. If
 * one trade collides with something already logged for that day and area, none
 * of them are written and the supervisor is not left guessing which half went
 * in.
 */
export async function logAttendanceBatch(
  inputs: NewAttendance[],
): Promise<number> {
  if (inputs.length === 0) return 0
  const { error } = await supabase
    .from('labour_attendance')
    .insert(inputs.map(attendanceRow))
  if (error) throw error
  return inputs.length
}

/**
 * Void, never delete: attendance drives wages. A supervisor may void an entry
 * they created themselves — they log it, so they make the typos. Refused once
 * the period has been posted to the ledger, or the attendance and the booked
 * cost would stop agreeing.
 */
export async function voidAttendance(
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_void_attendance', {
    p_id: id,
    p_reason: reason,
  })
  if (error) throw error
}

/**
 * The site log has recorded a headcount since 001, and attendance records the
 * same fact in more detail. This surfaces the disagreement rather than letting
 * whichever was typed last quietly win.
 */
export async function fetchHeadcountCheck(
  projectId: string,
  date: string,
): Promise<{ site_log: number; attendance: number; variance: number } | null> {
  const { data, error } = await supabase.rpc('fn_labour_headcount_check', {
    p_project: projectId,
    p_date: date,
  })
  if (error) return null
  const r = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return {
    site_log: n(r.site_log_total),
    attendance: n(r.attendance_total),
    variance: n(r.variance),
  }
}

/* ---------------- rates ---------------- */

export async function fetchRates(): Promise<LabourRate[]> {
  const { data, error } = await supabase
    .from('labour_rates')
    .select(
      'id, project_id, contractor_id, trade, daily_rate, ot_multiplier, ' +
        'normal_hours, effective_from, effective_to, notes',
    )
    .order('trade')
    .order('effective_from', { ascending: false })

  if (error) throw error
  return rows(data).map((r) => ({
    id: r.id as string,
    project_id: str(r.project_id),
    contractor_id: str(r.contractor_id),
    trade: r.trade as string,
    daily_rate: n(r.daily_rate),
    ot_multiplier: n(r.ot_multiplier),
    normal_hours: n(r.normal_hours),
    effective_from: r.effective_from as string,
    effective_to: str(r.effective_to),
    notes: str(r.notes),
  }))
}

export async function createRate(input: NewLabourRate): Promise<void> {
  const { error } = await supabase.from('labour_rates').insert({
    project_id: input.project_id,
    contractor_id: input.contractor_id,
    trade: input.trade,
    daily_rate: input.daily_rate,
    ot_multiplier: input.ot_multiplier,
    normal_hours: input.normal_hours,
    effective_from: input.effective_from,
    effective_to: input.effective_to,
    notes: input.notes.trim() || null,
  })
  if (error) throw error
}

export async function deleteRate(id: string): Promise<void> {
  const { error } = await supabase.from('labour_rates').delete().eq('id', id)
  if (error) throw error
}

/* ---------------- cost + registers ---------------- */

export async function fetchLabourCost(
  projectId: string,
  from: string,
  to: string,
): Promise<LabourCostRow[]> {
  const { data, error } = await supabase
    .from('v_labour_cost')
    .select(
      'attendance_id, work_date, contractor_name, trade, workers_present, ' +
        'overtime_hours, daily_rate, rate_scope, mandays, wages, ot_amount, ' +
        'total_cost, rate_missing',
    )
    .eq('project_id', projectId)
    .gte('work_date', from)
    .lte('work_date', to)
    .order('work_date', { ascending: false })
    .limit(1000)

  if (error) throw error
  return rows(data).map((r) => ({
    attendance_id: r.attendance_id as string,
    work_date: r.work_date as string,
    contractor_name: r.contractor_name as string,
    trade: r.trade as string,
    workers_present: n(r.workers_present),
    overtime_hours: n(r.overtime_hours),
    daily_rate: optN(r.daily_rate),
    rate_scope: str(r.rate_scope),
    mandays: n(r.mandays),
    wages: n(r.wages),
    ot_amount: n(r.ot_amount),
    total_cost: n(r.total_cost),
    rate_missing: Boolean(r.rate_missing),
  }))
}

/** Form XVII equivalent, gang level. */
export async function fetchWageRegister(
  projectId: string,
  from: string,
  to: string,
): Promise<WageRegisterRow[]> {
  const { data, error } = await supabase.rpc('fn_wage_register', {
    p_project: projectId,
    p_from: from,
    p_to: to,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    contractor_id: r.contractor_id as string,
    contractor_name: r.contractor_name as string,
    trade: r.trade as string,
    days_worked: n(r.days_worked),
    mandays: n(r.mandays),
    daily_rate: optN(r.daily_rate),
    wages: n(r.wages),
    ot_hours: n(r.ot_hours),
    ot_amount: n(r.ot_amount),
    total_payable: n(r.total_payable),
    missing_rates: n(r.missing_rates),
  }))
}

/** Form XVI equivalent, gang level. No money — every project member reads it. */
export async function fetchMusterRoll(
  projectId: string,
  from: string,
  to: string,
): Promise<MusterRow[]> {
  const { data, error } = await supabase.rpc('fn_muster_roll', {
    p_project: projectId,
    p_from: from,
    p_to: to,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    work_date: r.work_date as string,
    contractor_id: r.contractor_id as string,
    contractor_name: r.contractor_name as string,
    trade: r.trade as string,
    workers_present: n(r.workers_present),
    overtime_hours: n(r.overtime_hours),
    work_area: str(r.work_area),
  }))
}

export async function fetchOvertimeRegister(
  projectId: string,
  from: string,
  to: string,
): Promise<OvertimeRow[]> {
  const { data, error } = await supabase.rpc('fn_overtime_register', {
    p_project: projectId,
    p_from: from,
    p_to: to,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    work_date: r.work_date as string,
    contractor_name: r.contractor_name as string,
    trade: r.trade as string,
    workers_present: n(r.workers_present),
    ot_hours: n(r.ot_hours),
    normal_hours: n(r.normal_hours),
    ot_multiplier: n(r.ot_multiplier),
    ot_rate_per_hr: n(r.ot_rate_per_hr),
    ot_amount: n(r.ot_amount),
  }))
}

/* ---------------- reconcile + post ---------------- */

export async function fetchReconcile(
  projectId: string,
  from: string,
  to: string,
): Promise<LabourReconcile | null> {
  const { data, error } = await supabase.rpc('fn_labour_reconcile', {
    p_project: projectId,
    p_from: from,
    p_to: to,
  })
  if (error) return null
  const r = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return {
    accrued: n(r.accrued),
    posted: n(r.posted),
    booked_ledger: n(r.booked_ledger),
    variance: n(r.variance),
  }
}

/**
 * Turns a period's attendance into ledger expenses — one per schedule activity,
 * so the earned-value tagging survives the trip.
 *
 * This is the ONLY way labour reaches the P&L. Attendance on its own never
 * does: if it did, every rupee of labour paid through an expense would be
 * counted twice. Overlapping periods are refused server-side.
 */
export async function postLabourExpense(
  projectId: string,
  from: string,
  to: string,
  categoryId: number,
  contractorId: string | null,
): Promise<number> {
  const { data, error } = await supabase.rpc('fn_post_labour_expense', {
    p_project: projectId,
    p_from: from,
    p_to: to,
    p_category: categoryId,
    p_contractor: contractorId,
  })
  if (error) throw error
  return Number(data ?? 0)
}

/**
 * Days, mandays and overtime per contractor and trade over a period.
 *
 * Summed in Postgres, not here: a manday total is what the wage register is
 * read in and what gets compared against a contractor's invoice, so it is
 * computed once, server-side. Voided entries are excluded there too.
 *
 * Carries no rate and no cost — this feeds History, which supervisors read.
 */
export async function fetchLabourEffort(
  projectId: string,
  from: string,
  to: string,
): Promise<LabourEffortRow[]> {
  const { data, error } = await supabase.rpc('fn_labour_effort', {
    p_project: projectId,
    p_from: from,
    p_to: to,
  })
  if (error) throw error
  return rows(data).map((r) => ({
    contractor_id: r.contractor_id as string,
    contractor_name: r.contractor_name as string,
    trade: r.trade as string,
    days_worked: n(r.days_worked),
    mandays: n(r.mandays),
    ot_hours: n(r.ot_hours),
    peak_workers: n(r.peak_workers),
  }))
}
