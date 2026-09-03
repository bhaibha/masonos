import { supabase } from '@/lib/supabase'

/**
 * THE TEAM SIDE of the client message thread (065 table, 072 read-marking).
 *
 * The client's half lives in queries/portal.ts and reads the curated
 * `v_client_messages`. This reads the base table, which internal members are
 * permitted to do — `client_messages_read` allows `is_member(project_id)`.
 *
 * Both halves write to the same table and a BEFORE INSERT trigger stamps
 * `from_client` and `author_id`, so neither side can post as the other. That is
 * why this file never sends those columns: they would be discarded, and sending
 * them would imply the browser has a say.
 */

export interface TeamClientMessage {
  id: string
  project_id: string
  body: string
  from_client: boolean
  author_name: string | null
  created_at: string
  read_at: string | null
}

interface Joined {
  profiles: { full_name: string } | { full_name: string }[] | null
}

function authorName(row: unknown): string | null {
  const p = (row as Joined).profiles
  if (!p) return null
  return Array.isArray(p) ? (p[0]?.full_name ?? null) : p.full_name
}

/**
 * The whole thread, oldest first — a conversation reads top to bottom.
 *
 * Ordered by created_at rather than paginated: this is a client on a house,
 * not a support queue. If a thread ever gets long enough to need paging, that
 * is a signal the conversation should have been a phone call.
 */
export async function fetchThread(
  projectId: string,
): Promise<TeamClientMessage[]> {
  const { data, error } = await supabase
    .from('client_messages')
    .select('id, project_id, body, from_client, created_at, read_at, profiles(full_name)')
    .eq('project_id', projectId)
    .order('created_at')

  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    body: r.body as string,
    from_client: Boolean(r.from_client),
    // A client's own name is not shown to the team as an author line — the
    // side of the thread already says who it is, and repeating it is noise.
    author_name: r.from_client ? null : authorName(r),
    created_at: r.created_at as string,
    read_at: (r.read_at as string | null) ?? null,
  }))
}

/** Founder/PM only, matching client_messages_write (065). */
export async function replyToClient(
  projectId: string,
  body: string,
): Promise<void> {
  const { error } = await supabase
    .from('client_messages')
    .insert({ project_id: projectId, body: body.trim() })
  if (error) throw error
}

/**
 * Marks the client's unread messages read. Returns how many were marked, so the
 * caller can skip a refetch when nothing changed.
 *
 * `client_messages` has no UPDATE policy — a sent message stays sent — so this
 * goes through a SECURITY DEFINER function that touches only `read_at`, and
 * only on rows the client sent (072).
 */
export async function markThreadRead(projectId: string): Promise<number> {
  const { data, error } = await supabase.rpc('fn_mark_client_messages_read', {
    p_project: projectId,
  })
  if (error) throw error
  return Number(data ?? 0)
}

/** Unread count for one project — drives the tab badge. */
export async function fetchUnreadCount(projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from('client_messages')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('from_client', true)
    .is('read_at', null)

  if (error) throw error
  return count ?? 0
}

/* ---------------- What the client is waiting on (migration 073) ---------------- */

/**
 * Counts of client-originated things nobody has looked at, plus approvals the
 * client has been sitting on. Returns null when there is NOTHING waiting —
 * `fn_client_attention` returns zero rows in that case on purpose, so the
 * dashboard strip renders only when it has something to say.
 *
 * There is deliberately no stored "important" flag behind this. A flag that is
 * true for everything a client sends is a permanent badge, and a permanent
 * badge is one people stop seeing.
 */
export interface ClientAttention {
  unread_messages: number
  unseen_rejections: number
  unseen_approvals: number
  stale_pending: number
  oldest_pending_days: number | null
  latest_message_at: string | null
}

export async function fetchClientAttention(): Promise<ClientAttention | null> {
  const { data, error } = await supabase.rpc('fn_client_attention')
  // Returns null rather than throwing, and the strip simply does not render —
  // matching fetchComplianceAlert. Also covers the window before 073 is applied.
  if (error) return null

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined
  if (!row) return null

  return {
    unread_messages: Number(row.unread_messages ?? 0),
    unseen_rejections: Number(row.unseen_rejections ?? 0),
    unseen_approvals: Number(row.unseen_approvals ?? 0),
    stale_pending: Number(row.stale_pending ?? 0),
    oldest_pending_days:
      row.oldest_pending_days === null ? null : Number(row.oldest_pending_days),
    latest_message_at: (row.latest_message_at as string | null) ?? null,
  }
}

/** Marks the client's decisions as seen when the register is opened (073). */
export async function markApprovalsSeen(projectId: string): Promise<number> {
  const { data, error } = await supabase.rpc('fn_mark_approvals_seen', {
    p_project: projectId,
  })
  if (error) throw error
  return Number(data ?? 0)
}
