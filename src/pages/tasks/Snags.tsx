import { ClipboardCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { DeleteButton } from '@/components/DeleteAction'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  createSnag,
  fetchSnags,
  fetchSnagSummary,
  resolveSnag,
  setSnagStatus,
  verifySnag,
} from '@/lib/queries/snags'
import { PhotoHelper } from '@/components/PhotoHelper'
import { compressImage, signedSitePhotoUrl, uploadSitePhoto } from '@/lib/storage'
import {
  canRaiseSnag,
  canVerifySnag,
  DLP_WARN_DAYS,
  SNAG_SEVERITIES,
  SNAG_SEVERITY_LABEL,
  SNAG_STATUS_LABEL,
  TRADES,
  type NewSnagInput,
  type SnagRow,
  type SnagSeverity,
  type SnagStatus,
  type SnagSummary,
  type UserRole,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const STATUS_TONE: Record<SnagStatus, string> = {
  open: 'bg-destructive/10 text-destructive',
  in_progress: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  resolved: 'bg-secondary text-secondary-foreground',
  verified: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
}

const SEVERITY_TONE: Record<SnagSeverity, string> = {
  low: 'text-muted-foreground',
  medium: 'text-[var(--warning)]',
  high: 'text-destructive',
}

type Filter = 'outstanding' | 'all' | 'dlp'

export default function Snags() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayRaise = canRaiseSnag(role)

  const [rows, setRows] = useState<SnagRow[] | null>(null)
  const [summary, setSummary] = useState<SnagSummary | null>(null)
  const [filter, setFilter] = useState<Filter>('outstanding')
  const [raising, setRaising] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const [list, sum] = await Promise.all([
        fetchSnags(projectId),
        fetchSnagSummary(projectId),
      ])
      setRows(list)
      setSummary(sum)
    } catch (err) {
      toast.error('Could not load snags', { description: errText(err) })
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

  const shown = rows?.filter((s) => {
    if (filter === 'all') return true
    if (filter === 'dlp') return s.raised_during_dlp
    return s.status === 'open' || s.status === 'in_progress'
  })

  return (
    <div className="space-y-4 pb-6">
      {mayRaise && (
        <Button className="h-12 w-full text-base" onClick={() => setRaising(true)}>
          Raise snag
        </Button>
      )}

      {summary && <SummaryStrip summary={summary} />}

      <div className="flex gap-1">
        {(['outstanding', 'dlp', 'all'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'min-h-11 rounded-lg px-3.5 text-sm font-medium transition-colors',
              filter === f
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f === 'outstanding' ? 'Outstanding' : f === 'dlp' ? 'In DLP' : 'All'}
          </button>
        ))}
      </div>

      {rows === null && <ListSkeleton rows={4} />}

      {shown?.length === 0 && (
        <>
          <EmptyState
            icon={ClipboardCheck}
            title={
              filter === 'outstanding'
                ? 'Nothing outstanding'
                : filter === 'dlp'
                  ? 'No snags raised during the DLP'
                  : 'No snags raised'
            }
            body={
              filter === 'outstanding'
                ? 'Every snag on this project has been resolved or verified.'
                : 'Log a defect with a photo, assign the trade, then prove the fix with a second photo.'
            }
            actionLabel={mayRaise && filter !== 'outstanding' ? 'Raise a snag' : undefined}
            onAction={mayRaise && filter !== 'outstanding' ? () => setRaising(true) : undefined}
          />
          {filter === 'all' && <OtherProjectsHint />}
        </>
      )}

      {shown && shown.length > 0 && (
        <Stagger className="card-grid">
          {shown.map((snag) => (
            <RevealItem key={snag.id}>
              <SnagCard snag={snag} role={role} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ---------------- Summary + DLP ---------------- */

function SummaryStrip({ summary: s }: { summary: SnagSummary }) {
  const outstanding = s.open_count + s.in_progress_count
  const dlpEnding =
    s.dlp_active && s.dlp_days_left !== null && s.dlp_days_left <= DLP_WARN_DAYS

  return (
    <div className="space-y-2">
      {outstanding > 0 && (
        <div className="paper flex flex-wrap items-baseline gap-x-5 gap-y-2 p-4">
          <span className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Outstanding
          </span>
          <span className="figure text-[19px] font-semibold tabular-nums">
            {outstanding}
          </span>
          {(['high', 'medium', 'low'] as SnagSeverity[]).map((sev) => {
            const n =
              sev === 'high' ? s.open_high : sev === 'medium' ? s.open_medium : s.open_low
            if (n === 0) return null
            return (
              <span key={sev} className={cn('text-sm tabular-nums', SEVERITY_TONE[sev])}>
                {n} {SNAG_SEVERITY_LABEL[sev].toLowerCase()}
              </span>
            )
          })}
        </div>
      )}

      {/* DLP position. The alert matters — once the period closes, defects
          stop being the contractor's to fix for free. */}
      {s.dlp_end && (
        <p
          className={cn(
            'rounded-lg px-3 py-2 text-sm',
            dlpEnding
              ? 'bg-destructive/10 text-destructive'
              : s.dlp_active
                ? 'bg-[color-mix(in_oklab,var(--positive)_12%,transparent)] text-[var(--positive)]'
                : 'bg-secondary text-muted-foreground',
          )}
        >
          {s.dlp_active ? (
            <>
              Defect liability period ends {s.dlp_end}
              {s.dlp_days_left !== null && ` · ${s.dlp_days_left} days left`}
              {dlpEnding && ' — close out anything outstanding'}
            </>
          ) : s.dlp_days_left !== null && s.dlp_days_left < 0 ? (
            <>Defect liability period ended {s.dlp_end}</>
          ) : (
            <>Defect liability period starts {s.dlp_start ?? '—'}</>
          )}
          {s.dlp_snag_count > 0 &&
            ` · ${s.dlp_snag_count} unverified snag${s.dlp_snag_count === 1 ? '' : 's'} raised in the period`}
        </p>
      )}
    </div>
  )
}

/* ---------------- One snag ---------------- */

function SnagCard({
  snag,
  role,
  onChanged,
}: {
  snag: SnagRow
  role: UserRole | null
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [note, setNote] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [status, setStatus] = useState<string | null>(null)

  const projectId = snag.project_id
  const mayRaise = canRaiseSnag(role)
  const mayVerify = canVerifySnag(role)

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

  async function saveResolution() {
    if (note.trim() === '' && photos.length === 0) {
      toast.error('Attach a photo of the fix, or write what was done')
      return
    }
    setBusy(true)
    try {
      const uploaded: string[] = []
      for (let i = 0; i < photos.length; i++) {
        setStatus(`Uploading photo ${i + 1} of ${photos.length}…`)
        const f = photos[i]
        if (f) uploaded.push(await uploadSitePhoto(projectId, f))
      }
      setStatus('Saving…')
      await resolveSnag(snag.id, note, uploaded)
      toast.success('Marked resolved', {
        description: 'A founder or PM verifies it from here.',
      })
      setResolving(false)
      setNote('')
      setPhotos([])
      await onChanged()
    } catch (err) {
      toast.error('Could not resolve the snag', { description: errText(err) })
    }
    setBusy(false)
    setStatus(null)
  }

  async function move(next: 'open' | 'in_progress') {
    setBusy(true)
    try {
      await setSnagStatus(snag.id, next)
      toast.success(next === 'open' ? 'Reopened' : 'Marked in progress', {
        description:
          next === 'open' ? 'The previous resolution was cleared.' : undefined,
      })
      await onChanged()
    } catch (err) {
      toast.error('Could not update the snag', { description: errText(err) })
    }
    setBusy(false)
  }

  async function sign() {
    setBusy(true)
    try {
      await verifySnag(snag.id)
      toast.success('Verified')
      await onChanged()
    } catch (err) {
      // The RPC refuses if it isn't resolved, or if the role can't verify.
      toast.error('Could not verify the snag', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="font-heading text-[17px] font-semibold tabular-nums">
              {snag.snag_number}
            </span>
            <span className={cn('text-xs font-medium', SEVERITY_TONE[snag.severity])}>
              {SNAG_SEVERITY_LABEL[snag.severity]}
            </span>
            {snag.raised_during_dlp && (
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
                DLP
              </span>
            )}
          </p>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {snag.work_area}
            {snag.trade && ` · ${snag.trade}`}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            STATUS_TONE[snag.status],
          )}
        >
          {SNAG_STATUS_LABEL[snag.status]}
        </span>
      </div>

      <p className="mt-3 text-sm">{snag.description}</p>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Raised {snag.raised_date}</span>
        {snag.assigned_display && (
          <span>
            To {snag.assigned_display}
            {!snag.assigned_registered && (
              <span
                className="ml-1 inline-block size-1.5 rounded-full bg-[var(--warning)] align-middle"
                title="Not a registered vendor"
                aria-label="Not a registered vendor"
              />
            )}
          </span>
        )}
        {snag.raised_by_name && <span>By {snag.raised_by_name}</span>}
      </div>

      {snag.photos.length > 0 && <Photos paths={snag.photos} label="Defect" />}

      {/* D1 — an optional second look at the defect photo. Opt-in only: it
          never fires on upload. Attached to the FIRST photo, because one
          suggestion per snag is a decision somebody can act on and five is a
          list nobody reads. */}
      {snag.photos.length > 0 && (
        <PhotoHelper
          projectId={snag.project_id}
          photoPath={snag.photos[0]}
          source="snag"
          snagId={snag.id}
        />
      )}

      {(snag.resolution_note || snag.resolution_photos.length > 0) && (
        <div className="mt-3 rounded-lg bg-secondary/50 p-3">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Fix
            {snag.resolved_at &&
              ` · ${new Date(snag.resolved_at).toLocaleDateString('en-IN')}`}
          </p>
          {snag.resolution_note && (
            <p className="mt-1 text-sm">{snag.resolution_note}</p>
          )}
          {snag.resolution_photos.length > 0 && (
            <Photos paths={snag.resolution_photos} label="" />
          )}
        </div>
      )}

      {snag.status === 'verified' && snag.verified_at && (
        <p className="mt-2 text-xs text-[var(--positive)]">
          Verified on {new Date(snag.verified_at).toLocaleDateString('en-IN')}
        </p>
      )}

      {resolving && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <FieldRow
            label="What was done"
            htmlFor={`note-${snag.id}`}
            hint="A photo of the fix, a note, or both — but not nothing."
          >
            <Textarea
              id={`note-${snag.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Re-plastered and repainted the patch."
            />
          </FieldRow>
          <Input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(e) => void addPhotos(e.target.files)}
            className="h-12 text-base"
            aria-label="Photos of the fix"
          />
          {photos.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {photos.length} photo{photos.length === 1 ? '' : 's'} ready
            </p>
          )}
          {status && <p className="text-xs text-muted-foreground">{status}</p>}
          <div className="flex gap-2">
            <Button
              className="h-11 flex-1"
              disabled={busy}
              onClick={() => void saveResolution()}
            >
              {busy ? 'Saving…' : 'Mark resolved'}
            </Button>
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setResolving(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!resolving && (
        <div className="mt-4 flex flex-wrap gap-2">
          {mayRaise && snag.status === 'open' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void move('in_progress')}
            >
              Start
            </Button>
          )}
          {mayRaise && snag.status !== 'verified' && (
            <Button disabled={busy} onClick={() => setResolving(true)}>
              {snag.status === 'resolved' ? 'Update fix' : 'Resolve'}
            </Button>
          )}
          {mayVerify && snag.status === 'resolved' && (
            <Button disabled={busy} onClick={() => void sign()}>
              Verify
            </Button>
          )}
          {mayRaise && snag.status !== 'open' && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void move('open')}
            >
              Reopen
            </Button>
          )}
          {/* A verified snag is refused by fn_delete_record — it's the record
              that a defect was fixed and signed off. */}
          <DeleteButton
            table="snags"
            id={snag.id}
            name={`${snag.snag_number} · ${snag.work_area}`}
            role={role}
            onDeleted={onChanged}
          />
        </div>
      )}
    </article>
  )
}

function Photos({ paths, label }: { paths: string[]; label: string }) {
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
    <div className="mt-2">
      {label && (
        <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
          {label}
        </p>
      )}
      <div className="mt-1 flex flex-wrap gap-2">
        {urls.map((u, i) =>
          u ? (
            <a key={i} href={u} target="_blank" rel="noreferrer">
              <img
                src={u}
                alt={`${label || 'Photo'} ${i + 1}`}
                className="size-20 rounded-lg object-cover ring-1 ring-foreground/10"
              />
            </a>
          ) : null,
        )}
      </div>
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

  const [workArea, setWorkArea] = useState('')
  const [trade, setTrade] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<SnagSeverity>('medium')
  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
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

    if (workArea.trim() === '') {
      toast.error('Say where the defect is')
      return
    }
    if (description.trim() === '') {
      toast.error('Describe the defect')
      return
    }

    setBusy(true)
    try {
      const uploaded: string[] = []
      for (let i = 0; i < photos.length; i++) {
        setStatus(`Uploading photo ${i + 1} of ${photos.length}…`)
        const f = photos[i]
        if (f) uploaded.push(await uploadSitePhoto(projectId, f))
      }

      setStatus('Raising…')
      const payload: NewSnagInput = {
        project_id: projectId,
        raised_date: todayIst(),
        work_area: workArea,
        trade,
        description,
        severity,
        photos: uploaded,
        assigned_vendor_id: vendor.vendorId,
        assigned_to: vendor.vendorName,
      }
      await createSnag(payload)
      toast.success('Snag raised')
      onDone()
    } catch (err) {
      toast.error('Could not raise the snag', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="paper mb-6 space-y-5 p-5" noValidate>
      <p className="font-heading text-[18px] font-semibold">New snag</p>

      <FieldRow label="Work area" htmlFor="sn_area">
        <Input
          id="sn_area"
          value={workArea}
          onChange={(e) => setWorkArea(e.target.value)}
          placeholder="e.g. FF Bedroom 2, GF lobby"
          className="h-12 text-base"
          autoFocus
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Trade" htmlFor="sn_trade">
          <Select
            id="sn_trade"
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

        <FieldRow label="Severity" htmlFor="sn_sev">
          <Select
            id="sn_sev"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as SnagSeverity)}
          >
            {SNAG_SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </FieldRow>
      </div>

      <FieldRow label="Defect" htmlFor="sn_desc">
        <Textarea
          id="sn_desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Hairline crack along the window reveal, full height."
        />
      </FieldRow>

      <FieldRow
        label="Assign to"
        htmlFor="sn_vendor"
        hint="The trade contractor who owns the fix. Free text is fine."
      >
        <VendorField id="sn_vendor" value={vendor} onChange={setVendor} />
      </FieldRow>

      <div className="space-y-2">
        <p className="text-sm leading-none font-medium">Photos</p>
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
          {busy ? 'Raising…' : 'Raise snag'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}
