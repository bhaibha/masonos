import {
  Activity,
  BellOff,
  CalendarClock,
  CircleCheck,
  Gauge,
  Info,
  RefreshCw,
  ShieldAlert,
  TrendingDown,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { PageHeader } from '@/components/PageHeader'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import {
  ackHealthFlag,
  captureSnapshotNow,
  fetchDeadlineSignals,
  fetchHealthFlags,
  unackHealthFlag,
} from '@/lib/queries/signals'
import {
  canAckSignals,
  canSeeSignals,
  SIGNAL_BASIS_LABEL,
  SIGNAL_CATEGORY_LABEL,
  SIGNAL_DISCLAIMER,
  SIGNAL_LEVEL_LABEL,
  type DeadlineSignal,
  type HealthFlag,
  type SignalCategory,
  type SignalLevel,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

const LEVEL_TONE: Record<SignalLevel, string> = {
  concern: 'bg-destructive/10 text-destructive',
  watch:
    'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
}

const CATEGORY_ICON: Record<
  SignalCategory,
  typeof Gauge
> = {
  cost: Gauge,
  schedule: TrendingDown,
  quality: ShieldAlert,
  deadline: CalendarClock,
}

/**
 * D3 — the health signals panel.
 *
 * Simple arithmetic over data the app already holds, turned into sentences.
 * There is no model here and nothing is predicted: every card prints the number
 * it was computed from, and says whether that number was measured once today or
 * compared against earlier readings.
 *
 * Founder and PM see all four categories; accounts sees cost and deadline
 * signals only; a supervisor gets nothing at all — the server returns zero rows
 * rather than a row of zeros, because zeros on a health panel read as "the job
 * is fine".
 */
export default function Signals() {
  const role = useAuth((s) => s.role)
  const mayAck = canAckSignals(role)

  const [flags, setFlags] = useState<HealthFlag[] | null>(null)
  const [deadlines, setDeadlines] = useState<DeadlineSignal[] | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setFlags(null)
    setDeadlines(null)

    // allSettled, never all: a failure computing project flags must not blank
    // the deadline strip as well (the 056 lesson).
    const [f, d] = await Promise.allSettled([
      fetchHealthFlags(null),
      fetchDeadlineSignals(),
    ])

    if (f.status === 'fulfilled') setFlags(f.value)
    else {
      toast.error('Could not read the project signals', {
        description: errText(f.reason),
      })
      setFlags([])
    }

    if (d.status === 'fulfilled') setDeadlines(d.value)
    else {
      toast.error('Could not read the deadline signals', {
        description: errText(d.reason),
      })
      setDeadlines([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  if (!canSeeSignals(role)) {
    return (
      <>
        <PageHeader title="Signals" />
        <p className="mx-auto max-w-lg px-4 py-10 text-center text-sm text-muted-foreground">
          Health signals are restricted for your role.
        </p>
      </>
    )
  }

  const loading = flags === null || deadlines === null
  const nothing =
    flags !== null &&
    deadlines !== null &&
    flags.length === 0 &&
    deadlines.length === 0

  return (
    <div className="mx-auto max-w-lg space-y-4 px-4 py-4 pb-6">
      {/* The framing, stated once at the top and not buried. */}
      <p className="flex items-start gap-2 rounded-lg bg-secondary/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        {SIGNAL_DISCLAIMER}
      </p>

      {loading && <ListSkeleton rows={4} />}

      {nothing && (
        <EmptyState
          icon={CircleCheck}
          title="Nothing is flagging"
          body={
            'No signal crossed its threshold today. That is not a clean bill of ' +
            'health — it means these particular checks found nothing, on the ' +
            'data that has been entered.'
          }
        />
      )}

      {deadlines !== null && deadlines.length > 0 && (
        <section className="space-y-2">
          <p className="px-1 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Dates coming up
          </p>
          {deadlines.map((d) => (
            <article key={d.code} className="paper p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="flex items-start gap-2 text-sm font-medium">
                  <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-[var(--accent)]" />
                  {d.headline}
                </p>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                    LEVEL_TONE[d.level],
                  )}
                >
                  {SIGNAL_LEVEL_LABEL[d.level]}
                </span>
              </div>
              <p className="mt-2 pl-[22px] text-xs leading-relaxed text-muted-foreground">
                {d.detail}
              </p>
            </article>
          ))}
        </section>
      )}

      {flags !== null && flags.length > 0 && (
        <section className="space-y-2">
          <p className="px-1 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            On the projects
          </p>
          <Stagger className="space-y-3">
            {flags.map((f) => (
              <RevealItem key={`${f.project_id}_${f.code}`}>
                <FlagCard flag={f} mayAck={mayAck} onChanged={reload} />
              </RevealItem>
            ))}
          </Stagger>
        </section>
      )}

      {!loading && (
        <div className="space-y-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-10 w-full gap-1.5"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const n = await captureSnapshotNow()
                toast.success(`Captured ${n} project${n === 1 ? '' : 's'}`, {
                  description:
                    'Trends need several readings before they mean anything.',
                })
                await reload()
              } catch (err) {
                toast.error('Could not capture', { description: errText(err) })
              }
              setBusy(false)
            }}
          >
            <RefreshCw className="size-3.5" /> Capture today's reading
          </Button>
          <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
            A reading is taken automatically each night. Anything marked
            "measured once" will start comparing against earlier readings once a
            few have accumulated — progress has no history before this module was
            installed, so it cannot be trended backwards.
          </p>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function FlagCard({
  flag: f,
  mayAck,
  onChanged,
}: {
  flag: HealthFlag
  mayAck: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [snoozing, setSnoozing] = useState(false)
  const [days, setDays] = useState('14')
  const [note, setNote] = useState('')

  const Icon = CATEGORY_ICON[f.category] ?? Activity

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            {SIGNAL_CATEGORY_LABEL[f.category]} · {f.project_name}
          </p>
          <h3 className="font-heading mt-1 flex items-start gap-2 text-[16px] leading-snug font-semibold">
            <Icon className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
            {f.headline}
          </h3>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            LEVEL_TONE[f.level],
          )}
        >
          {SIGNAL_LEVEL_LABEL[f.level]}
        </span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {f.detail}
      </p>

      {/* The number it was computed from, large and in the serif face — so the
          reader can disagree with the threshold rather than with the app. */}
      {f.metric_value !== null && (
        <div className="mt-4 flex items-baseline gap-2">
          <span className="figure text-2xl leading-none font-semibold tabular-nums">
            {f.metric_value}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {f.metric_label}
          </span>
        </div>
      )}

      {/* Basis and sample size. A divergence measured once today and a slope
          over six readings are different claims and must not look the same. */}
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        {SIGNAL_BASIS_LABEL[f.basis]}
        {f.basis === 'trend' && f.sample_n > 0
          ? ` · ${f.sample_n} observations`
          : ''}
        . Indicative only — check it before acting on it.
      </p>

      {mayAck && (
        <div className="mt-4">
          {!snoozing ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-10 flex-1 gap-1.5"
                onClick={() => setSnoozing(true)}
              >
                <BellOff className="size-3.5" /> Set aside
              </Button>
              {f.snoozed_until && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10 gap-1.5"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await unackHealthFlag(f.project_id, f.code)
                      toast.success('Back on the list')
                      onChanged()
                    } catch (err) {
                      toast.error('Could not bring it back', {
                        description: errText(err),
                      })
                      setBusy(false)
                    }
                  }}
                >
                  <Undo2 className="size-3.5" /> Bring back
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <FieldRow label="For how long" htmlFor={`d_${f.code}`}>
                <Select
                  id={`d_${f.code}`}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                >
                  <option value="7">A week</option>
                  <option value="14">A fortnight</option>
                  <option value="30">A month</option>
                  <option value="90">Three months</option>
                </Select>
              </FieldRow>
              <FieldRow label="Why (optional)" htmlFor={`n_${f.code}`}>
                <Textarea
                  id={`n_${f.code}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Budget was set low at tender; revision going in this week"
                  rows={2}
                />
              </FieldRow>
              <p className="text-[11px] text-muted-foreground">
                It comes back after that. There is no permanent dismissal — the
                condition does not go away because it was acknowledged.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  className="h-11"
                  onClick={() => setSnoozing(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  className="h-11"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await ackHealthFlag(
                        f.project_id,
                        f.code,
                        Number(days),
                        note || null,
                      )
                      toast.success('Set aside')
                      setSnoozing(false)
                      onChanged()
                    } catch (err) {
                      toast.error('Could not set it aside', {
                        description: errText(err),
                      })
                      setBusy(false)
                    }
                  }}
                >
                  Set aside
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  )
}
