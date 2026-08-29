import { Download, TrendingUp } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { downloadCsv, toCsvSections } from '@/lib/csv'
import { errText } from '@/lib/errText'
import {
  formatInr,
  MARGIN_LABEL,
  MARGIN_TEXT,
  marginTone,
} from '@/lib/format'
import {
  fetchCompanyNet,
  fetchOverheadSummary,
  periodRange,
} from '@/lib/queries/overheads'
import {
  fetchCompanyPnl,
  fetchPnlCategories,
  fetchProjectPnl,
} from '@/lib/queries/pnl'
import {
  canAdminister,
  type CompanyNet,
  type CompanyPnl,
  type OverheadSummaryRow,
  type PnlCategoryRow,
  PNL_PERIODS,
  type PnlPeriod,
  type ProjectPnl,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

/**
 * Company P&L and project profitability.
 *
 * Every figure comes from v_project_pnl or fn_company_pnl — this file formats
 * and nothing else. The one arithmetic operation below is a percentage for a
 * progress bar's width.
 */
export default function Pnl() {
  const role = useAuth((s) => s.role)
  const isFounder = canAdminister(role)

  const [period, setPeriod] = useState<PnlPeriod>('fy')
  const [rows, setRows] = useState<ProjectPnl[] | null>(null)
  const [company, setCompany] = useState<CompanyPnl | null>(null)
  const [net, setNet] = useState<CompanyNet | null>(null)
  const [overheads, setOverheads] = useState<OverheadSummaryRow[]>([])

  const reload = useCallback(async () => {
    const { from, to } = periodRange(period)
    try {
      const [projects, co, n, oh] = await Promise.all([
        fetchProjectPnl(),
        fetchCompanyPnl().catch(() => null),
        fetchCompanyNet(from, to),
        fetchOverheadSummary(from, to).catch(() => [] as OverheadSummaryRow[]),
      ])
      setRows(projects)
      setCompany(co)
      setNet(n)
      setOverheads(oh)
    } catch (err) {
      toast.error('Could not load the P&L', { description: errText(err) })
      setRows([])
    }
  }, [period])

  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * Two sections in one file, because the CA wants both halves of the same
   * question: what each contract earned, and what the firm spent to exist.
   * Blank line between them — Excel keeps them as separate blocks.
   */
  function exportCsv() {
    if (!rows?.length) {
      toast.error('Nothing to export')
      return
    }

    const { from, to } = periodRange(period)

    const sections: { headers: string[]; rows: unknown[][] }[] = [
      {
        headers: [
          'PROJECT MARGINS (lifetime to date)',
        ],
        rows: [],
      },
      {
        headers: [
          'Project', 'Status', 'Contract value', 'Approved variations',
          'Revenue', 'Expenses', 'Contractor bills', 'Total cost',
          'Gross margin', 'Margin %', 'Retention held (unpaid)',
          'Budget', 'Budget remaining', 'Committed (open POs)',
          'Projected cost', 'Projected margin',
        ],
        rows: rows.map((p) => [
          p.name, p.project_status, p.contract_value, p.variations_value,
          p.revenue, p.expense_cost, p.contractor_cost, p.total_cost,
          p.gross_margin, p.margin_pct ?? '', p.retention_held,
          p.budget_total, p.budget_remaining, p.committed_open,
          p.projected_cost ?? '', p.projected_margin ?? '',
        ]),
      },
    ]

    // Overheads only where the caller is allowed them — the same rule RLS
    // applies, so a PM's export cannot carry the firm's cost base out of the
    // building in a spreadsheet.
    if (net?.sees_overheads) {
      sections.push(
        { headers: [`COMPANY OVERHEADS — ${from} to ${to}`], rows: [] },
        {
          headers: ['Category', 'Entries', 'Amount', 'GST', 'Total'],
          rows: overheads.map((o) => [
            o.category_name,
            o.entry_count,
            o.amount,
            o.gst_amount,
            o.total,
          ]),
        },
        {
          headers: ['NET POSITION', 'Amount'],
          rows: [
            ['Project gross margin (lifetime to date)', net.project_margin],
            [`Less company overheads (${from} to ${to})`, net.overheads ?? 0],
            ['Net position', net.net_position ?? 0],
          ],
        },
      )
    }

    downloadCsv(
      `mason-os-pnl-${new Date().toISOString().slice(0, 10)}`,
      toCsvSections(sections),
    )
    toast.success('Exported', {
      description: net?.sees_overheads
        ? 'Project margins, overheads by category and the net position.'
        : 'Opens in Excel — send it straight to your CA.',
    })
  }

  if (rows === null) return <ListSkeleton rows={4} />

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="Nothing to report yet"
        body="A project needs a contract value and some recorded cost before its profitability means anything."
      />
    )
  }

  const { from, to } = periodRange(period)

  return (
    <div className="space-y-4 pb-6">
      {/* The period governs OVERHEADS only. Project margins are lifetime —
          a contract is judged over its whole life, not by the calendar. */}
      <PeriodPicker value={period} onChange={setPeriod} />

      {/* Layer (c): the true net. Founder and accounts only — fn_company_net
          returns sees_overheads false for a PM and a null net with it. */}
      {net?.sees_overheads && (
        <NetCard net={net} period={period} from={from} to={to} />
      )}

      {/* Founder only — fn_company_pnl returns nothing for anyone else. */}
      {isFounder && company && <CompanyCard co={company} />}

      {/* Layer (b): what the firm spends to exist. */}
      {net?.sees_overheads && (
        <OverheadBreakdown rows={overheads} from={from} to={to} />
      )}

      {/* Layer (a): each project. */}
      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          By project
        </p>
        <Button variant="outline" className="h-10" onClick={exportCsv}>
          <Download className="size-4" aria-hidden="true" />
          Export for CA
        </Button>
      </div>

      <Stagger className="card-grid">
        {rows.map((p) => (
          <RevealItem key={p.project_id}>
            <ProjectCard pnl={p} />
          </RevealItem>
        ))}
      </Stagger>

      <p className="pt-2 text-xs text-muted-foreground">
        Margin is revenue less cost. Retention held is shown separately because
        it is already inside cost — the work is done and owed, just not yet
        paid. Deducting it twice would flatter every project holding it.
      </p>
    </div>
  )
}

