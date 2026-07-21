import { Building2, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { FadeUp, RevealItem, Stagger } from '@/components/Reveal'
import { ProjectCardSkeleton, Skeleton } from '@/components/Skeleton'
import { barGeometry, formatInr } from '@/lib/format'
import {
  fetchPortfolioSummary,
  fetchProjectPulse,
} from '@/lib/queries/dashboard'
import { fetchProjectSpend } from '@/lib/queries/projects'
import {
  canSeeMoney,
  type PortfolioSummary,
  type ProjectPulse,
  type ProjectSpend,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

export default function Dashboard() {
  const role = useAuth((s) => s.role)
  const showMoney = canSeeMoney(role)

  const [rows, setRows] = useState<ProjectSpend[] | null>(null)
  const [pulse, setPulse] = useState<Map<string, ProjectPulse>>(new Map())
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetchProjectSpend()
      .then((data) => {
        if (!cancelled) setRows(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setFailed(true)
        setRows([])
        toast.error('Could not load projects', {
          description: err instanceof Error ? err.message : undefined,
        })
      })

    // Secondary data — a failure here shouldn't block the grid.
    fetchProjectPulse()
      .then((p) => {
        if (!cancelled) setPulse(p)
      })
      .catch(() => {})

    fetchPortfolioSummary()
      .then((p) => {
        if (!cancelled) setPortfolio(p)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  const totalAlerts = [...pulse.values()].reduce(
    (n, p) => n + p.low_stock_count,
    0,
  )

  return (
    <>
      <PageHeader title="Command" />

      <div className="mx-auto max-w-3xl px-5 py-6">
        {rows === null && (
          <>
            <Skeleton className="h-36 w-full rounded-2xl" />
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ProjectCardSkeleton />
              <ProjectCardSkeleton />
            </div>
          </>
        )}

        {rows?.length === 0 && (
          <EmptyState
            icon={Building2}
            title={failed ? 'Nothing to show' : 'No projects yet'}
            body={
              failed
                ? 'We could not reach the server. Pull down to try again.'
                : 'Projects you are assigned to will appear here with spend against budget.'
            }
          />
        )}

        {rows && rows.length > 0 && (
          <>
            <FadeUp>
              <PortfolioCard
                portfolio={portfolio}
                projectCount={rows.length}
                totalAlerts={totalAlerts}
                showMoney={showMoney}
              />
            </FadeUp>

            <p className="mt-8 mb-4 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              By project
            </p>

            {/* One column on a phone — two 180px cards can't hold a
                ₹96,76,736 figure legibly. Two up from 640px. */}
            <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {rows.map((p) => (
                <RevealItem key={p.project_id} className="h-full">
                  <ProjectCard
                    project={p}
                    pulse={pulse.get(p.project_id)}
                    showMoney={showMoney}
                  />
                </RevealItem>
              ))}
            </Stagger>
          </>
        )}
      </div>
    </>
  )
}

/* ---------------- All projects ---------------- */

function PortfolioCard({
  portfolio,
  projectCount,
  totalAlerts,
  showMoney,
}: {
  portfolio: PortfolioSummary | null
  projectCount: number
  totalAlerts: number
  showMoney: boolean
}) {
  const over = portfolio !== null && portfolio.remaining < 0
  const bar = portfolio
    ? barGeometry(portfolio.total_spent, portfolio.total_budget)
    : null

  return (
    <section className="paper p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          All projects
        </h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {portfolio?.active_count ?? projectCount} active ·{' '}
          {portfolio?.project_count ?? projectCount} total
        </span>
      </div>

      {!showMoney ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Portfolio figures are restricted for your role.
        </p>
      ) : portfolio === null ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Portfolio totals need migration 009.
        </p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Metric label="Total spent" value={formatInr(portfolio.total_spent)} big />
            <Metric label="Total budget" value={formatInr(portfolio.total_budget)} />
            <Metric
              label={over ? 'Over budget' : 'Remaining'}
              value={formatInr(Math.abs(portfolio.remaining))}
              tone={over ? 'danger' : 'positive'}
            />
            <Metric
              label="Stock alerts"
              value={String(totalAlerts)}
              tone={totalAlerts > 0 ? 'danger' : undefined}
            />
          </div>

          {bar?.hasBudget && (
            <div className="relative mt-6 h-[6px] w-full overflow-hidden rounded-full bg-border">
              <div
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full',
                  bar.over ? 'bg-destructive/45' : 'bg-primary',
                )}
                style={{ width: `${Math.min(bar.fillTo, bar.budgetAt) * 100}%` }}
              />
              {bar.over && (
                <>
                  <div
                    className="absolute inset-y-0 rounded-full bg-destructive"
                    style={{
                      left: `${bar.budgetAt * 100}%`,
                      width: `${(bar.fillTo - bar.budgetAt) * 100}%`,
                    }}
                  />
                  <div
                    className="absolute inset-y-[-2px] w-[2px] bg-card"
                    style={{ left: `${bar.budgetAt * 100}%` }}
                    aria-hidden="true"
                  />
                </>
              )}
            </div>
          )}

          {portfolio.over_budget_count > 0 && (
            <p className="mt-3 text-[13px] font-medium text-destructive">
              {portfolio.over_budget_count} project
              {portfolio.over_budget_count === 1 ? '' : 's'} over budget
            </p>
          )}
        </>
      )}
    </section>
  )
}

function Metric({
  label,
  value,
  big,
  tone,
}: {
  label: string
  value: string
  big?: boolean
  tone?: 'danger' | 'positive'
}) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'figure mt-1.5 leading-none font-semibold',
          big ? 'text-[26px]' : 'text-[19px]',
          tone === 'danger' && 'text-destructive',
          tone === 'positive' && 'text-positive',
        )}
      >
        {value}
      </p>
    </div>
  )
}

