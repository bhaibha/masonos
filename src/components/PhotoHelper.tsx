import {
  CheckCircle2,
  Eye,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { Skeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  acceptPhotoAnalysis,
  analysePhoto,
  dismissPhotoAnalysis,
  fetchPhotoAnalysis,
  reanalysePhoto,
} from '@/lib/queries/photoAnalysis'
import {
  AI_SUGGESTION_LABEL,
  canAcceptAsNcr,
  canAnalysePhotos,
  type PhotoAnalysis,
  type PhotoSource,
} from '@/lib/types'
import { useAuth } from '@/store/auth'

interface Props {
  projectId: string
  photoPath: string
  source: PhotoSource
  siteLogId?: string | null
  snagId?: string | null
  commentId?: string | null
  /** Called after a snag or NCR is raised, so the host screen can refresh. */
  onRaised?: () => void
}

/**
 * D1 — the optional second look at a site photo.
 *
 * OPT-IN, ALWAYS. Nothing here fires on upload. Somebody has to tap "Analyse
 * photo", which keeps the feature inside the free tier and, more importantly,
 * keeps it an act somebody chose rather than a thing that happened to them.
 *
 * The output is styled as a SUGGESTION and never as a finding: an accent-tinted
 * panel, the words "AI suggestion — verify on site" at the top, every concern
 * paired with what to physically check, and no severity anywhere — because a
 * model that cannot measure should not be handing out severities.
 */
export function PhotoHelper({
  projectId,
  photoPath,
  source,
  siteLogId = null,
  snagId = null,
  commentId = null,
  onRaised,
}: Props) {
  const role = useAuth((s) => s.role)
  const mayUse = canAnalysePhotos(role)
  const mayNcr = canAcceptAsNcr(role)

  const [row, setRow] = useState<PhotoAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  const [target, setTarget] = useState<'snag' | 'ncr'>('snag')
  const [area, setArea] = useState('')
  const [text, setText] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRow(await fetchPhotoAnalysis(photoPath))
    } catch {
      setRow(null)
    }
    setLoading(false)
  }, [photoPath])

  useEffect(() => {
    void load()
  }, [load])

  if (!mayUse) return null

  async function run() {
    setThinking(true)
    try {
      const r = await analysePhoto({
        projectId,
        photoPath,
        source,
        siteLogId,
        snagId,
        commentId,
      })
      setRow(r)
      toast.success('Looked at', {
        description:
          r.concerns.length === 0
            ? 'Nothing obvious flagged. Still worth your own look.'
            : `${r.concerns.length} thing${r.concerns.length === 1 ? '' : 's'} to check.`,
      })
    } catch (err) {
      toast.error('Could not analyse that photo', { description: errText(err) })
    }
    setThinking(false)
  }

  if (loading) return <Skeleton className="h-10 w-full" />

  /* ---------- nothing yet: the opt-in button ---------- */
  if (!row) {
    return (
      <div className="mt-3">
        <Button
          variant="outline"
          size="sm"
          className="h-10 w-full gap-2"
          disabled={thinking}
          onClick={() => void run()}
        >
          <Sparkles className="size-3.5" />
          {thinking ? 'Looking at the photo…' : 'Analyse photo'}
        </Button>
        {thinking && (
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        )}
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Optional. Sends this one photo to an AI for a second opinion — it is
          not an inspector and cannot measure anything.
        </p>
      </div>
    )
  }

  /* ---------- the suggestion ---------- */
  return (
    <section className="mt-3 rounded-xl border border-[var(--accent)]/35 bg-[color-mix(in_oklab,var(--accent)_7%,transparent)] p-4">
      {/* The label is a constant in types.ts so it cannot drift between the
          three screens that show this component. */}
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.1em] text-[var(--accent)] uppercase">
          <Sparkles className="size-3" />
          {AI_SUGGESTION_LABEL}
        </p>
        {row.status !== 'suggested' && (
          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground">
            {row.status === 'accepted' ? 'Raised' : 'Dismissed'}
          </span>
        )}
      </div>

      {row.description && (
        <p className="mt-3 text-sm leading-relaxed">{row.description}</p>
      )}

      {row.concerns.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Nothing obvious flagged. That is not a clean bill of health — it is one
          model looking at one photograph.
        </p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {row.concerns.map((c, i) => (
            <li
              key={i}
              className="rounded-lg border border-border bg-surface/60 p-3"
            >
              <p className="flex items-start gap-1.5 text-xs font-medium">
                <TriangleAlert className="mt-0.5 size-3 shrink-0 text-[var(--warning)]" />
                {c.concern}
              </p>
              {/* The instruction is the point of the whole structure: it turns
                  model output into a question for a person rather than a
                  finding. */}
              <p className="mt-1.5 flex items-start gap-1.5 pl-[18px] text-[11px] text-muted-foreground">
                <Eye className="mt-0.5 size-3 shrink-0" />
                {c.what_to_check}
              </p>
            </li>
          ))}
        </ul>
      )}

      {row.dismiss_note && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Dismissed: {row.dismiss_note}
        </p>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        Generated by {row.model ?? 'an AI model'} on{' '}
        {row.analysed_at.slice(0, 10)}. It cannot measure a crack, judge cover or
        tell shrinkage from settlement. Nothing here is a finding until you have
        stood in front of it.
      </p>

      {/* ---------- actions ---------- */}
      {row.status === 'suggested' && !accepting && !dismissing && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            className="h-10 flex-1 gap-1.5"
            onClick={() => {
              setText(row.description ?? '')
              setAccepting(true)
            }}
          >
            <CheckCircle2 className="size-3.5" /> Raise a snag
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-10 flex-1 gap-1.5"
            onClick={() => setDismissing(true)}
          >
            <X className="size-3.5" /> Dismiss
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-10"
            disabled={busy}
            aria-label="Analyse again"
            onClick={async () => {
              setBusy(true)
              try {
                await reanalysePhoto(photoPath)
                setRow(null)
                toast.success('Cleared — tap Analyse photo to look again')
              } catch (err) {
                toast.error('Could not clear it', { description: errText(err) })
              }
              setBusy(false)
            }}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      )}

      {accepting && (
        <div className="mt-4 space-y-3 rounded-lg border border-border bg-surface p-3">
          {mayNcr && (
            <FieldRow label="Raise as" htmlFor={`t_${row.id}`}>
              <Select
                id={`t_${row.id}`}
                value={target}
                onChange={(e) => setTarget(e.target.value as 'snag' | 'ncr')}
              >
                <option value="snag">Snag</option>
                <option value="ncr">NCR — formal non-conformance</option>
              </Select>
            </FieldRow>
          )}

          <FieldRow label="Where is it" htmlFor={`a_${row.id}`}>
            <Input
              id={`a_${row.id}`}
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="Ground floor, column C4"
              className="h-12 text-base"
            />
          </FieldRow>

          <FieldRow label="What is wrong" htmlFor={`d_${row.id}`}>
            <Textarea
              id={`d_${row.id}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
            />
          </FieldRow>
          {/* Editable on the way in, deliberately: the person filing owns the
              words, because their name goes on the record — not the model's. */}
          <p className="text-[11px] text-muted-foreground">
            Pre-filled from the suggestion. Edit it — this becomes your record,
            in your name.
          </p>

          <FieldRow label="How bad is it" htmlFor={`s_${row.id}`}>
            <Select
              id={`s_${row.id}`}
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
            >
              {target === 'ncr' ? (
                <>
                  <option value="minor">Minor</option>
                  <option value="major">Major</option>
                  <option value="critical">Critical</option>
                </>
              ) : (
                <>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </>
              )}
            </Select>
          </FieldRow>
          <p className="text-[11px] text-muted-foreground">
            Your judgement. The AI never supplies one — it cannot measure, so it
            has no basis for a severity.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setAccepting(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              className="h-11"
              disabled={busy || area.trim() === ''}
              title={area.trim() === '' ? 'Say where it is first' : undefined}
              onClick={async () => {
                setBusy(true)
                try {
                  await acceptPhotoAnalysis(
                    row.id,
                    target,
                    area,
                    text,
                    severity,
                  )
                  toast.success(
                    target === 'snag' ? 'Snag raised' : 'NCR raised',
                    { description: 'It carries your name, not the AI’s.' },
                  )
                  setAccepting(false)
                  await load()
                  onRaised?.()
                } catch (err) {
                  toast.error('Could not raise it', {
                    description: errText(err),
                  })
                  setBusy(false)
                }
              }}
            >
              Raise it
            </Button>
          </div>
        </div>
      )}

      {dismissing && (
        <div className="mt-4 space-y-3 rounded-lg border border-border bg-surface p-3">
          <FieldRow label="Why (optional)" htmlFor={`n_${row.id}`}>
            <Textarea
              id={`n_${row.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Checked on site — nothing there"
              rows={2}
            />
          </FieldRow>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setDismissing(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await dismissPhotoAnalysis(row.id, note || null)
                  toast.success('Dismissed', {
                    description: 'Kept on record so we can tell if this helper is any use.',
                  })
                  setDismissing(false)
                  await load()
                } catch (err) {
                  toast.error('Could not dismiss it', {
                    description: errText(err),
                  })
                  setBusy(false)
                }
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {row.status === 'accepted' && (
        <p className="mt-3 text-[11px] text-[var(--positive)]">
          A {row.accepted_ncr_id ? 'NCR' : 'snag'} was raised from this.
        </p>
      )}
    </section>
  )
}
