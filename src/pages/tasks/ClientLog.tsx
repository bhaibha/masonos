import { AlertTriangle, MessageCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  closeCommitment,
  closeComplaint,
  createCommEntry,
  createCommitment,
  createComplaint,
  fetchCommAttention,
  fetchCommEntries,
  fetchCommitments,
  fetchComplaints,
  reopenCommitment,
  reopenComplaint,
  updateCommEntry,
} from '@/lib/queries/clientLog'
import { fetchApprovals } from '@/lib/queries/approvals'
import { fetchVariations } from '@/lib/queries/variations'
import {
  canLogClientComm,
  COMM_CHANNEL_LABEL,
  COMM_CHANNELS,
  COMM_EDIT_WINDOW_HOURS,
  commEntryEditable,
  COMMITMENT_STATE_LABEL,
  COMPLAINT_STATE_LABEL,
  type ClientApprovalRow,
  type CommAttention,
  type CommChannel,
  type CommEntry,
  type Commitment,
  type Complaint,
  type VariationOrder,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { todayIst } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/**
 * M36 CLIENT COMMUNICATION LOG — the firm's record OF the client.
 *
 * Not `client_messages` (065), which is the thread the client writes in and
 * reads. This holds what was said on a call the client may later remember
 * differently, and it is dispute material: nothing here is ever deleted, and an
 * entry is frozen 24 hours after it was logged (`fn_comm_entry_freeze`).
 *
 * WHAT A SUPERVISOR SEES IS DECIDED IN POSTGRES, NOT HERE. `cce_read` (083)
 * hides commercial entries from them; this file has no role filter on the list
 * at all. Writing a second copy of that rule in the browser would be one more
 * place for it to drift, and the copy that drifts is the one nobody re-checks.
 * Role only decides which BUTTONS render.
 */

type Tab = 'log' | 'commitments' | 'complaints'

export default function ClientLog() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayWrite = canLogClientComm(role)

  const [tab, setTab] = useState<Tab>('log')
  const [entries, setEntries] = useState<CommEntry[] | null>(null)
  const [commitments, setCommitments] = useState<Commitment[]>([])
  const [complaints, setComplaints] = useState<Complaint[]>([])
  const [attention, setAttention] = useState<CommAttention | null>(null)
  const [composing, setComposing] = useState(false)
  const [editing, setEditing] = useState<CommEntry | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    // allSettled, not all: one refused panel must not blank the screen and
    // claim there is nothing here (the 056 lesson).
    const [e, m, p, a] = await Promise.allSettled([
      fetchCommEntries(projectId),
      fetchCommitments(projectId),
      fetchComplaints(projectId),
      fetchCommAttention(projectId),
    ])
    if (e.status === 'fulfilled') setEntries(e.value)
    else {
      toast.error('Could not load the log', { description: errText(e.reason) })
      setEntries([])
    }
    if (m.status === 'fulfilled') setCommitments(m.value)
    if (p.status === 'fulfilled') setComplaints(p.value)
    setAttention(a.status === 'fulfilled' ? a.value : null)
  }, [projectId])

  useEffect(() => {
    setEntries(null)
    void reload()
  }, [reload])

  if (composing || editing) {
    return (
      <EntryForm
        projectId={projectId ?? ''}
        entry={editing}
        onDone={() => {
          setComposing(false)
          setEditing(null)
          void reload()
        }}
        onCancel={() => {
          setComposing(false)
          setEditing(null)
        }}
      />
    )
  }

  const TABS: { value: Tab; label: string; count: number }[] = [
    { value: 'log', label: 'Log', count: entries?.length ?? 0 },
    {
      value: 'commitments',
      label: 'Commitments',
      count: commitments.filter((c) => c.state === 'pending').length,
    },
    {
      value: 'complaints',
      label: 'Complaints',
      count: complaints.filter((c) => c.state === 'open').length,
    },
  ]

  return (
    <div className="space-y-4 pb-6">
      {attention && <AttentionStrip a={attention} onOpen={setTab} />}

      {mayWrite && tab === 'log' && (
        <Button className="h-12 w-full text-base" onClick={() => setComposing(true)}>
          Log an interaction
        </Button>
      )}

      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={cn(
              'min-h-11 rounded-lg px-3.5 text-sm font-medium transition-colors',
              tab === t.value
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {t.count > 0 && (
              <span className="ml-1.5 text-xs tabular-nums opacity-70">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {entries === null && <ListSkeleton rows={4} />}

      {entries !== null && tab === 'log' && (
        <LogTab
          entries={entries}
          mayWrite={mayWrite}
          onCompose={() => setComposing(true)}
          onEdit={setEditing}
        />
      )}

      {entries !== null && tab === 'commitments' && (
        <CommitmentsTab
          projectId={projectId ?? ''}
          rows={commitments}
          entries={entries}
          mayWrite={mayWrite}
          onChanged={reload}
        />
      )}

      {entries !== null && tab === 'complaints' && (
        <ComplaintsTab
          projectId={projectId ?? ''}
          rows={complaints}
          entries={entries}
          mayWrite={mayWrite}
          onChanged={reload}
        />
      )}
    </div>
  )
}

/* ---------------- Attention ---------------- */

function AttentionStrip({
  a,
  onOpen,
}: {
  a: CommAttention
  onOpen: (t: Tab) => void
}) {
  // Overdue is the only thing that makes this urgent. A strip that turns red
  // for "one due next week" teaches people to ignore red (the 073 rule).
  const urgent = a.overdue_commitments > 0
  const bits: string[] = []
  if (a.overdue_commitments > 0)
    bits.push(
      `${a.overdue_commitments} promise${a.overdue_commitments === 1 ? '' : 's'} overdue`,
    )
  if (a.due_soon_commitments > 0) bits.push(`${a.due_soon_commitments} due this week`)
  if (a.open_complaints > 0)
    bits.push(
      `${a.open_complaints} complaint${a.open_complaints === 1 ? '' : 's'} open` +
        (a.oldest_complaint_days !== null
          ? `, oldest ${a.oldest_complaint_days} days`
          : ''),
    )

  return (
    <button
      type="button"
      onClick={() => onOpen(a.overdue_commitments > 0 ? 'commitments' : 'complaints')}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left',
        urgent
          ? 'border-destructive/30 bg-destructive/5'
          : 'border-[var(--warning)]/30 bg-[color-mix(in_oklab,var(--warning)_8%,transparent)]',
      )}
    >
      <AlertTriangle
        className={cn(
          'mt-0.5 size-4 shrink-0',
          urgent ? 'text-destructive' : 'text-[var(--warning)]',
        )}
        aria-hidden="true"
      />
      <span className="text-sm">{bits.join(' · ')}</span>
    </button>
  )
}

/* ---------------- Log ---------------- */

function LogTab({
  entries,
  mayWrite,
  onCompose,
  onEdit,
}: {
  entries: CommEntry[]
  mayWrite: boolean
  onCompose: () => void
  onEdit: (e: CommEntry) => void
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={MessageCircle}
        title="Nothing logged yet"
        body={
          mayWrite
            ? 'Log every call, meeting and site visit as it happens. Six months from now this is the only record of what was agreed.'
            : 'Nothing site-related has been logged on this project yet. Commercial conversations are not shown here.'
        }
        actionLabel={mayWrite ? 'Log an interaction' : undefined}
        onAction={mayWrite ? onCompose : undefined}
      />
    )
  }

  return (
    <Stagger className="space-y-3">
      {entries.map((e) => (
        <RevealItem key={e.id}>
          <article className="paper p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-heading text-[15px] font-semibold">
                    {COMM_CHANNEL_LABEL[e.channel]}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {e.comm_no}
                  </span>
                  {e.is_commercial && (
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tracking-wider text-muted-foreground uppercase">
                      Commercial
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {e.occurred_on}
                  {e.client_person && ` · with ${e.client_person}`}
                </p>
              </div>
              {mayWrite && commEntryEditable(e) && (
                <button
                  type="button"
                  onClick={() => onEdit(e)}
                  className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Correct
                </button>
              )}
            </div>

            <p className="mt-3 text-sm whitespace-pre-wrap">{e.summary}</p>

            {(e.vo_number || e.approval_no || e.document_title) && (
              <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {e.vo_number && <span>About {e.vo_number}</span>}
                {e.approval_no && <span>Approval {e.approval_no}</span>}
                {e.document_title && <span>Doc: {e.document_title}</span>}
              </p>
            )}

            <p className="mt-2 text-xs text-muted-foreground">
              Logged by {e.logged_by_name ?? 'someone'}
              {!commEntryEditable(e) && ' · part of the record'}
            </p>
          </article>
        </RevealItem>
      ))}
    </Stagger>
  )
}

/* ---------------- Entry form ---------------- */

function EntryForm({
  projectId,
  entry,
  onDone,
  onCancel,
}: {
  projectId: string
  entry: CommEntry | null
  onDone: () => void
  onCancel: () => void
}) {
  const isEdit = entry !== null
  const [channel, setChannel] = useState<CommChannel>(entry?.channel ?? 'call')
  const [occurredOn, setOccurredOn] = useState(entry?.occurred_on ?? todayIst())
  const [person, setPerson] = useState(entry?.client_person ?? '')
  const [summary, setSummary] = useState(entry?.summary ?? '')
  const [isCommercial, setIsCommercial] = useState(entry?.is_commercial ?? true)
  const [voId, setVoId] = useState(entry?.variation_id ?? '')
  const [approvalId, setApprovalId] = useState(entry?.approval_id ?? '')
  const [vos, setVos] = useState<VariationOrder[]>([])
  const [approvals, setApprovals] = useState<ClientApprovalRow[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!projectId) return
    // Both are money-gated surfaces; only write roles reach this form, so a
    // refusal here is a real error rather than an expected empty.
    void Promise.allSettled([
      fetchVariations(projectId),
      fetchApprovals(projectId, null),
    ]).then(([v, a]) => {
      if (v.status === 'fulfilled') setVos(v.value)
      if (a.status === 'fulfilled') setApprovals(a.value)
    })
  }, [projectId])

  // The database forces this true when a VO or approval is linked. Mirroring it
  // here means the checkbox never shows a state the insert will overrule.
  const forcedCommercial = voId !== '' || approvalId !== ''
  const effectiveCommercial = forcedCommercial || isCommercial

  async function save() {
    if (summary.trim() === '') {
      toast.error('Write what was said')
      return
    }
    setBusy(true)
    try {
      if (isEdit && entry) {
        await updateCommEntry(entry.id, {
          channel,
          occurred_on: occurredOn,
          client_person: person,
          summary,
          is_commercial: effectiveCommercial,
        })
        toast.success('Entry corrected')
      } else {
        await createCommEntry({
          project_id: projectId,
          channel,
          occurred_on: occurredOn,
          client_person: person,
          summary,
          is_commercial: effectiveCommercial,
          variation_id: voId || null,
          approval_id: approvalId || null,
          document_id: null,
        })
        toast.success('Logged', {
          description: `Correctable for ${COMM_EDIT_WINDOW_HOURS} hours, then it becomes part of the record.`,
        })
      }
      onDone()
    } catch (err) {
      toast.error(isEdit ? 'Could not correct the entry' : 'Could not log it', {
        description: errText(err),
      })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="paper space-y-4 p-5">
        <h2 className="font-heading text-lg font-semibold">
          {isEdit ? 'Correct the entry' : 'Log an interaction'}
        </h2>

        {isEdit && (
          <p className="rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
            Corrections are possible for {COMM_EDIT_WINDOW_HOURS} hours after
            logging. After that the entry is fixed and a correction is a new
            entry — the database refuses the edit, not just this screen.
          </p>
        )}

        <FieldRow label="How" htmlFor="cl-channel">
          <Select
            id="cl-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as CommChannel)}
            className="h-12 text-base"
          >
            {COMM_CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </FieldRow>

        <FieldRow
          label="When it happened"
          htmlFor="cl-date"
          hint="The day of the conversation, not the day you are typing it up."
        >
          <Input
            id="cl-date"
            type="date"
            value={occurredOn}
            onChange={(e) => setOccurredOn(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>

        <FieldRow label="Who from the client's side" htmlFor="cl-person">
          <Input
            id="cl-person"
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            className="h-12 text-base"
            placeholder="Mr Rao"
          />
        </FieldRow>

        <FieldRow
          label="What was said"
          htmlFor="cl-summary"
          hint="Write it as you would want to read it in two years, in a disagreement."
        >
          <Textarea
            id="cl-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={5}
            placeholder="Client confirmed the terrace railing spec and asked for the revised quote by Friday."
          />
        </FieldRow>

        {!isEdit && (
          <>
            <FieldRow label="About a variation" htmlFor="cl-vo">
              <Select
                id="cl-vo"
                value={voId}
                onChange={(e) => setVoId(e.target.value)}
                className="h-12 text-base"
              >
                <option value="">Not about a specific VO</option>
                {vos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.vo_number} · {v.title}
                  </option>
                ))}
              </Select>
            </FieldRow>

            <FieldRow label="About an approval" htmlFor="cl-ap">
              <Select
                id="cl-ap"
                value={approvalId}
                onChange={(e) => setApprovalId(e.target.value)}
                className="h-12 text-base"
              >
                <option value="">Not about a specific approval</option>
                {approvals.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.approval_no} · {a.title}
                  </option>
                ))}
              </Select>
            </FieldRow>
          </>
        )}

        {/* The one control that decides who can read this afterwards, so it is
            explained rather than left as a bare checkbox. */}
        <div className="rounded-lg border border-border p-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={effectiveCommercial}
              disabled={forcedCommercial}
              onChange={(e) => setIsCommercial(e.target.checked)}
              className="mt-1 size-5 shrink-0"
            />
            <span className="text-sm">
              <span className="font-medium">Commercial — hide from supervisors</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {forcedCommercial
                  ? 'Forced on because this entry is linked to a variation or an approval. The database sets it either way.'
                  : 'Leave this on for anything touching price, variations or payment. Turn it off only for site matters — access, timing, a complaint about noise — which supervisors need to see.'}
              </span>
            </span>
          </label>
        </div>

        <div className="flex gap-2">
          <Button
            className="h-12 flex-1 text-base"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : isEdit ? 'Save correction' : 'Log it'}
          </Button>
          <Button variant="ghost" className="h-12" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Commitments ---------------- */

