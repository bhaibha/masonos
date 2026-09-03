import { Receipt } from 'lucide-react'
import { useEffect, useState } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { formatInr } from '@/lib/format'
import { type ClientInvoice, fetchInvoices } from '@/lib/queries/portal'
import { cn } from '@/lib/utils'

export default function PortalBills() {
  const [bills, setBills] = useState<ClientInvoice[] | null>(null)

  useEffect(() => {
    void fetchInvoices()
      .then(setBills)
      .catch(() => setBills([]))
  }, [])

  // Totals are display-only sums of figures Postgres already computed for each
  // row. Nothing here derives an amount — no rate, no percentage, no balance
  // that the database has not already stated (CLAUDE.md rule 2).
  const outstanding = (bills ?? []).reduce((n, b) => n + Number(b.outstanding), 0)

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Bills
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your progress bills. Ask your project team about anything that looks
          wrong before paying.
        </p>
      </div>

      {bills && bills.length > 0 && outstanding > 0 && (
        <div className="paper p-5">
          <p className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
            Currently outstanding
          </p>
          <p className="figure mt-1 text-3xl leading-none tabular-nums">
            {formatInr(outstanding)}
          </p>
        </div>
      )}

      {bills === null && <ListSkeleton rows={3} />}

      {bills?.length === 0 && (
        <EmptyState
          icon={Receipt}
          title="No bills yet"
          body="Progress bills appear here as they are issued."
        />
      )}

      {bills && bills.length > 0 && (
        <Stagger className="space-y-3">
          {bills.map((b) => (
            <RevealItem key={b.id}>
              <div className="paper p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-heading text-[17px] leading-tight font-semibold">
                      {b.invoice_number}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {fmtDate(b.invoice_date)}
                      {b.period_from && b.period_to
                        ? ` · work to ${fmtDate(b.period_to)}`
                        : ''}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium',
                      b.is_paid
                        ? 'bg-[var(--positive)]/10 text-[var(--positive)]'
                        : 'bg-secondary text-muted-foreground',
                    )}
                  >
                    {b.is_paid ? 'Paid' : 'Due'}
                  </span>
                </div>

                <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
                  <Row label="Subtotal" value={formatInr(b.subtotal)} />
                  <Row label="GST" value={formatInr(b.gst_amount)} />
                  <Row label="Total" value={formatInr(b.total)} strong />
                  {b.is_paid ? (
                    <Row
                      label={`Paid ${b.paid_on ? fmtDate(b.paid_on) : ''}`.trim()}
                      value={formatInr(b.paid_amount)}
                    />
                  ) : (
                    <Row
                      label="Outstanding"
                      value={formatInr(b.outstanding)}
                      strong
                    />
                  )}
                </dl>
              </div>
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  strong,
}: {
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cn('text-muted-foreground', strong && 'text-foreground')}>
        {label}
      </dt>
      <dd
        className={cn(
          'figure tabular-nums',
          strong ? 'text-base font-medium' : 'text-sm',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