/* ---------------- Per project ---------------- */

function ProjectCard({
  project,
  pulse,
  showMoney,
}: {
  project: ProjectSpend
  pulse: ProjectPulse | undefined
  showMoney: boolean
}) {
  const bar = barGeometry(project.total_spent, project.total_budget)
  const noBudget = !bar.hasBudget
  const pct = project.pct_used

  return (
    <Link
      to={`/project/${project.project_id}`}
      className="paper flex h-full flex-col p-5 transition-shadow hover:paper-lift focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
      aria-label={`Open ${project.name}`}
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="font-heading text-[20px] leading-tight font-semibold">
          {project.name}
        </h3>
        <ChevronRight
          className="mt-1 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </header>

      {showMoney && (
        <div className="mt-2">
          <StatusPill over={bar.over} noBudget={noBudget} pct={pct} />
        </div>
      )}

      {showMoney ? (
        <>
          <div className="mt-5">
            <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
              Spent
            </p>
            <p
              className={cn(
                'figure mt-1 text-[28px] leading-none font-semibold',
                bar.over && 'text-destructive',
              )}
            >
              {formatInr(project.total_spent)}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
              of {noBudget ? '—' : formatInr(project.total_budget)}
            </p>
          </div>

          {project.remaining !== null && !noBudget && (
            <p
              className={cn(
                'mt-2.5 text-[13px] font-medium tabular-nums',
                project.remaining < 0 ? 'text-destructive' : 'text-positive',
              )}
            >
              {project.remaining < 0
                ? `${formatInr(Math.abs(project.remaining))} over`
                : `${formatInr(project.remaining)} remaining`}
            </p>
          )}

          <div className="relative mt-5 h-[6px] w-full overflow-hidden rounded-full bg-border">
            <div
              className={cn(
                'absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out',
                bar.over ? 'bg-destructive/45' : 'bg-primary',
              )}
              style={{ width: `${Math.min(bar.fillTo, bar.budgetAt) * 100}%` }}
            />
            {bar.over && (
              <>
                <div
                  className="absolute inset-y-0 rounded-full bg-destructive"
                  style={{
                    left: `${bar.budgetAt * 100}%`,
                    width: `${(bar.fillTo - bar.budgetAt) * 100}%`,
                  }}
                />
                <div
                  className="absolute inset-y-[-2px] w-[2px] bg-card"
                  style={{ left: `${bar.budgetAt * 100}%` }}
                  aria-hidden="true"
                />
              </>
            )}
          </div>
        </>
      ) : (
        <p className="mt-5 text-sm text-muted-foreground">
          Budget figures are restricted for your role.
        </p>
      )}

      <StatsRow pulse={pulse} />
    </Link>
  )
}

function StatsRow({ pulse }: { pulse: ProjectPulse | undefined }) {
  const taskPct = pulse?.task_pct
  const alerts = pulse?.low_stock_count ?? 0

  return (
    <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
          Tasks
        </span>
        <span className="text-sm font-medium tabular-nums">
          {taskPct === null || taskPct === undefined ? '—' : `${taskPct}%`}
        </span>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
          Alerts
        </span>
        <span
          className={cn(
            'text-sm font-medium tabular-nums',
            alerts > 0 && 'text-destructive',
          )}
        >
          {alerts}
        </span>
      </div>
    </div>
  )
}

function StatusPill({
  over,
  noBudget,
  pct,
}: {
  over: boolean
  noBudget: boolean
  pct: number | null
}) {
  if (noBudget) {
    return (
      <span className="inline-block rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium tracking-wide text-muted-foreground">
        No budget
      </span>
    )
  }

  if (over) {
    return (
      <span className="inline-block rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-medium tracking-wide text-destructive">
        Over budget
      </span>
    )
  }

  if (pct === null) return null

  const nearing = pct >= 85

  return (
    <span
      className={cn(
        'inline-block rounded-full px-2.5 py-1 text-[11px] font-medium tracking-wide tabular-nums',
        nearing
          ? 'bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-[var(--warning)]'
          : 'bg-[color-mix(in_oklab,var(--positive)_12%,transparent)] text-[var(--positive)]',
      )}
    >
      {Math.round(pct)}% used
    </span>
  )
}