function CommitmentsTab({
  projectId,
  rows,
  entries,
  mayWrite,
  onChanged,
}: {
  projectId: string
  rows: Commitment[]
  entries: CommEntry[]
  mayWrite: boolean
  onChanged: () => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [promise, setPromise] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [entryId, setEntryId] = useState('')
  const [busy, setBusy] = useState(false)
  const today = todayIst()

  async function add() {
    if (promise.trim() === '') {
      toast.error('Write what was promised')
      return
    }
    setBusy(true)
    try {
      await createCommitment({
        project_id: projectId,
        entry_id: entryId || null,
        promise,
        due_on: dueOn || null,
        owner_id: null,
      })
      toast.success('Commitment tracked')
      setPromise('')
      setDueOn('')
      setEntryId('')
      setAdding(false)
      await onChanged()
    } catch (err) {
      toast.error('Could not save it', { description: errText(err) })
    }
    setBusy(false)
  }

  async function close(c: Commitment, state: 'done' | 'dropped') {
    const note = window.prompt(
      state === 'done' ? 'How was it delivered?' : 'Why was it dropped?',
      '',
    )
    if (note === null) return
    try {
      await closeCommitment(c.id, state, note, today)
      toast.success(state === 'done' ? 'Marked done' : 'Dropped')
      await onChanged()
    } catch (err) {
      toast.error('Could not update it', { description: errText(err) })
    }
  }

  return (
    <div className="space-y-3">
      {mayWrite && !adding && (
        <Button variant="outline" className="h-11" onClick={() => setAdding(true)}>
          Track a promise
        </Button>
      )}

      {adding && (
        <div className="paper space-y-4 p-5">
          <FieldRow label="What was promised" htmlFor="cm-promise">
            <Textarea
              id="cm-promise"
              value={promise}
              onChange={(e) => setPromise(e.target.value)}
              placeholder="Send the revised terrace drawing"
            />
          </FieldRow>
          <FieldRow
            label="By when"
            htmlFor="cm-due"
            hint="Leave blank if no date was given — do not invent one the client never heard."
          >
            <Input
              id="cm-due"
              type="date"
              value={dueOn}
              onChange={(e) => setDueOn(e.target.value)}
              className="h-12 text-base"
            />
          </FieldRow>
          <FieldRow label="Promised during" htmlFor="cm-entry">
            <Select
              id="cm-entry"
              value={entryId}
              onChange={(e) => setEntryId(e.target.value)}
              className="h-12 text-base"
            >
              <option value="">Not tied to a logged interaction</option>
              {entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.occurred_on} · {COMM_CHANNEL_LABEL[e.channel]} · {e.comm_no}
                </option>
              ))}
            </Select>
          </FieldRow>
          <div className="flex gap-2">
            <Button className="h-11 flex-1" disabled={busy} onClick={() => void add()}>
              {busy ? 'Saving…' : 'Track it'}
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {rows.length === 0 && !adding && (
        <EmptyState
          icon={MessageCircle}
          title="No promises tracked"
          body="Every time the firm tells the client it will do something by a date, put it here. This is the list that gets read back at a handover meeting."
          actionLabel={mayWrite ? 'Track a promise' : undefined}
          onAction={mayWrite ? () => setAdding(true) : undefined}
        />
      )}

      {rows.map((c) => {
        const overdue = c.state === 'pending' && c.due_on !== null && c.due_on < today
        return (
          <article key={c.id} className="paper p-5">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm font-medium">{c.promise}</p>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                  c.state === 'pending'
                    ? overdue
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-secondary text-muted-foreground'
                    : 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
                )}
              >
                {overdue ? 'Overdue' : COMMITMENT_STATE_LABEL[c.state]}
              </span>
            </div>

            <p className="mt-1.5 text-xs text-muted-foreground">
              {c.due_on ? `Due ${c.due_on}` : 'No date given'}
              {c.closed_on && ` · closed ${c.closed_on}`}
            </p>
            {c.closing_note && <p className="mt-2 text-sm">{c.closing_note}</p>}

            {mayWrite && (
              <div className="mt-3 flex flex-wrap gap-2">
                {c.state === 'pending' ? (
                  <>
                    <Button size="sm" onClick={() => void close(c, 'done')}>
                      Mark done
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void close(c, 'dropped')}
                    >
                      Drop
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await reopenCommitment(c.id)
                        toast.success('Reopened')
                        await onChanged()
                      } catch (err) {
                        toast.error('Could not reopen', { description: errText(err) })
                      }
                    }}
                  >
                    Reopen
                  </Button>
                )}
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

/* ---------------- Complaints ---------------- */

function ComplaintsTab({
  projectId,
  rows,
  entries,
  mayWrite,
  onChanged,
}: {
  projectId: string
  rows: Complaint[]
  entries: CommEntry[]
  mayWrite: boolean
  onChanged: () => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [subject, setSubject] = useState('')
  const [detail, setDetail] = useState('')
  const [raisedOn, setRaisedOn] = useState(todayIst())
  const [entryId, setEntryId] = useState('')
  const [busy, setBusy] = useState(false)
  const today = todayIst()

  async function add() {
    if (subject.trim() === '') {
      toast.error('Give the complaint a subject')
      return
    }
    setBusy(true)
    try {
      await createComplaint({
        project_id: projectId,
        entry_id: entryId || null,
        subject,
        detail,
        raised_on: raisedOn,
      })
      toast.success('Complaint registered')
      setSubject('')
      setDetail('')
      setEntryId('')
      setAdding(false)
      await onChanged()
    } catch (err) {
      toast.error('Could not register it', { description: errText(err) })
    }
    setBusy(false)
  }

  async function resolve(c: Complaint) {
    // The CHECK constraint refuses a resolved complaint with no resolution, so
    // an empty answer is stopped here rather than surfacing a constraint name.
    const note = window.prompt('What was done about it?', '')
    if (note === null) return
    if (note.trim() === '') {
      toast.error('Say what was done', {
        description: 'A complaint marked resolved with no account of how is what this register exists to prevent.',
      })
      return
    }
    try {
      await closeComplaint(c.id, 'resolved', note, today)
      toast.success('Resolved')
      await onChanged()
    } catch (err) {
      toast.error('Could not resolve it', { description: errText(err) })
    }
  }

  return (
    <div className="space-y-3">
      {mayWrite && !adding && (
        <Button variant="outline" className="h-11" onClick={() => setAdding(true)}>
          Register a complaint
        </Button>
      )}

      {adding && (
        <div className="paper space-y-4 p-5">
          <FieldRow label="Subject" htmlFor="cp-subject">
            <Input
              id="cp-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="h-12 text-base"
              placeholder="Dust in the lobby"
            />
          </FieldRow>
          <FieldRow label="Detail" htmlFor="cp-detail">
            <Textarea
              id="cp-detail"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Client says the lobby is dusty every morning after the cutting work upstairs."
            />
          </FieldRow>
          <FieldRow label="Raised on" htmlFor="cp-date">
            <Input
              id="cp-date"
              type="date"
              value={raisedOn}
              onChange={(e) => setRaisedOn(e.target.value)}
              className="h-12 text-base"
            />
          </FieldRow>
          <FieldRow label="Raised during" htmlFor="cp-entry">
            <Select
              id="cp-entry"
              value={entryId}
              onChange={(e) => setEntryId(e.target.value)}
              className="h-12 text-base"
            >
              <option value="">Not tied to a logged interaction</option>
              {entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.occurred_on} · {COMM_CHANNEL_LABEL[e.channel]} · {e.comm_no}
                </option>
              ))}
            </Select>
          </FieldRow>
          <div className="flex gap-2">
            <Button className="h-11 flex-1" disabled={busy} onClick={() => void add()}>
              {busy ? 'Saving…' : 'Register'}
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {rows.length === 0 && !adding && (
        <EmptyState
          icon={MessageCircle}
          title="No complaints registered"
          body="An empty register means nothing has been written down, not that the client is happy. Log one the day it is raised — the date it was raised is what matters later."
          actionLabel={mayWrite ? 'Register a complaint' : undefined}
          onAction={mayWrite ? () => setAdding(true) : undefined}
        />
      )}

      {rows.map((c) => {
        const days = Math.max(
          0,
          Math.round(
            (new Date(today).getTime() - new Date(c.raised_on).getTime()) / 86_400_000,
          ),
        )
        return (
          <article key={c.id} className="paper p-5">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 font-heading text-[15px] font-semibold">
                {c.subject}
              </p>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                  c.state === 'open'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
                )}
              >
                {COMPLAINT_STATE_LABEL[c.state]}
              </span>
            </div>

            <p className="mt-1 text-xs text-muted-foreground">
              Raised {c.raised_on}
              {c.state === 'open' && days > 0 && ` · open ${days} days`}
              {c.resolved_on && ` · resolved ${c.resolved_on}`}
            </p>

            {c.detail && <p className="mt-2 text-sm">{c.detail}</p>}

            {c.resolution && (
              <div className="mt-3 rounded-lg bg-secondary/50 p-3">
                <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  Resolution
                </p>
                <p className="mt-1 text-sm">{c.resolution}</p>
              </div>
            )}

            {mayWrite && (
              <div className="mt-3 flex flex-wrap gap-2">
                {c.state === 'open' ? (
                  <Button size="sm" onClick={() => void resolve(c)}>
                    Mark resolved
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await reopenComplaint(c.id)
                        toast.success('Reopened')
                        await onChanged()
                      } catch (err) {
                        toast.error('Could not reopen', { description: errText(err) })
                      }
                    }}
                  >
                    Reopen
                  </Button>
                )}
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}
