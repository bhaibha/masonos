import { ArrowLeft, Paperclip } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { DeleteButton } from '@/components/DeleteAction'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton, Skeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  addRevision,
  fetchDrawing,
  fetchRevisions,
  issueRevision,
  withdrawRevision,
} from '@/lib/queries/drawings'
import { signedDrawingUrl, uploadDrawing } from '@/lib/storage'
import {
  canManageDrawings,
  DRAWING_DISCIPLINE_LABEL,
  DRAWING_STATUS_LABEL,
  type DrawingRevisionRow,
  type DrawingRow,
  type DrawingStatus,
  type UserRole,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

const STATUS_TONE: Record<DrawingStatus, string> = {
  ifc: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  wip: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  superseded: 'bg-secondary text-muted-foreground',
}

/**
 * Level 3: one drawing, every revision, and the actions that change what site
 * builds from. Issuing lives here and nowhere else — you open the drawing, pick
 * the sheet, issue it.
 */
export default function DrawingDetail() {
  const { discipline, drawingId } = useParams<{
    discipline: string
    drawingId: string
  }>()
  const navigate = useNavigate()
  const role = useAuth((s) => s.role)
  const mayManage = canManageDrawings(role)

  const [drawing, setDrawing] = useState<DrawingRow | null | 'missing'>(null)
  const [revisions, setRevisions] = useState<DrawingRevisionRow[] | null>(null)
  const [adding, setAdding] = useState(false)

  const backTo = `/docs/register/${discipline ?? ''}`

  const reload = useCallback(async () => {
    if (!drawingId) return
    try {
      const [d, revs] = await Promise.all([
        fetchDrawing(drawingId),
        fetchRevisions(drawingId),
      ])
      setDrawing(d ?? 'missing')
      setRevisions(revs)
    } catch (err) {
      toast.error('Could not load the drawing', { description: errText(err) })
      setDrawing('missing')
    }
  }, [drawingId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function openSheet(path: string | null) {
    if (!path) return
    const url = await signedDrawingUrl(path)
    if (url) window.open(url, '_blank', 'noopener')
    else toast.error('Could not open that sheet')
  }

  if (drawing === 'missing') {
    return (
      <div className="pb-6">
        <BackLink to={backTo} />
        <EmptyState
          icon={Paperclip}
          title="Drawing not available"
          body="It may have been removed, or nothing has been issued for construction yet."
          actionLabel="Back to the register"
          actionTo={backTo}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4 pb-6">
      <BackLink to={backTo} />

      {drawing === null ? (
        <div className="paper space-y-3 p-5">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <>
          <header className="paper p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-heading text-[22px] leading-tight font-semibold">
                  {drawing.drawing_no}
                </h2>
                <p className="mt-1 text-sm">{drawing.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {DRAWING_DISCIPLINE_LABEL[drawing.discipline]}
                </p>
              </div>
              {drawing.current_revision ? (
                <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--positive)]">
                  {drawing.current_revision} · IFC
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--warning)]">
                  Not issued
                </span>
              )}
            </div>

            {/* The current sheet is what the screen is for — everything below
                is history. */}
            {drawing.current_file_path ? (
              <div className="mt-4 rounded-lg bg-secondary/50 p-3">
                <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  Build from this sheet
                </p>
                <button
                  type="button"
                  onClick={() => void openSheet(drawing.current_file_path)}
                  className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-[15px] font-medium text-primary"
                >
                  <Paperclip className="size-4" aria-hidden="true" />
                  Revision {drawing.current_revision}
                  {drawing.current_issued_date &&
                    ` · issued ${drawing.current_issued_date}`}
                </button>
                {drawing.current_notes && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {drawing.current_notes}
                  </p>
                )}
              </div>
            ) : (
              mayManage && (
                <p className="mt-4 rounded-lg bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] px-3 py-2 text-sm text-[var(--warning)]">
                  Nothing issued for construction — site cannot see this drawing.
                </p>
              )
            )}

            {mayManage && (
              <div className="mt-4 flex flex-wrap gap-2">
                {!adding && (
                  <Button onClick={() => setAdding(true)}>
                    {drawing.revision_count === 0
                      ? 'Upload first sheet'
                      : 'New revision'}
                  </Button>
                )}
                <DeleteButton
                  table="drawings"
                  id={drawing.id}
                  name={`${drawing.drawing_no} · ${drawing.title}`}
                  role={role}
                  label="Delete drawing"
                  onDeleted={() => navigate(backTo)}
                />
              </div>
            )}
          </header>

          {adding && (
            <RevisionForm
              drawingId={drawing.id}
              projectId={drawing.project_id}
              suggested={nextRevision(drawing.latest_revision)}
              onCancel={() => setAdding(false)}
              onSaved={async () => {
                setAdding(false)
                await reload()
              }}
            />
          )}
        </>
      )}

      <p className="pt-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Revisions
      </p>

      {revisions === null && <ListSkeleton rows={2} />}

      {revisions?.length === 0 && (
        <EmptyState
          icon={Paperclip}
          title="No sheets yet"
          body="Upload the first sheet — site sees nothing until a revision is issued for construction."
          actionLabel={mayManage ? 'Upload first sheet' : undefined}
          onAction={mayManage ? () => setAdding(true) : undefined}
        />
      )}

      {revisions && revisions.length > 0 && (
        <Stagger className="space-y-3">
          {revisions.map((r) => (
            <RevealItem key={r.id}>
              <RevisionCard
                rev={r}
                role={role}
                onOpen={() => void openSheet(r.file_path)}
                onChanged={reload}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function BackLink({ to }: { to: string }) {
  return (
    <Link
      to={to}
      className="-ml-2 inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to register
    </Link>
  )
}

/** R0 → R1, A → B. Blank when it can't tell. */
function nextRevision(latest: string | null): string {
  if (!latest) return 'R0'
  const m = latest.match(/^(.*?)(\d+)$/)
  if (m) return `${m[1]}${Number(m[2]) + 1}`
  const letter = latest.match(/^([A-Za-z])$/)
  if (letter && letter[1]) {
    return String.fromCharCode(letter[1].charCodeAt(0) + 1)
  }
  return ''
}

function RevisionCard({
  rev,
  role,
  onOpen,
  onChanged,
}: {
  rev: DrawingRevisionRow
  role: UserRole | null
  onOpen: () => void
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const mayManage = canManageDrawings(role)

  async function issue() {
    setBusy(true)
    try {
      await issueRevision(rev.id, rev.issued_date ?? todayIst())
      toast.success(`Revision ${rev.revision} issued for construction`, {
        description: 'Any previous revision is now marked superseded.',
      })
      await onChanged()
    } catch (err) {
      toast.error('Could not issue the revision', { description: errText(err) })
    }
    setBusy(false)
  }

  async function withdraw() {
    setBusy(true)
    try {
      await withdrawRevision(rev.id)
      toast.success('Withdrawn from construction', {
        description: 'Site no longer has a current sheet for this drawing.',
      })
      await onChanged()
    } catch (err) {
      toast.error('Could not withdraw the revision', {
        description: errText(err),
      })
    }
    setBusy(false)
  }

  return (
    <article
      className={cn('paper p-5', rev.status === 'superseded' && 'opacity-70')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[16px] font-semibold">
            Revision {rev.revision}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {rev.issued_date
              ? `Issued ${rev.issued_date}`
              : `Added ${rev.created_at.slice(0, 10)}`}
          </p>
          {rev.notes && <p className="mt-2 text-sm">{rev.notes}</p>}
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            STATUS_TONE[rev.status],
          )}
        >
          {DRAWING_STATUS_LABEL[rev.status]}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {rev.file_path && (
          <Button variant="outline" size="sm" className="h-9" onClick={onOpen}>
            <Paperclip className="size-4" aria-hidden="true" />
            Open sheet
          </Button>
        )}
        {mayManage && rev.status === 'wip' && (
          <Button size="sm" className="h-9" disabled={busy} onClick={() => void issue()}>
            Issue for construction
          </Button>
        )}
        {mayManage && rev.status === 'superseded' && (
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            disabled={busy}
            onClick={() => void issue()}
          >
            Re-issue this sheet
          </Button>
        )}
        {mayManage && rev.status === 'ifc' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            disabled={busy}
            onClick={() => void withdraw()}
          >
            Withdraw
          </Button>
        )}
        {/* WIP for a PM, any status for the founder — fn_delete_record decides
            and explains, so the button is always offered. */}
        {mayManage && (
          <DeleteButton
            table="drawing_revisions"
            id={rev.id}
            name={`Revision ${rev.revision}`}
            role={role}
            onDeleted={onChanged}
          />
        )}
      </div>
    </article>
  )
}

function RevisionForm({
  drawingId,
  projectId,
  suggested,
  onCancel,
  onSaved,
}: {
  drawingId: string
  projectId: string
  suggested: string
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const [revision, setRevision] = useState(suggested)
  const [issuedDate, setIssuedDate] = useState(todayIst())
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [issueNow, setIssueNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (revision.trim() === '') {
      toast.error('Give the revision a number')
      return
    }
    if (issueNow && !file) {
      toast.error('Attach the sheet before issuing it for construction')
      return
    }

    setBusy(true)
    try {
      let path: string | null = null
      let fileType: string | null = null

      if (file) {
        setStatus('Uploading the sheet…')
        const up = await uploadDrawing(projectId, file)
        path = up.path
        fileType = up.fileType
      }

      setStatus('Saving…')
      const id = await addRevision({
        drawing_id: drawingId,
        revision,
        issued_date: issueNow ? issuedDate : null,
        file_path: path,
        file_type: fileType,
        notes,
      })

      if (issueNow) {
        await issueRevision(id, issuedDate)
        toast.success(`Revision ${revision.trim()} issued for construction`, {
          description: 'Any previous revision is now superseded.',
        })
      } else {
        toast.success(`Revision ${revision.trim()} saved as WIP`, {
          description: 'Site cannot see it until it is issued.',
        })
      }

      await onSaved()
    } catch (err) {
      toast.error('Could not save the revision', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="paper space-y-4 p-5" noValidate>
      <p className="font-heading text-[18px] font-semibold">New revision</p>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Revision" htmlFor="r-no">
          <Input
            id="r-no"
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            placeholder="R1"
            className="h-12 text-base"
            autoFocus
          />
        </FieldRow>

        <FieldRow label="Issued date" htmlFor="r-date">
          <Input
            id="r-date"
            type="date"
            value={issuedDate}
            onChange={(e) => e.target.value && setIssuedDate(e.target.value)}
            className="h-12"
            disabled={!issueNow}
          />
        </FieldRow>
      </div>

      <FieldRow
        label="Sheet"
        htmlFor="r-file"
        hint="PDF, DWG or DXF. Uploaded byte-for-byte — never compressed."
      >
        <Input
          id="r-file"
          type="file"
          accept=".pdf,.dwg,.dxf,image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="What changed" htmlFor="r-notes">
        <Textarea
          id="r-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Staircase width revised to 1200, window W3 relocated."
        />
      </FieldRow>

      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={issueNow}
          onChange={(e) => setIssueNow(e.target.checked)}
          className="size-5 accent-[var(--accent)]"
        />
        Issue for construction now — supersedes the current sheet
      </label>

      {status && <p className="text-xs text-muted-foreground">{status}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy} className="h-11 flex-1">
          {busy ? 'Saving…' : issueNow ? 'Upload and issue' : 'Save as WIP'}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
