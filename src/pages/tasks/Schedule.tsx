import {
  CalendarRange,
  Download,
  GitBranch,
  Plus,
  Trash2,
  Wand2,
} from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  evmVerdict,
  formatIndex,
  formatInr,
  INDEX_BG,
  INDEX_TEXT,
  indexBand,
} from '@/lib/format'
import {
  createActivity,
  createDependency,
  deleteActivity,
  deleteDependency,
  fetchActivities,
  fetchActivityEvm,
  fetchActivityFloat,
  fetchDependencies,
  fetchProjectEvm,
  generateSchedule,
  setActivityProgress,
  updateActivity,
} from '@/lib/queries/schedule'
import {
  type ActivityDependency,
  type ActivityEvm,
  type ActivityFloat,
  canEditSchedule,
  canLogProgress,
  canSeeEvm,
  type NewActivityInput,
  type ProjectEvm,
  SCHEDULE_TIGHT_BELOW,
  type ScheduleActivity,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { downloadXlsx, type XlsxCell, type XlsxSheet } from '@/lib/xlsx'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/**
 * Schedule + earned value (B1 / M02).
 *
 * Every number below is computed in Postgres. This file positions bars,
 * chooses colours and writes sentences; it does not do EVM arithmetic, and the
 * one division it performs is a bar's width in percent.
 *
 * The role split is the thing to preserve: a supervisor sees the programme,
 * their progress and the critical path, and `fn_activity_evm` returns them
 * zero rows, so there is no cost figure anywhere on their screen — not even a
 * blank one to wonder about.
 */
export default function Schedule() {
  // Rule 7: the selected project comes from the store, never useOutletContext —
  // that crashed once between RequireRole and the provider.
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  const showEvm = canSeeEvm(role)
  const canEdit = canEditSchedule(role)
  const canProgress = canLogProgress(role)

  const [dataDate, setDataDate] = useState(() => todayIst())
  const [acts, setActs] = useState<ScheduleActivity[] | null>(null)
  const [deps, setDeps] = useState<ActivityDependency[]>([])
  const [floats, setFloats] = useState<ActivityFloat[]>([])
  const [evm, setEvm] = useState<ActivityEvm[]>([])
  const [summary, setSummary] = useState<ProjectEvm | null>(null)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ScheduleActivity | null>(null)
  const [linking, setLinking] = useState(false)
  const [generating, setGenerating] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const rows = await fetchActivities(projectId)
      setActs(rows)

      const ids = rows.map((a) => a.id)
      const [d, f] = await Promise.all([
        fetchDependencies(ids).catch(() => [] as ActivityDependency[]),
        rows.length
          ? fetchActivityFloat(projectId).catch(() => [] as ActivityFloat[])
          : Promise.resolve([] as ActivityFloat[]),
      ])
      setDeps(d)
      setFloats(f)

      if (showEvm && rows.length) {
        const [e, s] = await Promise.all([
          fetchActivityEvm(projectId, dataDate).catch(() => [] as ActivityEvm[]),
          fetchProjectEvm(projectId, dataDate),
        ])
        setEvm(e)
        setSummary(s)
      } else {
        setEvm([])
        setSummary(null)
      }
    } catch (err) {
      toast.error('Could not load the schedule', { description: errText(err) })
      setActs([])
    }
  }, [projectId, dataDate, showEvm])

  useEffect(() => {
    setActs(null)
    void reload()
  }, [reload])

  const floatBy = useMemo(
    () => new Map(floats.map((f) => [f.activity_id, f])),
    [floats],
  )
  const evmBy = useMemo(
    () => new Map(evm.map((e) => [e.activity_id, e])),
    [evm],
  )
  // Distinct phases in schedule order, for the add/edit form's picker.
  const phases = useMemo(() => {
    const seen: string[] = []
    for (const a of acts ?? []) {
      if (a.phase && !seen.includes(a.phase)) seen.push(a.phase)
    }
    return seen
  }, [acts])

  /**
   * The whole programme as a real .xlsx — typed dates, Indian-grouped rupees,
   * frozen header, autofilter, one sheet per concern.
   *
   * Built from what is already on screen, which means it is built from what
   * THIS user is allowed to see. A supervisor's file has no cost columns at
   * all, because `fetchActivityEvm` returned them nothing — an exported file
   * carries no RLS with it, so the filtering has to have happened before the
   * rows reach here.
   */
  async function exportXlsx() {
    if (!acts?.length) {
      toast.error('Nothing to export')
      return
    }

    const nameOf = (id: string) => {
      const a = acts.find((x) => x.id === id)
      return a ? `${a.code} ${a.name}` : '—'
    }

    const schedule: XlsxSheet = {
      name: 'Schedule',
      columns: [
        { header: 'Phase', type: 'text', width: 28 },
        { header: 'Code', type: 'text', width: 9 },
        { header: 'Activity', type: 'text', width: 44 },
        { header: 'Planned start', type: 'date', width: 14 },
        { header: 'Planned finish', type: 'date', width: 14 },
        { header: 'Days', type: 'int', width: 7 },
        { header: '% complete', type: 'percent', width: 11 },
        { header: 'Actual start', type: 'date', width: 14 },
        { header: 'Actual finish', type: 'date', width: 14 },
        { header: 'Float (days)', type: 'int', width: 11 },
        { header: 'Critical', type: 'text', width: 9 },
        ...(showEvm
          ? ([
              { header: 'Budget (BAC)', type: 'money', width: 15 },
              { header: 'Planned value (PV)', type: 'money', width: 16 },
              { header: 'Earned value (EV)', type: 'money', width: 16 },
              { header: 'Actual cost (AC)', type: 'money', width: 16 },
              { header: 'SV', type: 'money', width: 14 },
              { header: 'CV', type: 'money', width: 14 },
              { header: 'SPI', type: 'number', width: 8 },
              { header: 'CPI', type: 'number', width: 8 },
              { header: 'Forecast (EAC)', type: 'money', width: 16 },
            ] as const)
          : []),
      ],
      rows: acts.map((a) => {
        const f = floatBy.get(a.id)
        const e = evmBy.get(a.id)
        const days =
          Math.round(
            (Date.parse(`${a.planned_end}T00:00:00Z`) -
              Date.parse(`${a.planned_start}T00:00:00Z`)) /
              86_400_000,
          ) + 1

        return [
          a.phase ?? 'Other activities',
          a.code,
          a.name,
          a.planned_start,
          a.planned_end,
          days,
          a.pct_complete,
          a.actual_start,
          a.actual_end,
          f?.total_float ?? null,
          f?.is_critical ? 'Yes' : '',
          ...(showEvm
            ? [
                e?.bac ?? 0,
                e?.pv ?? 0,
                e?.ev ?? 0,
                e?.ac ?? 0,
                e?.sv ?? 0,
                e?.cv ?? 0,
                // n/a rather than a misleading zero — the sheet must not
                // imply an index exists where the denominator was zero.
                e?.spi ?? 'n/a',
                e?.cpi ?? 'n/a',
                e?.eac ?? 'n/a',
              ]
            : []),
        ]
      }),
    }

    const sheets: XlsxSheet[] = [schedule, ganttSheet(acts, floatBy, todayIst())]

    if (showEvm && summary) {
      sheets.push({
        name: 'Earned value',
        columns: [
          { header: 'Measure', type: 'text', width: 34 },
          { header: 'Value', type: 'money', width: 18 },
        ],
        rows: [
          ['Data date', summary.data_date],
          ['Activities', summary.activity_count],
          ['Budget at completion (BAC)', summary.bac],
          ['Planned value (PV)', summary.pv],
          ['Earned value (EV)', summary.ev],
          ['Actual cost (AC)', summary.ac],
          ['Schedule variance (SV)', summary.sv],
          ['Cost variance (CV)', summary.cv],
          ['Schedule index (SPI)', summary.spi ?? 'n/a'],
          ['Cost index (CPI)', summary.cpi ?? 'n/a'],
          ['Forecast final cost (EAC)', summary.eac ?? 'n/a'],
          ['Still to spend (ETC)', summary.etc ?? 'n/a'],
          ['Variance at completion (VAC)', summary.vac ?? 'n/a'],
          ['Complete by value', summary.pct_complete ?? 'n/a'],
          ['Read', evmVerdict(summary.spi, summary.cpi)],
        ],
      })
    }

    if (deps.length) {
      sheets.push({
        name: 'Sequence',
        columns: [
          { header: 'After this finishes', type: 'text', width: 46 },
          { header: 'This can start', type: 'text', width: 46 },
          { header: 'Lag (days)', type: 'int', width: 11 },
        ],
        rows: deps.map((d) => [
          nameOf(d.predecessor_id),
          nameOf(d.successor_id),
          d.lag_days,
        ]),
      })
    }

    try {
      await downloadXlsx(
        `mason-os-programme-${todayIst()}`,
        sheets,
      )
      toast.success(`${acts.length} activities exported`, {
        description: showEvm
          ? 'Schedule, earned value and sequence, on three sheets.'
          : 'Opens in Excel. Cost columns are not included for your role.',
      })
    } catch (err) {
      toast.error('Could not build the spreadsheet', {
        description: errText(err),
      })
    }
  }

  if (!projectId || acts === null) return <ListSkeleton rows={5} />

  // No programme yet: the generator IS the empty state. Typing thirty
  // activities by hand before a project starts is what stops anyone having a
  // programme at all.
  if (acts.length === 0) {
    if (!canEdit) {
      return (
        <EmptyState
          icon={CalendarRange}
          title="No programme yet"
          body="Nobody has set out the programme for this project yet."
        />
      )
    }

    return (
      <div className="space-y-4 pb-6">
        <GenerateForm projectId={projectId} onDone={reload} />

        <div className="text-center">
          <button
            type="button"
            onClick={() => setAdding((a) => !a)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {adding ? 'Close' : 'Or add activities one at a time'}
          </button>
        </div>

        {adding && (
          <ActivityForm
            projectId={projectId}
            onDone={async () => {
              setAdding(false)
              await reload()
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4 pb-6">
      {/* The data date drives PV and therefore SPI. Defaults to today; moving
          it back is how you ask "where did we stand at month end". */}
      {showEvm && (
        <div className="flex items-end gap-3">
          <FieldRow label="Data date" htmlFor="evm_date">
            <Input
              id="evm_date"
              type="date"
              value={dataDate}
              onChange={(e) => setDataDate(e.target.value || todayIst())}
              className="h-11 text-base"
            />
          </FieldRow>
          {dataDate !== todayIst() && (
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setDataDate(todayIst())}
            >
              Today
            </Button>
          )}
        </div>
      )}

      {showEvm && summary && <EvmCard evm={summary} />}

      {!showEvm && (
        <p className="rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          Cost figures are restricted for your role. The programme, the critical
          path and progress are all here.
        </p>
      )}

      <Gantt
        acts={acts}
        floatBy={floatBy}
        today={todayIst()}
        dataDate={showEvm ? dataDate : null}
      />

      {/* Available to every role. What differs is the columns: the file is
          built from the rows already on screen, so a supervisor's copy has no
          cost in it — an exported file carries no RLS with it. */}
      <Button
        variant="outline"
        className="h-11 w-full"
        onClick={() => void exportXlsx()}
      >
        <Download className="size-4" aria-hidden="true" />
        Export to Excel
      </Button>

      {canEdit && (
        <div className="flex gap-3">
          <Button className="h-11 flex-1" onClick={() => setAdding((a) => !a)}>
            <Plus className="size-4" aria-hidden="true" />
            {adding ? 'Close' : 'Add activity'}
          </Button>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => setLinking((l) => !l)}
          >
            <GitBranch className="size-4" aria-hidden="true" />
            Links
          </Button>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => setGenerating((g) => !g)}
          >
            <Wand2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      {canEdit && generating && (
        <GenerateForm
          projectId={projectId}
          replacing
          onDone={async () => {
            setGenerating(false)
            await reload()
          }}
        />
      )}

      {adding && (
        <ActivityForm
          projectId={projectId}
          phases={phases}
          onDone={async () => {
            setAdding(false)
            await reload()
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {editing && (
        <ActivityForm
          projectId={projectId}
          activity={editing}
          phases={phases}
          seedBudget={evmBy.get(editing.id)?.bac ?? 0}
          onDone={async () => {
            setEditing(null)
            await reload()
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {canEdit && linking && (
        <DependencyEditor
          acts={acts}
          deps={deps}
          onChanged={reload}
        />
      )}

      {/* A micro schedule is 120+ activities. Flat, that is a wall nobody
          scrolls; grouped by phase and collapsed, it is a table of contents
          you can open at the bit you're working on. */}
      <PhaseList
        acts={acts}
        floatBy={floatBy}
        evmBy={evmBy}
        showEvm={showEvm}
        canEdit={canEdit}
        canProgress={canProgress}
        today={todayIst()}
        onEdit={setEditing}
        onChanged={reload}
      />

      <p className="pt-1 text-xs text-muted-foreground">
        Planned value is straight-line across each activity's dates — nothing
        here models a resource curve, and pretending it did would be false
        precision. An index reads "n/a" when its denominator is zero: an
        activity that has not started has no performance, which is not the same
        as bad performance.
      </p>
    </div>
  )
}

/* ---------------- generate the programme ---------------- */

/**
 * Four inputs, one whole work-breakdown structure.
 *
 * The arithmetic is entirely in `fn_generate_schedule` — this collects dates,
 * floors and plot area, and then reports what came back. The compression figure
 * is the part that matters: the function will happily fit an eighteen-month
 * build into ten months because that is the founder's call, but it says so, and
 * so does this screen. A programme that quietly squashed itself to meet a date
 * would be the most damaging thing this module could produce.
 */
function GenerateForm({
  projectId,
  replacing = false,
  onDone,
}: {
  projectId: string
  replacing?: boolean
  onDone: () => Promise<void>
}) {
  const [start, setStart] = useState(todayIst())
  const [end, setEnd] = useState('')
  const [floors, setFloors] = useState('2')
  const [area, setArea] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()

    if (!end || end <= start) {
      toast.error('The finish date must be after the start date.')
      return
    }
    const f = Number(floors)
    const a = Number(area)
    if (!Number.isInteger(f) || f < 1 || f > 12) {
      toast.error('Floors must be a whole number between 1 and 12.')
      return
    }
    if (!Number.isFinite(a) || a <= 0) {
      toast.error('Enter the plot area in square feet.')
      return
    }

    if (
      replacing &&
      !confirm(
        'Replace the current programme? Every activity and link is rebuilt from these inputs. Any progress recorded against them is lost.',
      )
    ) {
      return
    }

    setBusy(true)
    try {
      const res = await generateSchedule(projectId, {
        start,
        end,
        floors: f,
        plot_area_sqft: a,
        replace: replacing,
      })

      const months = (n: number) => (n / 30.4).toFixed(1)

      if (res.compression < SCHEDULE_TIGHT_BELOW) {
        // Not an error — a warning that outlives the toast, so it is worded as
        // a finding rather than a failure.
        toast.warning(`${res.activities_created} activities — programme is tight`, {
          description: `This size of build normally runs about ${months(res.natural_days)} months; you have allowed ${months(res.target_days)}. Every duration was compressed to fit. Adjust the activities that can't move.`,
          duration: 12_000,
        })
      } else {
        toast.success(`${res.activities_created} activities generated`, {
          description: `${res.links_created} links, ${months(res.target_days)} months. Set each activity's budget to bring earned value to life.`,
        })
      }

      await onDone()
    } catch (err) {
      // The RPC refuses readably — "already has 34 activities", "12 expenses
      // are booked against the current programme".
      toast.error('Could not generate the programme', {
        description: errText(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="paper space-y-5 p-5" noValidate>
      <div>
        <h2 className="font-heading text-[19px] leading-tight font-semibold">
          {replacing ? 'Rebuild the programme' : 'Generate the programme'}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {replacing
            ? 'Same four inputs, from scratch. Refused if any expense or certified bill is tagged to the current activities.'
            : 'Four inputs and the whole work-breakdown structure is laid out — mobilisation, substructure, a cycle per floor, services, finishes, external works, handover.'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Start on site" htmlFor="gen_start">
          <Input
            id="gen_start"
            type="date"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Target handover" htmlFor="gen_end">
          <Input
            id="gen_end"
            type="date"
            required
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow
          label="Floors"
          htmlFor="gen_floors"
          hint="Including ground"
        >
          <Input
            id="gen_floors"
            type="number"
            inputMode="numeric"
            min="1"
            max="12"
            step="1"
            required
            value={floors}
            onChange={(e) => setFloors(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
        <FieldRow label="Plot area (sqft)" htmlFor="gen_area">
          <Input
            id="gen_area"
            type="number"
            inputMode="decimal"
            min="1"
            step="1"
            required
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="2400"
          />
        </FieldRow>
      </div>

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        <Wand2 className="size-4" aria-hidden="true" />
        {busy ? 'Building…' : replacing ? 'Rebuild programme' : 'Generate programme'}
      </Button>

      <p className="text-xs text-muted-foreground">
        Durations come from the plot area and floor count, then stretch or
        compress to land on your handover date. Everything generated is an
        ordinary activity afterwards — rename it, move it, delete it, add your
        own. Budgets stay at zero until you set them, because an auto-split by
        typical percentages would produce SPI and CPI figures that look
        authoritative and are guesses.
      </p>
    </form>
  )
}

/* ---------------- EVM summary ---------------- */

function EvmCard({ evm: e }: { evm: ProjectEvm }) {
  const spiBand = indexBand(e.spi)
  const cpiBand = indexBand(e.cpi)
  const overBudget = e.eac !== null && e.eac > e.bac

  return (
    <section className="paper p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Earned value
        </h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          as at {e.data_date}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-6">
        <Index label="Schedule (SPI)" value={e.spi} band={spiBand} />
        <Index label="Cost (CPI)" value={e.cpi} band={cpiBand} />
      </div>

      <p className="mt-5 text-sm font-medium">{evmVerdict(e.spi, e.cpi)}</p>

      <dl className="mt-5 space-y-1.5 border-t border-border pt-4 text-sm">
        <Line label="Budget (BAC)" value={formatInr(e.bac)} />
        <Line
          label="Planned by now (PV)"
          value={formatInr(e.pv)}
          hint={`${e.activity_count} ${e.activity_count === 1 ? 'activity' : 'activities'}`}
        />
        <Line label="Earned (EV)" value={formatInr(e.ev)} />
        <Line label="Actual cost (AC)" value={formatInr(e.ac)} />
        <Line
          label="Schedule variance (SV)"
          value={formatInr(e.sv)}
          tone={e.sv < 0 ? 'bad' : e.sv > 0 ? 'good' : undefined}
        />
        <Line
          label="Cost variance (CV)"
          value={formatInr(e.cv)}
          tone={e.cv < 0 ? 'bad' : e.cv > 0 ? 'good' : undefined}
        />
      </dl>

      <div className="mt-5 border-t border-border pt-4">
        <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
          Forecast final cost (EAC)
        </p>
        {e.eac === null ? (
          <p className="mt-1.5 text-sm text-muted-foreground">
            n/a — nothing earned or nothing spent yet, so there is no cost
            performance to project forward.
          </p>
        ) : (
          <>
            <p
              className={cn(
                'figure mt-1.5 text-[28px] leading-none font-semibold',
                overBudget ? 'text-destructive' : 'text-[var(--positive)]',
              )}
            >
              {formatInr(e.eac)}
            </p>
            <p
              className={cn(
                'mt-1.5 text-sm',
                overBudget ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {overBudget
                ? `${formatInr(Math.abs(e.vac ?? 0))} over the ${formatInr(e.bac)} budget`
                : `${formatInr(e.vac ?? 0)} under the ${formatInr(e.bac)} budget`}
              {e.etc !== null && ` · ${formatInr(e.etc)} still to spend`}
            </p>
          </>
        )}
      </div>

      {e.pct_complete !== null && (
        <p className="mt-4 text-xs text-muted-foreground">
          {e.pct_complete}% complete by value — physical progress weighted by
          budget, not an average of the percentages.
        </p>
      )}
    </section>
  )
}

function Index({
  label,
  value,
  band,
}: {
  label: string
  value: number | null
  band: ReturnType<typeof indexBand>
}) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'figure mt-1.5 text-[34px] leading-none font-semibold',
          INDEX_TEXT[band],
        )}
      >
        {formatIndex(value)}
      </p>
      <p className={cn('mt-1.5 text-[11px] font-medium', INDEX_TEXT[band])}>
        {band === 'good'
          ? 'On plan'
          : band === 'watch'
            ? 'Watch'
            : band === 'alert'
              ? 'Alert'
              : 'Not measurable'}
      </p>
    </div>
  )
}

function Line({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'good' | 'bad'
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt>
        {label}
        {hint && (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        )}
      </dt>
      <dd
        className={cn(
          'shrink-0 tabular-nums',
          tone === 'bad' && 'font-medium text-destructive',
          tone === 'good' && 'text-[var(--positive)]',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

/* ---------------- Gantt ---------------- */

const DAY_PX = 7

/**
 * Planned bars with a progress overlay, a today line and the critical path
 * picked out.
 *
 * Rendered from server data with two divs per row rather than a charting
 * library: the whole chart is one horizontal scroll on a phone, and a library
 * that assumes a mouse and 1200px would fight that the whole way.
 */
function Gantt({
  acts,
  floatBy,
  today,
  dataDate,
}: {
  acts: ScheduleActivity[]
  floatBy: Map<string, ActivityFloat>
  today: string
  dataDate: string | null
}) {
  const { start, days } = useMemo(() => {
    const starts = acts.map((a) => a.planned_start).sort()
    const ends = acts.map((a) => a.planned_end).sort()
    const s = starts[0] ?? today
    const e = ends[ends.length - 1] ?? today
    return { start: s, days: Math.max(dayDiff(s, e) + 1, 1) }
  }, [acts, today])

  const width = days * DAY_PX
  const offsetOf = (d: string) => dayDiff(start, d) * DAY_PX
  const todayX = offsetOf(today)
  const dataX = dataDate ? offsetOf(dataDate) : null

  return (
    <section className="paper overflow-hidden p-0">
      <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Programme
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {monthLabel(start)} → {monthLabel(acts.map((a) => a.planned_end).sort().slice(-1)[0] ?? start)}
        </span>
      </div>

      {/* Both axes scroll: a micro schedule is 120+ rows, and letting the
          chart run to 4000px tall would bury everything under it. */}
      <div className="mt-4 max-h-[60vh] overflow-auto pb-4">
        <div className="relative" style={{ width: `${width + 16}px` }}>
          {/* Today, and the data date when it differs — one is where we are,
              the other is what the numbers above are measured at. */}
          {todayX >= 0 && todayX <= width && (
            <div
              className="absolute inset-y-0 z-10 w-px bg-destructive/70"
              style={{ left: `${todayX + 8}px` }}
              aria-hidden="true"
            />
          )}
          {dataX !== null && dataX !== todayX && dataX >= 0 && dataX <= width && (
            <div
              className="absolute inset-y-0 z-10 w-px bg-primary/60"
              style={{ left: `${dataX + 8}px` }}
              aria-hidden="true"
            />
          )}

          <ul className="space-y-1.5 px-2">
            {acts.map((a) => {
              const critical = floatBy.get(a.id)?.is_critical ?? false
              const left = offsetOf(a.planned_start)
              const w = Math.max(
                (dayDiff(a.planned_start, a.planned_end) + 1) * DAY_PX,
                4,
              )
              return (
                <li key={a.id} className="relative h-[18px]">
                  <div
                    className={cn(
                      'absolute top-[3px] h-3 overflow-hidden rounded-[2px]',
                      critical ? 'bg-destructive/25' : 'bg-secondary',
                    )}
                    style={{ left: `${left}px`, width: `${w}px` }}
                    title={`${a.code} ${a.name}`}
                  >
                    <div
                      className={cn(
                        'h-full',
                        critical ? 'bg-destructive/70' : 'bg-primary/70',
                      )}
                      style={{ width: `${a.pct_complete}%` }}
                    />
                  </div>
                  {/* The label rides just past its bar, so a phone-width
                      viewport still tells you which row is which. */}
                  <span
                    className="absolute top-0 text-[10px] leading-[18px] whitespace-nowrap text-muted-foreground"
                    style={{ left: `${left + w + 5}px` }}
                  >
                    {a.code}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-5 py-3 text-[11px] text-muted-foreground">
        <Key className="bg-primary/70" label="Progress" />
        <Key className="bg-destructive/70" label="On critical path" />
        <Key className="bg-destructive/70 w-px" label="Today" />
        {dataDate && dataDate !== today && (
          <Key className="bg-primary/60 w-px" label="Data date" />
        )}
      </div>
    </section>
  )
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-block h-2.5 w-3 rounded-sm', className)} />
      {label}
    </span>
  )
}

/* ---------------- phases ---------------- */

/**
 * Groups the activity list by phase, one collapsible section each.
 *
 * `phase` is a label, never a parent row — every activity is a leaf, so nothing
 * here double-counts in earned value. The section header counts finished
 * activities rather than averaging their percentages: "14 of 22 done" is a fact,
 * an averaged percentage across activities of wildly different size is not.
 *
 * The phase containing today opens by default. Everything else stays shut,
 * which is the difference between a usable screen and 140 stacked cards.
 */
function PhaseList({
  acts,
  floatBy,
  evmBy,
  showEvm,
  canEdit,
  canProgress,
  today,
  onEdit,
  onChanged,
}: {
  acts: ScheduleActivity[]
  floatBy: Map<string, ActivityFloat>
  evmBy: Map<string, ActivityEvm>
  showEvm: boolean
  canEdit: boolean
  canProgress: boolean
  today: string
  onEdit: (a: ScheduleActivity) => void
  onChanged: () => Promise<void>
}) {
  const groups = useMemo(() => {
    const out: { phase: string; items: ScheduleActivity[] }[] = []
    for (const a of acts) {
      const phase = a.phase ?? 'Other activities'
      const last = out[out.length - 1]
      if (last && last.phase === phase) last.items.push(a)
      else out.push({ phase, items: [a] })
    }
    return out
  }, [acts])

  const liveIndex = useMemo(() => {
    const i = groups.findIndex((g) =>
      g.items.some((a) => a.planned_start <= today && a.planned_end >= today),
    )
    // Nothing in progress: fall back to the first phase with work outstanding,
    // which before the start date is simply the first phase.
    if (i >= 0) return i
    return Math.max(
      0,
      groups.findIndex((g) => g.items.some((a) => a.pct_complete < 100)),
    )
  }, [groups, today])

  const [open, setOpen] = useState<Set<string>>(new Set())
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (touched) return
    const g = groups[liveIndex]
    if (g) setOpen(new Set([g.phase]))
  }, [groups, liveIndex, touched])

  function toggle(phase: string) {
    setTouched(true)
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(phase)) next.delete(phase)
      else next.add(phase)
      return next
    })
  }

  return (
    <div className="space-y-2.5">
      {groups.map((g) => {
        const isOpen = open.has(g.phase)
        const done = g.items.filter((a) => a.pct_complete >= 100).length
        const started = g.items.filter((a) => a.pct_complete > 0).length
        const critical = g.items.some((a) => floatBy.get(a.id)?.is_critical)

        return (
          <section key={g.phase}>
            <button
              type="button"
              onClick={() => toggle(g.phase)}
              aria-expanded={isOpen}
              className={cn(
                'paper flex w-full items-center gap-3 p-4 text-left',
                isOpen && 'rounded-b-none',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'shrink-0 text-muted-foreground transition-transform',
                  isOpen && 'rotate-90',
                )}
              >
                ›
              </span>

              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{g.phase}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                  {g.items[0].planned_start} → {g.items[g.items.length - 1].planned_end}
                  {critical && ' · on critical path'}
                </span>
              </span>

              <span className="shrink-0 text-right">
                <span className="block text-sm font-medium tabular-nums">
                  {done}/{g.items.length}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {done === g.items.length
                    ? 'complete'
                    : started > done
                      ? 'in progress'
                      : 'done'}
                </span>
              </span>
            </button>

            {isOpen && (
              <Stagger className="space-y-2.5 border-t border-border pt-2.5">
                {g.items.map((a) => (
                  <RevealItem key={a.id}>
                    <ActivityCard
                      act={a}
                      flt={floatBy.get(a.id)}
                      evm={evmBy.get(a.id)}
                      showEvm={showEvm}
                      canEdit={canEdit}
                      canProgress={canProgress}
                      onEdit={() => onEdit(a)}
                      onChanged={onChanged}
                    />
                  </RevealItem>
                ))}
              </Stagger>
            )}
          </section>
        )
      })}
    </div>
  )
}

/* ---------------- one activity ---------------- */

function ActivityCard({
  act: a,
  flt,
  evm: e,
  showEvm,
  canEdit,
  canProgress,
  onEdit,
  onChanged,
}: {
  act: ScheduleActivity
  flt?: ActivityFloat
  evm?: ActivityEvm
  showEvm: boolean
  canEdit: boolean
  canProgress: boolean
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const [pct, setPct] = useState(String(a.pct_complete))
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => setPct(String(a.pct_complete)), [a.pct_complete])

  const dirty = Number(pct) !== a.pct_complete

  async function saveProgress() {
    const n = Number(pct)
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      toast.error('Progress must be between 0 and 100.')
      return
    }
    setSaving(true)
    try {
      await setActivityProgress(a.id, n)
      toast.success(`${a.code} at ${n}%`)
      await onChanged()
    } catch (err) {
      toast.error('Could not save progress', { description: errText(err) })
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!confirm(`Remove "${a.name}" from the programme?`)) return
    try {
      await deleteActivity(a.id)
      toast.success('Activity removed')
      await onChanged()
    } catch (err) {
      // The RPC names what is in the way — a live expense, a certified bill.
      toast.error('Could not remove that activity', {
        description: errText(err),
      })
    }
  }

  return (
    <article className="paper p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            <span className="text-muted-foreground">{a.code}</span> {a.name}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {a.planned_start} → {a.planned_end}
            {a.planned_qty !== null &&
              ` · ${a.planned_qty}${a.qty_unit ? ` ${a.qty_unit}` : ''}`}
          </p>
          {flt?.is_critical && (
            <span className="mt-1.5 inline-block rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-destructive uppercase">
              Critical path
            </span>
          )}
          {flt && !flt.is_critical && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {flt.total_float} day{flt.total_float === 1 ? '' : 's'} of float
            </p>
          )}
        </div>

        {showEvm && e && (
          <div className="shrink-0 text-right">
            <p className="text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
              SPI · CPI
            </p>
            <p className="mt-1 text-sm font-medium tabular-nums">
              <span className={INDEX_TEXT[indexBand(e.spi)]}>
                {formatIndex(e.spi)}
              </span>
              <span className="text-muted-foreground"> · </span>
              <span className={INDEX_TEXT[indexBand(e.cpi)]}>
                {formatIndex(e.cpi)}
              </span>
            </p>
          </div>
        )}
      </div>

      {/* Planned versus actual progress in one bar: the tick is where the plan
          says we should be, the fill is where we are. */}
      <div className="relative mt-3 h-[6px] w-full overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            INDEX_BG[showEvm && e ? indexBand(e.spi) : 'na'],
          )}
          style={{ width: `${a.pct_complete}%` }}
        />
        {showEvm && e && (
          <div
            className="absolute inset-y-0 w-px bg-foreground/50"
            style={{ left: `${Math.min(e.planned_pct, 100)}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
        {a.pct_complete}% done
        {showEvm && e && ` · ${e.planned_pct}% planned by the data date`}
      </p>

      {canProgress && (
        <div className="mt-3 flex items-center gap-2">
          <Input
            type="number"
            min="0"
            max="100"
            step="1"
            inputMode="numeric"
            value={pct}
            onChange={(ev) => setPct(ev.target.value)}
            className="h-11 w-24 text-base tabular-nums"
            aria-label={`Progress for ${a.code}`}
          />
          <Button
            className="h-11"
            disabled={saving || !dirty}
            onClick={() => void saveProgress()}
          >
            {saving ? 'Saving…' : 'Update %'}
          </Button>
          {showEvm && e && (
            <Button
              variant="ghost"
              className="ml-auto h-11"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Hide' : 'Cost'}
            </Button>
          )}
        </div>
      )}

      {showEvm && e && open && (
        <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
          <Line label="Budget (BAC)" value={formatInr(e.bac)} />
          <Line label="Planned (PV)" value={formatInr(e.pv)} />
          <Line label="Earned (EV)" value={formatInr(e.ev)} />
          <Line label="Actual (AC)" value={formatInr(e.ac)} />
          <Line
            label="Cost variance (CV)"
            value={formatInr(e.cv)}
            tone={e.cv < 0 ? 'bad' : undefined}
          />
          <Line
            label="Forecast (EAC)"
            value={e.eac === null ? 'n/a' : formatInr(e.eac)}
            tone={e.eac !== null && e.eac > e.bac ? 'bad' : undefined}
          />
        </dl>
      )}

      {canEdit && (
        <div className="mt-3 flex gap-2 border-t border-border pt-3">
          <Button variant="outline" className="h-10 flex-1" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="ghost"
            className="h-10 text-destructive"
            onClick={() => void remove()}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </article>
  )
}

/* ---------------- dependencies ---------------- */

function DependencyEditor({
  acts,
  deps,
  onChanged,
}: {
  acts: ScheduleActivity[]
  deps: ActivityDependency[]
  onChanged: () => Promise<void>
}) {
  const [pred, setPred] = useState('')
  const [succ, setSucc] = useState('')
  const [lag, setLag] = useState('0')
  const [busy, setBusy] = useState(false)

  const nameOf = (id: string) => {
    const a = acts.find((x) => x.id === id)
    return a ? `${a.code} ${a.name}` : '—'
  }

  async function add() {
    if (!pred || !succ) {
      toast.error('Pick both activities.')
      return
    }
    if (pred === succ) {
      toast.error('An activity cannot follow itself.')
      return
    }
    setBusy(true)
    try {
      await createDependency(pred, succ, Number(lag) || 0)
      toast.success('Link added')
      setPred('')
      setSucc('')
      setLag('0')
      await onChanged()
    } catch (err) {
      // The cycle trigger explains itself; surface it as-is.
      toast.error('Could not add that link', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="paper space-y-4 p-5">
      <div>
        <h3 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Sequence
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Finish-to-start: the successor cannot begin until the predecessor
          finishes. Lag in days — negative overlaps them.
        </p>
      </div>

      <FieldRow label="After this finishes" htmlFor="dep_pred">
        <Select
          id="dep_pred"
          value={pred}
          onChange={(e) => setPred(e.target.value)}
        >
          <option value="">Select…</option>
          {acts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </Select>
      </FieldRow>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <FieldRow label="This can start" htmlFor="dep_succ">
          <Select
            id="dep_succ"
            value={succ}
            onChange={(e) => setSucc(e.target.value)}
          >
            <option value="">Select…</option>
            {acts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </FieldRow>

        <FieldRow label="Lag" htmlFor="dep_lag">
          <Input
            id="dep_lag"
            type="number"
            step="1"
            value={lag}
            onChange={(e) => setLag(e.target.value)}
            className="h-12 w-20 text-base tabular-nums"
          />
        </FieldRow>
      </div>

      <Button className="h-11 w-full" disabled={busy} onClick={() => void add()}>
        {busy ? 'Adding…' : 'Add link'}
      </Button>

      {deps.length === 0 ? (
        <p className="pt-1 text-xs text-muted-foreground">
          No links yet — without them every activity floats free and the
          critical path is just the longest bar.
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {deps.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 py-2.5 text-sm"
            >
              <span className="min-w-0 truncate">
                {nameOf(d.predecessor_id)}{' '}
                <span className="text-muted-foreground">→</span>{' '}
                {nameOf(d.successor_id)}
                {d.lag_days !== 0 && (
                  <span className="text-muted-foreground">
                    {' '}
                    ({d.lag_days > 0 ? '+' : ''}
                    {d.lag_days}d)
                  </span>
                )}
              </span>
              <Button
                variant="ghost"
                className="h-9 shrink-0 px-2 text-xs text-destructive"
                onClick={() =>
                  void deleteDependency(d.id)
                    .then(async () => {
                      toast.success('Link removed')
                      await onChanged()
                    })
                    .catch((err) =>
                      toast.error('Could not remove that link', {
                        description: errText(err),
                      }),
                    )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ---------------- add / edit ---------------- */

function ActivityForm({
  projectId,
  activity,
  phases = [],
  seedBudget = 0,
  onDone,
  onCancel,
}: {
  projectId: string
  activity?: ScheduleActivity
  /** existing phases, so a hand-added activity joins a group rather than
      landing alone under "Other activities" at the bottom */
  phases?: string[]
  /**
   * The budget cannot be read back from the table — 042 revoked the column —
   * so an edit seeds it from the EVM row, which is role-gated anyway. Leaving
   * it blank would silently zero a budget on every edit.
   */
  seedBudget?: number
  onDone: () => void | Promise<void>
  onCancel: () => void
}) {
  const [code, setCode] = useState(activity?.code ?? '')
  const [name, setName] = useState(activity?.name ?? '')
  const [start, setStart] = useState(activity?.planned_start ?? todayIst())
  const [end, setEnd] = useState(activity?.planned_end ?? todayIst())
  const [budget, setBudget] = useState(
    activity ? String(seedBudget) : '',
  )
  const [qty, setQty] = useState(
    activity?.planned_qty !== null && activity?.planned_qty !== undefined
      ? String(activity.planned_qty)
      : '',
  )
  const [unit, setUnit] = useState(activity?.qty_unit ?? '')
  const [notes, setNotes] = useState(activity?.notes ?? '')
  const [phase, setPhase] = useState(activity?.phase ?? '')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()

    if (!code.trim() || !name.trim()) {
      toast.error('A code and a name, please.')
      return
    }
    if (end < start) {
      toast.error('The finish cannot be before the start.')
      return
    }
    const b = budget === '' ? 0 : Number(budget)
    if (!Number.isFinite(b) || b < 0) {
      toast.error('Budget cannot be negative.')
      return
    }

    const input: NewActivityInput = {
      code,
      name,
      planned_start: start,
      planned_end: end,
      budget_amount: b,
      planned_qty: qty === '' ? null : Number(qty),
      qty_unit: unit,
      notes,
      phase,
    }

    setBusy(true)
    try {
      if (activity) {
        await updateActivity(activity.id, input)
        toast.success('Activity updated')
      } else {
        await createActivity(projectId, input)
        toast.success('Activity added')
      }
      await onDone()
    } catch (err) {
      const msg = errText(err) ?? ''
      toast.error('Could not save that activity', {
        description: /duplicate|unique/i.test(msg)
          ? 'Another activity on this project already uses that code.'
          : msg,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="paper space-y-5 p-5" noValidate>
      <div className="grid grid-cols-[5rem_1fr] gap-3">
        <FieldRow label="Code" htmlFor="act_code">
          <Input
            id="act_code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="h-12 text-base"
            placeholder="2.1"
          />
        </FieldRow>
        <FieldRow label="Activity" htmlFor="act_name">
          <Input
            id="act_name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-12 text-base"
            placeholder="Ground floor slab"
          />
        </FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Planned start" htmlFor="act_start">
          <Input
            id="act_start"
            type="date"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Planned finish" htmlFor="act_end">
          <Input
            id="act_end"
            type="date"
            required
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      {phases.length > 0 && (
        <FieldRow label="Phase" htmlFor="act_phase">
          <Select
            id="act_phase"
            value={phase}
            onChange={(e) => setPhase(e.target.value)}
          >
            <option value="">Other activities</option>
            {phases.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </FieldRow>
      )}

      <FieldRow
        label="Budget (₹)"
        htmlFor="act_budget"
        hint="This activity's share of cost — the BAC that earned value is measured against."
      >
        <Input
          id="act_budget"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          className="h-12 text-base tabular-nums"
          placeholder="0.00"
        />
      </FieldRow>

      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <FieldRow label="Planned quantity" htmlFor="act_qty">
          <Input
            id="act_qty"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="Optional"
          />
        </FieldRow>
        <FieldRow label="Unit" htmlFor="act_unit">
          <Input
            id="act_unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="h-12 text-base"
            placeholder="sqft"
          />
        </FieldRow>
      </div>

      <FieldRow label="Notes" htmlFor="act_notes">
        <Textarea
          id="act_notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Scope, method, anything the next person needs"
        />
      </FieldRow>

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Saving…' : activity ? 'Save changes' : 'Add activity'}
        </Button>
        <Button type="button" variant="ghost" className="h-12" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/* ---------------- the Gantt, as a sheet ---------------- */

/**
 * The chart, drawn out of filled cells — one column per week.
 *
 * Deliberately NOT a picture of the on-screen Gantt. A PNG in a spreadsheet is
 * a screenshot: it will not print at the right size, it cannot be re-sorted,
 * and it is stale the moment a date moves. Filled cells are native Excel — the
 * bar prints, survives a column being widened, and a planner can drag it.
 *
 * A week per column rather than a day: a 15-month programme is 65 week columns
 * and 456 day columns. Excel copes with either; a person does not.
 *
 * The completed portion of each bar is filled solid brass (or danger red on the
 * critical path), the remainder in the pale tint — the same reading as the
 * screen, so the two are not two different charts.
 */
function ganttSheet(
  acts: ScheduleActivity[],
  floatBy: Map<string, ActivityFloat>,
  today: string,
): XlsxSheet {
  const starts = acts.map((a) => a.planned_start).sort()
  const ends = acts.map((a) => a.planned_end).sort()
  const first = starts[0] ?? today
  const last = ends[ends.length - 1] ?? today

  // Weeks start on the project's first day, not on a Monday: the grid then
  // lines up with the programme rather than with a calendar nobody set.
  const weekCount = Math.max(1, Math.ceil((dayDiff(first, last) + 1) / 7))
  const weekStart = (w: number) => addDays(first, w * 7)

  const todayWeek =
    today >= first && today <= addDays(first, weekCount * 7 - 1)
      ? Math.floor(dayDiff(first, today) / 7)
      : -1

  const LABEL_COLS = 4

  const columns: XlsxSheet['columns'] = [
    { header: 'Code', type: 'text', width: 9 },
    { header: 'Activity', type: 'text', width: 42 },
    { header: 'Start', type: 'date', width: 12 },
    { header: 'Finish', type: 'date', width: 12 },
    ...Array.from({ length: weekCount }, (_, w) => ({
      header: shortDate(weekStart(w)),
      type: 'text' as const,
      width: 6,
      // The week containing today, marked in the header rather than as a
      // vertical line — a spreadsheet has no vertical lines.
      ...(w === todayWeek ? { headerFill: 'today' as const } : {}),
    })),
  ]

  const rows: XlsxCell[][] = acts.map((a) => {
    const critical = floatBy.get(a.id)?.is_critical ?? false

    // Where the bar's completed portion ends, in days from its own start.
    const span = dayDiff(a.planned_start, a.planned_end) + 1
    const doneDays = Math.round((span * a.pct_complete) / 100)
    const doneUntil = addDays(a.planned_start, doneDays - 1)

    const bars: XlsxCell[] = Array.from({ length: weekCount }, (_, w) => {
      const ws = weekStart(w)
      const we = addDays(ws, 6)
      // Does this week overlap the activity at all?
      if (we < a.planned_start || ws > a.planned_end) return null

      const done = doneDays > 0 && ws <= doneUntil
      const fill = critical
        ? done
          ? ('barCriticalDone' as const)
          : ('barCritical' as const)
        : done
          ? ('barDone' as const)
          : ('bar' as const)

      return { v: null, fill }
    })

    return [a.code, a.name, a.planned_start, a.planned_end, ...bars]
  })

  // A legend, two rows below the bars. Without it the colours are decoration.
  const pad = (cells: XlsxCell[]): XlsxCell[] => [
    ...cells,
    ...Array.from({ length: weekCount - 1 }, () => null),
  ]
  rows.push([])
  rows.push(pad([null, 'Legend', null, null, { v: null, fill: 'barDone' }]))
  rows.push(pad([null, 'Complete', null, null, { v: null, fill: 'bar' }]))
  rows.push(
    pad([null, 'Remaining', null, null, { v: null, fill: 'barCriticalDone' }]),
  )
  rows.push(
    pad([
      null,
      'On the critical path',
      null,
      null,
      { v: null, fill: 'today' },
    ]),
  )
  rows.push(pad([null, `Week containing ${today}`, null, null, null]))

  return { name: 'Gantt', columns, rows, freezeCols: LABEL_COLS }
}

/* ---------------- dates ---------------- */

function addDays(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(t)) return iso
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10)
}

/** "07/04" — compact enough for a 6-character column header. */
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** Whole days between two ISO dates, both parsed as UTC so DST cannot shift them. */
function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

function monthLabel(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleDateString('en-IN', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
