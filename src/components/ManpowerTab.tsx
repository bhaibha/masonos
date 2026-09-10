import { AlertTriangle, ChevronDown, HardHat, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  calcManpower,
  deleteManpowerEstimate,
  fetchConstantStatus,
  fetchLabourActivities,
  fetchManpowerEstimates,
  fetchManpowerVsActual,
  fetchManpowerVsSchedule,
  runManpowerSelftest,
  saveManpowerEstimate,
  updateLabourActivity,
  type ManpowerSelftestRow,
} from '@/lib/queries/manpower'
import { fetchActivities } from '@/lib/queries/schedule'
import {
  canEditLabourConstants,
  LABOUR_SOURCE_LABEL,
  type LabourActivity,
  type LabourConstantStatus,
  type LabourSource,
  type ManpowerResult,
  type ManpowerVsActual,
  type ManpowerVsSchedule,
  type SavedManpowerEstimate,
  type ScheduleActivity,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

/**
 * M14 MANPOWER — the other half of the quantity question.
 *
 * It lives on `/calculator` rather than on a screen of its own because the
 * INPUT IS THE SAME. Somebody who has just worked out the blocks for 37.5 sqm
 * of wall should not retype 37.5 somewhere else to find out how long it takes.
 *
 * NOT ONE DIVISION HAPPENS HERE. `fn_manpower` (087) returns the gang, the
 * man-days, the duration and the working together — the 051 rule.
 *
 * EVERY RESULT FROM AN UNCONFIRMED CONSTANT SAYS SO, on the result itself and
 * not only in a banner at the top. The seeded outputs are starting figures, not
 * IS 7272 values, and a number nobody has checked should have to admit it every
 * time somebody reads it.
 */

const DEBOUNCE_MS = 300

const n = (s: string): number => {
  const v = Number(s)
  return Number.isFinite(v) ? v : 0
}

export function ManpowerTab({ projectId }: { projectId: string | null }) {
  const [acts, setActs] = useState<LabourActivity[] | null>(null)
  const [code, setCode] = useState('')
  const [qty, setQty] = useState('45')
  const [gangs, setGangs] = useState('1')
  const [eff, setEff] = useState('100')
  const [target, setTarget] = useState('')
  const [linkId, setLinkId] = useState('')
  const [sched, setSched] = useState<ScheduleActivity[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchLabourActivities()
      .then((a) => {
        setActs(a)
        setCode((c) => c || a[0]?.code || '')
      })
      .catch((err) => {
        setActs([])
        toast.error('Could not load the activity list', { description: errText(err) })
      })
  }, [])

  useEffect(() => {
    if (!projectId) {
      setSched([])
      return
    }
    fetchActivities(projectId).then(setSched).catch(() => setSched([]))
  }, [projectId])

  const chosen = acts?.find((a) => a.code === code) ?? null

  const args = useMemo(
    () => ({
      activity_code: code,
      qty: n(qty),
      gangs: Math.max(1, Math.round(n(gangs))),
      efficiency_pct: n(eff),
      target_days: target === '' ? null : Math.round(n(target)),
    }),
    [code, qty, gangs, eff, target],
  )

  const { result, busy } = useDebouncedCalc(args, code !== '' && n(qty) > 0)

  // Grouped so a 26-row picker is navigable on a phone.
  const grouped = useMemo(() => {
    const g = new Map<string, LabourActivity[]>()
    for (const a of acts ?? []) {
      const list = g.get(a.category) ?? []
      list.push(a)
      g.set(a.category, list)
    }
    return [...g.entries()]
  }, [acts])

  if (acts === null) return <ListSkeleton rows={4} />

  return (
    <Stagger className="space-y-4">
      <RevealItem>
        <div className="paper space-y-4 p-5">
          <h2 className="font-heading text-lg font-semibold">Manpower</h2>

          <FieldRow label="Activity" htmlFor="mp-act">
            <Select
              id="mp-act"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-12 text-base"
            >
              {grouped.map(([cat, list]) => (
                <optgroup key={cat} label={cat}>
                  {list.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.label}
                      {a.output_per_gang_day === null ? ' — no output set' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </FieldRow>

          {chosen && (
            <div className="rounded-lg bg-secondary/50 px-4 py-3">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-medium">
                  {chosen.output_per_gang_day === null
                    ? 'No output figure yet'
                    : `${chosen.output_per_gang_day} ${chosen.unit} per gang-day`}
                </span>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
                    chosen.verified
                      ? 'bg-[color-mix(in_oklab,var(--positive)_16%,transparent)] text-[var(--positive)]'
                      : 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
                  )}
                >
                  {chosen.verified ? 'Confirmed' : 'Unconfirmed'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {LABOUR_SOURCE_LABEL[chosen.source]}
                  {chosen.is_ref && ` · ${chosen.is_ref}`}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Gang:{' '}
                {chosen.gang.map((g) => `${g.persons} × ${g.trade}`).join(' + ') ||
                  'none recorded'}
              </p>
              {chosen.note && (
                <p className="mt-1.5 text-xs text-muted-foreground">{chosen.note}</p>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <FieldRow
              label={chosen ? `Quantity (${chosen.unit})` : 'Quantity'}
              htmlFor="mp-qty"
            >
              <Input
                id="mp-qty"
                type="number"
                inputMode="decimal"
                step="0.01"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="h-12 text-base tabular-nums"
              />
            </FieldRow>
            <FieldRow label="Gangs" htmlFor="mp-gangs">
              <Input
                id="mp-gangs"
                type="number"
                inputMode="numeric"
                step="1"
                min="1"
                value={gangs}
                onChange={(e) => setGangs(e.target.value)}
                className="h-12 text-base tabular-nums"
              />
            </FieldRow>
            <FieldRow
              label="Efficiency (%)"
              htmlFor="mp-eff"
              hint="Monsoon, night work, a difficult floor."
            >
              <Input
                id="mp-eff"
                type="number"
                inputMode="numeric"
                step="5"
                value={eff}
                onChange={(e) => setEff(e.target.value)}
                className="h-12 text-base tabular-nums"
              />
            </FieldRow>
          </div>

          {/* The question a PM actually asks, backwards. */}
          <FieldRow
            label="Or: I need it in this many days"
            htmlFor="mp-target"
            hint="Leave blank to work forwards from the number of gangs."
          >
            <Input
              id="mp-target"
              type="number"
              inputMode="numeric"
              step="1"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-12 text-base tabular-nums"
              placeholder="e.g. 10"
            />
          </FieldRow>
        </div>
      </RevealItem>

      <RevealItem>
        <ManpowerResultCard
          result={result}
          busy={busy}
          sched={sched}
          linkId={linkId}
          onLink={setLinkId}
          onSave={
            projectId && result?.ok
              ? () =>
                  void saveFlow({
                    projectId,
                    code,
                    qty: args.qty,
                    gangs: args.gangs,
                    eff: args.efficiency_pct,
                    activityId: linkId || null,
                    result,
                    setSaving,
                  })
              : undefined
          }
        />
      </RevealItem>
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
    </Stagger>
  )
}

/** One debounced round trip, last-write-wins so a slow reply cannot land late. */
function useDebouncedCalc(
  args: Parameters<typeof calcManpower>[0],
  ready: boolean,
) {
  const [result, setResult] = useState<ManpowerResult | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const key = JSON.stringify(args)

  useEffect(() => {
    if (!ready) {
      setResult(null)
      return
    }
    const mine = ++seq.current
    setBusy(true)
    const t = setTimeout(() => {
      calcManpower(JSON.parse(key) as Parameters<typeof calcManpower>[0])
        .then((r) => {
          if (mine === seq.current) setResult(r)
        })
        .catch((err) => {
          if (mine === seq.current) {
            setResult(null)
            toast.error('Could not calculate', { description: errText(err) })
          }
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  return { result, busy }
}

function ManpowerResultCard({
  result,
  busy,
  sched,
  linkId,
  onLink,
  onSave,
}: {
  result: ManpowerResult | null
  busy: boolean
  sched: ScheduleActivity[]
  linkId: string
  onLink: (v: string) => void
  onSave?: () => void
}) {
  const [showWorking, setShowWorking] = useState(false)

  if (busy && !result) return <ListSkeleton rows={2} />
  if (!result) return null

  if (!result.ok) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <span className="text-sm">{result.error}</span>
      </div>
    )
  }

  const d = result.detail

  return (
    <div className={cn('paper p-5 transition-opacity', busy && 'opacity-60')}>
      {/* The three figures somebody came here for. */}
      <div className="grid grid-cols-3 gap-3">
        <Headline label="Man-days" value={d.total_man_days} />
        <Headline label="Duration" value={d.duration_days} suffix="days" />
        <Headline label="On site" value={d.people_on_site} suffix="people" />
      </div>

      <ul className="mt-4 divide-y divide-border">
        {result.lines.map((l) => (
          <li key={l.trade} className="flex items-baseline justify-between gap-3 py-2.5">
            <span className="text-sm">
              {l.trade}
              <span className="ml-2 text-xs text-muted-foreground">
                {l.persons_total} on site
              </span>
            </span>
            <span className="shrink-0 font-heading text-lg font-semibold tabular-nums">
              {l.man_days.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                man-days
              </span>
            </span>
          </li>
        ))}
      </ul>

      {d.gangs_for_target !== null && d.target_days !== null && (
        <div className="mt-3 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm">
          To finish in {d.target_days} days you need{' '}
          <span className="font-medium">{d.gangs_for_target} gangs</span>.
        </div>
      )}

      {/* Named on the result, not once in a banner people learn to skip. */}
      {result.warning && (
        <div className="mt-3 flex items-start gap-3 rounded-lg border border-[var(--warning)]/30 bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] px-4 py-3">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-[var(--warning)]"
            aria-hidden="true"
          />
          <span className="text-sm">{result.warning}</span>
        </div>
      )}

      {sched.length > 0 && (
        <div className="mt-4">
          <FieldRow
            label="Plan this against a programme activity"
            htmlFor="mp-link"
            hint="Optional. Linking reports the gap against the dates — it never changes them."
          >
            <Select
              id="mp-link"
              value={linkId}
              onChange={(e) => onLink(e.target.value)}
              className="h-12 text-base"
            >
              <option value="">Not linked</option>
              {sched.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </Select>
          </FieldRow>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setShowWorking((s) => !s)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          <ChevronDown
            className={cn('size-4 transition-transform', showWorking && 'rotate-180')}
            aria-hidden="true"
          />
          {showWorking ? 'Hide working' : 'Show working'}
        </button>
        {onSave && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={onSave}>
            Save to project
          </Button>
        )}
      </div>

      {showWorking && (
        <pre className="mt-3 overflow-x-auto rounded-lg bg-secondary/50 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {result.working}
        </pre>
      )}
    </div>
  )
}

function Headline({
  label,
  value,
  suffix,
}: {
  label: string
  value: number
  suffix?: string
}) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className="mt-0.5 font-heading text-2xl font-semibold tabular-nums">
        {value.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
      </p>
      {suffix && <p className="text-xs text-muted-foreground">{suffix}</p>}
    </div>
  )
}

async function saveFlow(a: {
  projectId: string
  code: string
  qty: number
  gangs: number
  eff: number
  activityId: string | null
  result: ManpowerResult
  setSaving: (b: boolean) => void
}) {
  const title = window.prompt('Save this manpower plan as:', '')
  if (title === null) return
  if (title.trim() === '') {
    toast.error('Give the plan a name')
    return
  }
  a.setSaving(true)
  try {
    await saveManpowerEstimate({
      project_id: a.projectId,
      activity_code: a.code,
      title: title.trim(),
      work_area: '',
      notes: '',
      qty: a.qty,
      gangs: a.gangs,
      efficiency_pct: a.eff,
      activity_id: a.activityId,
      result: a.result,
    })
    toast.success('Plan saved', {
      description: a.result.activity?.verified
        ? undefined
        : 'Recorded as based on an unconfirmed output figure — the saved plan says so.',
    })
  } catch (err) {
    toast.error('Could not save the plan', { description: errText(err) })
  }
  a.setSaving(false)
}

/* ================= saved plans ================= */

export function ManpowerSavedTab({ projectId }: { projectId: string | null }) {
  const [rows, setRows] = useState<SavedManpowerEstimate[] | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setRows(await fetchManpowerEstimates(projectId))
    } catch (err) {
      setRows([])
      toast.error('Could not load saved plans', { description: errText(err) })
    }
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (rows === null) return <ListSkeleton rows={3} />

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={HardHat}
        title="No manpower plans yet"
        body="Work out a gang on the Manpower tab and tap Save to project. A plan linked to a programme activity will then report the gap against its dates, and against what the gangs actually worked."
      />
    )
  }

  return (
    <Stagger className="space-y-4">
      {rows.map((e) => (
        <RevealItem key={e.id}>
          <SavedPlanCard plan={e} onChanged={reload} />
        </RevealItem>
      ))}
    </Stagger>
  )
}

function SavedPlanCard({
  plan: e,
  onChanged,
}: {
  plan: SavedManpowerEstimate
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [vs, setVs] = useState<ManpowerVsSchedule | null>(null)
  const [actual, setActual] = useState<ManpowerVsActual[]>([])

  useEffect(() => {
    if (!e.activity_id) return
    fetchManpowerVsSchedule(e.id).then(setVs).catch(() => setVs(null))
    fetchManpowerVsActual(e.activity_id).then(setActual).catch(() => setActual([]))
  }, [e.id, e.activity_id])

  return (
    <div className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-base font-semibold">{e.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {e.activity_label} · {e.qty} · {e.gangs} gang{e.gangs === 1 ? '' : 's'} ·{' '}
            {e.created_at.slice(0, 10)}
            {e.created_by_name && ` · ${e.created_by_name}`}
          </p>
        </div>
        <button
          type="button"
          onClick={async () => {
            if (!window.confirm(`Delete "${e.title}"?`)) return
            try {
              await deleteManpowerEstimate(e.id)
              toast.success('Deleted')
              await onChanged()
            } catch (err) {
              toast.error('Could not delete it', { description: errText(err) })
            }
          }}
          className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-destructive"
        >
          Delete
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <Headline label="Man-days" value={e.total_man_days} />
        <Headline label="Duration" value={e.duration_days} suffix="days" />
        <Headline label="Gang-days" value={e.gang_days} />
      </div>

      {/* What the figure was worth AT THE TIME — not today's confidence. */}
      {e.from_unverified && (
        <p className="mt-3 text-xs text-[var(--warning)]">
          Planned from an output figure that was unconfirmed when this was saved.
        </p>
      )}

      {vs && (
        <div
          className={cn(
            'mt-4 rounded-lg border px-4 py-3',
            vs.shortfall_days > 0
              ? 'border-destructive/30 bg-destructive/5'
              : 'border-[var(--positive)]/30 bg-[color-mix(in_oklab,var(--positive)_8%,transparent)]',
          )}
        >
          <p className="text-sm">
            <span className="font-medium">{vs.activity_name}</span> allows{' '}
            {vs.days_allowed} days; this gang needs {vs.days_needed}.
            {vs.shortfall_days > 0 ? (
              <>
                {' '}
                <span className="font-medium">
                  Short by {vs.shortfall_days} day{vs.shortfall_days === 1 ? '' : 's'}
                </span>{' '}
                — {vs.gangs_needed} gangs would hold the date.
              </>
            ) : (
              ' There is enough time.'
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Reported only. The programme's dates are set on the Schedule screen.
          </p>
        </div>
      )}

      {actual.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Planned against actually worked
          </p>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
                <th className="pb-1.5 font-medium">Trade</th>
                <th className="pb-1.5 text-right font-medium">Planned</th>
                <th className="pb-1.5 text-right font-medium">Worked</th>
                <th className="pb-1.5 text-right font-medium">Variance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {actual.map((r) => (
                <tr key={r.trade}>
                  <td className="py-2">{r.trade}</td>
                  <td className="py-2 text-right tabular-nums">{r.planned_days}</td>
                  <td className="py-2 text-right tabular-nums">{r.actual_days}</td>
                  <td
                    className={cn(
                      'py-2 text-right font-medium tabular-nums',
                      r.variance_days > 0
                        ? 'text-[var(--warning)]'
                        : 'text-muted-foreground',
                    )}
                  >
                    {r.variance_days > 0 ? '+' : ''}
                    {r.variance_days}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">
            From the attendance register, voided days excluded. A trade with nothing
            planned was worked but never estimated.
          </p>
        </div>
      )}

      {e.working && (
        <>
          <button
            type="button"
            onClick={() => setOpen((s) => !s)}
            className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            <ChevronDown
              className={cn('size-4 transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
            {open ? 'Hide working' : 'Show working as it was computed'}
          </button>
          {open && (
            <pre className="mt-3 overflow-x-auto rounded-lg bg-secondary/50 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {e.working}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

/* ================= the constants, on Reference ================= */

export function LabourConstantsBlock() {
  const role = useAuth((s) => s.role)
  const mayEdit = canEditLabourConstants(role)
  const [acts, setActs] = useState<LabourActivity[] | null>(null)
  const [status, setStatus] = useState<LabourConstantStatus | null>(null)
  const [tests, setTests] = useState<ManpowerSelftestRow[] | null>(null)

  const reload = useCallback(async () => {
    const [a, s, t] = await Promise.allSettled([
      fetchLabourActivities(),
      fetchConstantStatus(),
      runManpowerSelftest(),
    ])
    setActs(a.status === 'fulfilled' ? a.value : [])
    setStatus(s.status === 'fulfilled' ? s.value : null)
    setTests(t.status === 'fulfilled' ? t.value : [])
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const failing = useMemo(() => (tests ?? []).filter((t) => !t.passed).length, [tests])

  if (acts === null) return <ListSkeleton rows={4} />

  return (
    <>
      <RevealItem>
        <div className="paper p-5">
          <h2 className="font-heading text-lg font-semibold">Labour output constants</h2>

          {/* The honest headline. Not a reassurance. */}
          <div className="mt-3 rounded-lg border border-[var(--warning)]/30 bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] px-4 py-3">
            <p className="text-sm">
              <span className="font-medium">
                These are starting figures, not code values.
              </span>{' '}
              Nothing here was taken from IS 7272 — they shipped with the app as a
              reasonable guess so the calculator would work on day one. Replace them with
              your own measured outputs, or with figures from your copy of{' '}
              <span className="font-medium">IS 7272 Part 2 (South zone)</span> — Part 1 is
              the North zone and is the one that circulates freely, so it is the wrong
              half of the country for Bengaluru.
            </p>
            {status && (
              <p className="mt-2 text-sm tabular-nums">
                <span className="font-medium">
                  {status.verified} of {status.total}
                </span>{' '}
                confirmed
                {status.unfilled > 0 && ` · ${status.unfilled} with no figure yet`}
                {status.from_code > 0 && ` · ${status.from_code} cited to a standard`}
              </p>
            )}
          </div>

          {tests && (
            <p className="mt-4 text-sm">
              Arithmetic self-test:{' '}
              <span
                className={cn(
                  'font-heading text-base font-semibold',
                  failing === 0 ? 'text-[var(--positive)]' : 'text-destructive',
                )}
              >
                {tests.length - failing} / {tests.length} passing
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                — checks the division, not the constants. The constants are yours to
                confirm.
              </span>
            </p>
          )}

          <div className="mt-4 space-y-3">
            {acts.map((a) => (
              <ConstantRow key={a.code} a={a} mayEdit={mayEdit} onSaved={reload} />
            ))}
          </div>
        </div>
      </RevealItem>
    </>
  )
}

function ConstantRow({
  a,
  mayEdit,
  onSaved,
}: {
  a: LabourActivity
  mayEdit: boolean
  onSaved: () => Promise<void>
}) {
  const [v, setV] = useState(a.output_per_gang_day?.toString() ?? '')
  const [ref, setRef] = useState(a.is_ref ?? '')
  const [busy, setBusy] = useState(false)

  const dirty =
    (v.trim() === '' ? null : Number(v)) !== a.output_per_gang_day ||
    (ref.trim() || null) !== a.is_ref

  async function save(verified?: boolean) {
    setBusy(true)
    try {
      const out = v.trim() === '' ? null : Number(v)
      await updateLabourActivity(a.code, {
        output_per_gang_day: out,
        is_ref: ref.trim() || null,
        // A row citing a clause IS from a code — `la_is_ref_needed` enforces the
        // other direction, and setting it here keeps the label honest without
        // making somebody pick from a dropdown.
        source: ref.trim() ? 'is_code' : ((a.source === 'is_code' ? 'firm' : a.source) as LabourSource),
        ...(verified === undefined ? {} : { verified }),
      })
      toast.success(
        verified === true
          ? 'Confirmed — results from this no longer carry the warning'
          : verified === false
            ? 'Marked unconfirmed again'
            : 'Saved',
      )
      await onSaved()
    } catch (err) {
      toast.error('Could not update it', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <div className="border-b border-border pb-3 last:border-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {a.label}
            {a.verified ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wider text-[var(--positive)] uppercase">
                <ShieldCheck className="size-3" aria-hidden="true" />
                confirmed
              </span>
            ) : (
              <span className="text-[10px] font-semibold tracking-wider text-[var(--warning)] uppercase">
                unconfirmed
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {a.category} · gang{' '}
            {a.gang.map((g) => `${g.persons} × ${g.trade}`).join(' + ') || '—'}
          </p>
          {a.verified && a.verified_by_name && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Confirmed by {a.verified_by_name} on {a.verified_on}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            value={v}
            disabled={!mayEdit}
            onChange={(e) => setV(e.target.value)}
            className="h-11 w-24 text-right text-base tabular-nums"
            aria-label={`${a.label} output per gang-day`}
            placeholder="—"
          />
          <span className="w-20 text-xs text-muted-foreground">{a.unit}/gang-day</span>
        </div>
      </div>

      {mayEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            className="h-10 flex-1 text-sm"
            placeholder="Clause, e.g. IS 7272 (Part 2) Table 3 — optional"
            aria-label={`Reference for ${a.label}`}
          />
          {dirty && (
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          )}
          <Button
            variant={a.verified ? 'ghost' : 'outline'}
            size="sm"
            disabled={busy || a.output_per_gang_day === null}
            onClick={() => void save(!a.verified)}
          >
            {a.verified ? 'Un-confirm' : 'Confirm this figure'}
          </Button>
        </div>
      )}
    </div>
  )
}
