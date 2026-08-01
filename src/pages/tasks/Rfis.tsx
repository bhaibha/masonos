import { HelpCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import {
  EMPTY_VENDOR,
  VendorField,
  type VendorValue,
} from '@/components/VendorField'
import { CancelDialog, CancelNote } from '@/components/VoidDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { companyNeedsSetup } from '@/lib/company'
import { errText } from '@/lib/errText'
import { createDocument } from '@/lib/queries/documents'
import { fetchProject } from '@/lib/queries/projects'
import { answerRfi, createRfi, fetchRfis, setRfiStatus } from '@/lib/queries/rfis'
import { generateRfiFile, generateRfiPdf } from '@/lib/rfiPdf'
import {
  compressImage,
  signedSitePhotoUrl,
  uploadDocument,
  uploadSitePhoto,
} from '@/lib/storage'
import {
  canCancel,
  canRaiseRFI,
  RFI_CATEGORIES,
  RFI_CATEGORY_LABEL,
  RFI_STATUS_LABEL,
  rfiIsOverdue,
  type NewRfiInput,
  type RfiCategory,
  type RfiRow,
  type RfiStatus,
  type UserRole,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const STATUS_TONE: Record<RfiStatus, string> = {
  open: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  answered: 'bg-secondary text-secondary-foreground',
  closed: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  cancelled: 'bg-destructive/10 text-destructive',
}

export default function Rfis() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayRaise = canRaiseRFI(role)

  const [rows, setRows] = useState<RfiRow[] | null>(null)
  const [raising, setRaising] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setRows(await fetchRfis(projectId))
    } catch (err) {
      toast.error('Could not load RFIs', { description: errText(err) })
      setRows([])
    }
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (raising) {
    return (
      <RaiseForm
        onDone={() => {
          setRaising(false)
          void reload()
        }}
        onCancel={() => setRaising(false)}
      />
    )
  }

  const today = todayIst()
  const waiting = rows?.filter((r) => r.status === 'open').length ?? 0
  const overdue = rows?.filter((r) => rfiIsOverdue(r, today)).length ?? 0

  return (
    <div className="space-y-4 pb-6">
      {mayRaise && (
        <Button className="h-12 w-full text-base" onClick={() => setRaising(true)}>
          Raise RFI
        </Button>
      )}

      {/* The clock is the point of this module — surface it before the list. */}
      {rows && rows.length > 0 && waiting > 0 && (
        <p
          className={cn(
            'rounded-lg px-3 py-2 text-sm',
            overdue > 0
              ? 'bg-destructive/10 text-destructive'
              : 'bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] text-[var(--warning)]',
          )}
        >
          {waiting} awaiting an answer
          {overdue > 0 && ` · ${overdue} past the required-by date`}
        </p>
      )}

      {rows === null && <ListSkeleton rows={3} />}

      {rows?.length === 0 && (
        <>
          <EmptyState
            icon={HelpCircle}
            title="No RFIs raised"
            body="Questions to the architect or consultant that are holding work up — with the date you need an answer by, and the answer when it lands."
            actionLabel={mayRaise ? 'Raise the first one' : undefined}
            onAction={mayRaise ? () => setRaising(true) : undefined}
          />
          <OtherProjectsHint />
        </>
      )}

      {rows && rows.length > 0 && (
        <Stagger className="space-y-3">
          {rows.map((rfi) => (
            <RevealItem key={rfi.id}>
              <RfiCard rfi={rfi} role={role} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ---------------- One RFI ---------------- */

function RfiCard({
  rfi,
  role,
  onChanged,
}: {
  rfi: RfiRow
  role: UserRole | null
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [response, setResponse] = useState(rfi.response ?? '')
  const [responseDate, setResponseDate] = useState(
    rfi.response_date ?? todayIst(),
  )

  const mayRaise = canRaiseRFI(role)
  const cancelled = rfi.status === 'cancelled'
  const overdue = rfiIsOverdue(rfi, todayIst())

  async function saveAnswer() {
    if (response.trim() === '') {
      toast.error('Record what the consultant said')
      return
    }
    setBusy(true)
    try {
      await answerRfi(rfi.id, response, responseDate)
      toast.success('Response recorded')
      setAnswering(false)
      await onChanged()
    } catch (err) {
      toast.error('Could not record the response', { description: errText(err) })
    }
    setBusy(false)
  }

  async function move(next: 'open' | 'closed') {
    setBusy(true)
    try {
      await setRfiStatus(rfi.id, next)
      toast.success(next === 'closed' ? 'RFI closed' : 'RFI reopened')
      await onChanged()
    } catch (err) {
      // The RPC refuses to close an unanswered RFI and says why — surface it.
      toast.error('Could not update the RFI', { description: errText(err) })
    }
    setBusy(false)
  }

  async function document(file: boolean) {
    setBusy(true)
    try {
      const project = await fetchProject(rfi.project_id)
      const opts = {
        rfi,
        projectName: project?.name ?? '',
        siteAddress: project?.site_address ?? null,
        clientName: project?.client_name ?? null,
      }
      if (file) {
        const f = generateRfiFile(opts)
        const { path, fileType } = await uploadDocument(rfi.project_id, f)
        await createDocument({
          project_id: rfi.project_id,
          folder: 'drawings',
          title: `${rfi.rfi_number} · RFI`,
          file_path: path,
          file_type: fileType,
          // No figures on an RFI, so every project member can open it.
          is_confidential: false,
        })
        toast.success('Filed to Docs → Drawings')
      } else {
        generateRfiPdf(opts)
        toast[companyNeedsSetup() ? 'warning' : 'success'](
          companyNeedsSetup()
            ? 'RFI generated — fill company details in src/lib/company.ts'
            : 'RFI PDF downloaded',
        )
      }
    } catch (err) {
      toast.error('Could not generate the RFI', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[17px] font-semibold tabular-nums">
            {rfi.rfi_number}
          </p>
          <p className="mt-0.5 truncate text-sm">
            To {rfi.addressed_display ?? '—'}
            {!rfi.addressed_registered && rfi.addressed_display && (
              <span
                className="ml-1 inline-block size-1.5 rounded-full bg-[var(--warning)] align-middle"
                title="Not a registered vendor"
                aria-label="Not a registered vendor"
              />
            )}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            STATUS_TONE[rfi.status],
          )}
        >
          {RFI_STATUS_LABEL[rfi.status]}
        </span>
      </div>

      <p
        className={cn(
          'mt-3 text-sm',
          cancelled && 'text-muted-foreground line-through',
        )}
      >
        {rfi.question}
      </p>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{RFI_CATEGORY_LABEL[rfi.category]}</span>
        <span>Raised {rfi.raised_date}</span>
        {rfi.required_by && (
          <span className={cn(overdue && 'font-medium text-destructive')}>
            By {rfi.required_by}
            {overdue && ' · overdue'}
          </span>
        )}
        {rfi.raised_by_name && <span>By {rfi.raised_by_name}</span>}
      </div>

      {rfi.attachments.length > 0 && <Attachments paths={rfi.attachments} />}

      {rfi.response && (
        <div className="mt-3 rounded-lg bg-secondary/50 p-3">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Response{rfi.response_date ? ` · ${rfi.response_date}` : ''}
          </p>
          <p className="mt-1 text-sm">{rfi.response}</p>
        </div>
      )}

      {cancelled && <CancelNote reason={rfi.cancel_reason} at={rfi.cancelled_at} />}

      {answering && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <FieldRow label="Response" htmlFor={`resp-${rfi.id}`}>
            <Textarea
              id={`resp-${rfi.id}`}
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              placeholder="What did the consultant say?"
              className="min-h-24"
            />
          </FieldRow>
          <FieldRow label="Response date" htmlFor={`respd-${rfi.id}`}>
            <Input
              id={`respd-${rfi.id}`}
              type="date"
              value={responseDate}
              onChange={(e) => setResponseDate(e.target.value)}
              className="h-12 text-base"
            />
          </FieldRow>
          <div className="flex gap-2">
            <Button
              className="h-11 flex-1"
              disabled={busy}
              onClick={() => void saveAnswer()}
            >
              {busy ? 'Saving…' : 'Save response'}
            </Button>
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setAnswering(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mayRaise && !cancelled && !answering && (
        <div className="mt-4 flex flex-wrap gap-2">
          {rfi.status !== 'closed' && (
            <Button
              variant={rfi.response ? 'outline' : 'default'}
              disabled={busy}
              onClick={() => setAnswering(true)}
            >
              {rfi.response ? 'Edit response' : 'Record response'}
            </Button>
          )}
          {rfi.status === 'answered' && (
            <Button disabled={busy} onClick={() => void move('closed')}>
              Close
            </Button>
          )}
          {rfi.status === 'closed' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void move('open')}
            >
              Reopen
            </Button>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void document(false)}>
          Download
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void document(true)}>
          File to Docs
        </Button>
        {canCancel(role, 'rfis') && !cancelled && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setCancelling(true)}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Cancel
          </Button>
        )}
      </div>

      {cancelling && (
        <CancelDialog
          table="rfis"
          id={rfi.id}
          summary={`${rfi.rfi_number} · to ${rfi.addressed_display ?? '—'}`}
          consequence="The RFI keeps its number and stays on record, and its PDF prints with a CANCELLED watermark. A closed RFI cannot be cancelled — it was answered and acted on."
          onDone={async () => {
            setCancelling(false)
            await onChanged()
          }}
          onCancel={() => setCancelling(false)}
        />
      )}
    </article>
  )
}

function Attachments({ paths }: { paths: string[] }) {
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

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {urls.map((u, i) =>
        u ? (
          <a key={i} href={u} target="_blank" rel="noreferrer">
            <img
              src={u}
              alt={`Attachment ${i + 1}`}
              className="size-20 rounded-lg object-cover ring-1 ring-foreground/10"
            />
          </a>
        ) : null,
      )}
    </div>
  )
}

/* ---------------- Raise ---------------- */

function RaiseForm({
  onDone,
  onCancel,
}: {
  onDone: () => void
  onCancel: () => void
}) {
  const projectId = useProjects((s) => s.selectedId)

  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
  const [category, setCategory] = useState<RfiCategory>('design')
  const [question, setQuestion] = useState('')
  const [requiredBy, setRequiredBy] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return
    try {
      const next: File[] = []
      for (const f of Array.from(files)) next.push(await compressImage(f))
      setPhotos((p) => [...p, ...next])
    } catch {
      toast.error('Could not process one of those images.')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!projectId) return

    if (question.trim() === '') {
      toast.error('Write the question')
      return
    }
    if (vendor.vendorId === null && vendor.vendorName.trim() === '') {
      toast.error('Say who this is addressed to')
      return
    }

    setBusy(true)
    try {
      const uploaded: string[] = []
      for (let i = 0; i < photos.length; i++) {
        setStatus(`Uploading attachment ${i + 1} of ${photos.length}…`)
        const f = photos[i]
        if (f) uploaded.push(await uploadSitePhoto(projectId, f))
      }

      setStatus('Raising…')
      const payload: NewRfiInput = {
        project_id: projectId,
        raised_date: todayIst(),
        vendor_id: vendor.vendorId,
        addressed_to: vendor.vendorId ? '' : vendor.vendorName,
        category,
        question,
        attachments: uploaded,
        required_by: requiredBy || null,
      }
      await createRfi(payload)
      toast.success('RFI raised', {
        description: 'Download it to send to the consultant.',
      })
      onDone()
    } catch (err) {
      toast.error('Could not raise the RFI', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="paper mb-6 space-y-5 p-5" noValidate>
      <p className="font-heading text-[18px] font-semibold">New RFI</p>

      <FieldRow label="Addressed to" htmlFor="rfi_vendor">
        <VendorField id="rfi_vendor" value={vendor} onChange={setVendor} />
      </FieldRow>

      <FieldRow label="Category" htmlFor="rfi_cat">
        <Select
          id="rfi_cat"
          value={category}
          onChange={(e) => setCategory(e.target.value as RfiCategory)}
        >
          {RFI_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow
        label="Question"
        htmlFor="rfi_q"
        hint="Be specific enough that it can be answered without a site visit."
      >
        <Textarea
          id="rfi_q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="GF slab drawing shows a 200mm drop at the bathroom but the MEP layout needs 250mm. Which governs?"
          className="min-h-28"
        />
      </FieldRow>

      <FieldRow
        label="Response required by"
        htmlFor="rfi_by"
        hint="Anything unanswered past this date is flagged at the top of the list."
      >
        <Input
          id="rfi_by"
          type="date"
          value={requiredBy}
          onChange={(e) => setRequiredBy(e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <div className="space-y-2">
        <p className="text-sm leading-none font-medium">Attachments</p>
        <Input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(e) => void addPhotos(e.target.files)}
          className="h-12 text-base"
        />
        {photos.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {photos.length} photo{photos.length === 1 ? '' : 's'} ready —
            compressed before upload.
          </p>
        )}
      </div>

      {status && <p className="text-xs text-muted-foreground">{status}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Raising…' : 'Raise RFI'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}
