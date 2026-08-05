import { supabase } from '@/lib/supabase'
import type {
  IncidentStatus,
  IncidentType,
  SafetyResult,
  SiteLogRow,
} from '@/lib/types'

/**
 * Range reads for the History screen. Everything here is capped: a year of a
 * busy site is a few hundred rows, and a query that quietly starts taking six
 * seconds is worse than one that asks you to narrow the range.
 *
 * Names are resolved in a second pass rather than an embedded join, because a
 * join defeats PostgREST's type inference and the join is one query either way.
 */

async function namesFor(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => Boolean(i)))]
  if (unique.length === 0) return new Map()

  const { data } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', unique)

  return new Map((data ?? []).map((p) => [p.id as string, p.full_name as string]))
}

/* ---------------- Site logs ---------------- */

export interface SiteLogHistoryRow extends SiteLogRow {
  created_by_name: string | null
  /** mason + helper + other, computed here only for display */
  labour_total: number
}

export async function fetchSiteLogHistory(
  projectId: string,
  from: string,
  to: string,
): Promise<SiteLogHistoryRow[]> {
  const { data, error } = await supabase
    .from('site_logs')
    .select(
      'id, project_id, log_date, weather, labour_mason, labour_helper, labour_other, work_summary, issues, photos, created_by',
    )
    .eq('project_id', projectId)
    .gte('log_date', from)
    .lte('log_date', to)
    .order('log_date', { ascending: false })
    .limit(1000)

  if (error) throw error
  const rows = (data ?? []) as unknown as SiteLogRow[]
  const names = await namesFor(rows.map((r) => r.created_by))

  return rows.map((r) => ({
    ...r,
    photos: r.photos ?? [],
    labour_mason: Number(r.labour_mason ?? 0),
    labour_helper: Number(r.labour_helper ?? 0),
    labour_other: Number(r.labour_other ?? 0),
    labour_total:
      Number(r.labour_mason ?? 0) +
      Number(r.labour_helper ?? 0) +
      Number(r.labour_other ?? 0),
    created_by_name: names.get(r.created_by) ?? null,
  }))
}

/* ---------------- Safety checklists ---------------- */

export interface ChecklistHistoryRow {
  id: string
  check_date: string
  created_by_name: string | null
  /** item_key → result, so the grid can show one column per check */
  results: Record<string, SafetyResult>
  remarks: Record<string, string>
  pass: number
  fail: number
  na: number
}

/**
 * One row per day, with each checklist item as a column. The items live in a
 * child table, so this pulls both and pivots — the alternative, a row per item,
 * makes a month of checks 180 rows nobody can read.
 */
export async function fetchChecklistHistory(
  projectId: string,
  from: string,
  to: string,
): Promise<ChecklistHistoryRow[]> {
  const { data, error } = await supabase
    .from('safety_checklists')
    .select('id, check_date, created_by')
    .eq('project_id', projectId)
    .gte('check_date', from)
    .lte('check_date', to)
    .order('check_date', { ascending: false })
    .limit(500)

  if (error) throw error
  const heads = (data ?? []) as unknown as {
    id: string
    check_date: string
    created_by: string
  }[]

  if (heads.length === 0) return []

  const { data: items } = await supabase
    .from('safety_checklist_items')
    .select('checklist_id, item_key, result, remark')
    .in(
      'checklist_id',
      heads.map((h) => h.id),
    )

  const byList = new Map<
    string,
    { key: string; result: SafetyResult; remark: string | null }[]
  >()
  for (const raw of items ?? []) {
    const i = raw as unknown as {
      checklist_id: string
      item_key: string
      result: SafetyResult
      remark: string | null
    }
    const list = byList.get(i.checklist_id) ?? []
    list.push({ key: i.item_key, result: i.result, remark: i.remark })
    byList.set(i.checklist_id, list)
  }

  const names = await namesFor(heads.map((h) => h.created_by))

  return heads.map((h) => {
    const list = byList.get(h.id) ?? []
    const results: Record<string, SafetyResult> = {}
    const remarks: Record<string, string> = {}
    let pass = 0
    let fail = 0
    let na = 0

    for (const i of list) {
      results[i.key] = i.result
      if (i.remark) remarks[i.key] = i.remark
      if (i.result === 'pass') pass += 1
      else if (i.result === 'fail') fail += 1
      else na += 1
    }

    return {
      id: h.id,
      check_date: h.check_date,
      created_by_name: names.get(h.created_by) ?? null,
      results,
      remarks,
      pass,
      fail,
      na,
    }
  })
}

/* ---------------- Site instructions / RFIs / snags ---------------- */

/**
 * These three tables share a shape: a numbered document, a date, a party it is
 * addressed to (linked vendor or free text), and a status. Rather than three
 * near-identical readers, one generic row type carries what the grid needs and
 * each fetcher maps its own columns onto it.
 */
export interface DocHistoryRow {
  id: string
  number: string
  date: string
  /** vendor name when linked, else the free-text party */
  party: string | null
  /** work area, trade, or category — whatever that document type calls it */
  context: string | null
  summary: string
  status: string
  /** required-by, resolved-on, answered-on… whatever closes it */
  due: string | null
  closed: string | null
  /** free-text extra shown in its own column, e.g. severity or "cost: yes" */
  extra: string | null
}

