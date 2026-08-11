import { supabase } from '@/lib/supabase'
import type {
  NewProjectInput,
  NewUserInput,
  Project,
  ProjectStatus,
  TeamMember,
  UserRole,
} from '@/lib/types'

/**
 * Founder-only admin operations.
 *
 * Nothing here bypasses RLS. `projects_write` and `members_write` (001_core.sql)
 * already restrict INSERT/UPDATE/DELETE to is_founder(), and `profiles_admin`
 * restricts profile UPDATE the same way — so a non-founder calling any of these
 * gets a policy violation from Postgres, not a client-side block.
 *
 * User creation is the one thing the browser cannot do (it needs the
 * service-role key), so it goes through the admin-create-user Edge Function.
 */

/* ---------------- Projects ---------------- */

/**
 * Migration 010 revoked SELECT on contract_value / management_fee_pct and
 * re-granted an explicit column list without them. PostgREST's default
 * `Prefer: return=representation` re-SELECTs every column after a write, which
 * would hit that revoke — so every write below selects only granted columns.
 */
const WRITE_RETURN = 'id, name, client_name, site_address, status'

export async function createProject(input: NewProjectInput): Promise<Project> {
  const { data, error } = await supabase
    .from('projects')
    .insert({
      name: input.name.trim(),
      client_name: input.client_name.trim() || null,
      site_address: input.site_address.trim() || null,
      status: input.status,
      contract_value: input.contract_value,
      management_fee_pct: input.management_fee_pct,
      start_date: input.start_date,
      target_end_date: input.target_end_date,
      floors: input.floors,
      plot_area_sqft: input.plot_area_sqft,
    })
    .select(WRITE_RETURN)
    .single()

  if (error) throw error

  const r = data as Record<string, unknown>
  return {
    id: r.id as string,
    name: r.name as string,
    client_name: (r.client_name as string | null) ?? null,
    site_address: (r.site_address as string | null) ?? null,
    status: r.status as ProjectStatus,
    // Written above but not readable back — 010 revoked SELECT on these.
    contract_value: null,
    management_fee_pct: null,
    management_fee_amount: null,
  }
}

/**
 * Deliberately does NOT write the build parameters (start/end/floors/area).
 *
 * 010 revoked SELECT on some project columns and the edit form cannot read
 * these four back, so it would post nulls and silently wipe what generated the
 * programme. They are set once at creation, and afterwards through the
 * Schedule tab's rebuild, which writes them as part of generating.
 */
export async function updateProject(
  id: string,
  input: NewProjectInput,
): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({
      name: input.name.trim(),
      client_name: input.client_name.trim() || null,
      site_address: input.site_address.trim() || null,
      status: input.status,
      contract_value: input.contract_value,
      management_fee_pct: input.management_fee_pct,
    })
    .eq('id', id)
    .select(WRITE_RETURN)
    .single()

  if (error) throw error
}

export async function setProjectStatus(
  id: string,
  status: ProjectStatus,
): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ status })
    .eq('id', id)
    .select('id, status')
    .single()

  if (error) throw error
}

/* ---------------- Team ---------------- */

const PROFILE_COLS = 'id, full_name, phone, role, is_active, designation'

/**
 * Everyone in the org plus their project assignments.
 * `profiles_read` is `using (true)`, so this works for any signed-in user —
 * the founder-only gate on the screen is a UX choice, and the write paths are
 * where RLS actually enforces it.
 */
export async function fetchTeam(): Promise<TeamMember[]> {
  const [people, members] = await Promise.all([
    supabase.from('profiles').select(PROFILE_COLS).order('full_name'),
    supabase.from('project_members').select('project_id, user_id'),
  ])

  if (people.error) throw people.error

  const byUser = new Map<string, string[]>()
  for (const m of members.data ?? []) {
    const uid = m.user_id as string
    const list = byUser.get(uid) ?? []
    list.push(m.project_id as string)
    byUser.set(uid, list)
  }

  return (people.data ?? []).map((r) => {
    const row = r as Record<string, unknown>
    return {
      id: row.id as string,
      full_name: (row.full_name as string) ?? '',
      phone: (row.phone as string | null) ?? null,
      role: row.role as UserRole,
      is_active: Boolean(row.is_active),
      designation: (row.designation as string | null) ?? null,
      project_ids: byUser.get(row.id as string) ?? [],
    }
  })
}

/**
 * Creates the login + profile via the Edge Function, which holds the
 * service-role key server-side and re-checks that the caller is a founder.
 * The browser never sees that key (CLAUDE.md rule 1).
 */
export async function createUser(input: NewUserInput): Promise<string> {
  const { data, error } = await supabase.functions.invoke('admin-create-user', {
    body: {
      email: input.email.trim().toLowerCase(),
      password: input.password,
      full_name: input.full_name.trim(),
      phone: input.phone.trim(),
      role: input.role,
      designation: input.designation,
      project_ids: input.project_ids,
    },
  })

  if (error) {
    // functions.invoke wraps non-2xx in a FunctionsHttpError whose message is
    // just "non-2xx status code" — the useful text is in the response body.
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try {
        const body = await ctx.json()
        if (body?.error) throw new Error(String(body.error))
      } catch (parsed) {
        if (parsed instanceof Error && parsed.message !== 'Unexpected end of JSON input') {
          throw parsed
        }
      }
    }
    throw error
  }

  if (data?.error) throw new Error(String(data.error))
  return String(data?.id ?? '')
}

/** Role, designation and contact details. `profiles_admin` gates this to founders. */
export async function updateTeamMember(
  id: string,
  patch: {
    full_name?: string
    phone?: string
    role?: UserRole
    designation?: string
    is_active?: boolean
  },
): Promise<void> {
  const body: Record<string, unknown> = {}
  if (patch.full_name !== undefined) body.full_name = patch.full_name.trim()
  if (patch.phone !== undefined) body.phone = patch.phone.trim() || null
  if (patch.role !== undefined) body.role = patch.role
  if (patch.designation !== undefined) body.designation = patch.designation || null
  if (patch.is_active !== undefined) body.is_active = patch.is_active

  const { error } = await supabase.from('profiles').update(body).eq('id', id)
  if (error) throw error
}

/**
 * Replaces a person's project assignments with exactly `projectIds`.
 * Deleting rows for projects they've left is what actually revokes access —
 * every is_member() check reads this table.
 */
export async function setProjectAssignments(
  userId: string,
  projectIds: string[],
): Promise<void> {
  const current = await supabase
    .from('project_members')
    .select('project_id')
    .eq('user_id', userId)

  if (current.error) throw current.error

  const have = new Set((current.data ?? []).map((r) => r.project_id as string))
  const want = new Set(projectIds)

  const toAdd = [...want].filter((p) => !have.has(p))
  const toRemove = [...have].filter((p) => !want.has(p))

  if (toAdd.length > 0) {
    const { error } = await supabase
      .from('project_members')
      .insert(toAdd.map((project_id) => ({ project_id, user_id: userId })))
    if (error) throw error
  }

  if (toRemove.length > 0) {
    const { error } = await supabase
      .from('project_members')
      .delete()
      .eq('user_id', userId)
      .in('project_id', toRemove)
    if (error) throw error
  }
}
