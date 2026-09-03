import {
  Building2,
  CalendarClock,
  ChevronRight,
  Landmark,
  MessageSquare,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { Figure } from '@/components/Figure'
import { PageHeader } from '@/components/PageHeader'
import { PushCard } from '@/components/PushCard'
import { FadeUp, RevealItem, Stagger } from '@/components/Reveal'
import { ProjectCardSkeleton, Skeleton } from '@/components/Skeleton'
import {
  barGeometry,
  formatInr,
  MARGIN_LABEL,
  MARGIN_TEXT,
  marginTone,
} from '@/lib/format'
import {
  fetchPortfolioSummary,
  fetchProjectPulse,
} from '@/lib/queries/dashboard'
import {
  type ClientAttention,
  fetchClientAttention,
} from '@/lib/queries/clientMessages'
import { fetchComplianceAlert } from '@/lib/queries/compliance'
import { fetchProjectSpend } from '@/lib/queries/projects'
import { fetchInsuranceAlert } from '@/lib/queries/insurance'
import { fetchCompanyPnl, fetchProjectPnl } from '@/lib/queries/pnl'
import { fetchBgAlert } from '@/lib/queries/retention'
import {
  type BgAlert,
  canAdminister,
  canManageCompliance,
  canSeeMoney,
  type CompanyPnl,
  type ComplianceAlert,
  type InsuranceAlert,
  type PortfolioSummary,
  type ProjectPnl,
  type ProjectPulse,
  type ProjectSpend,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

export default function Dashboard() {
  const role = useAuth((s) => s.role)
  const showMoney = canSeeMoney(role)
  const isAdmin = canAdminister(role)

  const [rows, setRows] = useState<ProjectSpend[] | null>(null)
  const [pulse, setPulse] = useState<Map<string, ProjectPulse>>(new Map())
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null)
  const [compliance, setCompliance] = useState<ComplianceAlert | null>(null)
  const [client, setClient] = useState<ClientAttention | null>(null)
  const [bg, setBg] = useState<BgAlert | null>(null)
  const [insurance, setInsurance] = useState<InsuranceAlert | null>(null)
  const [pnl, setPnl] = useState<Map<string, ProjectPnl>>(new Map())
  const [totals, setTotals] = useState<CompanyPnl | null>(null)
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

    // Profitability per project. v_project_pnl returns zero rows for a
    // supervisor, so this is safe to call unconditionally — but there's no
    // reason to spend the round trip when the card will hide the figures
    // anyway.
    if (canSeeMoney(role)) {
      fetchProjectPnl()
        .then((rows) => {
          if (!cancelled) setPnl(new Map(rows.map((r) => [r.project_id, r])))
        })
        .catch(() => {})

      // Totals summed in Postgres, scoped to whatever this person can see —
      // never added up in the browser (CLAUDE.md rule 2).
      fetchCompanyPnl()
        .then((c) => {
          if (!cancelled) setTotals(c)
        })
        .catch(() => {})
    }

    // What the client is waiting on (073). security_invoker, so a supervisor
    // sees nothing (client_messages_read and the approvals policies both need
    // membership plus the right role) and the strip does not render for them.
    // Returns null before 073 is applied, which has the same effect.
    fetchClientAttention()
      .then((c) => {
        if (!cancelled) setClient(c)
      })
      .catch(() => {})

    // Compliance counts. RLS gives a supervisor zeroes rather than an error,
    // and the query returns null before migration 028 — either way the strip
    // just doesn't render.
    if (canManageCompliance(role)) {
      fetchComplianceAlert()
        .then((c) => {
          if (!cancelled) setCompliance(c)
        })
        .catch(() => {})

      // Same shape: RLS gives a supervisor zeroes, and the query returns null
      // before migration 033, so the strip simply doesn't render.
      fetchBgAlert()
        .then((b) => {
          if (!cancelled) setBg(b)
        })
        .catch(() => {})

      fetchInsuranceAlert()
        .then((i) => {
          if (!cancelled) setInsurance(i)
        })
        .catch(() => {})
    }

    return () => {
      cancelled = true
    }
  }, [role])

  const totalAlerts = [...pulse.values()].reduce(
    (n, p) => n + p.low_stock_count,
    0,
  )

  return (
    <>
      <PageHeader title="Command" width="wide" />

      <div className="page-w-wide px-5 py-6">
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
                : isAdmin
                  ? 'Create your first project, then add the team who will work on it.'
                  : 'Projects you are assigned to will appear here with spend against budget.'
            }
            actionLabel={!failed && isAdmin ? 'New project' : undefined}
            actionTo={!failed && isAdmin ? '/admin' : undefined}
          />
        )}

        {client !== null && <ClientStrip alert={client} />}
        {compliance !== null && <ComplianceStrip alert={compliance} />}
        {bg !== null && <BgStrip alert={bg} />}
        {insurance !== null && <InsuranceStrip alert={insurance} />}

        {rows && rows.length > 0 && (
          <>
            <FadeUp>
              <PortfolioCard
                portfolio={portfolio}
                totals={totals}
                projectCount={rows.length}
                totalAlerts={totalAlerts}
                showMoney={showMoney}
              />
            </FadeUp>

            <div className="mt-8 mb-4 flex items-center justify-between gap-3">
              <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                By project
              </p>
              {/* Founder only — the route is guarded and RLS enforces it too. */}
              {isAdmin && (
                <Link
                  to="/admin"
                  className="flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-primary"
                >
                  <Settings2 className="size-4" aria-hidden="true" />
                  Manage
                </Link>
              )}
            </div>

            {/* One column on a phone — two 180px cards can't hold a
                ₹96,76,736 figure legibly. Two up from 640px. */}
            <Stagger className="card-grid card-grid-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {rows.map((p) => (
                <RevealItem key={p.project_id} className="h-full">
                  <ProjectCard
                    project={p}
                    pulse={pulse.get(p.project_id)}
                    pnl={pnl.get(p.project_id)}
                    showMoney={showMoney}
                  />
                </RevealItem>
              ))}
            </Stagger>
          </>
        )}

        {/* Per device, so it lives on the screen everyone opens first. */}
        <PushCard />
      </div>
    </>
  )
}

