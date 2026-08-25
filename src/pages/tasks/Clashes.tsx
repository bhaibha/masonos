import {
  CheckCircle2,
  Camera,
  HelpCircle,
  Layers,
  Plus,
  ShieldCheck,
  Trash2,
  Unplug,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DrawingOverlay } from '@/components/DrawingOverlay'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  createClash,
  deleteClash,
  fetchAssignableUsers,
  fetchClashDrawings,
  fetchClashes,
  raiseRfiFromClash,
  setClashStatus,
} from '@/lib/queries/clashes'
import { signedSitePhotoUrl, uploadSitePhoto } from '@/lib/storage'
import {
  canVerifyClash,
  canWorkClashes,
  CLASH_DISCIPLINES,
  CLASH_SEVERITY_LABEL,
  CLASH_STATUS_LABEL,
  DRAWING_DISCIPLINES,
  type ClashRow,
  type ClashSeverity,
  type ClashStatus,
  type DrawingDiscipline,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const STATUS_TONE: Record<ClashStatus, string> = {
  open: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  resolved: 'bg-secondary text-secondary-foreground',
  verified:
    'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
}

const SEV_TONE: Record<ClashSeverity, string> = {
  high: 'bg-destructive/10 text-destructive',
  medium: 'bg-secondary text-muted-foreground',
  low: 'bg-secondary text-muted-foreground',
}

const disciplineLabel = (d: DrawingDiscipline) =>
  DRAWING_DISCIPLINES.find((x) => x.value === d)?.label ?? d

interface Sheet {
  id: string
  label: string
  filePath: string | null
  discipline: string
}

/**
 * D2 — the coordination clash register.
 *
 * A manual register, not BIM clash detection: somebody noticed two systems in
 * the same place and wrote it down so it gets chased. There is no geometry
 * here, so nothing on this screen claims a count means "all the clashes" — it
 * means the ones people found.
 *
 * No money on the table, so supervisors see and use all of it. Verifying is
 * founder/PM, and the server refuses self-verification even for them.
 */
export default function Clashes() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayWork = canWorkClashes(role)
  const mayVerify = canVerifyClash(role)

  const [list, setList] = useState<ClashRow[] | null>(null)
  const [filter, setFilter] = useState<ClashStatus | null>(null)
  const [raising, setRaising] = useState(false)
  const [overlay, setOverlay] = useState(false)
  const [sheets, setSheets] = useState<Sheet[]>([])
  const [people, setPeople] = useState<{ id: string; name: string }[]>([])

  const reload = useCallback(async () => {
    if (!projectId) return
    setList(null)
    try {
      setList(await fetchClashes(projectId, filter))
    } catch (err) {
      toast.error('Could not load the clash register', {
        description: errText(err),
      })
      setList([])
    }
  }, [projectId, filter])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!projectId) return
    // Pickers are a convenience — a failure here must not stop somebody logging
    // a clash they are standing in front of.
    void fetchClashDrawings(projectId).then(setSheets).catch(() => setSheets([]))
    void fetchAssignableUsers(projectId).then(setPeople).catch(() => setPeople([]))
  }, [projectId])

  if (!projectId) {
    return (
      <div className="mx-auto max-w-lg px-4 py-8">
        <OtherProjectsHint />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 px-4 py-4 pb-6">
      {mayWork && !raising && !overlay && (
        <div className="grid grid-cols-2 gap-2">
          <Button className="h-12 gap-2 text-base" onClick={() => setRaising(true)}>
            <Plus className="size-4" /> Raise
          </Button>
          <Button
            variant="outline"
            className="h-12 gap-2 text-base"
            onClick={() => setOverlay(true)}
          >
            <Layers className="size-4" /> Overlay
          </Button>
        </div>
      )}

      {overlay && (
        <DrawingOverlay sheets={sheets} onClose={() => setOverlay(false)} />
      )}

      {raising && (
        <RaiseForm
          projectId={projectId}
          sheets={sheets}
          people={people}
          onCancel={() => setRaising(false)}
          onDone={() => {
            setRaising(false)
            void reload()
          }}
        />
      )}

      <div className="flex gap-2 overflow-x-auto pb-1">
        {([null, 'open', 'resolved', 'verified'] as const).map((s) => (
          <button
            key={s ?? 'all'}
            type="button"
            onClick={() => setFilter(s)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors',
              filter === s
                ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-[var(--accent)]'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {s === null ? 'All' : CLASH_STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {list === null && <ListSkeleton rows={4} />}

      {list !== null && list.length === 0 && (
        <EmptyState
          icon={Unplug}
          title={filter ? 'Nothing in this state' : 'No clashes logged yet'}
          body={
            filter
              ? 'Clear the filter to see the whole register.'
              : mayWork
                ? 'When two systems want the same space — a beam through a duct ' +
                  'run, a stack crossing a conduit bank — log it here so it gets ' +
                  'chased before it gets built.'
                : 'Nothing has been logged on this project yet.'
          }
          actionLabel={mayWork && !filter ? 'Raise the first one' : undefined}
          onAction={mayWork && !filter ? () => setRaising(true) : undefined}
        />
      )}

      {list !== null && list.length > 0 && (
        <Stagger className="space-y-3">
          {list.map((c) => (
            <RevealItem key={c.id}>
              <ClashCard
                row={c}
                mayWork={mayWork}
                mayVerify={mayVerify}
                onChanged={reload}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}

      {list !== null && list.length > 0 && (
        <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
          This is a register of clashes people found, not of clashes that exist.
          There is no model behind it — an empty list means nobody has looked.
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ClashCard({
  row,
  mayWork,
  mayVerify,
  onChanged,
}: {
  row: ClashRow
  mayWork: boolean
  mayVerify: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [askingRfi, setAskingRfi] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [note, setNote] = useState('')
  const [question, setQuestion] = useState('')
  const [addressee, setAddressee] = useState('')
  const [category, setCategory] = useState('design')
  const [requiredBy, setRequiredBy] = useState('')

  async function move(status: ClashStatus, text: string | null) {
    setBusy(true)
    try {
      await setClashStatus(row.id, status, text)
      toast.success(
        status === 'resolved'
          ? 'Recorded as resolved'
          : status === 'verified'
            ? 'Verified'
            : 'Reopened',
      )
      setResolving(false)
      setNote('')
      onChanged()
    } catch (err) {
      toast.error('Could not update it', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            {row.clash_no} · {row.location}
          </p>
          <h3 className="font-heading mt-1 text-[16px] leading-snug font-semibold">
            {row.system_a}{' '}
            <span className="text-muted-foreground">vs</span> {row.system_b}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {disciplineLabel(row.discipline_a)} ·{' '}
            {disciplineLabel(row.discipline_b)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11px] font-medium',
              STATUS_TONE[row.status],
            )}
          >
            {CLASH_STATUS_LABEL[row.status]}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px]',
              SEV_TONE[row.severity],
            )}
          >
            {CLASH_SEVERITY_LABEL[row.severity]}
          </span>
        </div>
      </div>

      <p className="mt-3 text-sm leading-relaxed">{row.description}</p>

      <dl className="mt-4 space-y-1.5 text-xs">
        {(row.drawing_a_no || row.drawing_b_no || row.drawing_refs.length > 0) && (
          <Line
            label="Drawings"
            value={[
              row.drawing_a_no,
              row.drawing_b_no,
              ...row.drawing_refs,
            ]
              .filter(Boolean)
              .join(', ')}
          />
        )}
        {row.assigned_to_name && (
          <Line label="With" value={row.assigned_to_name} />
        )}
        {row.raised_by_name && <Line label="Raised by" value={row.raised_by_name} />}
        {row.open_days !== null && row.open_days > 0 && (
          <Line
            label="Open"
            value={`${row.open_days} day${row.open_days === 1 ? '' : 's'}`}
          />
        )}
        {row.resolved_by_name && (
          <Line label="Resolved by" value={row.resolved_by_name} />
        )}
        {row.verified_by_name && (
          <Line label="Verified by" value={row.verified_by_name} />
        )}
      </dl>

      {row.photos.length > 0 && <Photos paths={row.photos} />}

      {row.resolution && (
        <p className="mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs">
          <span className="font-medium">What was done:</span> {row.resolution}
        </p>
      )}

      {/* The RFI, when the answer belongs to somebody outside the firm. */}
      {row.rfi_number && (
        <p
          className={cn(
            'mt-3 flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs',
            row.rfi_answered
              ? 'bg-[color-mix(in_oklab,var(--positive)_10%,transparent)] text-[var(--positive)]'
              : 'bg-[color-mix(in_oklab,var(--warning)_11%,transparent)] text-[var(--warning)]',
          )}
        >
          <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
          {row.rfi_number} —{' '}
          {row.rfi_answered
            ? 'answered'
            : 'waiting on the consultant. Nobody here can move this one.'}
        </p>
      )}

      {mayWork && (
        <div className="mt-4 space-y-2">
          {!resolving && !askingRfi && !confirmDelete && (
            <div className="flex flex-wrap gap-2">
              {row.status === 'open' && (
                <Button
                  size="sm"
                  className="h-10 flex-1 gap-1.5"
                  disabled={busy}
                  onClick={() => setResolving(true)}
                >
                  <CheckCircle2 className="size-3.5" /> Resolved
                </Button>
              )}
              {row.status === 'resolved' && mayVerify && (
                <Button
                  size="sm"
                  className="h-10 flex-1 gap-1.5"
                  disabled={busy}
                  onClick={() => void move('verified', null)}
                >
                  <ShieldCheck className="size-3.5" /> Verify
                </Button>
              )}
              {row.status !== 'open' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-10"
                  disabled={busy}
                  onClick={() => void move('open', null)}
                >
                  Reopen
                </Button>
              )}
              {!row.rfi_id && mayVerify && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-10 gap-1.5"
                  onClick={() => {
                    setQuestion(
                      `${row.system_a} and ${row.system_b} conflict at ${row.location}. ${row.description}\n\nPlease advise how to resolve.`,
                    )
                    setAskingRfi(true)
                  }}
                >
                  <HelpCircle className="size-3.5" /> Ask consultant
                </Button>
              )}
              {row.status === 'open' && !row.rfi_id && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-10 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete this clash"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          )}

          {resolving && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <FieldRow label="What was done" htmlFor={`r_${row.id}`}>
                <Textarea
                  id={`r_${row.id}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Duct dropped below the soffit; sleeve cast per the consultant's mark-up"
                  rows={3}
                />
              </FieldRow>
              <p className="text-[11px] text-muted-foreground">
                Required. "Resolved" with no account of the fix tells the next
                person nothing.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  className="h-11"
                  onClick={() => setResolving(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  className="h-11"
                  disabled={busy || note.trim() === ''}
                  title={note.trim() === '' ? 'Say what was done first' : undefined}
                  onClick={() => void move('resolved', note)}
                >
                  Record it
                </Button>
              </div>
            </div>
          )}

          {askingRfi && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <FieldRow label="Question" htmlFor={`q_${row.id}`}>
                <Textarea
                  id={`q_${row.id}`}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  rows={4}
                />
              </FieldRow>
              <p className="text-[11px] text-muted-foreground">
                The clash number, systems, location and drawing numbers are
                appended automatically — the consultant's first reply is
                otherwise "which drawings?".
              </p>
              <div className="grid grid-cols-2 gap-2">
                <FieldRow label="Addressed to" htmlFor={`at_${row.id}`}>
                  <Input
                    id={`at_${row.id}`}
                    value={addressee}
                    onChange={(e) => setAddressee(e.target.value)}
                    placeholder="Structural consultant"
                    className="h-12 text-base"
                  />
                </FieldRow>
                <FieldRow label="Category" htmlFor={`cat_${row.id}`}>
                  <Select
                    id={`cat_${row.id}`}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    <option value="design">Design</option>
                    <option value="structural">Structural</option>
                    <option value="mep">MEP</option>
                    <option value="finishes">Finishes</option>
                    <option value="other">Other</option>
                  </Select>
                </FieldRow>
              </div>
              <FieldRow label="Answer needed by" htmlFor={`rb_${row.id}`}>
                <Input
                  id={`rb_${row.id}`}
                  type="date"
                  value={requiredBy}
                  onChange={(e) => setRequiredBy(e.target.value)}
                  className="h-12 text-base"
                />
              </FieldRow>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  className="h-11"
                  onClick={() => setAskingRfi(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  className="h-11"
                  disabled={busy || question.trim() === ''}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await raiseRfiFromClash(
                        row.id,
                        question,
                        addressee || null,
                        category,
                        requiredBy || null,
                      )
                      toast.success('RFI raised', {
                        description: 'Find it under Tasks → RFIs.',
                      })
                      setAskingRfi(false)
                      onChanged()
                    } catch (err) {
                      toast.error('Could not raise the RFI', {
                        description: errText(err),
                      })
                      setBusy(false)
                    }
                  }}
                >
                  Raise RFI
                </Button>
              </div>
            </div>
          )}

          {confirmDelete && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-xs">
                Delete {row.clash_no}? Only possible while it is open with no RFI
                against it.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  className="h-11"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep
                </Button>
                <Button
                  variant="destructive"
                  className="h-11"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await deleteClash(row.id)
                      toast.success('Deleted')
                      onChanged()
                    } catch (err) {
                      toast.error('Could not delete', {
                        description: errText(err),
                      })
                      setBusy(false)
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{value}</dd>
    </div>
  )
}

function Photos({ paths }: { paths: string[] }) {
  const [urls, setUrls] = useState<(string | null)[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all(paths.map((p) => signedSitePhotoUrl(p))).then((u) => {
      if (!cancelled) setUrls(u)
    })
    return () => {
      cancelled = true
    }
  }, [paths])

  if (urls.length === 0) return null

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {urls.map((u, i) =>
        u ? (
          <a key={i} href={u} target="_blank" rel="noreferrer">
            <img
              src={u}
              alt={`Clash ${i + 1}`}
              className="size-20 rounded-lg object-cover ring-1 ring-foreground/10"
            />
          </a>
        ) : null,
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function RaiseForm({
  projectId,
  sheets,
  people,
  onCancel,
  onDone,
}: {
  projectId: string
  sheets: Sheet[]
  people: { id: string; name: string }[]
  onCancel: () => void
  onDone: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  const [systemA, setSystemA] = useState('')
  const [systemB, setSystemB] = useState('')
  const [discA, setDiscA] = useState<DrawingDiscipline>('structural')
  const [discB, setDiscB] = useState<DrawingDiscipline>('mep')
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<ClashSeverity>('medium')
  const [drawingA, setDrawingA] = useState('')
  const [drawingB, setDrawingB] = useState('')
  const [refs, setRefs] = useState('')
  const [assignee, setAssignee] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function save() {
    if (!systemA.trim() || !systemB.trim()) {
      toast.error('Name both systems')
      return
    }
    if (systemA.trim().toLowerCase() === systemB.trim().toLowerCase()) {
      toast.error('Those are the same thing', {
        description: 'A clash needs two different systems.',
      })
      return
    }
    if (!location.trim()) {
      toast.error('Where is it?', {
        description: 'A grid reference or a room name — anything findable.',
      })
      return
    }
    if (!description.trim()) {
      toast.error('Say what the conflict is')
      return
    }

    setBusy(true)
    try {
      const photos: string[] = []
      for (let i = 0; i < files.length; i++) {
        setStatus(`Uploading photo ${i + 1} of ${files.length}…`)
        photos.push(await uploadSitePhoto(projectId, files[i]))
      }
      setStatus('Saving…')

      await createClash({
        project_id: projectId,
        system_a: systemA,
        system_b: systemB,
        discipline_a: discA,
        discipline_b: discB,
        location,
        description,
        severity,
        drawing_a_id: drawingA || null,
        drawing_b_id: drawingB || null,
        drawing_refs: refs
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        photos,
        assigned_to: assignee || null,
      })

      toast.success('Clash logged', {
        description: 'It stays open until somebody records how it was resolved.',
      })
      onDone()
    } catch (err) {
      toast.error('Could not log it', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <section className="paper space-y-4 p-5">
      <p className="font-heading text-[15px] font-semibold">Raise a clash</p>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="This…" htmlFor="c_sa">
          <Input
            id="c_sa"
            value={systemA}
            onChange={(e) => setSystemA(e.target.value)}
            placeholder="PT beam B-14"
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="…clashes with" htmlFor="c_sb">
          <Input
            id="c_sb"
            value={systemB}
            onChange={(e) => setSystemB(e.target.value)}
            placeholder="600 dia supply duct"
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Discipline" htmlFor="c_da">
          <Select
            id="c_da"
            value={discA}
            onChange={(e) => setDiscA(e.target.value as DrawingDiscipline)}
          >
            {CLASH_DISCIPLINES.map((d) => (
              <option key={d} value={d}>
                {disciplineLabel(d)}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="Discipline" htmlFor="c_db">
          <Select
            id="c_db"
            value={discB}
            onChange={(e) => setDiscB(e.target.value as DrawingDiscipline)}
          >
            {CLASH_DISCIPLINES.map((d) => (
              <option key={d} value={d}>
                {disciplineLabel(d)}
              </option>
            ))}
          </Select>
        </FieldRow>
      </div>

      <FieldRow label="Where" htmlFor="c_loc">
        <Input
          id="c_loc"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="2nd floor lobby, grid C/4-5"
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="What is the conflict" htmlFor="c_desc">
        <Textarea
          id="c_desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Duct passes through the beam soffit zone. No sleeve shown on either sheet."
          rows={3}
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="How bad" htmlFor="c_sev">
          <Select
            id="c_sev"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as ClashSeverity)}
          >
            <option value="low">Low — coordinate when convenient</option>
            <option value="medium">Medium</option>
            <option value="high">High — blocks work</option>
          </Select>
        </FieldRow>
        <FieldRow label="With" htmlFor="c_asg">
          <Select
            id="c_asg"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">Nobody yet</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FieldRow>
      </div>

      {sheets.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <FieldRow label="Drawing" htmlFor="c_dwa">
            <Select
              id="c_dwa"
              value={drawingA}
              onChange={(e) => setDrawingA(e.target.value)}
            >
              <option value="">Not linked</option>
              {sheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </FieldRow>
          <FieldRow label="Drawing" htmlFor="c_dwb">
            <Select
              id="c_dwb"
              value={drawingB}
              onChange={(e) => setDrawingB(e.target.value)}
            >
              <option value="">Not linked</option>
              {sheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </FieldRow>
        </div>
      )}

      <FieldRow label="Other sheet references" htmlFor="c_refs">
        <Input
          id="c_refs"
          value={refs}
          onChange={(e) => setRefs(e.target.value)}
          placeholder="AHU-SHOP-03, SK-12"
          className="h-12 text-base"
        />
      </FieldRow>
      <p className="text-[11px] text-muted-foreground">
        For sheets that are not in the drawing register — a consultant's PDF, a
        vendor shop drawing. Comma separated.
      </p>

      <div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <Button
          type="button"
          variant="outline"
          className="h-12 w-full justify-start gap-2 text-base"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <Camera className="size-4" />
          {files.length === 0
            ? 'Photo or mark-up'
            : `${files.length} photo${files.length === 1 ? '' : 's'} ready`}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" className="h-11" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button className="h-11" onClick={() => void save()} disabled={busy}>
          {busy ? (status ?? 'Saving…') : 'Log it'}
        </Button>
      </div>
    </section>
  )
}
