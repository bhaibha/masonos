import { ShieldAlert } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  createIncident,
  fetchIncidents,
  setIncidentStatus,
} from '@/lib/queries/safety'
import { compressImage, signedSitePhotoUrl, uploadSitePhoto } from '@/lib/storage'
import {
  canManageSafety,
  INCIDENT_TYPE_LABEL,
  INCIDENT_TYPES,
  type IncidentRow,
  type IncidentType,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

function nowLocalInput() {
  // datetime-local wants YYYY-MM-DDTHH:mm in the user's wall clock.
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function Incidents() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const canWrite = canManageSafety(role)

  const [rows, setRows] = useState<IncidentRow[] | null>(null)
  const [raising, setRaising] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setRows(await fetchIncidents(projectId))
    } catch (err) {
      toast.error('Could not load incidents', {
        description: err instanceof Error ? err.message : undefined,
      })
      setRows([])
    }
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  async function toggleStatus(inc: IncidentRow) {
    const next = inc.status === 'open' ? 'closed' : 'open'
    setBusyId(inc.id)
    try {
      await setIncidentStatus(inc.id, next)
      toast.success(next === 'closed' ? 'Incident closed' : 'Incident reopened')
      await reload()
    } catch (err) {
      toast.error('Could not update the incident', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    setBusyId(null)
  }

  if (raising) {
    return (
      <IncidentForm
        onCancel={() => setRaising(false)}
        onSaved={() => {
          setRaising(false)
          void reload()
        }}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      {canWrite && (
        <Button className="h-12 w-full text-base" onClick={() => setRaising(true)}>
          Raise incident
        </Button>
      )}

      {rows === null && <ListSkeleton rows={3} />}

      {rows !== null && rows.length === 0 && (
        <EmptyState
          icon={ShieldAlert}
          title="No incidents recorded"
          body="A clean record. Log any near-miss, first-aid case, injury or property damage here so it's tracked to closure."
          actionLabel={canWrite ? 'Raise an incident' : undefined}
          onAction={canWrite ? () => setRaising(true) : undefined}
        />
      )}

      {rows && rows.length > 0 && (
        <Stagger className="space-y-3">
          {rows.map((inc) => (
            <RevealItem key={inc.id}>
              <IncidentCard
                inc={inc}
                canWrite={canWrite}
                busy={busyId === inc.id}
                onToggle={() => void toggleStatus(inc)}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function IncidentCard({
  inc,
  canWrite,
  busy,
  onToggle,
}: {
  inc: IncidentRow
  canWrite: boolean
  busy: boolean
  onToggle: () => void
}) {
  const when = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(inc.occurred_at))

  const severe = inc.incident_type === 'injury'

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                severe
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-secondary text-secondary-foreground',
              )}
            >
              {INCIDENT_TYPE_LABEL[inc.incident_type]}
            </span>
            <span className="text-xs text-muted-foreground">{when}</span>
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            inc.status === 'open'
              ? 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]'
              : 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
          )}
        >
          {inc.status === 'open' ? 'Open' : 'Closed'}
        </span>
      </div>

      <p className="mt-3 text-sm">{inc.description}</p>

      {inc.people_involved && (
        <p className="mt-2 text-xs text-muted-foreground">
          People: {inc.people_involved}
        </p>
      )}
      {inc.immediate_action && (
        <p className="mt-1 text-xs text-muted-foreground">
          Action taken: {inc.immediate_action}
        </p>
      )}

      {inc.photos.length > 0 && <IncidentPhotos paths={inc.photos} />}

      {canWrite && (
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          disabled={busy}
          onClick={onToggle}
        >
          {inc.status === 'open' ? 'Mark closed' : 'Reopen'}
        </Button>
      )}
    </article>
  )
}

function IncidentPhotos({ paths }: { paths: string[] }) {
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
              alt=""
              className="size-20 rounded-lg object-cover ring-1 ring-foreground/10"
            />
          </a>
        ) : (
          <div key={i} className="size-20 rounded-lg bg-muted" />
        ),
      )}
    </div>
  )
}