/* ---------------- Deadline strips ---------------- */

/**
 * One line, and ONLY when something is actually due. A dashboard banner that is
 * always present stops being read, so every caller returns null on a clear
 * count rather than rendering a reassuring "all good" row.
 *
 * Red when something has already lapsed, amber when it is merely approaching —
 * the two states mean different things to whoever is looking.
 */
function AlertStrip({
  icon: Icon,
  label,
  parts,
  urgent,
  to,
  trailing,
}: {
  icon: typeof CalendarClock
  label: string
  parts: string[]
  urgent: boolean
  to: string
  trailing?: string
}) {
  if (parts.length === 0) return null

  return (
    <FadeUp>
      <Link
        to={to}
        className={cn(
          'mb-5 flex items-center gap-3 rounded-xl px-4 py-3 transition-colors',
          urgent
            ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
            : 'bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-[var(--warning)]',
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium">
          {label} — {parts.join(' · ')}
        </span>
        {trailing && (
          <span className="ml-auto hidden truncate text-[13px] opacity-80 sm:block">
            {trailing}
          </span>
        )}
        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
      </Link>
    </FadeUp>
  )
}

/**
 * WHAT THE CLIENT IS WAITING ON — first strip, above compliance and the expiry
 * registers, because a person waiting on an answer outranks a date on a
 * calendar.
 *
 * Urgent ONLY when the client asked for a change and nobody has looked. An
 * approval needs no action, and a strip that turns red for good news teaches
 * people to ignore red. The unseen counts clear themselves the moment somebody
 * opens the register, so this cannot become permanent — which is the whole
 * reason there is no stored "important" flag behind it.
 */
function ClientStrip({ alert }: { alert: ClientAttention }) {
  const parts: string[] = []
  if (alert.unseen_rejections > 0)
    parts.push(
      alert.unseen_rejections === 1
        ? '1 change requested'
        : `${alert.unseen_rejections} changes requested`,
    )
  if (alert.unread_messages > 0)
    parts.push(
      alert.unread_messages === 1
        ? '1 unread message'
        : `${alert.unread_messages} unread messages`,
    )
  if (alert.unseen_approvals > 0)
    parts.push(
      alert.unseen_approvals === 1
        ? '1 new approval'
        : `${alert.unseen_approvals} new approvals`,
    )
  if (alert.stale_pending > 0)
    parts.push(
      alert.stale_pending === 1
        ? '1 waiting on them'
        : `${alert.stale_pending} waiting on them`,
    )

  return (
    <AlertStrip
      icon={MessageSquare}
      label="From your client"
      parts={parts}
      urgent={alert.unseen_rejections > 0}
      // Messages, because that is where a conversation continues. The approvals
      // register is one tab away and marks itself seen when opened.
      to={alert.unread_messages > 0 ? '/tasks/messages' : '/tasks/approvals'}
      trailing={
        // The age, not the count — three items pending is normal, one of them
        // pending nine weeks is what stalls a job (the 060 rule).
        alert.stale_pending > 0 && alert.oldest_pending_days
          ? `Oldest: ${alert.oldest_pending_days} days`
          : undefined
      }
    />
  )
}

function ComplianceStrip({ alert }: { alert: ComplianceAlert }) {
  const parts: string[] = []
  if (alert.overdue_count > 0) parts.push(`${alert.overdue_count} overdue`)
  if (alert.due_week_count > 0)
    parts.push(`${alert.due_week_count} due this week`)

  return (
    <AlertStrip
      icon={CalendarClock}
      label="Compliance"
      parts={parts}
      urgent={alert.overdue_count > 0}
      to="/money/compliance"
      trailing={
        alert.next_title
          ? `Next: ${alert.next_title}${alert.next_due_date ? ` · ${alert.next_due_date}` : ''}`
          : undefined
      }
    />
  )
}

function BgStrip({ alert }: { alert: BgAlert }) {
  const parts: string[] = []
  if (alert.expired_count > 0) parts.push(`${alert.expired_count} expired`)
  if (alert.expiring_count > 0)
    parts.push(`${alert.expiring_count} expiring within 30 days`)

  return (
    <AlertStrip
      icon={Landmark}
      label="Bank guarantees"
      parts={parts}
      urgent={alert.expired_count > 0}
      to="/money/retention"
      trailing={
        alert.next_bg_number
          ? `Next: ${alert.next_bg_number}${alert.next_expiry ? ` · ${alert.next_expiry}` : ''}`
          : undefined
      }
    />
  )
}

/** Lapsed cover is the worst of the three — hence the same red treatment. */
function InsuranceStrip({ alert }: { alert: InsuranceAlert }) {
  const parts: string[] = []
  if (alert.expired_count > 0)
    parts.push(`${alert.expired_count} lapsed`)
  if (alert.expiring_count > 0)
    parts.push(`${alert.expiring_count} expiring within 30 days`)

  return (
    <AlertStrip
      icon={ShieldCheck}
      label="Insurance"
      parts={parts}
      urgent={alert.expired_count > 0}
      to="/money/insurance"
      trailing={
        alert.next_policy
          ? `Next: ${alert.next_policy}${alert.next_expiry ? ` · ${alert.next_expiry}` : ''}`
          : undefined
      }
    />
  )
}

/* ---------------- All projects ---------------- */

function PortfolioCard({
  portfolio,
  totals,
  projectCount,
  totalAlerts,
  showMoney,
}: {
  portfolio: PortfolioSummary | null
  /** margin across every project this person can see */
  totals: CompanyPnl | null
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
            <Metric
              label="Total spent"
              value={<Figure value={portfolio.total_spent} />}
              big
            />
            <Metric
              label="Total budget"
              value={<Figure value={portfolio.total_budget} />}
            />
            <Metric
              label={over ? 'Over budget' : 'Remaining'}
              value={<Figure value={Math.abs(portfolio.remaining)} />}
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

          {/* Profit across every project this person can see. Spend answers
              "what has gone out"; this answers "are we making anything" — the
              question the spend figure alone can't. */}
          {totals && totals.revenue > 0 && <TotalMargin totals={totals} />}
        </>
      )}
    </section>
  )
}

