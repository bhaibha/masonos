import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Textarea } from '@/components/Field'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { fetchChecklist, saveChecklist } from '@/lib/queries/safety'
import { compressImage, signedSitePhotoUrl, uploadSitePhoto } from '@/lib/storage'
import {
  canManageSafety,
  type ChecklistItemState,
  SAFETY_ITEMS,
  type SafetyResult,
} from '@/lib/types'
import { formatDayLabel, useSelectedDate } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

type ItemDraft = ChecklistItemState & {
  /** a freshly-picked file not yet uploaded */
  pendingFile: File | null
  previewUrl: string | null
}

function blankItem(): ItemDraft {
  return { result: 'na', remark: '', photo_path: null, pendingFile: null, previewUrl: null }
}

export default function SafetyChecklist() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const canWrite = canManageSafety(role)
  const [date] = useSelectedDate()

  const [drafts, setDrafts] = useState<Record<string, ItemDraft> | null>(null)
  const [existed, setExisted] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    setDrafts(null)

    fetchChecklist(projectId, date)
      .then((loaded) => {
        if (cancelled) return
        const next: Record<string, ItemDraft> = {}
        for (const item of SAFETY_ITEMS) {
          const saved = loaded.items[item.key]
          next[item.key] = saved
            ? { ...saved, pendingFile: null, previewUrl: null }
            : blankItem()
        }
        setDrafts(next)
        setExisted(loaded.meta !== null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        toast.error('Could not load the checklist', {
          description: err instanceof Error ? err.message : undefined,
        })
        setDrafts(null)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, date])

  function patch(key: string, change: Partial<ItemDraft>) {
    setDrafts((d) => (d ? { ...d, [key]: { ...d[key], ...change } } : d))
  }

  async function pickPhoto(key: string, file: File | null) {
    if (!file) {
      patch(key, { pendingFile: null, previewUrl: null })
      return
    }
    try {
      const compressed = await compressImage(file)
      patch(key, {
        pendingFile: compressed,
        previewUrl: URL.createObjectURL(compressed),
      })
    } catch {
      toast.error('Could not process that photo')
    }
  }

  async function save() {
    if (!projectId || !drafts) return
    setBusy(true)
    try {
      // Upload any newly-picked photos first, folding paths back in.
      const items: { item_key: string; state: ChecklistItemState }[] = []
      for (const item of SAFETY_ITEMS) {
        const d = drafts[item.key]
        let photo_path = d.photo_path
        if (d.pendingFile) {
          photo_path = await uploadSitePhoto(projectId, d.pendingFile)
        }
        items.push({
          item_key: item.key,
          state: { result: d.result, remark: d.remark, photo_path },
        })
      }

      await saveChecklist(projectId, date, items)
      toast.success(existed ? 'Checklist updated' : 'Checklist submitted')
      setExisted(true)
      // Clear pending previews now they're persisted.
      setDrafts((prev) => {
        if (!prev) return prev
        const next: Record<string, ItemDraft> = {}
        for (const item of SAFETY_ITEMS) {
          const d = prev[item.key]
          if (d.previewUrl) URL.revokeObjectURL(d.previewUrl)
          const uploaded = items.find((i) => i.item_key === item.key)
          next[item.key] = {
            result: d.result,
            remark: d.remark,
            photo_path: uploaded?.state.photo_path ?? d.photo_path,
            pendingFile: null,
            previewUrl: null,
          }
        }
        return next
      })
    } catch (err) {
      toast.error('Could not save the checklist', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    setBusy(false)
  }

  if (drafts === null) {
    return <ListSkeleton rows={6} />
  }

  const failCount = SAFETY_ITEMS.filter((i) => drafts[i.key].result === 'fail').length

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {existed ? 'Submitted for ' : 'New checklist for '}
          {formatDayLabel(date)}
        </p>
        {failCount > 0 && (
          <span className="rounded-full bg-destructive/10 px-3 py-1 text-[11px] font-medium text-destructive">
            {failCount} failing
          </span>
        )}
      </div>

      <div className="space-y-3">
        {SAFETY_ITEMS.map((item) => (
          <CheckItem
            key={item.key}
            label={item.label}
            hint={item.hint}
            draft={drafts[item.key]}
            canWrite={canWrite}
            onResult={(result) => patch(item.key, { result })}
            onRemark={(remark) => patch(item.key, { remark })}
            onPhoto={(file) => void pickPhoto(item.key, file)}
          />
        ))}
      </div>

      {canWrite ? (
        <Button
          className="h-12 w-full text-base"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : existed ? 'Update checklist' : 'Submit checklist'}
        </Button>
      ) : (
        <p className="py-4 text-center text-sm text-muted-foreground">
          Your role can view the checklist but not complete it.
        </p>
      )}
    </div>
  )
}

const RESULT_STYLE: Record<SafetyResult, string> = {
  pass: 'bg-[color-mix(in_oklab,var(--positive)_90%,white)] text-[var(--primary-foreground)]',
  fail: 'bg-destructive text-destructive-foreground',
  na: 'bg-secondary text-secondary-foreground',
}

function CheckItem({
  label,
  hint,
  draft,
  canWrite,
  onResult,
  onRemark,
  onPhoto,
}: {
  label: string
  hint: string
  draft: ItemDraft
  canWrite: boolean
  onResult: (r: SafetyResult) => void
  onRemark: (v: string) => void
  onPhoto: (file: File | null) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [savedUrl, setSavedUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (draft.photo_path && !draft.previewUrl) {
      signedSitePhotoUrl(draft.photo_path).then((u) => {
        if (!cancelled) setSavedUrl(u)
      })
    }
    return () => {
      cancelled = true
    }
  }, [draft.photo_path, draft.previewUrl])

  const results: SafetyResult[] = ['pass', 'fail', 'na']
  const thumb = draft.previewUrl ?? savedUrl

  return (
    <div className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        {results.map((r) => {
          const active = draft.result === r
          return (
            <button
              key={r}
              type="button"
              disabled={!canWrite}
              onClick={() => onResult(r)}
              className={cn(
                'h-11 rounded-lg text-sm font-medium transition-colors disabled:opacity-60',
                active
                  ? RESULT_STYLE[r]
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {r === 'na' ? 'N/A' : r === 'pass' ? 'Pass' : 'Fail'}
            </button>
          )
        })}
      </div>

      {/* Remark + photo matter most when something failed, but allowed always. */}
      {canWrite && (
        <div className="mt-3 space-y-2">
          <Textarea
            value={draft.remark}
            onChange={(e) => onRemark(e.target.value)}
            placeholder={draft.result === 'fail' ? 'What was wrong, and where' : 'Remark (optional)'}
            className="min-h-16"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => onPhoto(e.target.files?.[0] ?? null)}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              {thumb ? 'Change photo' : 'Add photo'}
            </Button>
            {draft.previewUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onPhoto(null)}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      )}

      {thumb && (
        <img
          src={thumb}
          alt={`${label} photo`}
          className="mt-3 max-h-40 rounded-lg object-contain ring-1 ring-foreground/10"
        />
      )}
    </div>
  )
}