/* ---------------- Period ---------------- */

function PeriodPicker({
  value,
  onChange,
}: {
  value: PnlPeriod
  onChange: (p: PnlPeriod) => void
}) {
  return (
    <div className="flex gap-1 rounded-xl bg-secondary/60 p-1">
      {PNL_PERIODS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onChange(p.value)}
          className={cn(
            'h-10 flex-1 rounded-lg text-sm font-medium transition-colors',
            value === p.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

/* ---------------- Net position (the hero) ---------------- */

/**
 * The one number on this screen that is actually profit.
 *
 * The two inputs cover different spans on purpose and the card says so out
 * loud: margin is lifetime-to-date, overheads are the chosen period. Comparing
 * a single month's rent against lifetime margin is a narrower question than it
 * looks, and a screen that quietly mixed the two would be the easiest way in
 * this app to mislead yourself.
 */
function NetCard({
  net,
  period,
  from,
  to,
}: {
  net: CompanyNet
  period: PnlPeriod
  from: string
  to: string
}) {
  const value = net.net_position ?? 0
  const tone = marginTone(value)

  return (
    <section className="paper p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Net position
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {period === 'all' ? 'all overheads' : `${from} → ${to}`}
        </span>
      </div>

      <div className={cn('mt-5', MARGIN_TEXT[tone])}>
        <p className="text-[11px] tracking-[0.12em] uppercase">
          {tone === 'loss'
            ? 'Net loss'
            : tone === 'breakeven'
              ? 'Break-even'
              : 'Net profit'}
        </p>
        <p className="figure mt-1 text-[38px] leading-none font-semibold">
          {formatInr(Math.abs(value))}
        </p>
      </div>

      <dl className="mt-6 space-y-2 border-t border-border pt-4 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt>
            Project gross margin
            <span className="block text-xs text-muted-foreground">
              all projects, lifetime to date
            </span>
          </dt>
          <dd className="shrink-0 font-medium tabular-nums">
            {formatInr(net.project_margin)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt>
            Less company overheads
            <span className="block text-xs text-muted-foreground">
              {net.overhead_count}{' '}
              {net.overhead_count === 1 ? 'entry' : 'entries'} in this period
            </span>
          </dt>
          <dd className="shrink-0 font-medium tabular-nums">
            − {formatInr(net.overheads ?? 0)}
          </dd>
        </div>
      </dl>

      {net.overhead_count === 0 && (
        <p className="mt-4 rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          No overheads recorded for this period, so the net equals the gross
          margin. Record rent, salaries and fees on the Overheads tab before
          treating this as profit.
        </p>
      )}
    </section>
  )
}

/* ---------------- Overheads by category ---------------- */

function OverheadBreakdown({
  rows,
  from,
  to,
}: {
  rows: OverheadSummaryRow[]
  from: string
  to: string
}) {
  if (rows.length === 0) return null

  const total = rows.reduce((s, r) => s + r.total, 0)

  return (
    <section className="paper p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Overheads by category
        </h2>
        <span className="figure text-[17px] font-semibold">
          {formatInr(total)}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {from} to {to}
      </p>

      <ul className="mt-4 space-y-2.5">
        {rows.map((o) => (
          <li key={o.category_id}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{o.category_name}</span>
              <span className="shrink-0 tabular-nums">{formatInr(o.total)}</span>
            </div>
            {/* Share of the firm's cost base — the point of the section is
                seeing which heading is eating the margin. */}
            <div className="mt-1 h-[4px] w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-primary/70"
                style={{
                  width: `${total > 0 ? (o.total / total) * 100 : 0}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ---------------- Company ---------------- */

function CompanyCard({ co }: { co: CompanyPnl }) {
  const tone = marginTone(co.gross_margin)

  return (
    <section className="paper p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Company position
        </h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {co.active_count} active · {co.project_count} total
        </span>
      </div>

      <div className={cn('mt-5', MARGIN_TEXT[tone])}>
        <p className="text-[11px] tracking-[0.12em] uppercase">
          {tone === 'loss'
            ? 'Gross loss'
            : tone === 'breakeven'
              ? 'Break-even'
              : 'Gross margin'}
        </p>
        <p className="figure mt-1 text-[34px] leading-none font-semibold">
          {formatInr(Math.abs(co.gross_margin))}
        </p>
        {co.blended_margin_pct !== null && (
          <p className="mt-1.5 text-sm font-medium tabular-nums">
            {co.blended_margin_pct}% blended
          </p>
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Metric label="Revenue" value={formatInr(co.revenue)} />
        <Metric label="Cost" value={formatInr(co.total_cost)} />
        <Metric
          label="Retention held"
          value={formatInr(co.retention_held)}
          tone={co.retention_held > 0 ? 'warning' : undefined}
        />
        <Metric
          label="Committed"
          value={formatInr(co.committed_open)}
          hint="Approved orders not yet invoiced"
        />
      </div>

      {(co.profitable_count > 0 || co.bleeding_count > 0) && (
        <p className="mt-5 border-t border-border pt-4 text-sm">
          <span className="text-[var(--positive)]">
            {co.profitable_count} in profit
          </span>
          {co.bleeding_count > 0 && (
            <>
              <span className="text-muted-foreground"> · </span>
              <span className="font-medium text-destructive">
                {co.bleeding_count} losing money
              </span>
            </>
          )}
        </p>
      )}
    </section>
  )
}

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone?: 'warning'
  hint?: string
}) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'figure mt-1.5 text-[19px] leading-none font-semibold',
          tone === 'warning' && 'text-[var(--warning)]',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/* ---------------- One project ---------------- */

function ProjectCard({ pnl: p }: { pnl: ProjectPnl }) {
  const [open, setOpen] = useState(false)
  const [cats, setCats] = useState<PnlCategoryRow[] | null>(null)
  const tone = marginTone(p.gross_margin)
  // Revenue but nothing spent: the margin is arithmetically 100% and means
  // nothing. Treat it as "not started" rather than as a triumph.
  const notStarted = p.total_cost === 0 && p.revenue > 0

  useEffect(() => {
    if (!open || cats !== null) return
    fetchPnlCategories(p.project_id)
      .then(setCats)
      .catch(() => setCats([]))
  }, [open, cats, p.project_id])

  // Layout only — how much of the revenue bar the cost fills.
  const costShare =
    p.revenue > 0 ? Math.min((p.total_cost / p.revenue) * 100, 100) : 0

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[18px] leading-tight font-semibold">
            {p.name}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {p.project_status === 'active'
              ? 'Active'
              : p.project_status === 'on_hold'
                ? 'On hold'
                : 'Completed'}
          </p>
        </div>
        {/* Label and figure share one colour — green profit, red loss, blue
            break-even. A muted word beside a red number reads as decoration. */}
        <div className={cn('text-right', !notStarted && MARGIN_TEXT[tone])}>
          <p
            className={cn(
              'text-[11px] tracking-[0.1em] uppercase',
              notStarted && 'text-muted-foreground',
            )}
          >
            {notStarted ? 'Margin' : MARGIN_LABEL[tone]}
          </p>
          {/* Revenue with no cost computes to 100%, which is true and
              useless — it means work hasn't started. Say that instead. */}
          {notStarted ? (
            <p className="mt-1 text-sm text-muted-foreground">Not started</p>
          ) : (
            <>
              <p className="figure text-[24px] leading-none font-semibold">
                {formatInr(Math.abs(p.gross_margin))}
              </p>
              {p.margin_pct !== null && (
                <p className="mt-1 text-xs font-medium tabular-nums">
                  {p.margin_pct}%
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Cost against revenue. Full bar means cost has eaten the contract. */}
      <div className="relative mt-4 h-[6px] w-full overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            tone === 'loss'
              ? 'bg-destructive'
              : tone === 'breakeven'
                ? 'bg-[var(--neutral)]'
                : 'bg-primary',
          )}
          style={{ width: `${costShare}%` }}
        />
      </div>

      <dl className="mt-4 space-y-1.5 text-sm">
        <Row label="Revenue" value={formatInr(p.revenue)} />
        {p.variations_value !== 0 && (
          <Row
            label="of which variations"
            value={formatInr(p.variations_value)}
            muted
          />
        )}
        {p.pending_variations !== 0 && (
          <Row
            label="Pending variations (not counted)"
            value={formatInr(p.pending_variations)}
            muted
          />
        )}
        <Row label="Expenses" value={`− ${formatInr(p.expense_cost)}`} />
        {p.contractor_cost > 0 && (
          <Row
            label="Certified contractor bills"
            value={`− ${formatInr(p.contractor_cost)}`}
          />
        )}
        <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
          <dt className="font-medium">Total cost</dt>
          <dd className="font-semibold tabular-nums">
            {formatInr(p.total_cost)}
          </dd>
        </div>
      </dl>

      {p.retention_held > 0 && (
        <p className="mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          {formatInr(p.retention_held)} of that cost is retention held — owed to
          contractors, not yet paid. It is not deducted twice.
        </p>
      )}

      {/* Forecast, only where a budget makes one meaningful. */}
      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4 text-sm sm:grid-cols-3">
        <Small label="Budget" value={p.budget_total > 0 ? formatInr(p.budget_total) : '—'} />
        <Small
          label="Budget left"
          value={p.budget_total > 0 ? formatInr(p.budget_remaining) : '—'}
          danger={p.budget_total > 0 && p.budget_remaining < 0}
        />
        <Small
          label="Committed"
          value={p.committed_open > 0 ? formatInr(p.committed_open) : '—'}
        />
      </div>

      {p.projected_margin !== null ? (
        <p
          className={cn(
            'mt-3 text-sm',
            p.projected_margin < 0 ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          Projected final margin{' '}
          <span className="font-semibold tabular-nums">
            {formatInr(p.projected_margin)}
          </span>{' '}
          — actual cost plus unspent budget plus open orders.
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          No budget set, so no projection — a forecast needs something to
          forecast against.
        </p>
      )}

      <Button
        variant="outline"
        className="mt-4 h-11 w-full"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide cost breakdown' : 'Cost breakdown by category'}
      </Button>

      {open && (
        <div className="mt-4 border-t border-border pt-4">
          {cats === null ? (
            <ListSkeleton rows={3} />
          ) : cats.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing spent or budgeted on this project yet.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {cats.map((c) => (
                <li key={c.category}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">{c.category}</span>
                    <span
                      className={cn(
                        'shrink-0 tabular-nums',
                        c.over_budget && 'font-medium text-destructive',
                      )}
                    >
                      {formatInr(c.actual)}
                      {c.budget > 0 && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          of {formatInr(c.budget)}
                        </span>
                      )}
                    </span>
                  </div>
                  {c.over_budget && (
                    <p className="text-xs text-destructive tabular-nums">
                      {formatInr(Math.abs(c.variance))} over
                      {c.pct_used !== null && ` · ${c.pct_used}% used`}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  )
}

function Row({
  label,
  value,
  muted,
}: {
  label: string
  value: string
  muted?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn(muted && 'text-xs text-muted-foreground')}>{label}</dt>
      <dd
        className={cn('tabular-nums', muted && 'text-xs text-muted-foreground')}
      >
        {value}
      </dd>
    </div>
  )
}

function Small({
  label,
  value,
  danger,
}: {
  label: string
  value: string
  danger?: boolean
}) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 font-medium tabular-nums',
          danger && 'text-destructive',
        )}
      >
        {value}
      </p>
    </div>
  )
}