/**
 * Combined margin across the visible projects, summed in Postgres by
 * fn_company_pnl — never added up here.
 */
function TotalMargin({ totals }: { totals: CompanyPnl }) {
  const tone = marginTone(totals.gross_margin)

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className={cn('flex items-end justify-between gap-4', MARGIN_TEXT[tone])}>
        <div>
          <p className="text-[11px] tracking-[0.12em] uppercase">
            {tone === 'loss'
              ? 'Overall loss'
              : tone === 'breakeven'
                ? 'Break-even'
                : 'Overall margin'}
          </p>
          <p className="figure mt-1.5 text-[26px] leading-none font-semibold">
            {formatInr(Math.abs(totals.gross_margin))}
          </p>
        </div>
        {totals.blended_margin_pct !== null && (
          <p className="text-sm font-medium tabular-nums">
            {totals.blended_margin_pct}%
          </p>
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Revenue {formatInr(totals.revenue)} · Cost {formatInr(totals.total_cost)}
      </p>

      {(totals.profitable_count > 0 || totals.bleeding_count > 0) && (
        <p className="mt-1.5 text-[13px]">
          {totals.profitable_count > 0 && (
            <span className="text-positive">
              {totals.profitable_count} in profit
            </span>
          )}
          {totals.profitable_count > 0 && totals.bleeding_count > 0 && (
            <span className="text-muted-foreground"> · </span>
          )}
          {totals.bleeding_count > 0 && (
            <span className="font-medium text-destructive">
              {totals.bleeding_count} losing money
            </span>
          )}
        </p>
      )}
    </div>
  )
}

function Metric({
  label,
  value,
  big,
  tone,
}: {
  label: string
  /** ReactNode, so a <Figure> can count up in place of a formatted string. */
  value: ReactNode
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
  pnl,
  showMoney,
}: {
  project: ProjectSpend
  pulse: ProjectPulse | undefined
  pnl: ProjectPnl | undefined
  showMoney: boolean
}) {
  const bar = barGeometry(project.total_spent, project.total_budget)
  const noBudget = !bar.hasBudget
  const pct = project.pct_used

  return (
    <Link
      to={`/project/${project.project_id}`}
      className="paper card-interactive flex h-full flex-col p-5 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
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
              <Figure value={project.total_spent} />
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

      {showMoney && pnl && <MarginLine pnl={pnl} />}

      <StatsRow pulse={pulse} />
    </Link>
  )
}

/**
 * Profit or loss on this project — revenue less cost, straight from
 * v_project_pnl.
 *
 * A project with revenue and NO recorded cost computes to a 100% margin, which
 * is arithmetically true and completely misleading: it means work hasn't
 * started, not that it's wildly profitable. Saying so is more use than a
 * triumphant number nobody should trust.
 */
function MarginLine({ pnl }: { pnl: ProjectPnl }) {
  const tone = marginTone(pnl.gross_margin)

  if (pnl.revenue === 0) {
    return (
      <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
        No contract value set — profitability can't be worked out yet.
      </p>
    )
  }

  if (pnl.total_cost === 0) {
    return (
      <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
        No cost recorded yet, so there is no margin to report.
      </p>
    )
  }

  // Word and figure share the tone — see marginTone in lib/format.
  return (
    <div
      className={cn(
        'mt-4 flex items-baseline justify-between gap-3 border-t border-border pt-3',
        MARGIN_TEXT[tone],
      )}
    >
      <span className="text-[11px] tracking-[0.1em] uppercase">
        {MARGIN_LABEL[tone]}
      </span>
      <span className="text-right">
        <span className="figure text-[19px] leading-none font-semibold">
          {formatInr(Math.abs(pnl.gross_margin))}
        </span>
        {pnl.margin_pct !== null && (
          <span className="ml-2 text-xs font-medium tabular-nums">
            {pnl.margin_pct}%
          </span>
        )}
      </span>
    </div>
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
