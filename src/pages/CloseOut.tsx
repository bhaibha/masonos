import { AlertTriangle, PackageCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import {
  addCloseoutItem,
  closeProject,
  deleteCloseoutItem,
  fetchBlockers,
  fetchCloseout,
  fetchFinalAccount,
  openCloseout,
  reopenProject,
  saveLessons,
  saveSurvey,
  setItemDocument,
  setItemReceived,
} from '@/lib/queries/closeout'
import { fetchDocuments } from '@/lib/queries/documents'
import {
  canManageCloseout,
  CLOSEOUT_CATEGORIES,
  CLOSEOUT_CATEGORY_LABEL,
  type CloseoutBlocker,
  type CloseoutCategory,
  type CloseoutItem,
  type DocumentRow,
  type FinalAccount,
  type ProjectCloseout,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { todayIst } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/**
 * M28 PROJECT CLOSE-OUT — the handover pack, the final account, and a close
 * that can refuse.
 *
 * Every figure comes from `fn_project_final_account`, which is owner-run
 * because it reads `projects.contract_value` (revoked in 010). Nothing is added
 * up in the browser.
 *
 * The close button is enabled or not, but the DATABASE is what enforces it —
 * `fn_close_project` refuses while required documents are missing or snags are
 * open, and only a founder can waive an unsettled balance, with a written
 * reason stored on the row. The screen just tries to say the same thing first.
 */
export default function CloseOut() {
  const projectId = useProjects((s) => s.selectedId)
  const projects = useProjects((s) => s.projects)
  const role = useAuth((s) => s.role)
  const mayManage = canManageCloseout(role)

  const [closeout, setCloseout] = useState<ProjectCloseout | null | undefined>(
    undefined,
  )
  const [account, setAccount] = useState<FinalAccount | null>(null)
  const [blockers, setBlockers] = useState<CloseoutBlocker[]>([])
  const [busy, setBusy] = useState(false)

  const project = projects.find((p) => p.id === projectId) ?? null

  const reload = useCallback(async () => {
    if (!projectId) return
    // allSettled: one refused panel must not blank the screen (056).
    const [c, a, b] = await Promise.allSettled([
      fetchCloseout(projectId),
      fetchFinalAccount(projectId),
      fetchBlockers(projectId),
    ])
    if (c.status === 'fulfilled') setCloseout(c.value)
    else {
      toast.error('Could not load the close-out', { description: errText(c.reason) })
      setCloseout(null)
    }
    setAccount(a.status === 'fulfilled' ? a.value : null)
    setBlockers(b.status === 'fulfilled' ? b.value : [])
  }, [projectId])

  useEffect(() => {
    setCloseout(undefined)
    void reload()
  }, [reload])

  async function open() {
    if (!projectId) return
    setBusy(true)
    try {
      await openCloseout(projectId)
      toast.success('Close-out opened', {
        description: 'Seeded with the standard handover pack.',
      })
      await reload()
    } catch (err) {
      toast.error('Could not open the close-out', { description: errText(err) })
    }
    setBusy(false)
  }

  const closed = Boolean(closeout?.closed_at)
  const hard = blockers.filter((b) => !b.waivable)
  const soft = blockers.filter((b) => b.waivable)

  return (
    <>
      <div className="space-y-4 pb-8">
        {closeout === undefined && <ListSkeleton rows={4} />}

        {closeout === null && (
          <EmptyState
            icon={PackageCheck}
            title="No close-out started"
            body={
              mayManage
                ? 'Open the handover pack when the job reaches completion. It comes seeded with the standard documentation list, and the final account is computed from what has already been billed and certified.'
                : 'The founder or PM has not opened a close-out for this project yet.'
            }
            actionLabel={mayManage ? 'Open the close-out' : undefined}
            onAction={mayManage ? () => void open() : undefined}
          />
        )}

        {closeout && (
          <Stagger className="space-y-4">
            {closed && (
              <RevealItem>
                <ClosedBanner
                  closeout={closeout}
                  projectName={project?.name ?? 'This project'}
                  mayReopen={role === 'founder'}
                  onReopen={async () => {
                    if (!projectId) return
                    try {
                      await reopenProject(projectId)
                      toast.success('Reopened')
                      await reload()
                    } catch (err) {
                      toast.error('Could not reopen', { description: errText(err) })
                    }
                  }}
                />
              </RevealItem>
            )}

            {account && (
              <RevealItem>
                <FinalAccountCard a={account} />
              </RevealItem>
            )}

            <RevealItem>
              <PackCard
                closeout={closeout}
                mayManage={mayManage && !closed}
                projectId={projectId ?? ''}
                onChanged={reload}
              />
            </RevealItem>

            <RevealItem>
              <SurveyCard
                closeout={closeout}
                mayManage={mayManage && !closed}
                onChanged={reload}
              />
            </RevealItem>

            <RevealItem>
              <LessonsCard
                closeout={closeout}
                mayManage={mayManage && !closed}
                onChanged={reload}
              />
            </RevealItem>

            {!closed && mayManage && (
              <RevealItem>
                <CloseCard
                  projectId={projectId ?? ''}
                  hard={hard}
                  soft={soft}
                  isFounder={role === 'founder'}
                  busy={busy}
                  onClosed={reload}
                />
              </RevealItem>
            )}
          </Stagger>
        )}
      </div>
    </>
  )
}

/* ---------------- Closed banner ---------------- */

function ClosedBanner({
  closeout: c,
  projectName,
  mayReopen,
  onReopen,
}: {
  closeout: ProjectCloseout
  projectName: string
  mayReopen: boolean
  onReopen: () => Promise<void>
}) {
  return (
    <div className="rounded-lg border border-[var(--positive)]/30 bg-[color-mix(in_oklab,var(--positive)_8%,transparent)] p-5">
      <p className="font-heading text-lg font-semibold text-[var(--positive)]">
        {projectName} is closed
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Handed over {c.closed_at?.slice(0, 10)}
        {c.closed_by_name && ` by ${c.closed_by_name}`}
      </p>
      {/* A waiver is printed, never hidden. "We closed it anyway" has to be a
          fact somebody can find. */}
      {c.close_waiver_reason && (
        <div className="mt-3 rounded-lg bg-background/60 p-3">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Closed with money outstanding
          </p>
          <p className="mt-1 text-sm">{c.close_waiver_reason}</p>
        </div>
      )}
      {mayReopen && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-3"
          onClick={() => void onReopen()}
        >
          Reopen
        </Button>
      )}
    </div>
  )
}

/* ---------------- Final account ---------------- */

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string
  value: string
  strong?: boolean
  tone?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={cn('text-sm', strong ? 'font-medium' : 'text-muted-foreground')}>
        {label}
      </span>
      <span
        className={cn(
          'tabular-nums',
          strong ? 'font-heading text-[17px] font-semibold' : 'text-sm',
          tone,
        )}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * The two sides are separate blocks with their own headings, because they are
 * different directions of money. Showing them as one running total would be
 * the thing 056 was written to stop.
 */
function FinalAccountCard({ a }: { a: FinalAccount }) {
  return (
    <div className="paper p-5">
      <h2 className="font-heading text-lg font-semibold">Final account</h2>

      <p className="mt-4 text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
        From the client
      </p>
      <div className="mt-1">
        <Row label="Original contract" value={formatInr(a.contract_value)} />
        <Row label="Approved variations" value={formatInr(a.variations_value)} />
        <div className="my-1 border-t border-border" />
        <Row label="Revised contract" value={formatInr(a.revised_contract)} strong />
        <Row label="Invoiced to date" value={formatInr(a.invoiced)} />
        <Row label="Received" value={formatInr(a.received)} />
        <div className="my-1 border-t border-border" />
        <Row
          label="Still to bill"
          value={formatInr(a.still_to_bill)}
          strong
          tone={a.still_to_bill !== 0 ? 'text-[var(--warning)]' : 'text-[var(--positive)]'}
        />
        <Row
          label="Still to collect"
          value={formatInr(a.still_to_collect)}
          strong
          tone={a.still_to_collect !== 0 ? 'text-destructive' : 'text-[var(--positive)]'}
        />
      </div>

      <p className="mt-5 text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
        To contractors
      </p>
      <div className="mt-1">
        <Row label="Certified on RA bills" value={formatInr(a.certified)} />
        <Row
          label="Retention still held"
          value={formatInr(a.retention_held)}
          strong
          tone={a.retention_held > 0 ? 'text-[var(--warning)]' : 'text-[var(--positive)]'}
        />
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Two directions of money, kept apart on purpose — what the client owes the
        firm and what the firm owes its contractors are not one figure.
        Everything here is computed in the database from the invoices and RA
        bills already recorded.
      </p>
    </div>
  )
}

/* ---------------- Documentation pack ---------------- */

function PackCard({
  closeout: c,
  mayManage,
  projectId,
  onChanged,
}: {
  closeout: ProjectCloseout
  mayManage: boolean
  projectId: string
  onChanged: () => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [category, setCategory] = useState<CloseoutCategory>('other')
  const [docs, setDocs] = useState<DocumentRow[]>([])
  const today = todayIst()

  useEffect(() => {
    if (!projectId) return
    fetchDocuments(projectId)
      .then(setDocs)
      .catch(() => setDocs([]))
  }, [projectId])

  const done = c.items.filter((i) => i.received).length
  const withEvidence = c.items.filter((i) => i.received && i.document_id).length
  const requiredLeft = c.items.filter((i) => i.is_required && !i.received).length

  async function tick(item: CloseoutItem, next: boolean) {
    try {
      await setItemReceived(item.id, next, today)
      await onChanged()
    } catch (err) {
      toast.error('Could not update the item', { description: errText(err) })
    }
  }

  async function link(item: CloseoutItem, documentId: string) {
    try {
      await setItemDocument(item.id, documentId || null)
      toast.success(documentId ? 'Document attached' : 'Document cleared')
      await onChanged()
    } catch (err) {
      toast.error('Could not attach the document', { description: errText(err) })
    }
  }

  return (
    <div className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-heading text-lg font-semibold">Handover pack</h2>
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
          {done} / {c.items.length}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {requiredLeft > 0
          ? `${requiredLeft} required item${requiredLeft === 1 ? '' : 's'} still to receive`
          : 'All required items received'}
        {done > 0 && ` · ${withEvidence} of ${done} have a document attached`}
      </p>

      <ul className="mt-4 divide-y divide-border">
        {c.items.map((i) => (
          <li key={i.id} className="py-3">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={i.received}
                disabled={!mayManage}
                onChange={(e) => void tick(i, e.target.checked)}
                className="mt-0.5 size-5 shrink-0"
                aria-label={i.label}
              />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={cn(i.received && 'text-muted-foreground')}>
                    {i.label}
                  </span>
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tracking-wider text-muted-foreground uppercase">
                    {CLOSEOUT_CATEGORY_LABEL[i.category]}
                  </span>
                  {i.is_required && (
                    <span className="text-[10px] font-semibold tracking-wider text-[var(--warning)] uppercase">
                      Required
                    </span>
                  )}
                </p>
                {i.received && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Received {i.received_on}
                    {i.document_title && ` · ${i.document_title}`}
                  </p>
                )}

                {/* Evidence is optional by design — a warranty booklet is a
                    physical original. Offered, never demanded. */}
                {i.received && mayManage && (
                  <Select
                    value={i.document_id ?? ''}
                    onChange={(e) => void link(i, e.target.value)}
                    className="mt-2 h-10 text-sm"
                    aria-label={`Document for ${i.label}`}
                  >
                    <option value="">No document attached</option>
                    {docs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </Select>
                )}
              </div>

              {mayManage && !i.is_required && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await deleteCloseoutItem(i.id)
                      await onChanged()
                    } catch (err) {
                      toast.error('Could not remove it', { description: errText(err) })
                    }
                  }}
                  className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-destructive"
                >
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {mayManage && !adding && (
        <Button variant="outline" size="sm" className="mt-4" onClick={() => setAdding(true)}>
          Add an item
        </Button>
      )}

      {adding && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <FieldRow label="What" htmlFor="ci-label">
            <Input
              id="ci-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="h-12 text-base"
              placeholder="Lift AMC contract"
            />
          </FieldRow>
          <FieldRow label="Category" htmlFor="ci-cat">
            <Select
              id="ci-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value as CloseoutCategory)}
              className="h-12 text-base"
            >
              {CLOSEOUT_CATEGORIES.map((c2) => (
                <option key={c2.value} value={c2.value}>
                  {c2.label}
                </option>
              ))}
            </Select>
          </FieldRow>
          <div className="flex gap-2">
            <Button
              className="h-11 flex-1"
              onClick={async () => {
                if (label.trim() === '') {
                  toast.error('Give the item a name')
                  return
                }
                try {
                  await addCloseoutItem({ closeout_id: c.id, category, label })
                  toast.success('Item added')
                  setLabel('')
                  setAdding(false)
                  await onChanged()
                } catch (err) {
                  toast.error('Could not add it', { description: errText(err) })
                }
              }}
            >
              Add
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- Survey ---------------- */

function SurveyCard({
  closeout: c,
  mayManage,
  onChanged,
}: {
  closeout: ProjectCloseout
  mayManage: boolean
  onChanged: () => Promise<void>
}) {
  const [score, setScore] = useState(c.survey_score?.toString() ?? '')
  const [method, setMethod] = useState(c.survey_method ?? '')
  const [comments, setComments] = useState(c.survey_comments ?? '')
  const [takenOn, setTakenOn] = useState(c.survey_taken_on ?? todayIst())
  const [busy, setBusy] = useState(false)

  async function save() {
    const n = score.trim() === '' ? null : Number(score)
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 10)) {
      toast.error('Score is 1 to 10')
      return
    }
    setBusy(true)
    try {
      await saveSurvey(c.id, { score: n, method, comments, takenOn })
      toast.success('Survey saved')
      await onChanged()
    } catch (err) {
      toast.error('Could not save the survey', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <div className="paper space-y-4 p-5">
      <h2 className="font-heading text-lg font-semibold">Client satisfaction</h2>
      <p className="text-xs text-muted-foreground">
        What the client said, recorded by the firm. How it was captured is stored
        alongside the score — a phone call and a signed form should not look the
        same on the record.
      </p>

      <FieldRow label="Score out of 10" htmlFor="sv-score">
        <Input
          id="sv-score"
          type="number"
          inputMode="numeric"
          min="1"
          max="10"
          value={score}
          disabled={!mayManage}
          onChange={(e) => setScore(e.target.value)}
          className="h-12 text-base tabular-nums"
          placeholder="8"
        />
      </FieldRow>

      <FieldRow label="How it was captured" htmlFor="sv-method">
        <Input
          id="sv-method"
          value={method}
          disabled={!mayManage}
          onChange={(e) => setMethod(e.target.value)}
          className="h-12 text-base"
          placeholder="Signed feedback form at handover"
        />
      </FieldRow>

      <FieldRow label="Date" htmlFor="sv-date">
        <Input
          id="sv-date"
          type="date"
          value={takenOn}
          disabled={!mayManage}
          onChange={(e) => setTakenOn(e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="What they said" htmlFor="sv-comments">
        <Textarea
          id="sv-comments"
          value={comments}
          disabled={!mayManage}
          onChange={(e) => setComments(e.target.value)}
          rows={4}
          placeholder="Very happy with the finish. Felt the last month ran slow."
        />
      </FieldRow>

      {mayManage && (
        <Button className="h-11" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save survey'}
        </Button>
      )}
    </div>
  )
}

/* ---------------- Lessons ---------------- */

function LessonsCard({
  closeout: c,
  mayManage,
  onChanged,
}: {
  closeout: ProjectCloseout
  mayManage: boolean
  onChanged: () => Promise<void>
}) {
  const [text, setText] = useState(c.lessons ?? '')
  const [busy, setBusy] = useState(false)

  return (
    <div className="paper space-y-4 p-5">
      <h2 className="font-heading text-lg font-semibold">Lessons learned</h2>
      <p className="text-xs text-muted-foreground">
        What the next job should do differently. Written while it is still fresh —
        nobody remembers this six months later.
      </p>
      <Textarea
        value={text}
        disabled={!mayManage}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder="Waterproofing was ordered late twice. Put the terrace membrane on the 8-week procurement list from day one."
      />
      {mayManage && (
        <Button
          className="h-11"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await saveLessons(c.id, text)
              toast.success('Saved')
              await onChanged()
            } catch (err) {
              toast.error('Could not save', { description: errText(err) })
            }
            setBusy(false)
          }}
        >
          {busy ? 'Saving…' : 'Save lessons'}
        </Button>
      )}
    </div>
  )
}

/* ---------------- Close ---------------- */

function CloseCard({
  projectId,
  hard,
  soft,
  isFounder,
  busy,
  onClosed,
}: {
  projectId: string
  hard: CloseoutBlocker[]
  soft: CloseoutBlocker[]
  isFounder: boolean
  busy: boolean
  onClosed: () => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(false)

  const ready = hard.length === 0 && soft.length === 0
  // Forcing is a founder's call and costs a sentence. The database enforces
  // both halves; this only avoids offering a button that would be refused.
  const canForce = hard.length === 0 && soft.length > 0 && isFounder

  async function close(force: boolean) {
    setWorking(true)
    try {
      await closeProject(projectId, force, reason)
      toast.success('Project closed', {
        description: force
          ? 'Closed with the balance outstanding — the reason is on the record.'
          : undefined,
      })
      await onClosed()
    } catch (err) {
      toast.error('Could not close the project', { description: errText(err) })
    }
    setWorking(false)
  }

  return (
    <div className="paper p-5">
      <h2 className="font-heading text-lg font-semibold">Close the project</h2>

      {ready ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Everything is settled. Closing marks the project completed and stamps
          who closed it and when.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {hard.map((b) => (
            <div
              key={b.blocker}
              className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
            >
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <span className="text-sm">{b.detail}</span>
            </div>
          ))}
          {soft.map((b) => (
            <div
              key={b.blocker}
              className="flex items-start gap-3 rounded-lg border border-[var(--warning)]/30 bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] px-4 py-3"
            >
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-[var(--warning)]"
                aria-hidden="true"
              />
              <span className="text-sm">{b.detail}</span>
            </div>
          ))}
          {hard.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Missing documents and open snags cannot be waived — they are what
              the handover pack exists to guarantee.
            </p>
          )}
        </div>
      )}

      {canForce && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <FieldRow
            label="Reason for closing anyway"
            htmlFor="cl-reason"
            hint="Stored on the record and shown on the closed project. A founder-only decision."
          >
            <Textarea
              id="cl-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Final ₹30,000 in dispute; client to pay on arbitration."
            />
          </FieldRow>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          className="h-12"
          disabled={busy || working || hard.length > 0 || (soft.length > 0 && !canForce)}
          onClick={() => void close(soft.length > 0)}
        >
          {working
            ? 'Closing…'
            : soft.length > 0
              ? 'Close anyway'
              : 'Close the project'}
        </Button>
      </div>

      {soft.length > 0 && !isFounder && (
        <p className="mt-2 text-xs text-muted-foreground">
          Only a founder may close past an unsettled balance.
        </p>
      )}
    </div>
  )
}
