import { type FormEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PhotoHelper } from '@/components/PhotoHelper'
import { ListSkeleton } from '@/components/Skeleton'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { fetchMySiteLog, upsertSiteLog } from '@/lib/queries/siteLogs'
import {
  compressImage,
  signedSitePhotoUrl,
  uploadSitePhoto,
} from '@/lib/storage'
import { canWriteTasks, WEATHER_OPTIONS } from '@/lib/types'
import { formatDayLabel, useSelectedDate } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

interface PendingPhoto {
  file: File
  previewUrl: string
  kb: number
}

export default function SiteLog() {
  const projectId = useProjects((s) => s.selectedId)
  const user = useAuth((s) => s.user)
  const role = useAuth((s) => s.role)
  const canWrite = canWriteTasks(role)
  const [date] = useSelectedDate()

  const [loading, setLoading] = useState(true)
  const [existingId, setExistingId] = useState<string | null>(null)

  const [weather, setWeather] = useState('')
  const [mason, setMason] = useState('0')
  const [helper, setHelper] = useState('0')
  const [other, setOther] = useState('0')
  const [summary, setSummary] = useState('')
  const [issues, setIssues] = useState('')

  const [savedPhotos, setSavedPhotos] = useState<string[]>([])
  const [pending, setPending] = useState<PendingPhoto[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId || !user) return
    let cancelled = false
    setLoading(true)

    fetchMySiteLog(projectId, date, user.id)
      .then((log) => {
        if (cancelled) return
        setExistingId(log?.id ?? null)
        setWeather(log?.weather ?? '')
        setMason(String(log?.labour_mason ?? 0))
        setHelper(String(log?.labour_helper ?? 0))
        setOther(String(log?.labour_other ?? 0))
        setSummary(log?.work_summary ?? '')
        setIssues(log?.issues ?? '')
        setSavedPhotos(log?.photos ?? [])
        setPending([])
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        toast.error('Could not load the log.', { description: errText(err) })
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, date, user])

  useEffect(() => {
    return () => {
      for (const p of pending) URL.revokeObjectURL(p.previewUrl)
    }
  }, [pending])

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return
    try {
      const next: PendingPhoto[] = []
      for (const file of Array.from(files)) {
        const compressed = await compressImage(file)
        next.push({
          file: compressed,
          previewUrl: URL.createObjectURL(compressed),
          kb: Math.round(compressed.size / 1024),
        })
      }
      setPending((p) => [...p, ...next])
    } catch {
      toast.error('Could not process one of those images.')
    }
  }

  function removePending(index: number) {
    setPending((p) => {
      const target = p[index]
      if (target) URL.revokeObjectURL(target.previewUrl)
      return p.filter((_, i) => i !== index)
    })
  }

  function removeSaved(path: string) {
    // Drops the reference from the log. The object stays in the bucket —
    // deleting storage objects isn't in v1 scope.
    setSavedPhotos((p) => p.filter((x) => x !== path))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!projectId || !user) return

    const counts = [mason, helper, other].map((v) => Number(v || 0))
    if (counts.some((n) => !Number.isInteger(n) || n < 0)) {
      toast.error('Labour counts must be whole numbers, zero or more.')
      return
    }

    setBusy(true)
    try {
      const uploaded: string[] = []
      for (let i = 0; i < pending.length; i++) {
        setStatus(`Uploading photo ${i + 1} of ${pending.length}…`)
        const item = pending[i]
        if (item) uploaded.push(await uploadSitePhoto(projectId, item.file))
      }

      setStatus('Saving log…')
      const photos = [...savedPhotos, ...uploaded]

      await upsertSiteLog({
        project_id: projectId,
        log_date: date,
        weather,
        labour_mason: counts[0] ?? 0,
        labour_helper: counts[1] ?? 0,
        labour_other: counts[2] ?? 0,
        work_summary: summary,
        issues,
        photos,
        created_by: user.id,
      })

      for (const p of pending) URL.revokeObjectURL(p.previewUrl)
      setPending([])
      setSavedPhotos(photos)
      setExistingId(existingId ?? 'saved')
      toast.success('Site log saved.')
    } catch (err) {
      toast.error('Could not save the log.', { description: errText(err) })
    }
    setBusy(false)
    setStatus(null)
  }

  if (loading) return <ListSkeleton rows={5} />

  if (!canWrite) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Your role can view site logs but not file them.
      </p>
    )
  }

  return (
    <form onSubmit={onSubmit} className="paper mb-6 space-y-5 p-5" noValidate>
      <p className="text-sm text-muted-foreground">
        {existingId ? 'Editing your log for ' : 'New log for '}
        {formatDayLabel(date)}
      </p>

      <FieldRow label="Weather" htmlFor="weather">
        <Select
          id="weather"
          value={weather}
          onChange={(e) => setWeather(e.target.value)}
        >
          <option value="">Not recorded</option>
          {WEATHER_OPTIONS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </Select>
      </FieldRow>

      <fieldset className="space-y-2">
        <legend className="text-sm leading-none font-medium">Labour on site</legend>
        <div className="grid grid-cols-3 gap-3 pt-2">
          <FieldRow label="Masons" htmlFor="lab_mason">
            <Input
              id="lab_mason"
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={mason}
              onChange={(e) => setMason(e.target.value)}
              className="h-12 text-center text-base tabular-nums"
            />
          </FieldRow>
          <FieldRow label="Helpers" htmlFor="lab_helper">
            <Input
              id="lab_helper"
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={helper}
              onChange={(e) => setHelper(e.target.value)}
              className="h-12 text-center text-base tabular-nums"
            />
          </FieldRow>
          <FieldRow label="Other" htmlFor="lab_other">
            <Input
              id="lab_other"
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={other}
              onChange={(e) => setOther(e.target.value)}
              className="h-12 text-center text-base tabular-nums"
            />
          </FieldRow>
        </div>
      </fieldset>

      <FieldRow label="Work done today" htmlFor="summary">
        <Textarea
          id="summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="What progressed, where"
        />
      </FieldRow>

      <FieldRow label="Issues" htmlFor="issues">
        <Textarea
          id="issues"
          value={issues}
          onChange={(e) => setIssues(e.target.value)}
          placeholder="Delays, shortages, safety concerns"
        />
      </FieldRow>

      <FieldRow
        label="Site photos"
        htmlFor="photos"
        hint="Each photo is compressed to under 300 KB before upload."
      >
        <input
          ref={fileRef}
          id="photos"
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

        {/* D1 — optional second look. Only on a SAVED photo: a pending one has
            no storage path yet, so there is nothing for the helper to fetch.
            Save the log first. */}
        {savedPhotos.length > 0 && projectId && (
          <PhotoHelper
            projectId={projectId}
            photoPath={savedPhotos[0]}
            source="site_log"
            siteLogId={existingId}
          />
        )}

        {(savedPhotos.length > 0 || pending.length > 0) && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {savedPhotos.map((path) => (
              <SavedPhoto key={path} path={path} onRemove={() => removeSaved(path)} />
            ))}
            {pending.map((p, i) => (
              <div key={p.previewUrl} className="relative">
                <img
                  src={p.previewUrl}
                  alt=""
                  className="aspect-square w-full rounded-lg object-cover ring-1 ring-foreground/10"
                />
                <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1 text-[10px] tabular-nums">
                  {p.kb} KB
                </span>
                <button
                  type="button"
                  onClick={() => removePending(i)}
                  aria-label="Remove photo"
                  className="absolute top-1 right-1 flex size-7 items-center justify-center rounded-full bg-background/90 text-sm"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </FieldRow>

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        {busy ? (status ?? 'Saving…') : existingId ? 'Update log' : 'Save log'}
      </Button>
    </form>
  )
}

function SavedPhoto({ path, onRemove }: { path: string; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    signedSitePhotoUrl(path).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <div className="relative">
      {url ? (
        <img
          src={url}
          alt=""
          className="aspect-square w-full rounded-lg object-cover ring-1 ring-foreground/10"
        />
      ) : (
        <div className="aspect-square w-full rounded-lg bg-muted" />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove photo"
        className="absolute top-1 right-1 flex size-7 items-center justify-center rounded-full bg-background/90 text-sm"
      >
        ×
      </button>
    </div>
  )
}
