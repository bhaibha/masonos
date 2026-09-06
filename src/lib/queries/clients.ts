import { supabase } from '@/lib/supabase'
import type {
  ClientRosterRow,
  ClientRosterSummary,
  NewClientInput,
  ProjectStatus,
} from '@/lib/types'

/**
 * Founder-only client portal administration (migration 067).
 *
 * Nothing here bypasses RLS. `v_client_roster` is owner-run with its audience
 * in the WHERE clause, and all four RPCs raise for anyone who is not a founder.
 * A non-founder calling these gets a refusal from Postgres, not a client-side
 * block — this file only decides what to render.
 *
 * Creating the LOGIN is the one thing the browser cannot do (it needs the
 * service-role key), so it goes through the admin-create-user Edge Function,
 * which writes the auth user, the profile and the client_projects link together
 * and deletes the user if the link fails.
 */

/* ---------------- Read ---------------- */

export async function fetchClientRoster(): Promise<ClientRosterRow[]> {
  const { data, error } = await supabase
    .from('v_client_roster')
    .select('*')
    .order('project_name')

  if (error) throw error
  return (data ?? []) as ClientRosterRow[]
}

/**
 * Zero rows is a legitimate answer here, not an error: 067 makes the summary
 * return nothing to anyone outside founder/pm/accounts rather than a row of
 * zeros, because "0 clients" reads as a fact about the company (the 066
 * lesson). Callers render nothing when this is null.
 */
export async function fetchClientRosterSummary(): Promise<ClientRosterSummary | null> {
  const { data, error } = await supabase.rpc('fn_client_roster_summary')
  if (error) throw error
  const rows = (data ?? []) as ClientRosterSummary[]
  return rows.length > 0 ? rows[0] : null
}

/**
 * Projects with no client account yet — the grant form's picker.
 *
 * Returns its own narrow shape rather than `Project`. Padding it out to a full
 * Project would mean inventing `contract_value: null` and
 * `management_fee_amount: null` for money columns this function deliberately
 * never selects — a shape that claims to know the fee and reports it as absent
 * is worse than one that never mentions it.
 */
export interface ProjectOption {
  id: string
  name: string
  status: ProjectStatus
}

export async function fetchProjectsWithoutClient(): Promise<ProjectOption[]> {
  const { data, error } = await supabase.rpc('fn_projects_without_client')
  if (error) throw error

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.project_id as string,
    name: r.project_name as string,
    status: r.status as ProjectStatus,
  }))
}

/* ---------------- Write ---------------- */

/**
 * Creates the login, the profile and the project link in one call. The Edge
 * Function rolls the auth user back if the link fails, so there is no
 * half-created client — the state that produces "Your account is not linked to
 * a project yet" and needs SQL to repair.
 */
export async function createClient(input: NewClientInput): Promise<string> {
  const { data, error } = await supabase.functions.invoke('admin-create-user', {
    body: {
      email: input.email.trim().toLowerCase(),
      password: input.password,
      full_name: input.full_name.trim(),
      phone: input.phone.trim(),
      role: 'client',
      client_project_id: input.project_id,
      mode: input.mode,
      redirect_to: `${window.location.origin}/set-password`,
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
        if (
          parsed instanceof Error &&
          parsed.message !== 'Unexpected end of JSON input'
        ) {
          throw parsed
        }
      }
    }
    throw error
  }

  if (data?.error) throw new Error(String(data.error))
  return String(data?.id ?? '')
}

/**
 * Suspend or restore. This is the handover case and the common one: the login
 * stops, the record of what they approved stays. Reversible.
 */
export async function setClientActive(
  userId: string,
  active: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('fn_set_client_active', {
    p_user: userId,
    p_active: active,
  })
  if (error) throw error
}

/**
 * Remove portal access entirely — wrong person, or wrong project. Deletes the
 * link and deactivates the account. The profile survives, because their name is
 * stamped on approvals they signed.
 */
export async function unlinkClient(userId: string): Promise<void> {
  const { error } = await supabase.rpc('fn_unlink_client', { p_user: userId })
  if (error) throw error
}

/** Re-link, or move a client to a different project. */
export async function linkClient(
  userId: string,
  projectId: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_link_client', {
    p_user: userId,
    p_project: projectId,
  })
  if (error) throw error
}

/* ---------------- Recovery ---------------- */

/**
 * Sends the client a password reset link.
 *
 * Uses the ANON key and the caller's own session — `resetPasswordForEmail`
 * needs no privilege, so no Edge Function and no service-role key is involved.
 * The link lands on /set-password with `type=recovery`, which is the same
 * screen an invite lands on.
 *
 * ONLY OFFERED TO A CLIENT WHO HAS SIGNED IN BEFORE. Someone who never accepted
 * their invitation has no password to reset; sending them a recovery link is
 * the wrong email and leaves them exactly as stuck. That case needs the invite
 * re-sent, which is a service-role operation and waits on SMTP.
 *
 * Nothing here confirms the address exists — Supabase deliberately answers the
 * same way either way, and the toast copies that.
 */
export async function sendClientPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/set-password`,
  })
  if (error) throw error
}