interface Pending {
  file: File
  url: string
}

function IncidentForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void
  onSaved: () => void
}) {
  const projectId = useProjects((s) => s.selectedId)

  const [type, setType] = useState<IncidentType>('near_miss')
  const [occurredAt, setOccurredAt] = useState(nowLocalInput())
  const [description, setDescription] = useState('')
  const [people, setPeople] = useState('')
  const [action, setAction] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      for (const p of pending) URL.revokeObjectURL(p.url)
    }
  }, [pending])

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return
    try {
      const next: Pending[] = []
      for (const f of Array.from(files)) {
        const c = await compressImage(f)
        next.push({ file: c, url: URL.createObjectURL(c) })
      }
      setPending((p) => [...p, ...next])
    } catch {
      toast.error('Could not process one of those photos')
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!projectId) return
    if (description.trim() === '') {
      toast.error('Add a short description of what happened')
      return
    }

    setBusy(true)
    try {
      const photos: string[] = []
      for (let i = 0; i < pending.length; i++) {
        setStatus(`Uploading photo ${i + 1} of ${pending.length}…`)
        const item = pending[i]
        if (item) photos.push(await uploadSitePhoto(projectId, item.file))
      }

      setStatus('Saving…')
      await createIncident({
        project_id: projectId,
        // datetime-local has no zone; treat as local wall clock.
        occurred_at: new Date(occurredAt).toISOString(),
        incident_type: type,
        description: description.trim(),
        people_involved: people.trim(),
        immediate_action: action.trim(),
        photos,
      })

      toast.success('Incident logged')
      onSaved()
    } catch (err) {
      toast.error('Could not save the incident', {
        description: err instanceof Error ? err.message : undefined,
      })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 pb-6" noValidate>
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        New incident
      </p>

      <FieldRow label="Type" htmlFor="inc_type">
        <Select
          id="inc_type"
          value={type}
          onChange={(e) => setType(e.target.value as IncidentType)}
        >
          {INCIDENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow label="When" htmlFor="inc_when">
        <Input
          id="inc_when"
          type="datetime-local"
          value={occurredAt}
          onChange={(e) => setOccurredAt(e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="What happened" htmlFor="inc_desc">
        <Textarea
          id="inc_desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the incident"
        />
      </FieldRow>

      <FieldRow label="People involved" htmlFor="inc_people">
        <Input
          id="inc_people"
          value={people}
          onChange={(e) => setPeople(e.target.value)}
          className="h-12 text-base"
          placeholder="Names or gang, optional"
        />
      </FieldRow>

      <FieldRow label="Immediate action taken" htmlFor="inc_action">
        <Textarea
          id="inc_action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="First aid given, area cordoned off, etc."
        />
      </FieldRow>

      <FieldRow label="Photos" htmlFor="inc_photos" hint="Compressed before upload.">
        <input
          ref={fileRef}
          id="inc_photos"
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
          onChange={(e) => void addPhotos(e.target.files)}
        />
        <Button
          type="button"
          variant="outline"
          className="h-12 w-full text-base"
          onClick={() => fileRef.current?.click()}
        >
          Add photo
        </Button>
        {pending.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {pending.map((p, i) => (
              <div key={p.url} className="relative">
                <img
                  src={p.url}
                  alt=""
                  className="aspect-square w-full rounded-lg object-cover ring-1 ring-foreground/10"
                />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => {
                    URL.revokeObjectURL(p.url)
                    setPending((prev) => prev.filter((_, idx) => idx !== i))
                  }}
                  className="absolute top-1 right-1 flex size-7 items-center justify-center rounded-full bg-background/90 text-sm"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="ghost"
          className="h-12"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" className="h-12" disabled={busy}>
          {busy ? (status ?? 'Saving…') : 'Log incident'}
        </Button>
      </div>
    </form>
  )
}
