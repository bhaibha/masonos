import { Download, History } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { Select } from '@/components/Field'
import { useSelectedProjectName } from '@/components/ProjectPicker'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { downloadCsv, toCsv } from '@/lib/csv'
import { errText } from '@/lib/errText'
import {
  type ChecklistHistoryRow,
  type DocHistoryRow,
  fetchChecklistHistory,
  fetchIncidentHistory,
  fetchInspectionHistory,
  fetchNcrHistory,
  fetchRfiHistory,
  fetchScheduleEvents,
  fetchSiHistory,
  fetchSiteLogHistory,
  fetchSnagHistory,
  fetchVisitHistory,
  type IncidentHistoryRow,
  type InspectionHistoryRow,
  type ScheduleEventRow,
  type SiteLogHistoryRow,
} from '@/lib/queries/history'
import { fetchAttendanceRange, fetchLabourEffort } from '@/lib/queries/labour'
import { fetchTaskHistory } from '@/lib/queries/tasks'
import {
  type AttendanceRow,
  INCIDENT_TYPE_LABEL,
  type LabourEffortRow,
  SAFETY_ITEMS,
  TASK_STATUS_LABEL,
  type TaskRow,
  type TaskStatus,
  TRADES,
  VISIT_TYPE_LABEL,
  type VisitType,
} from '@/lib/types'
import { addDays, todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useProjects } from '@/store/project'

type Section =
  | 'tasks'
  | 'logs'
  | 'labour'
  | 'schedule'
  | 'safety'
  | 'incidents'
  | 'quality'
  | 'instructions'
  | 'rfis'
  | 'snags'
  | 'visits'

const SECTION_LABEL: Record<Section, string> = {
  tasks: 'Tasks',
  logs: 'Site logs',
  labour: 'Labour',
  schedule: 'Schedule',
  safety: 'Safety',
  incidents: 'Incidents',
  quality: 'Quality',
  instructions: 'Instructions',
  rfis: 'RFIs',
  snags: 'Snags',
  visits: 'Site visits',
}

/**
 * Bar schedule is deliberately ABSENT. A BBS is a specification a bar bender
 * cuts to, not something that happened on a date — putting it in a
 * "what happened between these dates" screen would file a drawing under events.
 */
const SECTIONS: Section[] = [
  'tasks', 'logs', 'labour', 'schedule', 'safety', 'incidents',
  'quality', 'instructions', 'rfis', 'snags', 'visits',
]

const STATUS_TONE: Record<TaskStatus, string> = {
  done: 'text-[var(--positive)]',
  partial: 'text-[var(--warning)]',
  not_done: 'text-destructive',
  pending: 'text-muted-foreground',
}

/**
 * What happened on this project between two dates — tasks, daily site logs,
 * safety checks and incidents — each as a grid you can read like a sheet and
 * export to Excel.
 *
 * One date range drives all three sections, because the question people
 * actually ask is "what happened in July", not "what tasks happened in July".
 */
