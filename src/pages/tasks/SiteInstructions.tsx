import { ClipboardList, Send } from 'lucide-react'
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
import { COMPANY, companyNeedsSetup } from '@/lib/company'
import { errText } from '@/lib/errText'
import { createDocument } from '@/lib/queries/documents'
import { fetchProject } from '@/lib/queries/projects'
import {
  createSi,
  fetchLinkableVariations,
  fetchSiList,
  setSiStatus,
} from '@/lib/queries/siteInstructions'
import { shareDocument } from '@/lib/share'
import { generateSiFile, generateSiPdf } from '@/lib/siPdf'
import { compressImage, signedSitePhotoUrl, uploadDocument, uploadSitePhoto } from '@/lib/storage'
import {
  canCancel,
  canIssueSI,
  SI_STATUS_LABEL,
  siIsOverdue,
  type NewSiInput,
  type SiRow,
  type SiStatus,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const STATUS_TONE: Record<SiStatus, string> = {
  issued: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  acknowledged: 'bg-secondary text-secondary-foreground',
  complete: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  cancelled: 'bg-destructive/10 text-destructive',
}

export default function SiteInstructions() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayIssue = canIssueSI(role)

  const [rows, setRows] = useState<SiRow[] | null>(null)
  const [issuing, setIssuing] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setRows(await fetchSiList(projectId))
    } catch (err) {
      toast.error('Could not load site instructions', { description: errText(err) })
      setRows([])
    }
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (issuing) {
    return (
      <IssueForm
        onDone={() => {
          setIssuing(false)
          void reload()
        }}
        onCancel={() => setIssuing(false)}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      {mayIssue && (
        <Button className="h-12 w-full text-base" onClick={() => setIssuing(true)}>
          Issue instruction
        </Button>
      )}

      {rows === null && <ListSkeleton rows={3} />}

      {rows?.length === 0 && (
        <>
          <EmptyState
            icon={ClipboardList}
            title="No instructions issued"
            body="Formal instructions to a contractor — what to do, where, and by when. Each one is a record, and can be issued on letterhead."
            actionLabel={mayIssue ? 'Issue the first one' : undefined}
            onAction={mayIssue ? () => setIssuing(true) : undefined}
          />
          <OtherProjectsHint />
        </>
      )}

      {rows && rows.length > 0 && (
        <Stagger className="card-grid">
          {rows.map((si) => (
            <RevealItem key={si.id}>
              <SiCard si={si} role={role} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ---------------- One instruction ---------------- */

function SiCard({
  si,
  role,
  onChanged,
}: {
  si: SiRow
  role: ReturnType<typeof useAuth.getState>['role']
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const mayIssue = canIssueSI(role)
  const cancelled = si.status === 'cancelled'
  const overdue = siIsOverdue(si, todayIst())

  async function advance(next: 'acknowledged' | 'complete') {
    setBusy(true)
    try {
      await setSiStatus(si.id, next)
      toast.success(
        next === 'acknowledged' ? 'Marked acknowledged' : 'Marked complete',
      )
      await onChanged()
    } catch (err) {
      toast.error('Could not update the instruction', { description: errText(err) })
    }
    setBusy(false)
  }

  /**
   * Hands the PDF to the phone's share sheet, or downloads it and opens
   * WhatsApp with the message ready. Never sends on its own — see
   * src/lib/share.ts.
   */
  async function send() {
    setBusy(true)
    try {
      const project = await fetchProject(si.project_id)
      const pdf = generateSiFile({
        si,
        projectName: project?.name ?? '',
        siteAddress: project?.site_address ?? null,
        clientName: project?.client_name ?? null,
      })

      const lines = [
        `${si.si_number} — site instruction`,
        project?.name ? `Project: ${project.name}` : null,
        si.work_area ? `Location: ${si.work_area}` : null,
        si.required_by ? `Required by: ${si.required_by}` : null,
        '',
        si.instruction,
        // Deliberately the flag, never a figure: the amount lives on the linked
        // VO, which the recipient has no business seeing in a WhatsApp message.
        si.has_cost_implication ? '\nThis instruction carries a cost implication.' : null,
        '',
        `— ${COMPANY.name}`,
      ].filter(Boolean)

      const outcome = await shareDocument({
        file: pdf,
        message: lines.join('\n'),
        phone: si.addressed_phone,
        label: si.si_number,
      })

      if (outcome === 'shared') {
        toast.success('Shared', { description: 'Pick the app and send.' })
      } else if (outcome === 'downloaded-and-opened-whatsapp') {
        toast.success('PDF downloaded, WhatsApp opened', {
          description: si.addressed_phone
            ? 'Attach the downloaded PDF and send.'
            : 'No number on file — pick the chat, attach the PDF and send.',
        })
      }
    } catch (err) {
      toast.error('Could not prepare the instruction', {
        description: errText(err),
      })
    }
    setBusy(false)
  }

  async function document(file: boolean) {
    setBusy(true)
    try {
      const project = await fetchProject(si.project_id)
      const opts = {
        si,
        projectName: project?.name ?? '',
        siteAddress: project?.site_address ?? null,
        clientName: project?.client_name ?? null,
      }
      if (file) {
        const f = generateSiFile(opts)
        const { path, fileType } = await uploadDocument(si.project_id, f)
        await createDocument({
          project_id: si.project_id,
          folder: 'other',
          title: `${si.si_number} · Site instruction`,
          file_path: path,
          file_type: fileType,
          // An instruction carries no figures, so every project member —
          // supervisors included — should be able to open it.
          is_confidential: false,
        })
        toast.success('Filed to Docs → Other')
      } else {
        generateSiPdf(opts)
        toast[companyNeedsSetup() ? 'warning' : 'success'](
          companyNeedsSetup()
            ? 'Instruction generated — fill company details in src/lib/company.ts'
            : 'Site instruction PDF downloaded',
        )
      }
    } catch (err) {
      toast.error('Could not generate the instruction', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[17px] font-semibold tabular-nums">
            {si.si_number}
          </p>
          <p className="mt-0.5 truncate text-sm">
            To {si.addressed_display ?? '—'}
            {!si.addressed_registered && si.addressed_display && (
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
            STATUS_TONE[si.status],
          )}
        >
          {SI_STATUS_LABEL[si.status]}
        </span>
      </div>

      <p className={cn('mt-3 text-sm', cancelled && 'text-muted-foreground line-through')}>
        {si.instruction}
      </p>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Issued {si.issued_date}</span>
        {si.work_area && <span>{si.work_area}</span>}
        {si.required_by && (
          <span className={cn(overdue && 'font-medium text-destructive')}>
            By {si.required_by}
            {overdue && ' · overdue'}
          </span>
        )}
        {si.issued_by_name && <span>By {si.issued_by_name}</span>}
      </div>

      {si.has_cost_implication && (
        <p className="mt-3 rounded-lg bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] px-3 py-2 text-xs text-[var(--warning)]">
          Carries a cost implication
          {/* variation_number is null for supervisors — variation_orders is
              money-gated, so they see the flag but never the VO. */}
          {si.variation_number
            ? ` · priced under ${si.variation_number}`
            : ' · no variation linked yet'}
        </p>
      )}

      {si.attachments.length > 0 && <Attachments paths={si.attachments} />}

      {cancelled && (
        <CancelNote reason={si.cancel_reason} at={si.cancelled_at} />
      )}

      {mayIssue && !cancelled && (
        <div className="mt-4 flex flex-wrap gap-2">
          {si.status === 'issued' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void advance('acknowledged')}
            >
              Mark acknowledged
            </Button>
          )}
          {si.status !== 'complete' && (
            <Button disabled={busy} onClick={() => void advance('complete')}>
              Mark complete
            </Button>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {!cancelled && (
          <Button variant="outline" disabled={busy} onClick={() => void send()}>
            <Send className="size-4" aria-hidden="true" />
            Send
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => void document(false)}>
          Download
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void document(true)}>
          File to Docs
        </Button>
        {canCancel(role, 'site_instructions') && !cancelled && (
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
          table="site_instructions"
          id={si.id}
          summary={`${si.si_number} · to ${si.addressed_display ?? '—'}`}
          consequence="The instruction keeps its number and stays on record, marked cancelled, and its PDF prints with a CANCELLED watermark. An instruction already marked complete cannot be cancelled."
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

/* ---------------- Issue form ---------------- */

function IssueForm({
  onDone,
  onCancel,
}: {
  onDone: () => void
  onCancel: () => void
}) {
  const projectId = useProjects((s) => s.selectedId)

  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
  const [workArea, setWorkArea] = useState('')
  const [instruction, setInstruction] = useState('')
  const [requiredBy, setRequiredBy] = useState('')
  const [hasCost, setHasCost] = useState(false)
  const [variationId, setVariationId] = useState('')
  const [variations, setVariations] = useState<{ id: string; label: string }[]>([])
  const [photos, setPhotos] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    fetchLinkableVariations(projectId).then(setVariations).catch(() => setVariations([]))
  }, [projectId])

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

    if (instruction.trim() === '') {
      toast.error('Write the instruction')
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

      setStatus('Issuing…')
      const payload: NewSiInput = {
        project_id: projectId,
        issued_date: todayIst(),
        vendor_id: vendor.vendorId,
        addressed_to: vendor.vendorId ? '' : vendor.vendorName,
        work_area: workArea,
        instruction,
        attachments: uploaded,
        has_cost_implication: hasCost,
        variation_id: hasCost && variationId ? variationId : null,
        required_by: requiredBy || null,
      }
      await createSi(payload)
      toast.success('Instruction issued', {
        description: 'Download it or file it to Docs from the list.',
      })
      onDone()
    } catch (err) {
      toast.error('Could not issue the instruction', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="paper mb-6 space-y-5 p-5" noValidate>
      <p className="font-heading text-[18px] font-semibold">New site instruction</p>

      <FieldRow label="Addressed to" htmlFor="si_vendor">
        <VendorField id="si_vendor" value={vendor} onChange={setVendor} />
      </FieldRow>

      <FieldRow label="Work area" htmlFor="si_area">
        <Input
          id="si_area"
          value={workArea}
          onChange={(e) => setWorkArea(e.target.value)}
          placeholder="e.g. GF slab, Bathroom 2"
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow
        label="Instruction"
        htmlFor="si_text"
        hint="Be specific — this is the record of what was asked for."
      >
        <Textarea
          id="si_text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Rework the shuttering on the GF slab edge to line before pouring."
          className="min-h-28"
        />
      </FieldRow>

      <FieldRow label="Required by" htmlFor="si_by">
        <Input
          id="si_by"
          type="date"
          value={requiredBy}
          onChange={(e) => setRequiredBy(e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <div className="space-y-3">
        <label className="flex items-start gap-3 rounded-lg bg-secondary/50 p-4">
          <input
            type="checkbox"
            checked={hasCost}
            onChange={(e) => setHasCost(e.target.checked)}
            className="mt-0.5 size-5 accent-[var(--primary)]"
          />
          <span className="text-sm">
            <span className="font-medium">This carries a cost implication</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              The amount belongs on a variation order, never on the instruction —
              so supervisors can read this without seeing money.
            </span>
          </span>
        </label>

        {hasCost && (
          <FieldRow
            label="Link a variation order"
            htmlFor="si_vo"
            hint={
              variations.length === 0
                ? 'No variations on this project yet — you can raise one and link it later.'
                : 'Optional. The PDF names it instead of stating an amount.'
            }
          >
            <Select
              id="si_vo"
              value={variationId}
              onChange={(e) => setVariationId(e.target.value)}
              disabled={variations.length === 0}
            >
              <option value="">Not linked yet</option>
              {variations.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </Select>
          </FieldRow>
        )}
      </div>

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
            {photos.length} photo{photos.length === 1 ? '' : 's'} ready — compressed
            before upload.
          </p>
        )}
      </div>

      {status && <p className="text-xs text-muted-foreground">{status}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Issuing…' : 'Issue instruction'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}
