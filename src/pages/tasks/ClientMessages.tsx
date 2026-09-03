import { MessageSquare, Send } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { Textarea } from '@/components/Field'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import {
  fetchThread,
  markThreadRead,
  replyToClient,
  type TeamClientMessage,
} from '@/lib/queries/clientMessages'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/**
 * THE TEAM SIDE of the client thread — the half that was missing when CP3
 * shipped, which left a client typing into a table nobody could open.
 *
 * Lives under Tasks rather than Admin: this is project conversation, not portal
 * administration. Admin -> Clients reports the unread COUNT and links here; the
 * reading and replying happen next to the work being discussed.
 */
export default function ClientMessages() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  // Matches client_messages_write (065): founder and PM speak to the client.
  // A supervisor can read the thread — useful context on site — but what the
  // firm says to a client in writing is not a site decision.
  const canReply = role === 'founder' || role === 'pm'

  const [msgs, setMsgs] = useState<TeamClientMessage[] | null>(null)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!projectId) return
    try {
      const thread = await fetchThread(projectId)
      setMsgs(thread)

      // Marking read is a side effect of a human OPENING the thread, so it
      // happens here rather than on a button. It only touches messages the
      // client sent, and only ones not already marked (072).
      if (thread.some((m) => m.from_client && !m.read_at)) {
        await markThreadRead(projectId).catch(() => {
          // Not worth a toast: the thread loaded, which is what was asked for.
        })
      }
    } catch (err) {
      setMsgs([])
      toast.error('Could not load the thread', { description: errText(err) })
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [msgs])

  async function send() {
    const text = body.trim()
    if (!text || !projectId) return
    setSending(true)
    try {
      await replyToClient(projectId, text)
      setBody('')
      await load()
    } catch (err) {
      toast.error('Could not send that', { description: errText(err) })
    }
    setSending(false)
  }

  if (!projectId) {
    return <p className="text-sm text-muted-foreground">Pick a project first.</p>
  }

  return (
    <div className="page-w space-y-5">
      <div>
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Client messages
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          The thread your client sees in their portal. Anything written here
          reaches them straight away.
        </p>
      </div>

      {msgs === null && <ListSkeleton rows={3} />}

      {msgs?.length === 0 && (
        <EmptyState
          icon={MessageSquare}
          title="No messages yet"
          body={
            canReply
              ? 'Start the conversation, or wait for your client to. Everything said here stays on the project record.'
              : 'Nothing has been said on this project yet.'
          }
        />
      )}

      {msgs && msgs.length > 0 && (
        <ul className="space-y-3">
          {msgs.map((m) => (
            <li
              key={m.id}
              className={cn('flex', m.from_client ? 'justify-start' : 'justify-end')}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-4 py-3 sm:max-w-[70%]',
                  m.from_client
                    ? 'border border-border bg-surface'
                    : 'bg-primary/10 text-foreground',
                )}
              >
                <p className="text-[11px] font-medium text-muted-foreground">
                  {m.from_client ? 'Client' : (m.author_name ?? 'Your team')}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap">
                  {m.body}
                </p>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  {fmtWhen(m.created_at)}
                </p>
              </div>
            </li>
          ))}
          <div ref={endRef} />
        </ul>
      )}

      {canReply ? (
        <div className="paper space-y-3 p-4">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Reply to your client…"
            aria-label="Reply"
          />
          <div className="flex items-center justify-between gap-3">
            {/* Said plainly, because it is easy to forget which audience this
                is. Nothing here is internal. */}
            <p className="text-[11px] text-muted-foreground">
              The client sees this immediately. It cannot be edited or deleted
              afterwards.
            </p>
            <Button
              className="h-11 shrink-0"
              disabled={sending || !body.trim()}
              onClick={() => void send()}
            >
              <Send className="size-4" />
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          Only a founder or project manager replies to the client.
        </p>
      )}
    </div>
  )
}

function fmtWhen(d: string): string {
  return new Date(d).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}
