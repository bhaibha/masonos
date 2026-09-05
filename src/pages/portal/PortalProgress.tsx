import { useEffect, useState } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { formatInr } from '@/lib/format'
import {
  type ClientProgressRow,
  type ClientProgressSummary,
  type ClientProject,
  type ClientSpendCategory,
  type ClientSpendSummary,
  fetchClientProject,
  fetchProgress,
  fetchProgressSummary,
  fetchSpendByCategory,
  fetchSpendSummary,
} from '@/lib/queries/portal'
import { cn } from '@/lib/utils'
import { Hammer } from 'lucide-react'

export default function PortalProgress() {
  const [project, setProject] = useState<ClientProject | null>(null)
  const [summary, setSummary] = useState<ClientProgressSummary | null>(null)
  const [rows, setRows] = useState<ClientProgressRow[] | null>(null)
  const [spend, setSpend] = useState<ClientSpendSummary | null>(null)
  const [cats, setCats] = useState<ClientSpendCategory[]>([])

  useEffect(() => {
    // allSettled: the open-book panel failing must not blank the progress list.
    void (async () => {
      const [p, s, r, sp, c] = await Promise.allSettled([
        fetchClientProject(),
        fetchProgressSummary(),
        fetchProgress(),
        fetchSpendSummary(),
        fetchSpendByCategory(),
      ])
      if (p.status === 'fulfilled') setProject(p.value)
      if (s.status === 'fulfilled') setSummary(s.value)
      setRows(r.status === 'fulfilled' ? r.value : [])
      if (sp.status === 'fulfilled') setSpend(sp.value)
      if (c.status === 'fulfilled') setCats(c.value)
    })()
  }, [])

  const grouped = groupByPhase(rows ?? [])

  return (
    <div className="space-y-6">
      {/* ---------- the headline ---------- */}
      <div className="paper p-6">
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Your project
        </p>
        <p className="font-heading mt-1 text-[26px] leading-tight font-semibold">
          {project?.name ?? '—'}
        </p>
        {project?.site_address && (
          <p className="mt-1 text-sm text-muted-foreground">{project.site_address}</p>
        )}

        {summary?.pct_complete != null && (
          <div className="mt-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-muted-foreground">Overall progress</p>
              <p className="figure text-2xl leading-none">{summary.pct_complete}%</p>
            </div>
            <Rail pct={summary.pct_complete} />
            <p className="mt-2 text-xs text-muted-foreground">
              {summary.completed_count} of {summary.activity_count} stages
              complete
              {summary.ends
                ? ` · planned to finish ${fmtDate(summary.ends)}`
                : ''}
            </p>
            {/* Weighted by value, and saying so — a plain average would call a
                job half done when the expensive half has not started. */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              Weighted by the value of each stage, not a simple average.
            </p>
          </div>
        )}
      </div>

      {/* ---------- open book ---------- */}
      {spend && spend.revised_contract_value > 0 && (
        <div className="paper p-6">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Open book
          </p>

          {/* When variations exist, show the ARITHMETIC rather than one number.
              A client who approved three variations and sees "112% of contract"
              reasonably concludes the job is over budget — when in fact they
              asked for more work and agreed the cost. The baseline has to say
              which contract it means (075). */}
          {spend.variations_count > 0 ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-sm text-muted-foreground">
                  Original contract
                </span>
                <span className="figure text-sm tabular-nums">
                  {formatInr(spend.contract_value)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-sm text-muted-foreground">
                  {spend.variations_count === 1
                    ? '1 approved variation'
                    : `${spend.variations_count} approved variations`}
                </span>
                <span className="figure text-sm tabular-nums">
                  + {formatInr(spend.variations_value)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
                <span className="text-sm font-medium">Revised contract</span>
                <span className="figure text-base tabular-nums">
                  {formatInr(spend.revised_contract_value)}
                </span>
              </div>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
            {spend.variations_count === 0 && (
              <Figure label="Contract value" value={formatInr(spend.contract_value)} />
            )}
            <Figure label="Spent so far" value={formatInr(spend.spent)} />
            {spend.pct_of_contract != null && (
              <Figure
                label={
                  spend.variations_count > 0
                    ? 'Of revised contract'
                    : 'Of contract'
                }
                value={`${spend.pct_of_contract}%`}
              />
            )}
          </div>

          {cats.length > 0 && (
            <ul className="mt-5 space-y-2.5 border-t border-border pt-4">
              {cats.map((c) => (
                <li key={c.category} className="flex items-baseline justify-between gap-4">
                  <span className="text-sm">{c.category}</span>
                  <span className="figure text-sm tabular-nums">
                    {formatInr(c.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            Spend is shown by category. Individual supplier invoices and rates
            are commercial records and are not published here.
          </p>
        </div>
      )}

      {/* ---------- the programme ---------- */}
      {rows === null && <ListSkeleton rows={5} />}

      {rows?.length === 0 && (
        <EmptyState
          icon={Hammer}
          title="The programme is being prepared"
          body="Once the build schedule is set, every stage and its progress will appear here."
        />
      )}

      {grouped.length > 0 && (
        <Stagger className="space-y-6">
          {grouped.map(([phase, items]) => (
            <RevealItem key={phase}>
              <div className="paper p-5">
                <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                  {phase}
                </p>
                <ul className="mt-3 space-y-3">
                  {items.map((a) => (
                    <li key={a.activity_id}>
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="text-sm">{a.name}</span>
                        <span
                          className={cn(
                            'figure shrink-0 text-sm tabular-nums',
                            a.pct_complete >= 100 && 'text-[var(--positive)]',
                          )}
                        >
                          {a.pct_complete}%
                        </span>
                      </div>
                      <Rail pct={a.pct_complete} thin />
                    </li>
                  ))}
                </ul>
              </div>
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className="figure mt-0.5 text-xl leading-tight tabular-nums">{value}</p>
    </div>
  )
}

function Rail({ pct, thin }: { pct: number; thin?: boolean }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div
      className={cn(
        'mt-2 overflow-hidden rounded-full bg-secondary',
        thin ? 'h-1.5' : 'h-2',
      )}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-500',
          pct >= 100 ? 'bg-[var(--positive)]' : 'bg-primary',
        )}
        style={{ width: `${w}%` }}
      />
    </div>
  )
}

function groupByPhase(rows: ClientProgressRow[]): [string, ClientProgressRow[]][] {
  const map = new Map<string, ClientProgressRow[]>()
  for (const r of rows) {
    const key = r.phase ?? 'Programme'
    const list = map.get(key)
    if (list) list.push(r)
    else map.set(key, [r])
  }
  return [...map.entries()]
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
