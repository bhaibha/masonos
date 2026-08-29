import { supabase } from '@/lib/supabase'
import type {
  AssistantActionKind,
  AssistantProposal,
} from '@/lib/types'

const rows = (d: unknown) => (d ?? []) as unknown as Record<string, unknown>[]

export interface StreamHandlers {
  onText: (delta: string) => void
  onTool: (name: string, args: Record<string, unknown>) => void
  onProposal: (p: Omit<AssistantProposal, 'state'>) => void
  onError: (message: string) => void
  onDone: () => void
}

/**
 * Sends a message and streams the reply.
 *
 * Uses `fetch` directly rather than `supabase.functions.invoke`, because invoke
 * buffers the whole response — there is no way to read it as it arrives, which
 * is the entire point of an SSE endpoint. The session token is attached by hand
 * for the same reason.
 *
 * Returns an abort function so leaving the panel stops the stream rather than
 * leaving it writing into a component that has gone.
 */
export async function streamAssistant(
  input: {
    message: string
    threadId: string | null
    projectHint: string | null
    history: { role: string; content: string }[]
  },
  h: StreamHandlers,
): Promise<() => void> {
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  if (!token) {
    h.onError('Your session has expired. Sign in again.')
    h.onDone()
    return () => {}
  }

  const base = import.meta.env.VITE_SUPABASE_URL as string
  const controller = new AbortController()

  void (async () => {
    try {
      const res = await fetch(`${base}/functions/v1/assistant`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        },
        body: JSON.stringify({
          message: input.message,
          thread_id: input.threadId,
          project_hint: input.projectHint,
          history: input.history,
        }),
      })

      if (!res.ok || !res.body) {
        // The function returns its own message on a non-2xx — surface that
        // rather than a status code, which tells nobody whether the key is
        // missing, the quota is spent or the model was retired.
        let msg = `The assistant is unavailable (${res.status}).`
        try {
          const b = await res.json()
          if (b?.error) msg = String(b.error)
        } catch {
          /* body was not JSON; keep the generic message */
        }
        h.onError(msg)
        h.onDone()
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })

        // SSE frames are separated by a blank line.
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''

        for (const frame of frames) {
          let event = 'message'
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) data += line.slice(5).trim()
          }
          if (!data) continue

          let payload: Record<string, unknown>
          try {
            payload = JSON.parse(data)
          } catch {
            continue
          }

          if (event === 'text') h.onText(String(payload.delta ?? ''))
          else if (event === 'tool')
            h.onTool(
              String(payload.name ?? ''),
              (payload.args as Record<string, unknown>) ?? {},
            )
          else if (event === 'proposal')
            h.onProposal({
              action_id: String(payload.action_id),
              kind: payload.kind as AssistantActionKind,
              project: String(payload.project ?? ''),
              values: (payload.values as Record<string, unknown>) ?? {},
            })
          else if (event === 'error') h.onError(String(payload.message ?? ''))
          else if (event === 'done') h.onDone()
        }
      }
      h.onDone()
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      h.onError(
        'The browser could not reach the assistant. Check that the ' +
          '"assistant" function is deployed and that you are online.',
      )
      h.onDone()
    }
  })()

  return () => controller.abort()
}

/**
 * Writes the proposed record.
 *
 * `fn_assistant_execute` is SECURITY INVOKER, so the insert obeys the caller's
 * own RLS exactly as if they had filled in the form — a supervisor confirming
 * an RFI proposal is refused by the RFI table's own policy, not by a role check
 * that could drift from it.
 */
export async function confirmProposal(
  actionId: string,
): Promise<{ id: string; kind: string }> {
  const { data, error } = await supabase.rpc('fn_assistant_execute', {
    p_id: actionId,
  })
  if (error) throw error
  return data as { id: string; kind: string }
}

export async function cancelProposal(
  actionId: string,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('fn_assistant_cancel', {
    p_id: actionId,
    p_reason: reason,
  })
  if (error) throw error
}

/* ---------------- threads ---------------- */

export async function createThread(
  title: string,
  projectId: string | null,
): Promise<string> {
  const { data, error } = await supabase
    .from('chat_threads')
    .insert({ title: title.slice(0, 80), project_id: projectId })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

export async function saveMessage(
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
  toolCalls: unknown[],
): Promise<void> {
  const { error } = await supabase.from('chat_messages').insert({
    thread_id: threadId,
    role,
    content,
    tool_calls: toolCalls,
  })
  if (error) throw error
}

export async function fetchThreadMessages(
  threadId: string,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('thread_id', threadId)
    .order('created_at')
    .limit(100)
  if (error) throw error
  return rows(data).map((r) => ({
    role: r.role as 'user' | 'assistant',
    content: r.content as string,
  }))
}

export async function fetchRecentThreads(): Promise<
  { id: string; title: string | null; updated_at: string }[]
> {
  const { data, error } = await supabase
    .from('chat_threads')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })
    .limit(20)
  if (error) return []
  return rows(data).map((r) => ({
    id: r.id as string,
    title: (r.title as string | null) ?? null,
    updated_at: r.updated_at as string,
  }))
}

/** Calls used today, and how often proposals get confirmed. */
export async function fetchAssistantStats(): Promise<{
  callsToday: number
  confirmRate: number | null
} | null> {
  const { data, error } = await supabase.rpc('fn_assistant_stats')
  if (error) return null
  const r = rows(data)[0]
  if (!r) return null
  return {
    callsToday: Number(r.calls_today ?? 0),
    confirmRate:
      r.confirm_rate_pct == null ? null : Number(r.confirm_rate_pct),
  }
}
