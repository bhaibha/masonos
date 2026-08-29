import {
  ArrowUp,
  Check,
  Info,
  Loader2,
  Search,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import {
  cancelProposal,
  confirmProposal,
  createThread,
  saveMessage,
  streamAssistant,
} from '@/lib/queries/assistant'
import {
  ACTION_KIND_LABEL,
  ASSISTANT_DISCLAIMER,
  type AssistantProposal,
  type ChatMessage,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/** Turns a tool name into something a person recognises while it runs. */
const TOOL_LABEL: Record<string, string> = {
  list_projects: 'Looking up your projects',
  tasks_for_day: 'Checking tasks',
  open_snags: 'Checking open snags',
  open_rfis: 'Checking RFIs',
  clash_register: 'Checking the clash register',
  material_stock: 'Checking stock',
  search_knowledge: 'Searching the library',
  project_spend: 'Checking spend',
  budget_vs_actual: 'Checking budget against actual',
  pending_purchase_orders: 'Checking purchase orders',
  compliance_due: 'Checking deadlines',
  health_signals: 'Checking health signals',
  propose_task: 'Drafting a task',
  propose_snag: 'Drafting a snag',
  propose_site_log_note: 'Drafting a site log note',
  propose_rfi: 'Drafting an RFI',
  propose_document_draft: 'Drafting a note',
}

const STARTERS = [
  'What tasks are open today?',
  'Any snags still open?',
  'How do I record material arriving?',
  'What does IS 456 say about cover?',
]

let msgSeq = 0
const newId = () => `m${++msgSeq}`

/**
 * The assistant panel.
 *
 * Reachable from anywhere. Everything it reads and writes goes through the
 * user's own session, so it can only ever see what their role permits — a
 * supervisor asking about margin is told the database refused, not given a
 * misleading zero.
 *
 * It never writes on its own. A write intent renders a confirmation card
 * showing the exact values that will be stored, and only the Confirm button
 * calls the RPC that inserts.
 */
export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const role = useAuth((s) => s.role)
  const projectId = useProjects((s) => s.selectedId)
  const projects = useProjects((s) => s.projects)
  const projectName =
    projects?.find((p) => p.id === projectId)?.name ?? null

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [threadId, setThreadId] = useState<string | null>(null)

  const abortRef = useRef<(() => void) | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Leaving must stop the stream, or it keeps writing into a component that
  // has gone and the tokens are spent on nothing.
  useEffect(() => () => abortRef.current?.(), [])

  const send = useCallback(
    async (text: string) => {
      const question = text.trim()
      if (!question || busy) return

      setInput('')
      setBusy(true)

      const userMsg: ChatMessage = {
        id: newId(),
        role: 'user',
        content: question,
        toolCalls: [],
        proposals: [],
      }
      const replyId = newId()
      const reply: ChatMessage = {
        id: replyId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        proposals: [],
        streaming: true,
      }

      const history = messages.slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
      }))

      setMessages((prev) => [...prev, userMsg, reply])

      // The thread is created lazily on the first message, so opening the panel
      // and closing it again does not litter the history with empty threads.
      let tid = threadId
      if (!tid) {
        try {
          tid = await createThread(question, projectId ?? null)
          setThreadId(tid)
        } catch {
          tid = null // history is a convenience; never block the answer on it
        }
      }
      if (tid) void saveMessage(tid, 'user', question, []).catch(() => {})

      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === replyId ? fn(m) : m)))

      abortRef.current = await streamAssistant(
        {
          message: question,
          threadId: tid,
          projectHint: projectName,
          history,
        },
        {
          onText: (delta) =>
            patch((m) => ({ ...m, content: m.content + delta })),
          onTool: (name, args) =>
            patch((m) => ({ ...m, toolCalls: [...m.toolCalls, { name, args }] })),
          onProposal: (p) =>
            patch((m) => ({
              ...m,
              proposals: [...m.proposals, { ...p, state: 'proposed' }],
            })),
          onError: (message) => patch((m) => ({ ...m, error: message })),
          onDone: () => {
            setBusy(false)
            patch((m) => {
              if (tid && m.content.trim()) {
                void saveMessage(tid, 'assistant', m.content, m.toolCalls).catch(
                  () => {},
                )
              }
              return { ...m, streaming: false }
            })
          },
        },
      )
    },
    [busy, messages, projectId, projectName, threadId],
  )

  return (
    <div
      // Above the bottom nav, which is also z-50 and sits later in the DOM —
      // at equal z-index it would paint over the composer on a phone, where
      // the panel is full-screen.
      className="fixed inset-0 z-[60] flex flex-col bg-[var(--bg)] sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[440px] sm:border-l sm:border-border sm:shadow-2xl"
    >
      {/* header */}
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="font-heading flex items-center gap-2 text-[15px] font-semibold">
            <span
              aria-hidden
              className="flex size-6 items-center justify-center rounded-full border border-border text-[13px] leading-none text-[color-mix(in_oklab,var(--ink)_85%,transparent)]"
            >
              M
            </span>
            Assistant
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {projectName ? `${projectName} · ` : ''}
            {role ?? 'signed out'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the assistant"
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* conversation */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <>
            <p className="flex items-start gap-2 rounded-lg bg-secondary/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              {ASSISTANT_DISCLAIMER}
            </p>
            <div className="space-y-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="paper w-full p-3 text-left text-sm transition-shadow hover:shadow-[var(--shadow-card-lift)]"
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        )}

        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--accent)] px-4 py-2.5 text-sm text-white">
                {m.content}
              </p>
            </div>
          ) : (
            <AssistantTurn key={m.id} msg={m} />
          ),
        )}

        <div ref={endRef} />
      </div>

      {/* composer */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
            rows={1}
            placeholder="Ask about your projects, or how to do something…"
            aria-label="Message the assistant"
            className="min-h-12 flex-1 resize-none rounded-xl border border-border bg-surface px-3 py-3 text-base outline-none focus:border-[var(--accent)]"
          />
          <Button
            className="size-12 shrink-0 rounded-xl p-0"
            disabled={busy || input.trim() === ''}
            onClick={() => void send(input)}
            aria-label="Send"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          It can draft records for you to confirm. It never creates, changes or
          deletes anything by itself, and never touches money.
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function AssistantTurn({ msg }: { msg: ChatMessage }) {
  return (
    <div className="space-y-2">
      {/* What it looked at. Shown while running and kept afterwards, so "why
          did it say that" stays answerable. */}
      {msg.toolCalls.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {msg.toolCalls.map((t, i) => (
            <span
              key={i}
              className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              <Search className="size-2.5" />
              {TOOL_LABEL[t.name] ?? t.name}
            </span>
          ))}
        </div>
      )}

      {(msg.content || msg.streaming) && (
        <div className="rounded-2xl rounded-bl-sm border border-[var(--accent)]/25 bg-[color-mix(in_oklab,var(--accent)_5%,transparent)] px-4 py-3">
          {msg.content ? (
            <div className="text-sm leading-relaxed">
              <Markdown source={msg.content} />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Thinking…
            </div>
          )}
        </div>
      )}

      {msg.proposals.map((p) => (
        <ProposalCard key={p.action_id} proposal={p} />
      ))}

      {msg.error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {msg.error}
        </p>
      )}
    </div>
  )
}

