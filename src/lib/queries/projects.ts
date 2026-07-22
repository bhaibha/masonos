import { supabase } from '@/lib/supabase'
import type { Project, ProjectSpend } from '@/lib/types'

/**
 * Only the non-commercial columns. Since migration 010, `authenticated` has no
 * SELECT on contract_value / management_fee_pct / management_fee_amount, so
 * requesting them here would 400 for everyone. Commercials come from
 * v_project_commercials via fetchProjectCommercials().
 */
const PROJECT_COLUMNS = 'id, name, client_name, site_address, status'

function toProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    client_name: (r.client_name as string | null) ?? null,
    site_address: (r.site_address as string | null) ?? null,
    status: r.status as Project['status'],
    // Filled in separately for money-roles; null everywhere else.
    contract_value: null,
    management_fee_pct: null,
    management_fee_amount: null,
  }
}

/** Projects visible to the signed-in user (RLS: projects_read → is_member). */
export async function fetchProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_COLUMNS)
    .order('name')

  if (error) throw error
  return (data ?? []).map((r) => toProject(r as Record<string, unknown>))
}

/** Returns null when RLS hides the project rather than throwing. */
export async function fetchProject(id: string): Promise<Project | null> {
  const { data, error } = await supabase
    .from('projects')
    .select(PROJECT_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data ? toProject(data as Record<string, unknown>) : null
}

export interface ProjectCommercials {
  contract_value: number | null
  management_fee_pct: number | null
  management_fee_amount: number | null
}

/**
 * Contract value + management fee for one project, from the role-gated
 * v_project_commercials view (migration 010). Only call this for money-roles.
 *
 * Returns null rather than throwing when the caller isn't permitted (the view
 * returns zero rows for supervisors) or — before 010 is applied — when the view
 * doesn't exist yet. In that pre-010 window it falls back to reading the
 * columns straight off projects, which still works until the revoke lands.
 */
export async function fetchProjectCommercials(
  id: string,
): Promise<ProjectCommercials | null> {
  const view = await supabase
    .from('v_project_commercials')
    .select('contract_value, management_fee_pct, management_fee_amount')
    .eq('id', id)
    .maybeSingle()

  if (!view.error) {
    return view.data
      ? {
          contract_value: num(view.data.contract_value),
          management_fee_pct: num(view.data.management_fee_pct),
          management_fee_amount: num(view.data.management_fee_amount),
        }
      : null
  }

  // Pre-010 fallback: the view isn't there yet, read the table directly.
  const direct = await supabase
    .from('projects')
    .select('contract_value, management_fee_pct, management_fee_amount')
    .eq('id', id)
    .maybeSingle()

  if (direct.error || !direct.data) return null
  return {
    contract_value: num(direct.data.contract_value),
    management_fee_pct: num(direct.data.management_fee_pct),
    management_fee_amount: num(direct.data.management_fee_amount),
  }
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
