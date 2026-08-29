import { AlertTriangle, Download, FileText, LayoutGrid } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { BarChart, CategoryBars, LineChart } from '@/components/MiniChart'
import { EmptyState } from '@/components/EmptyState'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { downloadCsv, toCsv } from '@/lib/csv'
import { errText } from '@/lib/errText'
import { formatInr, MARGIN_TEXT, marginTone } from '@/lib/format'
import { generateMisPdf } from '@/lib/misPdf'
import {
  fetchMisByCategory,
  fetchMisCompany,
  fetchMisExceptions,
  fetchMisProjects,
  fetchMisTrend,
} from '@/lib/queries/mis'
import { todayIst } from '@/lib/useSelectedDate'
import {
  canSeeMis,
  EXCEPTION_LABEL,
  HEALTH_DOT,
  HEALTH_LABEL,
  HEALTH_TEXT,
  type MisCategory,
  type MisCompany,
  type MisException,
  type MisProject,
  type MisTrendPoint,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

/** Lakh/crore — how these figures are actually spoken about. */
function short(v: number | null): string {
  if (v === null) return '—'
  const a = Math.abs(v)
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)} L`
  return formatInr(v)
}

function monthLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    month: 'short',
  }).format(new Date(`${iso}T00:00:00Z`))
}

function monthRange(date: string): [string, string] {
  const [y, m] = date.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const mm = String(m).padStart(2, '0')
  return [`${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2, '0')}`]
}

/**
 * MIS — the cross-project command view.
 *
 * Deliberately separate from the per-project dashboard: the question here is
 * "which of my jobs is bleeding", which cannot be asked one project at a time.
 *
 * Nothing on this screen is calculated. Every figure, every percentage and the
 * health verdict on each project all come from Postgres — the same values the
 * CSV and the board PDF print, so the three cannot disagree in front of anyone.
 *
 * Scope is inherited, not applied here: founder and accounts see every project,
 * a PM sees assigned ones, a supervisor gets zero rows from all five calls. The
 * guard below exists to give them a sentence rather than an empty screen.
 */
export default function Mis() {
  const role = useAuth((s) => s.role)

  const [from, setFrom] = useState(() => monthRange(todayIst())[0])
  const [to, setTo] = useState(() => monthRange(todayIst())[1])

  const [company, setCompany] = useState<MisCompany | null>(null)
  const [projects, setProjects] = useState<MisProject[] | null>(null)
  const [trend, setTrend] = useState<MisTrendPoint[]>([])
  const [categories, setCategories] = useState<MisCategory[]>([])
  const [exceptions, setExceptions] = useState<MisException[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * Five independent calls, settled independently.
   *
   * `Promise.all` rejects on the FIRST failure, so one bad query blanked the
   * whole screen and reported "No projects visible" — which is a different and
   * more alarming claim than "one panel could not load". Each result now stands
   * or falls on its own, and the errors are collected and shown rather than
   * swallowed.
   */
  const reload = useCallback(async () => {
    const [c, p, t, cat, ex] = await Promise.allSettled([
      fetchMisCompany(from, to),
      fetchMisProjects(),
      fetchMisTrend(12),
      fetchMisByCategory(null, null),
      fetchMisExceptions(),
    ])

    setCompany(c.status === 'fulfilled' ? c.value : null)
    setProjects(p.status === 'fulfilled' ? p.value : [])
    setTrend(t.status === 'fulfilled' ? t.value : [])
    setCategories(cat.status === 'fulfilled' ? cat.value : [])
    setExceptions(ex.status === 'fulfilled' ? ex.value : [])

    const failed = [
      ['KPIs', c],
      ['projects', p],
      ['trend', t],
      ['cost breakdown', cat],
      ['exceptions', ex],
    ].filter(([, r]) => (r as PromiseSettledResult<unknown>).status === 'rejected')

    if (failed.length > 0) {
      const first = failed[0][1] as PromiseRejectedResult
      toast.error(
        `Could not load the ${failed.map(([n]) => n).join(', ')}`,
        { description: errText(first.reason) },
      )
    }
  }, [from, to])

  useEffect(() => {
    setProjects(null)
    void reload()
  }, [reload])

  if (!canSeeMis(role)) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        The management report covers every project's commercial position, so it
        is restricted for your role.
      </p>
    )
  }

  if (projects === null) return <ListSkeleton rows={6} />

  function exportCsv() {
    if (!projects?.length) return toast.error('No projects to export')
    downloadCsv(
      `MIS-projects-${to}`,
      toCsv(
        ['Project', 'Status', 'Revenue', 'Cost to date', 'Gross margin',
         'Margin %', 'Budget', 'Budget used %', 'Over budget', 'SPI', 'CPI',
         '% complete', 'Open NCRs', 'Critical NCRs', 'Open snags',
         'POs pending', 'Bills awaiting', 'Health'],
        projects.map((p) => [
          p.project_name, p.project_status, p.revenue, p.total_cost,
          p.gross_margin, p.margin_pct ?? '', p.budget_total,
          p.budget_pct_used ?? '', p.over_budget ? 'yes' : 'no',
          p.spi ?? '', p.cpi ?? '', p.pct_complete ?? '', p.open_ncrs,
          p.critical_ncrs, p.open_snags, p.pos_pending, p.bills_awaiting,
          HEALTH_LABEL[p.health],
        ]),
      ),
    )
    toast.success(`${projects.length} projects exported`)
  }

  async function exportPdf() {
    if (!company || !projects) return
    setBusy('pdf')
    try {
      generateMisPdf({
        company,
        projects,
        exceptions,
        categories,
        periodFrom: from,
        periodTo: to,
      })
    } catch (err) {
      toast.error('Could not build the report', { description: errText(err) })
    }
    setBusy(null)
  }

  const critical = exceptions.filter((e) => e.severity === 'critical')

  return (
    <div className="space-y-4 pb-6">
      {company && <KpiCard company={company} />}

      {/* Exceptions sit high on purpose: the reason to open this screen is to
          find out what is wrong, and burying that under three charts would be
          designing for the day when nothing is. */}
      <ExceptionPanel exceptions={exceptions} criticalCount={critical.length} />

      <ProjectTable projects={projects} />

      <TrendSection trend={trend} />

      <section className="paper p-5">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Cost by category · all projects
        </h2>
        <div className="mt-4">
          <CategoryBars
            data={categories.map((c) => ({
              label: c.category_name,
              value: c.amount,
              pct: c.pct_of_total,
            }))}
            format={short}
            emptyLabel="No cost booked yet"
          />
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">
          Project cost only. Company overheads are a separate thing with their
          own screen — mixing office rent into this list would invite the total
          to be read as project cost.
        </p>
      </section>

      <section className="paper space-y-3 p-5">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Board report
        </h2>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Overheads from</span>
            <Input
              type="date"
              value={from}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
              className="h-11"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => e.target.value && setTo(e.target.value)}
              className="h-11"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="h-11"
            disabled={busy !== null}
            onClick={() => void exportPdf()}
          >
            <FileText className="size-4" />
            {busy === 'pdf' ? 'Building…' : 'PDF report'}
          </Button>
          <Button variant="outline" className="h-11" onClick={exportCsv}>
            <Download className="size-4" /> Projects CSV
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Both cover only the projects you can see, and the PDF's total row comes
          from the same call as the headline above — so the two cannot disagree
          across a table.
        </p>
      </section>
    </div>
  )
}

/* ---------------- KPI card ---------------- */

function KpiCard({ company: c }: { company: MisCompany }) {
  const tone = marginTone(c.gross_margin)

  return (
    <section className="paper p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          The company
        </h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {c.active_count} active of {c.project_count}
        </span>
      </div>

      <div className="mt-4">
        <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
          Gross margin
        </p>
        <p
          className={cn(
            'figure mt-1 text-[34px] leading-none font-semibold',
            MARGIN_TEXT[tone],
          )}
        >
          {short(c.gross_margin)}
          {c.blended_margin_pct !== null && (
            <span className="ml-2 text-lg font-normal">
              {c.blended_margin_pct}%
            </span>
          )}
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          on {short(c.contract_value)} of contract value · lifetime to date
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-5">
        <Figure label="Cost to date" value={short(c.total_cost)} />
        <Figure
          label="Net position"
          value={c.sees_overheads ? short(c.net_position) : 'Restricted'}
          hint={
            c.sees_overheads
              ? `less ${short(c.overheads)} overheads, ${c.overhead_from} to ${c.overhead_to}`
              : 'founder and accounts only'
          }
          tone={
            c.sees_overheads && (c.net_position ?? 0) < 0 ? 'danger' : undefined
          }
        />
        <Figure label="Retention held" value={short(c.retention_held)} />
        <Figure label="Open commitments" value={short(c.committed_open)} />
      </div>

      {/* Two different time spans in one figure, so both are named. The 040
          lesson: right for a financial year, misleading for a single month. */}
      {c.sees_overheads && (
        <p className="mt-4 rounded-lg bg-secondary px-3 py-2 text-[10px] text-muted-foreground">
          Net position is margin <strong>lifetime to date</strong> less overheads
          for the <strong>chosen period</strong>. It is not a cash figure — no
          bank balance or receipts are tracked anywhere in the app.
        </p>
      )}

      <div className="mt-4 grid grid-cols-4 gap-3 border-t border-border pt-4">
        <Count label="Over budget" value={c.over_budget_count} bad />
        <Count label="Losing money" value={c.bleeding_count} bad />
        <Count label="Compliance overdue" value={c.overdue_compliance} bad />
        <Count label="POs to approve" value={c.pos_pending} />
      </div>
      <div className="mt-3 grid grid-cols-4 gap-3">
        <Count label="Open NCRs" value={c.open_ncrs} />
        <Count label="Critical NCRs" value={c.critical_ncrs} bad />
        <Count label="Open snags" value={c.open_snags} />
        <Count label="Bills waiting" value={c.bills_awaiting} />
      </div>
    </section>
  )
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'danger'
}) {
  return (
    <div>
      <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'figure mt-1 text-[18px] font-semibold',
          tone === 'danger' && 'text-destructive',
        )}
      >
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}

function Count({
  label,
  value,
  bad,
}: {
  label: string
  value: number
  bad?: boolean
}) {
  return (
    <div>
      <p
        className={cn(
          'figure text-[19px] font-semibold tabular-nums',
          bad && value > 0 && 'text-destructive',
        )}
      >
        {value}
      </p>
      <p className="text-[9px] leading-tight text-muted-foreground">{label}</p>
    </div>
  )
}

/* ---------------- exceptions ---------------- */

function ExceptionPanel({
  exceptions,
  criticalCount,
}: {
  exceptions: MisException[]
  criticalCount: number
}) {
  const [showAll, setShowAll] = useState(false)

  if (exceptions.length === 0) {
    return (
      <section className="paper p-5">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Needs attention
        </h2>
        <p className="mt-3 text-sm text-[var(--positive)]">
          Nothing outstanding — no over-budget project, no expiring cover, no
          critical NCR and nothing waiting on an approval.
        </p>
      </section>
    )
  }

  const shown = showAll ? exceptions : exceptions.slice(0, 6)

  return (
    <section className="paper p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Needs attention
        </h2>
        <span
          className={cn(
            'text-[11px] tabular-nums',
            criticalCount > 0 ? 'font-medium text-destructive' : 'text-muted-foreground',
          )}
        >
          {criticalCount > 0 ? `${criticalCount} critical · ` : ''}
          {exceptions.length} total
        </span>
      </div>

      <ul className="mt-4 space-y-2.5">
        {shown.map((e, i) => (
          <li
            key={`${e.kind}-${e.project_id ?? 'none'}-${e.title}-${i}`}
            className="flex items-start gap-2.5"
          >
            <span
              className={cn(
                'mt-1.5 size-1.5 shrink-0 rounded-full',
                e.severity === 'critical'
                  ? 'bg-destructive'
                  : 'bg-[var(--warning)]',
              )}
            />
            <div className="min-w-0">
              <p className="text-sm">
                {e.project_name && (
                  <span className="text-muted-foreground">
                    {e.project_name} ·{' '}
                  </span>
                )}
                <span className="font-medium">{e.title}</span>
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                <span className="rounded bg-secondary px-1.5 py-0.5">
                  {EXCEPTION_LABEL[e.kind]}
                </span>
                {e.detail && <span className="ml-1.5">{e.detail}</span>}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {exceptions.length > 6 && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-3"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? 'Show fewer' : `Show all ${exceptions.length}`}
        </Button>
      )}
    </section>
  )
}

/* ---------------- project comparison ---------------- */

function ProjectTable({ projects }: { projects: MisProject[] }) {
  if (projects.length === 0) {
    return (
      <EmptyState
        icon={LayoutGrid}
        title="No projects visible"
        body="Projects appear here once they carry a contract value and some cost."
      />
    )
  }

  return (
    <section className="space-y-3">
      <h2 className="px-1 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Project by project
      </h2>

      <Stagger className="card-grid">
        {projects.map((p) => (
          <RevealItem key={p.project_id}>
            <Link
              to={`/project/${p.project_id}`}
              className="paper block p-5 transition-shadow hover:shadow-[var(--shadow-card-lift)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-heading text-[17px] font-semibold">
                    {p.project_name}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        HEALTH_DOT[p.health],
                      )}
                    />
                    <span className={HEALTH_TEXT[p.health]}>
                      {HEALTH_LABEL[p.health]}
                    </span>
                    <span className="text-muted-foreground">
                      · {p.project_status}
                    </span>
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={cn(
                      'figure text-[17px] font-semibold',
                      MARGIN_TEXT[marginTone(p.gross_margin)],
                    )}
                  >
                    {short(p.gross_margin)}
                  </p>
                  <p className="text-[10px] text-muted-foreground tabular-nums">
                    {p.margin_pct === null ? 'no revenue set' : `${p.margin_pct}% margin`}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-4 gap-3">
                <Metric label="Revenue" value={short(p.revenue)} />
                <Metric label="Cost" value={short(p.total_cost)} />
                <Metric
                  label="SPI"
                  value={p.spi === null ? '—' : p.spi.toFixed(2)}
                  tone={p.spi !== null && p.spi < 0.9 ? 'warning' : undefined}
                />
                <Metric
                  label="CPI"
                  value={p.cpi === null ? '—' : p.cpi.toFixed(2)}
                  tone={
                    p.cpi === null
                      ? undefined
                      : p.cpi < 0.9
                        ? 'danger'
                        : p.cpi < 1
                          ? 'warning'
                          : undefined
                  }
                />
              </div>

              {/* No schedule is a different state from being behind one, and
                  says so rather than showing a dash nobody can interpret. */}
              {p.activity_count === null || p.activity_count === 0 ? (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  No programme generated — SPI and CPI need a schedule.
                </p>
              ) : (
                <p className="mt-3 text-[11px] text-muted-foreground tabular-nums">
                  {p.pct_complete ?? 0}% complete over {p.activity_count}{' '}
                  activities
                  {p.budget_pct_used !== null &&
                    ` · ${p.budget_pct_used}% of budget used`}
                </p>
              )}

              {(p.over_budget || p.critical_ncrs > 0) && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-destructive">
                  <AlertTriangle className="size-3.5" />
                  {[
                    p.over_budget && 'over budget',
                    p.critical_ncrs > 0 && `${p.critical_ncrs} critical NCR`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </Link>
          </RevealItem>
        ))}
      </Stagger>
    </section>
  )
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'warning' | 'danger'
}) {
  return (
    <div>
      <p className="text-[9px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'mt-0.5 text-sm font-medium tabular-nums',
          tone === 'danger' && 'text-destructive',
          tone === 'warning' && 'text-[var(--warning)]',
        )}
      >
        {value}
      </p>
    </div>
  )
}

/* ---------------- trend ---------------- */

function TrendSection({ trend }: { trend: MisTrendPoint[] }) {
  return (
    <>
      <section className="paper p-5">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Cost over time
        </h2>
        <div className="mt-4">
          <BarChart
            data={trend.map((t) => ({
              label: monthLabel(t.month),
              value: t.monthly_cost,
            }))}
            line={trend.map((t) => ({
              label: monthLabel(t.month),
              value: t.cumulative_cost,
            }))}
            format={short}
            lineFormat={short}
            emptyLabel="No cost booked in the last twelve months"
          />
        </div>
      </section>

      <section className="paper p-5">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Margin to date
        </h2>
        <div className="mt-4">
          <LineChart
            data={trend
              .filter((t) => t.margin_pct_to_date !== null)
              .map((t) => ({
                label: monthLabel(t.month),
                value: t.margin_pct_to_date as number,
              }))}
            emptyLabel="No contract value set yet"
          />
        </div>
        {/* Said out loud, because "margin trend" usually means the other thing
            and this app cannot honestly produce it. */}
        <p className="mt-3 text-[10px] text-muted-foreground">
          Margin remaining at each month end, not margin earned that month. The
          app does not recognise revenue monthly, so a per-month margin would be
          a number with nothing behind it.
        </p>
      </section>
    </>
  )
}
