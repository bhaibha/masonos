import { supabase } from '@/lib/supabase'
import type { Project, ProjectSpend } from '@/lib/types'

const PROJECT_BASE =
  'id, name, client_name, site_address, status, contract_value, management_fee_pct'
/** management_fee_amount is the generated column from migration 008. */
const PROJECT_FULL = `${PROJECT_BASE}, management_fee_amount`

function toProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    client_name: (r.client_name as string | null) ?? null,
    site_address: (r.site_address as string | null) ?? null,
    status: r.status as Project['status'],
    contract_value: num(r.contract_value),
    management_fee_pct: num(r.management_fee_pct),
    management_fee_amount: num(r.management_fee_amount),
  }
}

/** Projects visible to the signed-in user (RLS: projects_read → is_member). */
export async function fetchProjects(): Promise<Project[]> {
  const full = await supabase
    .from('projects')
    .select(PROJECT_FULL)
    .order('name')

  let rows: unknown[] = full.data ?? []

  if (full.error) {
    const retry = await supabase
      .from('projects')
      .select(PROJECT_BASE)
      .order('name')
    if (retry.error) throw retry.error
    rows = retry.data ?? []
  }

  return rows.map((r) => toProject(r as Record<string, unknown>))
}

/** Returns null when RLS hides the project rather than throwing. */
export async function fetchProject(id: string): Promise<Project | null> {
  const full = await supabase
    .from('projects')
    .select(PROJECT_FULL)
    .eq('id', id)
    .maybeSingle()

  let row: unknown = full.data

  if (full.error) {
    const retry = await supabase
      .from('projects')
      .select(PROJECT_BASE)
      .eq('id', id)
      .maybeSingle()
    if (retry.error) throw retry.error
    row = retry.data
  }

  return row ? toProject(row as Record<string, unknown>) : null
}

const SPEND_BASE = 'project_id, name, total_spent, total_budget'
const SPEND_FULL = `${SPEND_BASE}, remaining, pct_used`

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

/**
 * Reads public.v_project_spend. The view is security_invoker, so RLS decides
 * which projects come back and whether expense amounts are visible at all
 * (supervisors see no expense rows, so total_spent reads 0 for them).
 *
 * `remaining` and `pct_used` arrive with migration 007. Until that's applied
 * PostgREST rejects the column list, so we retry with the original one and
 * return nulls — the dashboard then hides the delta line rather than breaking.
 */
export async function fetchProjectSpend(): Promise<ProjectSpend[]> {
  const full = await supabase
    .from('v_project_spend')
    .select(SPEND_FULL)
    .order('name')

  let rows: unknown[] = full.data ?? []

  if (full.error) {
    const retry = await supabase
      .from('v_project_spend')
      .select(SPEND_BASE)
      .order('name')
    if (retry.error) throw retry.error
    rows = retry.data ?? []
  }

  return rows.map((r) => {
    const row = r as Record<string, unknown>
    return {
      project_id: row.project_id as string,
      name: row.name as string,
      total_spent: Number(row.total_spent),
      total_budget: Number(row.total_budget),
      remaining: num(row.remaining),
      pct_used: num(row.pct_used),
    }
  })
}
