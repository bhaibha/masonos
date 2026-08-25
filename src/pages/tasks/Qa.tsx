import {
  Download,
  FileText,
  MessageSquareWarning,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { PhotoHelper } from '@/components/PhotoHelper'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { generateNcrFile, generateNcrPdf } from '@/lib/ncrPdf'
import { createDocument } from '@/lib/queries/documents'
import { fetchProject } from '@/lib/queries/projects'
import {
  createNcr,
  deleteComment,
  fetchComments,
  fetchNcrs,
  fetchQaDocs,
  fetchQaSummary,
  raiseComment,
  setNcrStatus,
} from '@/lib/queries/qa'
import { fetchProjectTeam } from '@/lib/queries/tasks'
import { deleteRecord } from '@/lib/queries/voids'
import {
  compressImage,
  signedDocumentUrl,
  signedSitePhotoUrl,
  uploadDocument,
  uploadSitePhoto,
} from '@/lib/storage'
import {
  canRaiseNcr,
  canSignOffInspection,
  type InspectionComment,
  NCR_SEVERITIES,
  NCR_SEVERITY_LABEL,
  NCR_STATUS_LABEL,
  type NcrRow,
  type NcrSeverity,
  type NewInspectionComment,
  type NewNcrInput,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  type QaSummary,
  TASK_PRIORITIES,
  type TaskPriority,
  TRADES,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

type Tab = 'comments' | 'ncrs' | 'docs'

/**
 * Quality — site observations, NCRs and the QA plan documents.
 *
 * A site walk produces OBSERVATIONS, not thirty-question forms. Somebody sees
 * something wrong, writes it down, photographs it, says how urgent it is, and
 * it becomes work for a named person. That is the whole loop, and it is why
 * the structured ITP that stood here until 048 is gone.
 */
export default function Qa() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  const maySignOff = canSignOffInspection(role)
  const mayRaise = canRaiseNcr(role)

  const [tab, setTab] = useState<Tab>('comments')
  const [comments, setComments] = useState<InspectionComment[] | null>(null)
  const [ncrs, setNcrs] = useState<NcrRow[]>([])
  const [summary, setSummary] = useState<QaSummary | null>(null)

  const [raising, setRaising] = useState(false)
  const [raisingNcr, setRaisingNcr] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const [c, n, s] = await Promise.all([
        fetchComments(projectId),
        fetchNcrs(projectId).catch(() => [] as NcrRow[]),
        fetchQaSummary(projectId),
      ])
      setComments(c)
      setNcrs(n)
      setSummary(s)
    } catch (err) {
      toast.error('Could not load quality records', {
        description: errText(err),
      })
      setComments([])
    }
  }, [projectId])

  useEffect(() => {
    setComments(null)
    void reload()
  }, [reload])

  if (!projectId || comments === null) return <ListSkeleton rows={5} />

  const openCount = summary?.open_comments ?? 0

  return (
    <div className="space-y-4 pb-6">
      {summary && <QaCard summary={summary} />}

      <div className="flex gap-1">
        {(
          [
            ['comments', 'Comments' + (openCount > 0 ? ' (' + openCount + ')' : '')],
            ['ncrs', 'NCRs' + (summary && summary.open_ncrs > 0 ? ' (' + summary.open_ncrs + ')' : '')],
            ['docs', 'QA plan docs'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'min-h-11 flex-1 rounded-lg px-3 text-sm font-medium transition-colors',
              tab === t
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'comments' && (
        <CommentsTab
          projectId={projectId}
          comments={comments}
          mayRaise={mayRaise}
          maySignOff={maySignOff}
          raising={raising}
          setRaising={setRaising}
          onChanged={reload}
        />
      )}

      {tab === 'ncrs' && (
        <NcrTab
          projectId={projectId}
          ncrs={ncrs}
          maySignOff={maySignOff}
          mayRaise={mayRaise}
          raising={raisingNcr}
          setRaising={setRaisingNcr}
          onChanged={reload}
        />
      )}

      {tab === 'docs' && (
        <DocsTab projectId={projectId} mayUpload={maySignOff} onChanged={reload} />
      )}
    </div>
  )
}

/* ---------------- summary card ---------------- */

function QaCard({ summary: s }: { summary: QaSummary }) {
  return (
    <section className="paper p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Quality
        </h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {s.total_comments} observation{s.total_comments === 1 ? '' : 's'} logged
        </span>
      </div>

      {/* Urgent is the only line that should ever shout. */}
      {s.urgent_comments > 0 && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
          {s.urgent_comments} urgent observation
          {s.urgent_comments === 1 ? '' : 's'} still open.
        </p>
      )}

      <div className="mt-4 grid grid-cols-3 gap-5">
        <Stat
          label="Open comments"
          value={String(s.open_comments)}
          tone={
            s.urgent_comments > 0
              ? 'danger'
              : s.open_comments > 0
                ? 'warning'
                : undefined
          }
          hint={
            s.open_comments > 0
              ? [
                  s.urgent_comments > 0 && s.urgent_comments + ' urgent',
                  s.high_comments > 0 && s.high_comments + ' high',
                ]
                  .filter(Boolean)
                  .join(' · ') || 'none urgent'
              : 'all cleared'
          }
        />
        <Stat
          label="Open NCRs"
          value={String(s.open_ncrs)}
          tone={
            s.ncr_critical > 0
              ? 'danger'
              : s.open_ncrs > 0
                ? 'warning'
                : undefined
          }
          hint={
            s.open_ncrs > 0
              ? [
                  s.ncr_critical > 0 && s.ncr_critical + ' critical',
                  s.ncr_major > 0 && s.ncr_major + ' major',
                ]
                  .filter(Boolean)
                  .join(' · ') || s.ncr_minor + ' minor'
              : 'none outstanding'
          }
        />
        <Stat
          label="QA documents"
          value={String(s.qa_docs)}
          hint="in QC Certificates"
        />
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'danger' | 'warning'
}) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'figure mt-1.5 text-[24px] leading-none font-semibold',
          tone === 'danger' && 'text-destructive',
          tone === 'warning' && 'text-[var(--warning)]',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/* ---------------- inspection comments ---------------- */

function CommentsTab({
  projectId,
  comments,
  mayRaise,
  maySignOff,
  raising,
  setRaising,
  onChanged,
}: {
  projectId: string
  comments: InspectionComment[]
  mayRaise: boolean
  maySignOff: boolean
  raising: boolean
  setRaising: (v: boolean) => void
  onChanged: () => Promise<void>
}) {
  const [showClosed, setShowClosed] = useState(false)
  const open = comments.filter((c) => !c.task_done)
  const shown = showClosed ? comments : open

  return (
    <div className="space-y-3">
      {mayRaise && (
        <Button className="h-12 w-full text-base" onClick={() => setRaising(!raising)}>
          <MessageSquareWarning className="size-4" aria-hidden="true" />
          {raising ? 'Close' : 'Add a comment'}
        </Button>
      )}

      {raising && (
        <CommentForm
          projectId={projectId}
          onDone={async () => {
            setRaising(false)
            await onChanged()
          }}
          onCancel={() => setRaising(false)}
        />
      )}

      {comments.length > open.length && (
        <button
          type="button"
          onClick={() => setShowClosed((v) => !v)}
          className="w-full py-1 text-sm text-muted-foreground hover:text-foreground"
        >
          {showClosed
            ? 'Show only open'
            : 'Show closed too (' + (comments.length - open.length) + ' hidden)'}
        </button>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={MessageSquareWarning}
          title={
            comments.length === 0
              ? 'Nothing raised yet'
              : 'Everything raised has been done'
          }
          body="Walk the site, tap Add a comment, say where it is and what is wrong. It becomes a task for whoever has to fix it."
        />
      ) : (
        <Stagger className="space-y-2.5">
          {shown.map((c) => (
            <RevealItem key={c.id}>
              <CommentCard
                comment={c}
                mayDelete={maySignOff}
                onChanged={onChanged}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}

      <p className="pt-1 text-xs text-muted-foreground">
        A comment has no status of its own — the task it created carries that,
        and closing that task on the Tasks screen closes the observation. One
        place to look for outstanding work.
      </p>
    </div>
  )
}

function CommentCard({
  comment: c,
  mayDelete,
  onChanged,
}: {
  comment: InspectionComment
  mayDelete: boolean
  onChanged: () => Promise<void>
}) {
  async function remove() {
    if (!confirm('Remove this observation? The task it created stays.')) return
    try {
      await deleteComment(c.id)
      toast.success('Observation removed', {
        description: 'The task it created is untouched.',
      })
      await onChanged()
    } catch (err) {
      toast.error('Could not remove it', { description: errText(err) })
    }
  }

  return (
    <article
      className={cn(
        'paper p-4',
        c.task_done && 'opacity-65',
        !c.task_done &&
          c.priority === 'urgent' &&
          'border-l-[3px] border-l-destructive',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
                PRIORITY_TONE[c.priority],
              )}
            >
              {PRIORITY_LABEL[c.priority]}
            </span>
            <span className="font-medium">{c.location}</span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {c.observed_on}
            {c.raised_for && ' · raised by ' + c.raised_for}
            {!c.raised_for && c.raised_by_name && ' · ' + c.raised_by_name}
          </p>
        </div>

        <span
          className={cn(
            'shrink-0 text-xs font-medium',
            c.task_done ? 'text-[var(--positive)]' : 'text-[var(--warning)]',
          )}
        >
          {c.task_done ? 'Done' : 'Open'}
        </span>
      </div>

      <p className="mt-2 text-sm break-words">{c.comment}</p>

      {c.photos.length > 0 && <PhotoStrip paths={c.photos} />}

      {/* D1 — optional second look at the observation photo. Opt-in only. */}
      {c.photos.length > 0 && (
        <PhotoHelper
          projectId={c.project_id}
          photoPath={c.photos[0]}
          source="inspection"
          commentId={c.id}
          onRaised={() => void onChanged()}
        />
      )}

      {mayDelete && (
        <div className="mt-3 flex justify-end border-t border-border pt-2">
          <Button
            variant="ghost"
            className="h-9 px-2 text-xs text-destructive"
            onClick={() => void remove()}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </article>
  )
}

function CommentForm({
  projectId,
  onDone,
  onCancel,
}: {
  projectId: string
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [location, setLocation] = useState('')
  const [comment, setComment] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('normal')
  const [raisedFor, setRaisedFor] = useState('')
  const [assignedTo, setAssignedTo] = useState('')
  const [trade, setTrade] = useState('')
  const [due, setDue] = useState(todayIst())
  const [files, setFiles] = useState<File[]>([])
  const [team, setTeam] = useState<{ id: string; full_name: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    fetchProjectTeam(projectId)
      .then((t) => setTeam(t.map((p) => ({ id: p.id, full_name: p.full_name }))))
      .catch(() => setTeam([]))
  }, [projectId])

  async function pick(list: FileList | null) {
    if (!list?.length) return
    try {
      const out: File[] = []
      for (const f of Array.from(list)) out.push(await compressImage(f))
      setFiles((prev) => [...prev, ...out])
    } catch {
      toast.error('Could not process that photo.')
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!location.trim()) {
      toast.error('Say where it is', {
        description: 'A defect with no location is a defect nobody can find.',
      })
      return
    }
    if (!comment.trim()) {
      toast.error('Say what is wrong.')
      return
    }

    setBusy(true)
    try {
      const paths: string[] = []
      if (files.length) {
        setStatus('Uploading photos…')
        for (const f of files) paths.push(await uploadSitePhoto(projectId, f))
      }

      setStatus('Saving…')
      const input: NewInspectionComment = {
        location,
        comment,
        priority,
        photos: paths,
        raised_for: raisedFor,
        assigned_to: assignedTo || null,
        due_date: due || null,
        trade,
      }
      await raiseComment(projectId, input)

      const who = team.find((t) => t.id === assignedTo)?.full_name
      toast.success('Comment raised', {
        description: who
          ? 'A task is now on ' + who + "'s list."
          : 'It is on the Tasks list for this project.',
      })
      await onDone()
    } catch (err) {
      toast.error('Could not raise that comment', { description: errText(err) })
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="paper space-y-4 p-5" noValidate>
      <FieldRow label="Where" htmlFor="c_loc">
        <Input
          id="c_loc"
          required
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="h-12 text-base"
          placeholder="First floor, master bedroom"
        />
      </FieldRow>

      <FieldRow label="What is wrong" htmlFor="c_text">
        <Textarea
          id="c_text"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Skirting line uneven along the north wall"
        />
      </FieldRow>

      {/* Priority as four tap targets rather than a dropdown — it is the field
          most likely to be set one-handed while standing in the room. */}
      <FieldRow label="Priority" htmlFor="c_pri">
        <div className="grid grid-cols-4 gap-2" id="c_pri">
          {TASK_PRIORITIES.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPriority(p.value)}
              aria-pressed={priority === p.value}
              className={cn(
                'h-12 rounded-lg text-sm font-medium transition-colors',
                priority === p.value
                  ? p.value === 'urgent'
                    ? 'bg-destructive text-white'
                    : p.value === 'high'
                      ? 'bg-[var(--warning)] text-white'
                      : 'bg-secondary text-secondary-foreground'
                  : 'bg-secondary/50 text-muted-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </FieldRow>

      <PhotoPicker files={files} onChange={setFiles} onPick={pick} id="c_photos" />

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Assign to" htmlFor="c_assign">
          <Select
            id="c_assign"
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
          >
            <option value="">Nobody yet</option>
            {team.map((t) => (
              <option key={t.id} value={t.id}>
                {t.full_name}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="Due" htmlFor="c_due">
          <Input
            id="c_due"
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Trade" htmlFor="c_trade">
          <Select
            id="c_trade"
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
          >
            <option value="">Not specified</option>
            {TRADES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow
          label="Raised by"
          htmlFor="c_by"
          hint="Leave blank if it is yours"
        >
          <Input
            id="c_by"
            value={raisedFor}
            onChange={(e) => setRaisedFor(e.target.value)}
            className="h-12 text-base"
            placeholder="Client name"
          />
        </FieldRow>
      </div>

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? (status ?? 'Saving…') : 'Raise comment'}
        </Button>
        <Button type="button" variant="ghost" className="h-12" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        This creates a task on the Tasks list at the same moment. An observation
        that never reached anybody is the thing this is here to prevent.
      </p>
    </form>
  )
}

/* ---------------- QA plan documents ---------------- */

interface QaDoc {
  id: string
  title: string
  file_path: string
  created_at: string
}

function DocsTab({
  projectId,
  mayUpload,
  onChanged,
}: {
  projectId: string
  mayUpload: boolean
  onChanged: () => Promise<void>
}) {
  const [docs, setDocs] = useState<QaDoc[] | null>(null)
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await fetchQaDocs(projectId)
      setDocs(d.map((x) => ({
        id: x.id,
        title: x.title,
        file_path: x.file_path,
        created_at: x.created_at,
      })))
    } catch {
      setDocs([])
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function upload() {
    if (!file) {
      toast.error('Choose a file first.')
      return
    }
    setBusy(true)
    try {
      const { path, fileType } = await uploadDocument(projectId, file)
      await createDocument({
        project_id: projectId,
        folder: 'qc_certificates',
        title: title.trim() || file.name.replace(/\.[^.]+$/, ''),
        file_path: path,
        file_type: fileType,
        // A QA plan carries no rupee figure and the people who must work to it
        // are the site team. Confidential would be the wrong default.
        is_confidential: false,
        doc_kind: 'qa_plan',
      })
      toast.success('Filed to Docs → QC Certificates')
      setTitle('')
      setFile(null)
      await load()
      await onChanged()
    } catch (err) {
      toast.error('Could not upload that file', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  async function open(path: string) {
    const url = await signedDocumentUrl(path)
    if (!url) {
      toast.error('Could not open that document')
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function remove(id: string) {
    if (!confirm('Remove this document?')) return
    try {
      await deleteRecord('documents', id)
      toast.success('Document removed')
      await load()
      await onChanged()
    } catch (err) {
      toast.error('Could not remove it', { description: errText(err) })
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        QA plans, blank checklists and completed inspection sheets. These are
        ordinary documents in <strong>Docs → QC Certificates</strong> — the same
        files, shown here because this is where you look for them. Filed NCRs
        go to that folder too, but not to this list.
      </p>

      {mayUpload && (
        <section className="paper space-y-4 p-5">
          <FieldRow
            label="Title"
            htmlFor="d_title"
            hint="Optional — the file name is used otherwise"
          >
            <Input
              id="d_title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-12 text-base"
              placeholder="Checklist — reinforcement of slab & beam"
            />
          </FieldRow>

          <FieldRow
            label="File"
            htmlFor="d_file"
            hint="PDFs upload byte-for-byte, never compressed"
          >
            <input
              id="d_file"
              type="file"
              accept="application/pdf,image/*"
              className="sr-only"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-12 flex-1 text-base"
                onClick={() => document.getElementById('d_file')?.click()}
              >
                <Upload className="size-4" aria-hidden="true" />
                {file ? 'Choose another' : 'Choose a PDF'}
              </Button>
              {file && (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-12"
                  onClick={() => setFile(null)}
                >
                  Clear
                </Button>
              )}
            </div>
            {file && (
              <p className="mt-2 truncate text-xs text-muted-foreground">
                {file.name} · {Math.round(file.size / 1024)} KB
              </p>
            )}
          </FieldRow>

          <Button
            className="h-12 w-full text-base"
            disabled={busy || !file}
            onClick={() => void upload()}
          >
            {busy ? 'Uploading…' : 'Upload'}
          </Button>
        </section>
      )}

      {docs === null ? (
        <ListSkeleton rows={3} />
      ) : docs.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No QA documents yet"
          body="Upload the QA plan, the blank checklists, or a completed sheet photographed from site."
        />
      ) : (
        <ul className="paper divide-y divide-border overflow-hidden">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-5 py-4">
              <FileText
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <button
                type="button"
                onClick={() => void open(d.file_path)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-sm font-medium">
                  {d.title}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {d.created_at.slice(0, 10)}
                </span>
              </button>
              {mayUpload && (
                <button
                  type="button"
                  onClick={() => void remove(d.id)}
                  aria-label="Remove document"
                  className="shrink-0 text-destructive"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ---------------- NCRs ---------------- */

const NCR_TONE: Record<string, string> = {
  open: 'bg-destructive/10 text-destructive',
  corrected:
    'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  closed:
    'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  rejected: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-secondary text-muted-foreground',
}

function NcrTab({
  projectId,
  ncrs,
  maySignOff,
  mayRaise,
  raising,
  setRaising,
  onChanged,
}: {
  projectId: string
  ncrs: NcrRow[]
  maySignOff: boolean
  mayRaise: boolean
  raising: boolean
  setRaising: (v: boolean) => void
  onChanged: () => Promise<void>
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        A comment is an observation that becomes a task. An NCR is the formal
        non-conformance — it carries a number, a corrective action and a
        close-out, and it is what you show a client or a consultant.
      </p>

      {mayRaise && (
        <Button className="h-11 w-full" onClick={() => setRaising(!raising)}>
          <ShieldAlert className="size-4" aria-hidden="true" />
          {raising ? 'Close' : 'Raise an NCR'}
        </Button>
      )}

      {raising && (
        <NcrForm
          projectId={projectId}
          onDone={async () => {
            setRaising(false)
            await onChanged()
          }}
          onCancel={() => setRaising(false)}
        />
      )}

      {ncrs.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No non-conformances"
          body="Nothing formal has been raised on this project."
        />
      ) : (
        <Stagger className="space-y-2.5">
          {ncrs.map((n) => (
            <RevealItem key={n.id}>
              <NcrCard
                ncr={n}
                projectId={projectId}
                maySignOff={maySignOff}
                onChanged={onChanged}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function NcrCard({
  ncr: n,
  projectId,
  maySignOff,
  onChanged,
}: {
  ncr: NcrRow
  projectId: string
  maySignOff: boolean
  onChanged: () => Promise<void>
}) {
  const [correcting, setCorrecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function move(
    status: 'corrected' | 'closed' | 'rejected' | 'cancelled',
  ) {
    if (status !== 'closed' && note.trim() === '') {
      toast.error(
        status === 'corrected'
          ? 'Say what was actually done'
          : status === 'rejected'
            ? 'Say why the correction was rejected'
            : 'A reason is required to cancel',
      )
      return
    }
    setBusy(true)
    try {
      await setNcrStatus(n.id, status, note.trim() || undefined)
      toast.success(
        status === 'corrected'
          ? 'Corrective action recorded'
          : status === 'closed'
            ? n.ncr_no + ' closed'
            : status === 'rejected'
              ? 'Correction rejected'
              : n.ncr_no + ' cancelled',
      )
      setNote('')
      setCorrecting(false)
      await onChanged()
    } catch (err) {
      toast.error('Could not update that NCR', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  async function pdf(file: boolean) {
    setBusy(true)
    try {
      const p = await fetchProject(projectId)
      const opts = {
        ncr: n,
        projectName: p?.name ?? 'Project',
        siteAddress: p?.site_address ?? null,
        clientName: p?.client_name ?? null,
      }

      if (!file) {
        generateNcrPdf(opts)
        toast.success('NCR downloaded')
        return
      }

      const f = generateNcrFile(opts)
      const { path, fileType } = await uploadDocument(projectId, f)
      await createDocument({
        project_id: projectId,
        folder: 'qc_certificates',
        title: n.ncr_no + ' · ' + n.area,
        file_path: path,
        file_type: fileType,
        is_confidential: false,
        // Keeps it out of the QA plan list. It still lives in QC Certificates,
        // which is where an NCR belongs and the only place it should appear.
        doc_kind: 'ncr',
      })
      toast.success('Filed to Docs → QC Certificates')
    } catch (err) {
      toast.error('Could not build the PDF', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={cn('paper p-4', n.status === 'cancelled' && 'opacity-70')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {n.ncr_no}
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
                n.severity === 'critical'
                  ? 'bg-destructive/15 text-destructive'
                  : n.severity === 'major'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-secondary text-muted-foreground',
              )}
            >
              {NCR_SEVERITY_LABEL[n.severity]}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {n.area}
            {n.standard_ref && ' · ' + n.standard_ref} ·{' '}
            {n.created_at.slice(0, 10)}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded px-2 py-1 text-[11px] font-medium',
            NCR_TONE[n.status],
          )}
        >
          {NCR_STATUS_LABEL[n.status]}
        </span>
      </div>

      <p className="mt-2 text-sm break-words">{n.description}</p>

      {n.photos.length > 0 && <PhotoStrip paths={n.photos} />}

      {n.corrective_action && (
        <p className="mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs">
          <span className="font-medium">Corrective action:</span>{' '}
          {n.corrective_action}
        </p>
      )}
      {n.reject_reason && (
        <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Rejected: {n.reject_reason}
        </p>
      )}
      {n.cancel_reason && (
        <p className="mt-2 text-xs text-muted-foreground">
          Cancelled — {n.cancel_reason}
        </p>
      )}

      {n.status !== 'cancelled' && n.status !== 'closed' && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {correcting && (
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                n.status === 'corrected'
                  ? 'Why is this being rejected, or why is it being cancelled?'
                  : 'What was actually done to correct it?'
              }
            />
          )}

          <div className="flex flex-wrap gap-2">
            {n.status !== 'corrected' && (
              <Button
                variant="outline"
                className="h-10"
                disabled={busy}
                onClick={() =>
                  correcting ? void move('corrected') : setCorrecting(true)
                }
              >
                {correcting ? 'Save corrective action' : 'Record correction'}
              </Button>
            )}

            {maySignOff && n.status === 'corrected' && (
              <>
                <Button
                  className="h-10"
                  disabled={busy}
                  onClick={() => void move('closed')}
                >
                  Re-inspected — close
                </Button>
                <Button
                  variant="outline"
                  className="h-10"
                  disabled={busy}
                  onClick={() =>
                    correcting ? void move('rejected') : setCorrecting(true)
                  }
                >
                  Reject correction
                </Button>
              </>
            )}

            {maySignOff && (
              <Button
                variant="ghost"
                className="h-10 text-destructive"
                disabled={busy}
                onClick={() =>
                  correcting ? void move('cancelled') : setCorrecting(true)
                }
              >
                Cancel NCR
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <Button
          variant="ghost"
          className="h-10"
          disabled={busy}
          onClick={() => void pdf(false)}
        >
          <Download className="size-4" aria-hidden="true" />
          PDF
        </Button>
        <Button
          variant="ghost"
          className="h-10"
          disabled={busy}
          onClick={() => void pdf(true)}
        >
          File to Docs
        </Button>
      </div>
    </article>
  )
}

function NcrForm({
  projectId,
  onDone,
  onCancel,
}: {
  projectId: string
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [area, setArea] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<NcrSeverity>('minor')
  const [standard, setStandard] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)

  async function pick(list: FileList | null) {
    if (!list?.length) return
    try {
      const out: File[] = []
      for (const f of Array.from(list)) out.push(await compressImage(f))
      setFiles((prev) => [...prev, ...out])
    } catch {
      toast.error('Could not process that photo.')
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!area.trim() || !description.trim()) {
      toast.error('Say where it is and what is wrong.')
      return
    }
    setBusy(true)
    try {
      const paths: string[] = []
      for (const f of files) paths.push(await uploadSitePhoto(projectId, f))

      const input: NewNcrInput = {
        area,
        description,
        severity,
        standard_ref: standard,
        photos: paths,
        assigned_to: null,
      }
      await createNcr(projectId, input)
      toast.success('NCR raised')
      await onDone()
    } catch (err) {
      toast.error('Could not raise that NCR', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="paper space-y-4 p-5" noValidate>
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Area" htmlFor="ncr_area">
          <Input
            id="ncr_area"
            required
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="h-12 text-base"
            placeholder="First floor, grid C3"
          />
        </FieldRow>
        <FieldRow label="Severity" htmlFor="ncr_sev">
          <Select
            id="ncr_sev"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as NcrSeverity)}
          >
            {NCR_SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </FieldRow>
      </div>

      <FieldRow label="Standard" htmlFor="ncr_std">
        <Input
          id="ncr_std"
          value={standard}
          onChange={(e) => setStandard(e.target.value)}
          className="h-12 text-base"
          placeholder="IS 456"
        />
      </FieldRow>

      <FieldRow label="What does not conform" htmlFor="ncr_desc">
        <Textarea
          id="ncr_desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What was found, and against what requirement"
        />
      </FieldRow>

      <PhotoPicker files={files} onChange={setFiles} onPick={pick} id="ncr_photos" />

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Saving…' : 'Raise NCR'}
        </Button>
        <Button type="button" variant="ghost" className="h-12" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/* ---------------- photos ---------------- */

function PhotoPicker({
  files,
  onChange,
  onPick,
  id,
}: {
  files: File[]
  onChange: (f: File[]) => void
  onPick: (l: FileList | null) => Promise<void>
  id: string
}) {
  return (
    <FieldRow
      label="Photos"
      htmlFor={id}
      hint={
        files.length > 0
          ? files.length + ' attached — compressed to under 300 KB each.'
          : 'Camera opens directly.'
      }
    >
      <input
        id={id}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="sr-only"
        onChange={(e) => void onPick(e.target.files)}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-12 flex-1 text-base"
          onClick={() => document.getElementById(id)?.click()}
        >
          {files.length > 0 ? 'Add another' : 'Take photo'}
        </Button>
        {files.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="h-12"
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        )}
      </div>
    </FieldRow>
  )
}

function PhotoStrip({ paths }: { paths: string[] }) {
  const [urls, setUrls] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all(paths.map((p) => signedSitePhotoUrl(p))).then((r) => {
      if (!cancelled) setUrls(r.filter((u): u is string => u !== null))
    })
    return () => {
      cancelled = true
    }
  }, [paths])

  if (urls.length === 0) return null

  return (
    <div className="mt-2 flex gap-2 overflow-x-auto">
      {urls.map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer" className="shrink-0">
          <img
            src={u}
            alt="Site photo"
            className="h-24 rounded-lg object-cover ring-1 ring-foreground/10"
          />
        </a>
      ))}
    </div>
  )
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}