export async function fetchSiHistory(
  projectId: string,
  from: string,
  to: string,
): Promise<DocHistoryRow[]> {
  const { data, error } = await supabase
    .from('site_instructions')
    .select(
      'id, si_number, issued_date, addressed_to, work_area, instruction, has_cost_implication, required_by, status, completed_at, vendors(name)',
    )
    .eq('project_id', projectId)
    .gte('issued_date', from)
    .lte('issued_date', to)
    .order('issued_date', { ascending: false })
    .limit(500)

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    id: r.id as string,
    number: r.si_number as string,
    date: r.issued_date as string,
    party: vendorName(r.vendors) ?? (r.addressed_to as string | null) ?? null,
    context: (r.work_area as string | null) ?? null,
    summary: r.instruction as string,
    status: r.status as string,
    due: (r.required_by as string | null) ?? null,
    closed: ((r.completed_at as string | null) ?? null)?.slice(0, 10) ?? null,
    // Boolean only — the rupee value lives on the linked VO, which supervisors
    // cannot read. Printing "Yes" here keeps that rule intact.
    extra: r.has_cost_implication ? 'Cost implication' : null,
  }))
}

export async function fetchRfiHistory(
  projectId: string,
  from: string,
  to: string,
): Promise<DocHistoryRow[]> {
  const { data, error } = await supabase
    .from('rfis')
    .select(
      'id, rfi_number, raised_date, addressed_to, category, question, required_by, response, response_date, status, vendors(name)',
    )
    .eq('project_id', projectId)
    .gte('raised_date', from)
    .lte('raised_date', to)
    .order('raised_date', { ascending: false })
    .limit(500)

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => ({
    id: r.id as string,
    number: r.rfi_number as string,
    date: r.raised_date as string,
    party: vendorName(r.vendors) ?? (r.addressed_to as string | null) ?? null,
    context: (r.category as string | null) ?? null,
    summary: r.question as string,
    status: r.status as string,
    due: (r.required_by as string | null) ?? null,
    closed: (r.response_date as string | null) ?? null,
    extra: (r.response as string | null) ?? null,
  }))
}

export async function fetchSnagHistory(
  projectId: string,
  from: string,
  to: string,
): Promise<DocHistoryRow[]> {
  const { data, error } = await supabase
    .from('snags')
    .select(
      'id, snag_number, raised_date, work_area, trade, description, severity, status, resolved_at, verified_at, raised_during_dlp, assigned_to, vendors(name)',
    )
    .eq('project_id', projectId)
    .gte('raised_date', from)
    .lte('raised_date', to)
    .order('raised_date', { ascending: false })
    .limit(500)

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]

  return rows.map((r) => {
    const verified = (r.verified_at as string | null) ?? null
    const resolved = (r.resolved_at as string | null) ?? null

    return {
      id: r.id as string,
      number: r.snag_number as string,
      date: r.raised_date as string,
      party: vendorName(r.vendors) ?? (r.assigned_to as string | null) ?? null,
      context: [r.work_area, r.trade].filter(Boolean).join(' · ') || null,
      summary: r.description as string,
      status: r.status as string,
      due: null,
      // Verified beats resolved: it is the later, and the one that counts.
      closed: (verified ?? resolved)?.slice(0, 10) ?? null,
      extra:
        `${String(r.severity ?? '')}${r.raised_during_dlp ? ' · in DLP' : ''}` ||
        null,
    }
  })
}

/** PostgREST returns an embedded join as an object or a one-element array. */
function vendorName(v: unknown): string | null {
  if (!v) return null
  if (Array.isArray(v)) return (v[0] as { name?: string })?.name ?? null
  return (v as { name?: string }).name ?? null
}

/* ---------------- Incidents ---------------- */

export interface IncidentHistoryRow {
  id: string
  occurred_at: string
  incident_type: IncidentType
  description: string
  people_involved: string | null
  immediate_action: string | null
  status: IncidentStatus
  photo_count: number
  created_by_name: string | null
}

export async function fetchIncidentHistory(
  projectId: string,
  from: string,
  to: string,
): Promise<IncidentHistoryRow[]> {
  // occurred_at is a timestamp, so the upper bound has to cover the whole day.
  const { data, error } = await supabase
    .from('incidents')
    .select(
      'id, occurred_at, incident_type, description, people_involved, immediate_action, photos, status, created_by',
    )
    .eq('project_id', projectId)
    .gte('occurred_at', `${from}T00:00:00`)
    .lte('occurred_at', `${to}T23:59:59`)
    .order('occurred_at', { ascending: false })
    .limit(500)

  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  const names = await namesFor(rows.map((r) => r.created_by as string))

  return rows.map((r) => ({
    id: r.id as string,
    occurred_at: r.occurred_at as string,
    incident_type: r.incident_type as IncidentType,
    description: r.description as string,
    people_involved: (r.people_involved as string | null) ?? null,
    immediate_action: (r.immediate_action as string | null) ?? null,
    status: r.status as IncidentStatus,
    photo_count: ((r.photos as string[] | null) ?? []).length,
    created_by_name: names.get(r.created_by as string) ?? null,
  }))
}