export default function TaskHistory() {
  const projectId = useProjects((s) => s.selectedId)
  const projectName = useSelectedProjectName()

  const [section, setSection] = useState<Section>('tasks')
  const [from, setFrom] = useState(addDays(todayIst(), -30))
  const [to, setTo] = useState(todayIst())

  const [tasks, setTasks] = useState<TaskRow[] | null>(null)
  const [logs, setLogs] = useState<SiteLogHistoryRow[] | null>(null)
  const [checks, setChecks] = useState<ChecklistHistoryRow[] | null>(null)
  const [incidents, setIncidents] = useState<IncidentHistoryRow[] | null>(null)
  const [sis, setSis] = useState<DocHistoryRow[] | null>(null)
  const [rfis, setRfis] = useState<DocHistoryRow[] | null>(null)
  const [snags, setSnags] = useState<DocHistoryRow[] | null>(null)
  const [visits, setVisits] = useState<DocHistoryRow[] | null>(null)
  const [ncrs, setNcrs] = useState<DocHistoryRow[] | null>(null)
  const [inspections, setInspections] = useState<InspectionHistoryRow[] | null>(null)
  const [schedule, setSchedule] = useState<ScheduleEventRow[] | null>(null)
  // Two shapes for one question: the roll-up somebody checks against a
  // contractor's invoice, and the day-by-day muster roll behind it.
  const [effort, setEffort] = useState<LabourEffortRow[] | null>(null)
  const [muster, setMuster] = useState<AttendanceRow[] | null>(null)

  const [status, setStatus] = useState<TaskStatus | ''>('')
  const [trade, setTrade] = useState('')

  const reload = useCallback(async () => {
    if (!projectId) return
    if (from > to) {
      toast.error('The start date is after the end date')
      return
    }

    setTasks(null)
    setLogs(null)
    setChecks(null)
    setIncidents(null)
    setSis(null)
    setRfis(null)
    setSnags(null)
    setVisits(null)
    setNcrs(null)
    setInspections(null)
    setSchedule(null)
    setEffort(null)
    setMuster(null)

    try {
      const [t, l, c, i, s, r, g, v, n, q, sch, e, m] = await Promise.all([
        fetchTaskHistory(projectId, from, to),
        fetchSiteLogHistory(projectId, from, to),
        fetchChecklistHistory(projectId, from, to),
        fetchIncidentHistory(projectId, from, to),
        fetchSiHistory(projectId, from, to),
        fetchRfiHistory(projectId, from, to),
        fetchSnagHistory(projectId, from, to),
        // Same degrade-to-empty treatment the labour pair already gets: these
        // arrived in later migrations, and one unrun migration must not take
        // the whole screen down with it (the 056 rule).
        fetchVisitHistory(projectId, from, to).catch(() => [] as DocHistoryRow[]),
        fetchNcrHistory(projectId, from, to).catch(() => [] as DocHistoryRow[]),
        fetchInspectionHistory(projectId, from, to).catch(
          () => [] as InspectionHistoryRow[],
        ),
        fetchScheduleEvents(projectId, from, to).catch(
          () => [] as ScheduleEventRow[],
        ),
        // Labour arrived with migration 054/055. If they have not been run the
        // rest of History must still work, so these two degrade to empty rather
        // than taking the whole screen down with them.
        fetchLabourEffort(projectId, from, to).catch(() => [] as LabourEffortRow[]),
        fetchAttendanceRange(projectId, from, to).catch(() => [] as AttendanceRow[]),
      ])
      setTasks(t)
      setLogs(l)
      setChecks(c)
      setIncidents(i)
      setSis(s)
      setRfis(r)
      setSnags(g)
      setVisits(v)
      setNcrs(n)
      setInspections(q)
      setSchedule(sch)
      setEffort(e)
      setMuster(m.filter((x) => x.voided_at === null))
    } catch (err) {
      toast.error('Could not load history', { description: errText(err) })
      setTasks([])
      setLogs([])
      setChecks([])
      setIncidents([])
      setSis([])
      setRfis([])
      setSnags([])
      setVisits([])
      setNcrs([])
      setInspections([])
      setSchedule([])
      setEffort([])
      setMuster([])
    }
  }, [projectId, from, to])

  useEffect(() => {
    void reload()
  }, [reload])

  const shownTasks = useMemo(
    () =>
      tasks?.filter(
        (t) =>
          (status === '' || t.status === status) &&
          (trade === '' || t.trade === trade),
      ) ?? null,
    [tasks, status, trade],
  )

  const taskDays = useMemo(() => groupBy(shownTasks, (t) => t.planned_date), [
    shownTasks,
  ])

  const stamp = `${from}-to-${to}`
  const base = projectName ?? 'project'

  function exportTasks() {
    if (!shownTasks?.length) return toast.error('Nothing to export in this range')
    downloadCsv(
      `${base}-tasks-${stamp}`,
      toCsv(
        ['Date', 'Task', 'Trade', 'Work area', 'Status', 'Target qty', 'Unit',
         'Done qty', 'Reason if not done', 'Rolled over from'],
        shownTasks.map((t) => [
          t.planned_date, t.title, t.trade ?? '', t.work_area ?? '',
          TASK_STATUS_LABEL[t.status], t.target_qty ?? '', t.qty_unit ?? '',
          t.done_qty ?? '', t.not_done_reason ?? '', t.rolled_from_date ?? '',
        ]),
      ),
    )
    toast.success(`${shownTasks.length} rows exported`)
  }

  function exportLogs() {
    if (!logs?.length) return toast.error('Nothing to export in this range')
    downloadCsv(
      `${base}-site-logs-${stamp}`,
      toCsv(
        ['Date', 'Weather', 'Masons', 'Helpers', 'Other', 'Total labour',
         'Work summary', 'Issues', 'Photos', 'Logged by'],
        logs.map((l) => [
          l.log_date, l.weather ?? '', l.labour_mason, l.labour_helper,
          l.labour_other, l.labour_total, l.work_summary ?? '', l.issues ?? '',
          l.photos.length, l.created_by_name ?? '',
        ]),
      ),
    )
    toast.success(`${logs.length} rows exported`)
  }

  function exportSafety() {
    if (!checks?.length && !incidents?.length)
      return toast.error('Nothing to export in this range')

    if (checks?.length) {
      downloadCsv(
        `${base}-safety-checks-${stamp}`,
        toCsv(
          ['Date', ...SAFETY_ITEMS.map((i) => i.label), 'Pass', 'Fail', 'N/A',
           'Checked by', 'Remarks'],
          checks.map((c) => [
            c.check_date,
            ...SAFETY_ITEMS.map((i) => resultLabel(c.results[i.key])),
            c.pass, c.fail, c.na, c.created_by_name ?? '',
            Object.entries(c.remarks)
              .map(([k, v]) => `${labelFor(k)}: ${v}`)
              .join(' | '),
          ]),
        ),
      )
    }

    if (incidents?.length) {
      downloadCsv(
        `${base}-incidents-${stamp}`,
        toCsv(
          ['When', 'Type', 'Description', 'People involved', 'Immediate action',
           'Status', 'Photos', 'Reported by'],
          incidents.map((i) => [
            i.occurred_at.slice(0, 16).replace('T', ' '),
            INCIDENT_TYPE_LABEL[i.incident_type], i.description,
            i.people_involved ?? '', i.immediate_action ?? '', i.status,
            i.photo_count, i.created_by_name ?? '',
          ]),
        ),
      )
    }

    toast.success('Exported', {
      description:
        checks?.length && incidents?.length
          ? 'Two files — checks and incidents.'
          : undefined,
    })
  }

  function exportLabour() {
    if (!muster?.length) return toast.error('Nothing to export in this range')

    // The muster roll — one row per gang per day, which is the register itself.
    downloadCsv(
      `${base}-muster-roll-${stamp}`,
      toCsv(
        ['Date', 'Contractor', 'Licence no', 'Trade', 'Workers present',
         'Overtime hours', 'Work area', 'Remarks'],
        muster.map((m) => [
          m.work_date, m.contractor_name, m.licence_no ?? '', m.trade,
          m.workers_present, m.overtime_hours, m.work_area ?? '',
          m.remarks ?? '',
        ]),
      ),
    )

    // The roll-up, as a second file — the figure that gets checked against a
    // contractor's invoice. Both carry effort only; no rate, no cost.
    if (effort?.length) {
      downloadCsv(
        `${base}-labour-summary-${stamp}`,
        toCsv(
          ['Contractor', 'Trade', 'Days worked', 'Mandays', 'Overtime hours',
           'Peak workers in a day'],
          effort.map((e) => [
            e.contractor_name, e.trade, e.days_worked, e.mandays, e.ot_hours,
            e.peak_workers,
          ]),
        ),
      )
    }

    toast.success('Exported', {
      description: effort?.length
        ? 'Two files — the muster roll and the summary.'
        : undefined,
    })
  }

  /** The three document sections share a shape, so they share a renderer. */
  const docRows: DocHistoryRow[] | null =
    section === 'instructions'
      ? sis
      : section === 'rfis'
        ? rfis
        : section === 'snags'
          ? snags
          : section === 'visits'
            ? visits
            : null

  function exportSchedule() {
    if (!schedule?.length) return toast.error('Nothing to export in this range')
    downloadCsv(
      `${base}-schedule-events-${stamp}`,
      toCsv(
        ['Date', 'Event', 'Code', 'Activity', 'Phase', 'Planned start',
         'Planned end', 'Variance (days)', 'Progress now %'],
        schedule.map((e) => [
          e.date, e.event === 'started' ? 'Started' : 'Finished', e.code, e.name,
          e.phase ?? '', e.planned_start, e.planned_end, e.variance_days,
          e.pct_complete,
        ]),
      ),
    )
    toast.success(`${schedule.length} rows exported`)
  }

  function exportQuality() {
    if (!inspections?.length && !ncrs?.length)
      return toast.error('Nothing to export in this range')

    if (inspections?.length) {
      downloadCsv(
        `${base}-site-observations-${stamp}`,
        toCsv(
          ['Date', 'Location', 'Observation', 'Priority', 'Raised for',
           'Photos', 'Became a task', 'Raised by'],
          inspections.map((i) => [
            i.observed_on, i.location, i.comment, i.priority, i.raised_for ?? '',
            i.photo_count, i.became_task ? 'Yes' : 'No', i.raised_by_name ?? '',
          ]),
        ),
      )
    }

    if (ncrs?.length) {
      downloadCsv(
        `${base}-ncrs-${stamp}`,
        toCsv(
          ['NCR no.', 'Raised', 'Area', 'Description', 'Status', 'Assigned to',
           'Closed', 'Severity / standard'],
          ncrs.map((n) => [
            n.number, n.date, n.context ?? '', n.summary, prettyStatus(n.status),
            n.party ?? '', n.closed ?? '', n.extra ?? '',
          ]),
        ),
      )
    }

    toast.success('Exported', {
      description:
        inspections?.length && ncrs?.length
          ? 'Two files — site observations and NCRs.'
          : undefined,
    })
  }

  function exportDocs() {
    if (!docRows?.length) return toast.error('Nothing to export in this range')

    const cols = DOC_COLUMNS[section as DocSection]
    downloadCsv(
      `${base}-${section}-${stamp}`,
      toCsv(
        [cols.number, 'Date', cols.party, cols.context, cols.summary,
         cols.status, cols.due, cols.closed, cols.extra],
        docRows.map((d) => [
          d.number, d.date, d.party ?? '', d.context ?? '', d.summary,
          prettyStatus(d.status), d.due ?? '', d.closed ?? '', d.extra ?? '',
        ]),
      ),
    )
    toast.success(`${docRows.length} rows exported`)
  }

  const loading =
    effort === null ||
    muster === null ||
    tasks === null ||
    logs === null ||
    checks === null ||
    incidents === null ||
    sis === null ||
    rfis === null ||
    snags === null ||
    visits === null ||
    ncrs === null ||
    inspections === null ||
    schedule === null

  const count =
    section === 'tasks'
      ? (shownTasks?.length ?? 0)
      : section === 'logs'
        ? (logs?.length ?? 0)
        : section === 'labour'
          ? (muster?.length ?? 0)
          : section === 'schedule'
            ? (schedule?.length ?? 0)
            : section === 'safety'
              ? (checks?.length ?? 0)
              : section === 'incidents'
                ? (incidents?.length ?? 0)
                : section === 'quality'
                  ? (inspections?.length ?? 0) + (ncrs?.length ?? 0)
                  : (docRows?.length ?? 0)

  return (
    <div className="space-y-4 pb-6">
      {/* ---------- range ---------- */}
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">From</span>
          <Input
            type="date"
            value={from}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
            className="h-11"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">To</span>
          <Input
            type="date"
            value={to}
            onChange={(e) => e.target.value && setTo(e.target.value)}
            className="h-11"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { label: 'Last 7 days', days: -7 },
          { label: 'Last 30 days', days: -30 },
          { label: 'Last 90 days', days: -90 },
        ].map((r) => (
          <button
            key={r.days}
            type="button"
            onClick={() => {
              setFrom(addDays(todayIst(), r.days))
              setTo(todayIst())
            }}
            className="min-h-9 rounded-lg bg-secondary px-3 text-xs font-medium text-secondary-foreground"
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* ---------- section ---------- */}
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
        {SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSection(s)}
            className={cn(
              'min-h-11 shrink-0 rounded-lg px-3.5 text-sm font-medium transition-colors',
              section === s
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {SECTION_LABEL[s]}
          </button>
        ))}
      </div>

      {section === 'tasks' && (
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus | '')}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>

          <Select
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
            aria-label="Filter by trade"
          >
            <option value="">All trades</option>
            {TRADES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
      )}

      {!loading && count > 0 && (
        <div className="paper flex flex-wrap items-baseline justify-between gap-3 p-4">
          <p className="text-sm">
            <span className="figure text-[19px] font-semibold tabular-nums">
              {count}
            </span>
            <span className="ml-2 text-muted-foreground">
              {section === 'tasks'
                ? `task${count === 1 ? '' : 's'}`
                : section === 'logs'
                  ? `day${count === 1 ? '' : 's'} logged`
                  : section === 'labour'
                    ? `gang entr${count === 1 ? 'y' : 'ies'}`
                    : section === 'schedule'
                      ? `activity event${count === 1 ? '' : 's'}`
                      : section === 'quality'
                        ? 'observations and NCRs'
                        : SECTION_LABEL[section].toLowerCase()}
            </span>
          </p>
          <Button
            variant="outline"
            className="h-10"
            onClick={
              section === 'tasks'
                ? exportTasks
                : section === 'logs'
                  ? exportLogs
                  : section === 'labour'
                    ? exportLabour
                    : section === 'schedule'
                      ? exportSchedule
                      : section === 'safety' || section === 'incidents'
                        ? exportSafety
                        : section === 'quality'
                          ? exportQuality
                          : exportDocs
            }
          >
            <Download className="size-4" aria-hidden="true" />
            Export to Excel
          </Button>
        </div>
      )}

      {loading && <ListSkeleton rows={4} />}

      {!loading && count === 0 && (
        <EmptyState
          icon={History}
          title="Nothing in this range"
          body={
            section === 'tasks'
              ? 'Widen the dates, or clear the status and trade filters.'
              : section === 'schedule'
                ? // "Nothing was recorded" would be wrong here: the programme
                  // may be full of activities that simply have not started or
                  // finished yet. Say which it is.
                  'No activity started or finished in this range. Activities are listed here once the programme carries an actual start or end date for them.'
                : 'Widen the dates — nothing was recorded in this period.'
          }
        />
      )}

      {/* ---------- tasks ---------- */}
      {!loading &&
        section === 'tasks' &&
        taskDays.map(([date, list]) => (
          <Day key={date} date={date}>
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <Th>Task</Th>
                  <Th>Trade</Th>
                  <Th>Work area</Th>
                  <Th>Status</Th>
                  <Th right>Target</Th>
                  <Th right>Done</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <Td>
                      <span className="font-medium">{t.title}</span>
                      {t.rolled_from_date && (
                        <span className="block text-[11px] text-muted-foreground">
                          rolled from {t.rolled_from_date}
                        </span>
                      )}
                    </Td>
                    <Td muted>{t.trade ?? '—'}</Td>
                    <Td muted>{t.work_area ?? '—'}</Td>
                    <Td>
                      <span className={cn('font-medium', STATUS_TONE[t.status])}>
                        {TASK_STATUS_LABEL[t.status]}
                      </span>
                    </Td>
                    <Td right muted>
                      {t.target_qty === null
                        ? '—'
                        : `${t.target_qty} ${t.qty_unit ?? ''}`}
                    </Td>
                    <Td right>{t.done_qty === null ? '—' : String(t.done_qty)}</Td>
                    <Td muted>{t.not_done_reason ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Day>
        ))}

      {/* ---------- site logs ---------- */}
      {!loading && section === 'logs' && logs && logs.length > 0 && (
        <div className="paper overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <Th>Date</Th>
                <Th>Weather</Th>
                <Th right>Masons</Th>
                <Th right>Helpers</Th>
                <Th right>Other</Th>
                <Th right>Total</Th>
                <Th>Work done</Th>
                <Th>Issues</Th>
                <Th right>Photos</Th>
                <Th>Logged by</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0">
                  <Td>
                    <span className="font-medium tabular-nums">{l.log_date}</span>
                  </Td>
                  <Td muted>{l.weather ?? '—'}</Td>
                  <Td right muted>{l.labour_mason}</Td>
                  <Td right muted>{l.labour_helper}</Td>
                  <Td right muted>{l.labour_other}</Td>
                  <Td right>
                    <span className="font-medium">{l.labour_total}</span>
                  </Td>
                  <Td>{l.work_summary ?? '—'}</Td>
                  <Td muted>{l.issues ?? '—'}</Td>
                  <Td right muted>{l.photos.length}</Td>
                  <Td muted>{l.created_by_name ?? '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- labour ---------- */}
      {!loading && section === 'labour' && muster && muster.length > 0 && (
        <LabourSection effort={effort ?? []} muster={muster} />
      )}

      {/* ---------- instructions / RFIs / snags ---------- */}
      {!loading && docRows && docRows.length > 0 && (
        <DocTable kind={section as DocSection} rows={docRows} />
      )}

      {/* ---------- schedule ---------- */}
      {!loading && section === 'schedule' && schedule && schedule.length > 0 && (
        <section className="space-y-2">
          <div className="paper overflow-x-auto">
            <table className="w-full min-w-[780px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <Th>Date</Th>
                  <Th>Event</Th>
                  <Th>Activity</Th>
                  <Th>Phase</Th>
                  <Th>Planned</Th>
                  <Th>Variance</Th>
                  <Th>Progress now</Th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((e) => {
                  const planned =
                    e.event === 'started' ? e.planned_start : e.planned_end
                  return (
                    <tr
                      key={e.key}
                      className="border-b border-border last:border-0"
                    >
                      <Td>
                        <span className="font-medium tabular-nums">{e.date}</span>
                      </Td>
                      <Td>
                        <span
                          className={cn(
                            'font-medium',
                            e.event === 'finished'
                              ? 'text-[var(--positive)]'
                              : 'text-muted-foreground',
                          )}
                        >
                          {e.event === 'started' ? 'Started' : 'Finished'}
                        </span>
                      </Td>
                      <Td>
                        <span className="font-medium">{e.code}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {e.name}
                        </span>
                      </Td>
                      <Td muted>{e.phase ?? '—'}</Td>
                      <Td muted>
                        <span className="tabular-nums">{planned}</span>
                      </Td>
                      <Td>
                        <span
                          className={cn(
                            'font-medium tabular-nums',
                            e.variance_days > 0
                              ? 'text-destructive'
                              : e.variance_days < 0
                                ? 'text-[var(--positive)]'
                                : 'text-muted-foreground',
                          )}
                        >
                          {e.variance_days === 0
                            ? 'on time'
                            : `${e.variance_days > 0 ? '+' : ''}${e.variance_days} d`}
                        </span>
                      </Td>
                      <Td muted>
                        <span className="tabular-nums">{e.pct_complete}%</span>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {/* Said plainly, because the column would otherwise be read as the
              figure on the event date. */}
          <p className="text-[11px] text-muted-foreground">
            Activities that STARTED or FINISHED in this range, from the
            programme's actual dates. Variance is against the planned date for
            that event — positive is late. <strong>Progress now</strong> is the
            activity's current percentage, not what it was on the date shown:
            this app keeps one current value per activity and no dated history
            of progress changes.
          </p>
        </section>
      )}

      {/* ---------- quality ---------- */}
      {!loading && section === 'quality' && (
        <>
          {inspections && inspections.length > 0 && (
            <section className="space-y-2">
              <p className="pt-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                Site observations
              </p>
              <div className="paper overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <Th>Date</Th>
                      <Th>Location</Th>
                      <Th>Observation</Th>
                      <Th>Priority</Th>
                      <Th>Raised for</Th>
                      <Th>Became a task</Th>
                      <Th>Raised by</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspections.map((i) => (
                      <tr
                        key={i.id}
                        className="border-b border-border last:border-0"
                      >
                        <Td>
                          <span className="font-medium tabular-nums">
                            {i.observed_on}
                          </span>
                          {i.photo_count > 0 && (
                            <span className="block text-[11px] text-muted-foreground">
                              {i.photo_count} photo
                              {i.photo_count === 1 ? '' : 's'}
                            </span>
                          )}
                        </Td>
                        <Td muted>{i.location}</Td>
                        <Td>{i.comment}</Td>
                        <Td>
                          <span
                            className={cn(
                              'font-medium',
                              i.priority === 'high'
                                ? 'text-destructive'
                                : 'text-muted-foreground',
                            )}
                          >
                            {prettyStatus(i.priority)}
                          </span>
                        </Td>
                        <Td muted>{i.raised_for ?? '—'}</Td>
                        <Td muted>{i.became_task ? 'Yes' : '—'}</Td>
                        <Td muted>{i.raised_by_name ?? '—'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {ncrs && ncrs.length > 0 && (
            <section className="space-y-2">
              <p className="pt-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                Non-conformance reports
              </p>
              <DocTable kind="snags" rows={ncrs} />
            </section>
          )}
        </>
      )}

      {/* ---------- safety ---------- */}
      {!loading && (section === 'safety' || section === 'incidents') && (
        <>
          {section === 'safety' && checks && checks.length > 0 && (
            <section className="space-y-2">
              <p className="pt-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                Daily checks
              </p>
              <div className="paper overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <Th>Date</Th>
                      {SAFETY_ITEMS.map((i) => (
                        <Th key={i.key}>{i.label}</Th>
                      ))}
                      <Th>Checked by</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr
                        key={c.id}
                        className="border-b border-border last:border-0"
                      >
                        <Td>
                          <span className="font-medium tabular-nums">
                            {c.check_date}
                          </span>
                          {c.fail > 0 && (
                            <span className="block text-[11px] text-destructive">
                              {c.fail} failed
                            </span>
                          )}
                        </Td>
                        {SAFETY_ITEMS.map((i) => {
                          const r = c.results[i.key]
                          return (
                            <Td key={i.key}>
                              <span
                                className={cn(
                                  'font-medium',
                                  r === 'pass' && 'text-[var(--positive)]',
                                  r === 'fail' && 'text-destructive',
                                  (r === 'na' || !r) && 'text-muted-foreground',
                                )}
                              >
                                {resultLabel(r)}
                              </span>
                              {c.remarks[i.key] && (
                                <span className="block text-[11px] text-muted-foreground">
                                  {c.remarks[i.key]}
                                </span>
                              )}
                            </Td>
                          )
                        })}
                        <Td muted>{c.created_by_name ?? '—'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {section === 'incidents' && incidents && incidents.length > 0 && (
            <section className="space-y-2">
              <p className="pt-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                Incidents &amp; near-misses
              </p>
              <div className="paper overflow-x-auto">
                <table className="w-full min-w-[700px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <Th>When</Th>
                      <Th>Type</Th>
                      <Th>What happened</Th>
                      <Th>People</Th>
                      <Th>Action taken</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {incidents.map((i) => (
                      <tr
                        key={i.id}
                        className="border-b border-border last:border-0"
                      >
                        <Td>
                          <span className="font-medium tabular-nums">
                            {i.occurred_at.slice(0, 10)}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {i.occurred_at.slice(11, 16)}
                          </span>
                        </Td>
                        <Td>{INCIDENT_TYPE_LABEL[i.incident_type]}</Td>
                        <Td>{i.description}</Td>
                        <Td muted>{i.people_involved ?? '—'}</Td>
                        <Td muted>{i.immediate_action ?? '—'}</Td>
                        <Td>
                          <span
                            className={cn(
                              'font-medium',
                              i.status === 'open'
                                ? 'text-[var(--warning)]'
                                : 'text-muted-foreground',
                            )}
                          >
                            {i.status === 'open' ? 'Open' : 'Closed'}
                          </span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Labour over the period: the roll-up first, then the day-by-day muster roll.
 *
 * EFFORT only — days, mandays, overtime hours. No rate and no cost anywhere,
 * because History is readable by supervisors and its exports carry no money
 * column. Wages are at Money → Labour, gated to money roles, and putting them
 * here as well would create a second place to look for one figure.
 *
 * Every total comes from fn_labour_effort; nothing on this screen is added up
 * in the browser.
 */
function LabourSection({
  effort,
  muster,
}: {
  effort: LabourEffortRow[]
  muster: AttendanceRow[]
}) {
  return (
    <>
      {effort.length > 0 && (
        <section className="space-y-2">
          <p className="pt-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Summary by contractor and trade
          </p>
          <div className="paper overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <Th>Contractor</Th>
                  <Th>Trade</Th>
                  <Th right>Days</Th>
                  <Th right>Mandays</Th>
                  <Th right>Overtime h</Th>
                  <Th right>Peak in a day</Th>
                </tr>
              </thead>
              <tbody>
                {effort.map((e) => (
                  <tr
                    key={`${e.contractor_id}-${e.trade}`}
                    className="border-b border-border last:border-0"
                  >
                    <Td>
                      <span className="font-medium">{e.contractor_name}</span>
                    </Td>
                    <Td muted>{e.trade}</Td>
                    <Td right muted>{e.days_worked}</Td>
                    <Td right>
                      <span className="font-medium">{e.mandays}</span>
                    </Td>
                    <Td right muted>{e.ot_hours || '—'}</Td>
                    <Td right muted>{e.peak_workers}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Mandays is the figure to check against a contractor's invoice. What
            it costs is under Money → Labour — this report carries no rates.
          </p>
        </section>
      )}

      <section className="space-y-2">
        <p className="pt-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Muster roll · gang level
        </p>
        <div className="paper overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <Th>Date</Th>
                <Th>Contractor</Th>
                <Th>Trade</Th>
                <Th right>Present</Th>
                <Th right>Overtime h</Th>
                <Th>Work area</Th>
                <Th>Remarks</Th>
              </tr>
            </thead>
            <tbody>
              {muster.map((m) => (
                <tr
                  key={m.attendance_id}
                  className="border-b border-border last:border-0"
                >
                  <Td>
                    <span className="font-medium tabular-nums">
                      {m.work_date}
                    </span>
                  </Td>
                  <Td>{m.contractor_name}</Td>
                  <Td muted>{m.trade}</Td>
                  <Td right>
                    <span
                      className={cn(
                        'font-medium',
                        m.over_licence && 'text-destructive',
                      )}
                    >
                      {m.workers_present}
                    </span>
                  </Td>
                  <Td right muted>{m.overtime_hours || '—'}</Td>
                  <Td muted>{m.work_area ?? '—'}</Td>
                  <Td muted>{m.remarks ?? '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">
          A Form XVI equivalent, built from gang counts. It is the firm's own
          record — not the named statutory muster roll your contractor must
          keep. Voided entries are excluded.
        </p>
      </section>
    </>
  )
}

/**
 * Instructions, RFIs and snags are the same object in three costumes: a
 * numbered document with a date, a party, a status and something that closes
 * it. One table renders all three; only the headings change.
 */
type DocSection = 'instructions' | 'rfis' | 'snags' | 'visits'

const DOC_COLUMNS: Record<
  DocSection,
  {
    number: string
    party: string
    context: string
    summary: string
    /** a visit has no workflow status, so this slot carries its TYPE */
    status: string
    due: string
    closed: string
    extra: string
  }
> = {
  instructions: {
    number: 'SI no.',
    party: 'Issued to',
    context: 'Work area',
    summary: 'Instruction',
    status: 'Status',
    due: 'Required by',
    closed: 'Completed',
    extra: 'Cost',
  },
  rfis: {
    number: 'RFI no.',
    party: 'Asked of',
    context: 'Category',
    summary: 'Question',
    status: 'Status',
    due: 'Required by',
    closed: 'Answered',
    extra: 'Response',
  },
  snags: {
    number: 'Snag no.',
    party: 'Assigned to',
    context: 'Area / trade',
    summary: 'Defect',
    status: 'Status',
    due: '—',
    closed: 'Closed',
    extra: 'Severity',
  },
  visits: {
    number: 'Visit no.',
    party: 'Visitor',
    context: 'Time',
    summary: 'Observations',
    // A visit is not a workflow — nothing opens or closes. The slot carries the
    // visit TYPE rather than printing one under a heading that says Status.
    status: 'Type',
    due: '—',
    closed: '—',
    extra: 'Attached',
  },
}

function DocTable({
  kind,
  rows,
}: {
  kind: DocSection
  rows: DocHistoryRow[]
}) {
  const c = DOC_COLUMNS[kind]
  const showDue = kind !== 'snags' && kind !== 'visits'
  // Nothing closes a visit, so the column would be a row of dashes.
  const showClosed = kind !== 'visits'

  return (
    <div className="paper overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <Th>{c.number}</Th>
            <Th>Date</Th>
            <Th>{c.party}</Th>
            <Th>{c.context}</Th>
            <Th>{c.summary}</Th>
            <Th>{c.status}</Th>
            {showDue && <Th>{c.due}</Th>}
            {showClosed && <Th>{c.closed}</Th>}
            <Th>{c.extra}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            // Past its required-by date and nothing has closed it.
            const late =
              showDue && d.due !== null && d.closed === null && d.due < todayIst()

            return (
              <tr key={d.id} className="border-b border-border last:border-0">
                <Td>
                  <span className="font-medium tabular-nums">{d.number}</span>
                </Td>
                <Td muted>{d.date}</Td>
                <Td muted>{d.party ?? '—'}</Td>
                <Td muted>{d.context ?? '—'}</Td>
                <Td>{d.summary}</Td>
                <Td>
                  <span
                    className={cn(
                      'font-medium',
                      kind === 'visits' ? undefined : docStatusTone(d.status),
                    )}
                  >
                    {kind === 'visits'
                      ? (VISIT_TYPE_LABEL[d.status as VisitType] ??
                        prettyStatus(d.status))
                      : prettyStatus(d.status)}
                  </span>
                </Td>
                {showDue && (
                  <Td muted>
                    <span className={cn(late && 'font-medium text-destructive')}>
                      {d.due ?? '—'}
                    </span>
                  </Td>
                )}
                {showClosed && <Td muted>{d.closed ?? '—'}</Td>}
                <Td muted>{d.extra ?? '—'}</Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Status vocabularies differ per table; the colours don't need to. */
function docStatusTone(s: string): string {
  if (['complete', 'closed', 'verified', 'answered'].includes(s))
    return 'text-[var(--positive)]'
  if (['cancelled', 'rejected'].includes(s)) return 'text-muted-foreground'
  if (['open', 'issued', 'resolved', 'in_progress'].includes(s))
    return 'text-[var(--warning)]'
  return ''
}

function prettyStatus(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
}

/* ---------------- bits ---------------- */

function groupBy<T>(
  rows: T[] | null,
  key: (r: T) => string,
): [string, T[]][] {
  if (!rows) return []
  const map = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const list = map.get(k)
    if (list) list.push(r)
    else map.set(k, [r])
  }
  return [...map.entries()]
}

function labelFor(key: string): string {
  return SAFETY_ITEMS.find((i) => i.key === key)?.label ?? key
}

function resultLabel(r: string | undefined): string {
  if (r === 'pass') return 'Pass'
  if (r === 'fail') return 'Fail'
  return 'N/A'
}

/**
 * A day's worth of rows. Horizontal scroll on a phone is the deliberate
 * trade-off: this screen exists to be read like a sheet, and the CSV is one tap
 * away when the small screen isn't enough.
 */
function Day({ date, children }: { date: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <p className="pt-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        {date}
      </p>
      <div className="paper overflow-x-auto">{children}</div>
    </section>
  )
}

function Th({
  children,
  right,
}: {
  children: React.ReactNode
  right?: boolean
}) {
  return (
    <th
      className={cn(
        'px-4 py-2.5 text-[11px] font-medium tracking-[0.1em] text-muted-foreground uppercase',
        right && 'text-right',
      )}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  right,
  muted,
}: {
  children: React.ReactNode
  right?: boolean
  muted?: boolean
}) {
  return (
    <td
      className={cn(
        'px-4 py-3 align-top',
        right && 'text-right tabular-nums',
        muted && 'text-muted-foreground',
      )}
    >
      {children}
    </td>
  )
}
