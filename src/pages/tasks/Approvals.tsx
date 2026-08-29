import {
  CheckCircle2,
  FileWarning,
  Image as ImageIcon,
  MessageSquare,
  Paperclip,
  Plus,
  Stamp,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  createApproval,
  deleteApproval,
  fetchApprovalLinkOptions,
  fetchApprovals,
  setApprovalStatus,
} from '@/lib/queries/approvals'
import { signedDocumentUrl, uploadDocument } from '@/lib/storage'
import {
  APPROVAL_METHOD_LABEL,
  APPROVAL_METHOD_WEIGHT,
  APPROVAL_STATUS_LABEL,
  APPROVAL_SUBJECT_LABEL,
  canLogApprovals,
  type ApprovalMethod,
  type ApprovalState,
  type ApprovalSubject,
  type ClientApprovalRow,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const STATUS_TONE: Record<ApprovalState, string> = {
  pending:
    'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  approved:
    'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  rejected: 'bg-destructive/10 text-destructive',
}

const SUBJECTS = Object.keys(APPROVAL_SUBJECT_LABEL) as ApprovalSubject[]
const METHODS = Object.keys(APPROVAL_METHOD_LABEL) as ApprovalMethod[]

interface LinkOptions {
  variations: { id: string; label: string }[]
  documents: { id: string; label: string }[]
  materials: { id: string; label: string }[]
}

/**
 * C2 — the client approval register (module 07, internal record version).
 *
 * There is no client portal. This is the firm's own record of decisions the
 * client made out of band: a nod on a site walk, a WhatsApp message, a
 * countersigned sheet. What makes it useful is that it captures HOW and WHEN,
 * so "who approved the marble" has an answer four months later.
 *
 * Readable by every project member — the table deliberately holds no figures,
 * so a supervisor sees the decision and nothing about what it cost.
 */
export default function Approvals() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayLog = canLogApprovals(role)

  const [list, setList] = useState<ClientApprovalRow[] | null>(null)
  const [filter, setFilter] = useState<ApprovalState | null>(null)
  const [logging, setLogging] = useState(false)
  const [links, setLinks] = useState<LinkOptions>({
    variations: [],
    documents: [],
    materials: [],
  })

  const reload = useCallback(async () => {
    if (!projectId) return
    setList(null)
    try {
      setList(await fetchApprovals(projectId, filter))
    } catch (err) {
      toast.error('Could not load the register', { description: errText(err) })
      setList([])
    }
  }, [projectId, filter])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!projectId || !mayLog) return
    // Pickers failing must not stop somebody logging an approval — the link is
    // optional, the record is not.
    void fetchApprovalLinkOptions(projectId).then(setLinks).catch(() => {})
  }, [projectId, mayLog])

  if (!projectId) {
    return (
      <div className="page-w px-4 py-8">
        <OtherProjectsHint />
      </div>
    )
  }

  return (
    <div className="page-w space-y-4 px-4 py-4 pb-6">
      {mayLog && !logging && (
        <Button
          className="h-12 w-full gap-2 text-base"
          onClick={() => setLogging(true)}
        >
          <Plus className="size-4" /> Log a client approval
        </Button>
      )}

      {logging && (
        <LogForm
          projectId={projectId}
          links={links}
          onCancel={() => setLogging(false)}
          onDone={() => {
            setLogging(false)
            void reload()
          }}
        />
      )}

      <div className="flex gap-2 overflow-x-auto pb-1">
        {([null, 'pending', 'approved', 'rejected'] as const).map((s) => (
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
            {s === null ? 'All' : APPROVAL_STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {list === null && <ListSkeleton rows={4} />}

      {list !== null && list.length === 0 && (
        <EmptyState
          icon={Stamp}
          title={filter ? 'Nothing in this state' : 'No approvals logged yet'}
          body={
            filter
              ? 'Clear the filter to see the whole register.'
              : mayLog
                ? 'When the client picks a finish, accepts a variation or signs off ' +
                  'a stage, log it here with the date and how they said it.'
                : 'The office has not logged any client decisions on this project yet.'
          }
          actionLabel={mayLog && !filter ? 'Log the first one' : undefined}
          onAction={mayLog && !filter ? () => setLogging(true) : undefined}
        />
      )}

      {list !== null && list.length > 0 && (
        <Stagger className="card-grid">
          {list.map((a) => (
            <RevealItem key={a.id}>
              <ApprovalCard row={a} mayLog={mayLog} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ApprovalCard({
  row,
  mayLog,
  onChanged,
}: {
  row: ClientApprovalRow
  mayLog: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [deciding, setDeciding] = useState<ApprovalState | null>(null)
  const [on, setOn] = useState(todayIst())
  const [reason, setReason] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function decide(status: ApprovalState) {
    setBusy(true)
    try {
      await setApprovalStatus(
        row.id,
        status,
        status === 'pending' ? null : on,
        status === 'rejected' ? reason : null,
      )
      toast.success(
        status === 'approved'
          ? 'Recorded as approved'
          : status === 'rejected'
            ? 'Recorded as rejected'
            : 'Back to awaiting the client',
      )
      setDeciding(null)
      setReason('')
      onChanged()
    } catch (err) {
      toast.error('Could not record that', { description: errText(err) })
      setBusy(false)
    }
  }

  const linked =
    row.vo_number ??
    row.variation_title ??
    row.document_title ??
    row.material_name

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            {row.approval_no} · {APPROVAL_SUBJECT_LABEL[row.subject]}
          </p>
          <h3 className="font-heading mt-1 text-[16px] leading-snug font-semibold">
            {row.title}
          </h3>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            STATUS_TONE[row.status],
          )}
        >
          {APPROVAL_STATUS_LABEL[row.status]}
        </span>
      </div>

      {row.details && (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {row.details}
        </p>
      )}

      <dl className="mt-4 space-y-1.5 text-xs">
        <Line
          label="Client"
          value={`${row.approved_by_name}${
            row.client_role ? ` · ${row.client_role}` : ''
          }`}
        />
        <Line label="How" value={APPROVAL_METHOD_LABEL[row.method]} />
        {row.decided_on && <Line label="Decided" value={row.decided_on} />}
        {row.decided_by_name && (
          <Line label="Recorded by" value={row.decided_by_name} />
        )}
        {/* A supervisor gets `linked` = null on a VO-backed approval, because
            variation_orders' RLS hides the row. That is the money rule working,
            not missing data. */}
        {linked && <Line label="Refers to" value={linked} />}
      </dl>

      {row.reject_reason && (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {row.reject_reason}
        </p>
      )}

      {/* The register's own honesty. A verbal approval with nothing behind it
          is the weakest row in here and is not allowed to look identical to a
          countersigned sheet. */}
      {row.evidence_count === 0 ? (
        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-[var(--warning)]">
          <FileWarning className="mt-0.5 size-3 shrink-0" />
          No evidence attached. {APPROVAL_METHOD_WEIGHT[row.method]}
        </p>
      ) : (
        <EvidenceStrip paths={row.evidence} />
      )}

      {mayLog && (
        <div className="mt-4 space-y-2">
          {deciding === null && (
            <div className="flex flex-wrap gap-2">
              {row.status !== 'approved' && (
                <Button
                  size="sm"
                  className="h-10 flex-1 gap-1.5"
                  disabled={busy}
                  onClick={() => setDeciding('approved')}
                >
                  <CheckCircle2 className="size-3.5" /> Client approved
                </Button>
              )}
              {row.status !== 'rejected' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-10 flex-1 gap-1.5"
                  disabled={busy}
                  onClick={() => setDeciding('rejected')}
                >
                  <XCircle className="size-3.5" /> Rejected
                </Button>
              )}
              {row.status !== 'pending' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-10"
                  disabled={busy}
                  onClick={() => void decide('pending')}
                >
                  Undo
                </Button>
              )}
              {row.status === 'pending' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-10 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete this approval"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          )}

          {deciding !== null && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <FieldRow label="Date the client decided" htmlFor={`d_${row.id}`}>
                <Input
                  id={`d_${row.id}`}
                  type="date"
                  value={on}
                  max={todayIst()}
                  onChange={(e) => setOn(e.target.value)}
                  className="h-12 text-base"
                />
              </FieldRow>
              <p className="text-[11px] text-muted-foreground">
                Not today's date unless it happened today — this is the day the
                decision was made, which is what matters if the sequence of
                events is ever reconstructed.
              </p>

              {deciding === 'rejected' && (
                <FieldRow label="Why they rejected it" htmlFor={`r_${row.id}`}>
                  <Textarea
                    id={`r_${row.id}`}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="What the client said, in their words if you have them"
                    rows={2}
                  />
                </FieldRow>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  className="h-11"
                  onClick={() => setDeciding(null)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  className="h-11"
                  disabled={
                    busy || (deciding === 'rejected' && reason.trim() === '')
                  }
                  title={
                    deciding === 'rejected' && reason.trim() === ''
                      ? 'Give a reason first'
                      : undefined
                  }
                  onClick={() => void decide(deciding)}
                >
                  Record it
                </Button>
              </div>
            </div>
          )}

          {confirmDelete && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-xs">
                Delete {row.approval_no}? Only possible while it is awaiting the
                client — once a decision is recorded it stays on the register.
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
                      await deleteApproval(row.id)
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

/** Signed links to whatever was attached. The bucket is private. */
function EvidenceStrip({ paths }: { paths: string[] }) {
  const [busy, setBusy] = useState(false)

  async function open(p: string) {
    setBusy(true)
    const url = await signedDocumentUrl(p, 300)
    setBusy(false)
    if (!url) {
      toast.error('Could not open that file')
      return
    }
    window.open(url, '_blank', 'noopener')
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {paths.map((p, i) => (
        <button
          key={p}
          type="button"
          disabled={busy}
          onClick={() => void open(p)}
          className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Paperclip className="size-3" /> Evidence {i + 1}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function LogForm({
  projectId,
  links,
  onCancel,
  onDone,
}: {
  projectId: string
  links: LinkOptions
  onCancel: () => void
  onDone: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  const [subject, setSubject] = useState<ApprovalSubject>('material_selection')
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [who, setWho] = useState('')
  const [clientRole, setClientRole] = useState('')
  const [method, setMethod] = useState<ApprovalMethod>('whatsapp')
  const [linkId, setLinkId] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)

  // Which picker is relevant follows from the subject — showing all three at
  // once invites a material selection linked to a variation order.
  const options =
    subject === 'variation_order'
      ? links.variations
      : subject === 'material_selection' || subject === 'sample'
        ? links.materials
        : links.documents

  const optionLabel =
    subject === 'variation_order'
      ? 'Variation order'
      : subject === 'material_selection' || subject === 'sample'
        ? 'Material'
        : 'Document'

  async function save() {
    if (!title.trim()) {
      toast.error('Say what is being approved')
      return
    }
    if (!who.trim()) {
      toast.error("Who on the client's side said it?", {
        description: 'A record with no name is not a record.',
      })
      return
    }

    setBusy(true)
    try {
      // Images are compressed to the 300KB budget, PDFs go byte for byte —
      // uploadDocument already draws that line (CLAUDE.md rule 4).
      const evidence: string[] = []
      for (const f of files) {
        const { path } = await uploadDocument(projectId, f)
        evidence.push(path)
      }

      await createApproval({
        project_id: projectId,
        subject,
        title,
        details,
        approved_by_name: who,
        client_role: clientRole,
        method,
        variation_id: subject === 'variation_order' ? linkId || null : null,
        material_id:
          subject === 'material_selection' || subject === 'sample'
            ? linkId || null
            : null,
        document_id:
          subject !== 'variation_order' &&
          subject !== 'material_selection' &&
          subject !== 'sample'
            ? linkId || null
            : null,
        evidence,
      })

      toast.success('Logged', {
        description: 'It sits as awaiting the client until you record a decision.',
      })
      onDone()
    } catch (err) {
      toast.error('Could not log it', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <section className="paper space-y-4 p-5">
      <p className="font-heading text-[15px] font-semibold">
        Log a client approval
      </p>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="What kind" htmlFor="a_subject">
          <Select
            id="a_subject"
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value as ApprovalSubject)
              setLinkId('')
            }}
          >
            {SUBJECTS.map((s) => (
              <option key={s} value={s}>
                {APPROVAL_SUBJECT_LABEL[s]}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="How they said it" htmlFor="a_method">
          <Select
            id="a_method"
            value={method}
            onChange={(e) => setMethod(e.target.value as ApprovalMethod)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {APPROVAL_METHOD_LABEL[m]}
              </option>
            ))}
          </Select>
        </FieldRow>
      </div>

      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <MessageSquare className="mt-0.5 size-3 shrink-0" />
        {APPROVAL_METHOD_WEIGHT[method]}
      </p>

      <FieldRow label="What is being approved" htmlFor="a_title">
        <Input
          id="a_title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Statuario marble for the master bath"
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Detail" htmlFor="a_details">
        <Textarea
          id="a_details"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="Anything a person reading this in six months would need"
          rows={2}
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Who approved it" htmlFor="a_who">
          <Input
            id="a_who"
            value={who}
            onChange={(e) => setWho(e.target.value)}
            placeholder="Mr R Iyer"
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Their role" htmlFor="a_role">
          <Input
            id="a_role"
            value={clientRole}
            onChange={(e) => setClientRole(e.target.value)}
            placeholder="Owner"
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      {options.length > 0 && (
        <FieldRow label={`${optionLabel} it refers to`} htmlFor="a_link">
          <Select
            id="a_link"
            value={linkId}
            onChange={(e) => setLinkId(e.target.value)}
          >
            <option value="">Not linked</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </FieldRow>
      )}

      <div>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          accept="image/*,.pdf"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <Button
          type="button"
          variant="outline"
          className="h-12 w-full justify-start gap-2 text-base"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <ImageIcon className="size-4" />
          {files.length === 0
            ? 'Attach evidence — screenshot, photo or PDF'
            : `${files.length} file${files.length === 1 ? '' : 's'} attached`}
        </Button>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          A screenshot of the message is usually the whole record. Photos are
          compressed; PDFs are uploaded untouched.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" className="h-11" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button className="h-11" onClick={() => void save()} disabled={busy}>
          {busy ? 'Logging…' : 'Log it'}
        </Button>
      </div>
    </section>
  )
}
