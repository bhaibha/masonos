import { ChevronRight, FileStack } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  addRevision,
  createDrawing,
  fetchDrawings,
  issueRevision,
} from '@/lib/queries/drawings'
import { uploadDrawing } from '@/lib/storage'
import {
  canManageDrawings,
  DRAWING_DISCIPLINES,
  DRAWING_DISCIPLINE_LABEL,
  type DrawingDiscipline,
  type DrawingRow,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const VALID = new Set(DRAWING_DISCIPLINES.map((d) => d.value))

/** Level 2: the drawings filed under one discipline. */
export default function DrawingList() {
  const { discipline } = useParams<{ discipline: string }>()
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayManage = canManageDrawings(role)

  const [rows, setRows] = useState<DrawingRow[] | null>(null)
  const [adding, setAdding] = useState(false)

  const valid = discipline && VALID.has(discipline as DrawingDiscipline)

  const reload = useCallback(async () => {
    if (!projectId || !valid) return
    try {
      const all = await fetchDrawings(projectId)
      setRows(all.filter((d) => d.discipline === discipline))
    } catch (err) {
      toast.error('Could not load drawings', { description: errText(err) })
      setRows([])
    }
  }, [projectId, discipline, valid])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (!valid) return <Navigate to="/docs/register" replace />

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-semibold">
          {DRAWING_DISCIPLINE_LABEL[discipline as DrawingDiscipline]}
        </h2>
        <Link
          to="/docs/register"
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          All disciplines
        </Link>
      </div>

      {mayManage && !adding && (
        <Button className="h-12 w-full text-base" onClick={() => setAdding(true)}>
          Add drawing
        </Button>
      )}

      {adding && (
        <NewDrawingForm
          discipline={discipline as DrawingDiscipline}
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await reload()
          }}
        />
      )}

      {rows === null && <ListSkeleton rows={3} />}

      {rows?.length === 0 && !adding && (
        <EmptyState
          icon={FileStack}
          title="Nothing filed here yet"
          body={
            mayManage
              ? 'Add a drawing — number, title and its first sheet in one go.'
              : 'Drawings appear here once they are issued for construction.'
          }
          actionLabel={mayManage ? 'Add drawing' : undefined}
          onAction={mayManage ? () => setAdding(true) : undefined}
        />
      )}

      {rows && rows.length > 0 && (
        <Stagger className="card-grid">
          {rows.map((d) => (
            <RevealItem key={d.id}>
              <Link
                to={`/docs/register/${discipline}/${d.id}`}
                className="paper flex items-center gap-3 p-5 transition-shadow hover:paper-lift focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-heading text-[17px] leading-tight font-semibold">
                    {d.drawing_no}
                  </p>
                  <p className="mt-0.5 truncate text-sm">{d.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {d.revision_count} revision
                    {d.revision_count === 1 ? '' : 's'}
                    {d.superseded_count > 0 &&
                      ` · ${d.superseded_count} superseded`}
                  </p>
                </div>

                {d.current_revision ? (
                  <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--positive)]">
                    {d.current_revision} · IFC
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--warning)]">
                    Not issued
                  </span>
                )}

                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </Link>
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ---------------- Add a drawing (with its first sheet) ---------------- */

/**
 * Creating the drawing and uploading its first sheet are one action, even
 * though they're two tables underneath. Nobody thinks "register a number now,
 * attach the sheet later" — they think "here is SD-101".
 */
function NewDrawingForm({
  discipline,
  onCancel,
  onSaved,
}: {
  discipline: DrawingDiscipline
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const projectId = useProjects((s) => s.selectedId)

  const [drawingNo, setDrawingNo] = useState('')
  const [title, setTitle] = useState('')
  const [disc, setDisc] = useState<DrawingDiscipline>(discipline)
  const [revision, setRevision] = useState('R0')
  const [issuedDate, setIssuedDate] = useState(todayIst())
  const [file, setFile] = useState<File | null>(null)
  const [notes, setNotes] = useState('')
  const [issueNow, setIssueNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!projectId) return
    if (drawingNo.trim() === '') {
      toast.error('Give the drawing its number')
      return
    }
    if (title.trim() === '') {
      toast.error('Give the drawing a title')
      return
    }
    if (issueNow && !file) {
      toast.error('Attach the sheet, or untick "issue for construction now"')
      return
    }

    setBusy(true)
    try {
      // Runs first so a duplicate number fails before anything is uploaded —
      // the unique index on (project, drawing_no) is what catches it.
      setStatus('Adding the drawing…')
      const drawingId = await createDrawing({
        project_id: projectId,
        drawing_no: drawingNo,
        title,
        discipline: disc,
      })

      if (file) {
        setStatus('Uploading the sheet…')
        const up = await uploadDrawing(projectId, file)

        setStatus('Saving the revision…')
        const revId = await addRevision({
          drawing_id: drawingId,
          revision: revision.trim() || 'R0',
          issued_date: issueNow ? issuedDate : null,
          file_path: up.path,
          file_type: up.fileType,
          notes,
        })

        if (issueNow) {
          await issueRevision(revId, issuedDate)
          toast.success(`${drawingNo.trim()} issued for construction`, {
            description: `Revision ${revision.trim() || 'R0'} — site can see it now.`,
          })
        } else {
          toast.success(`${drawingNo.trim()} added as WIP`, {
            description: 'Site cannot see it until it is issued.',
          })
        }
      } else {
        toast.success(`${drawingNo.trim()} added`, {
          description: 'Open it to upload its first sheet.',
        })
      }

      await onSaved()
    } catch (err) {
      toast.error('Could not add the drawing', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="paper space-y-5 p-5" noValidate>
      <p className="font-heading text-[18px] font-semibold">New drawing</p>

      <FieldRow
        label="Drawing number"
        htmlFor="d-no"
        hint="The sheet's number, not its revision — e.g. SD-101."
      >
        <Input
          id="d-no"
          value={drawingNo}
          onChange={(e) => setDrawingNo(e.target.value)}
          placeholder="e.g. SD-101"
          className="h-12 text-base"
          autoFocus
        />
      </FieldRow>

      <FieldRow label="Title" htmlFor="d-title">
        <Input
          id="d-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Ground floor plan"
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Discipline" htmlFor="d-disc">
        <Select
          id="d-disc"
          value={disc}
          onChange={(e) => setDisc(e.target.value as DrawingDiscipline)}
        >
          {DRAWING_DISCIPLINES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      <div className="border-t border-border pt-5">
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          First sheet
        </p>

        <div className="mt-3 grid grid-cols-2 gap-4">
          <FieldRow label="Revision" htmlFor="d-rev">
            <Input
              id="d-rev"
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              placeholder="R0"
              className="h-12 text-base"
            />
          </FieldRow>

          <FieldRow label="Issued date" htmlFor="d-date">
            <Input
              id="d-date"
              type="date"
              value={issuedDate}
              onChange={(e) => e.target.value && setIssuedDate(e.target.value)}
              className="h-12"
              disabled={!issueNow}
            />
          </FieldRow>
        </div>

        <div className="mt-4">
          <FieldRow
            label="Sheet"
            htmlFor="d-file"
            hint="PDF, DWG or DXF. Uploaded byte-for-byte — never compressed."
          >
            <Input
              id="d-file"
              type="file"
              accept=".pdf,.dwg,.dxf,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="h-12 text-base"
            />
          </FieldRow>
        </div>

        <div className="mt-4">
          <FieldRow label="Notes" htmlFor="d-notes">
            <Textarea
              id="d-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything site should know about this sheet."
            />
          </FieldRow>
        </div>

        <label className="mt-4 flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={issueNow}
            onChange={(e) => setIssueNow(e.target.checked)}
            className="size-5 accent-[var(--accent)]"
          />
          Issue for construction now — site can see it immediately
        </label>
      </div>

      {status && <p className="text-xs text-muted-foreground">{status}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Saving…' : issueNow ? 'Add and issue' : 'Add drawing'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}