/**
 * The confirmation card.
 *
 * It renders the SAME payload that was stored by fn_assistant_propose, so what
 * is shown and what gets inserted cannot drift. Nothing exists until Confirm.
 */
function ProposalCard({ proposal }: { proposal: AssistantProposal }) {
  const [state, setState] = useState(proposal.state)
  const [busy, setBusy] = useState(false)

  const entries = Object.entries(proposal.values).filter(
    ([, v]) => v !== null && v !== undefined && String(v).trim() !== '',
  )

  return (
    <div className="paper space-y-3 border-[var(--accent)]/40 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="font-heading text-[14px] font-semibold">
          {ACTION_KIND_LABEL[proposal.kind]}
        </p>
        <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
          {proposal.project}
        </span>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Nothing has been created yet. Check the values and confirm.
      </p>

      <dl className="space-y-1.5 rounded-lg bg-secondary/50 p-3 text-xs">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="w-28 shrink-0 text-muted-foreground">
              {k.replace(/_/g, ' ')}
            </dt>
            <dd className="min-w-0 flex-1 break-words">{String(v)}</dd>
          </div>
        ))}
      </dl>

      {state === 'proposed' && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            className="h-11"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await cancelProposal(proposal.action_id, null)
                setState('cancelled')
                toast.success('Discarded')
              } catch (err) {
                toast.error('Could not discard', { description: errText(err) })
                setBusy(false)
              }
            }}
          >
            Discard
          </Button>
          <Button
            className="h-11 gap-1.5"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await confirmProposal(proposal.action_id)
                setState('confirmed')
                toast.success('Created', {
                  description: 'It carries your name, not the assistant’s.',
                })
              } catch (err) {
                // An RLS refusal lands here — e.g. a supervisor confirming an
                // RFI. The message names the table, which is the honest answer.
                toast.error('Could not create it', {
                  description: errText(err),
                })
                setBusy(false)
              }
            }}
          >
            <Check className="size-3.5" /> Confirm
          </Button>
        </div>
      )}

      {state === 'confirmed' && (
        <p className="flex items-center gap-1.5 text-xs text-[var(--positive)]">
          <Check className="size-3.5" /> Created.
        </p>
      )}
      {state === 'cancelled' && (
        <p className="text-xs text-muted-foreground">Discarded.</p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/** The floating button that opens the panel, mounted once in the shell. */
export function AssistantLauncher() {
  const [open, setOpen] = useState(false)
  const role = useAuth((s) => s.role)

  if (!role) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open the assistant"
        className={cn(
          // bottom-24 at EVERY width, and above the nav's z-50.
          // The tab bar is `fixed bottom-0` on desktop too, not just on a
          // phone — an earlier `sm:bottom-6` put this 24px up, underneath a
          // 68px-tall translucent nav, where it was faintly visible through
          // the backdrop-blur and impossible to tap.
          'fixed right-4 bottom-24 z-[55] flex size-14 items-center justify-center',
          // No bottom tab bar at lg, so it can sit down in the corner.
          'lg:bottom-6',
          // A serif M in grey on a light surface, not a coloured AI blob.
          // The accent is brass and the design system spends it sparingly on
          // primary actions and key figures; a permanently-floating button is
          // neither, and in that colour it competed with the numbers on the
          // dashboard from across the screen.
          'rounded-full border border-border bg-surface shadow-lg',
          'transition-transform active:scale-95 hover:bg-secondary',
        )}
      >
        {/* Dark grey rather than the mid `--muted`: at 56px on a white circle
            the lighter grey read as disabled. Expressed against `--ink` so it
            stays a warm charcoal and not a cold slate. */}
        <span
          aria-hidden
          className="font-heading text-2xl leading-none font-semibold text-[color-mix(in_oklab,var(--ink)_85%,transparent)]"
        >
          M
        </span>
      </button>

      {open && <AssistantPanel onClose={() => setOpen(false)} />}
    </>
  )
}
