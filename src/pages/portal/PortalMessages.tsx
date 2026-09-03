import { MessageSquare, Send } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { Textarea } from '@/components/Field'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import { type ClientMessage, fetchMessages, sendMessage } from '@/lib/queries/portal'
import { cn } from '@/lib/utils'

export default function PortalMessages() {
  const [msgs, setMsgs] = useState<ClientMessage[] | null>(null)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(async () => {
    try {
      setMsgs(await fetchMessages())
    } catch {
      setMsgs([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [msgs])

  async function send() {
    const text = body.trim()
    if (!text) return
    setSending(true)
    try {
      await sendMessage(text)
      setBody('')
      await reload()
    } catch (err) {
      toast.error('Could not send that', { description: errText(err) })
    }
    setSending(false)
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Messages
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          A record of what was said, alongside the project.
        </p>
      </div>

      {msgs === null && <ListSkeleton rows={3} />}

      {msgs?.length === 0 && (
        <EmptyState
          icon={MessageSquare}
          title="No messages yet"
          body="Anything you write here reaches your project team and stays on record."
        />
      )}

      {msgs && msgs.length > 0 && (
        <ul className="space-y-3">
          {msgs.map((m) => (
            <li
              key={m.id}
              className={cn('flex', m.from_client ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-4 py-3 sm:max-w-[70%]',
                  m.from_client
                    ? 'bg-primary/10 text-foreground'
                    : 'border border-border bg-surface',
                )}
              >
                {!m.from_client && m.author_name && (
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {m.author_name}
                  </p>
                )}
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

      {/* The composer stays visible even on an empty thread — an empty state
          that says "write something" with no box to write in is a dead end. */}
      <div className="paper space-y-3 p-4">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a message to your project team…"
          aria-label="Message"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            Urgent? Call your project manager — this is not monitored constantly.
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
