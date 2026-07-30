import { PiggyBank } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ListSkeleton } from '@/components/Skeleton'
import { useOutletContext } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { formatInr, spendRatio } from '@/lib/format'
import { errText } from '@/lib/errText'
import { fetchBudgetVsActual } from '@/lib/queries/expenses'
import { canEditBudgets, type BudgetVsActual as Row } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import type { MoneyContext } from './MoneyLayout'

export default function BudgetVsActual() {
  const { projectId } = useOutletContext<MoneyContext>()
  const role = useAuth((s) => s.role)

  const [rows, setRows] = useState<Row[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    fetchBudgetVsActual(projectId)
      .then((data) => {
        if (!cancelled) setRows(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          toast.error('Could not load budgets.', { description: errText(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return (
    <div className="space-y-4">

      {rows === null && <ListSkeleton rows={5} />}

      {rows?.length === 0 && (
        <>
          <EmptyState
            icon={PiggyBank}
            title="No budgets set yet"
            body="Set a budget per category and every expense you record will count against it here."
            actionLabel={canEditBudgets(role) ? 'Set budgets' : undefined}
            actionTo={canEditBudgets(role) ? '/money/budget/edit' : undefined}
          />
          <OtherProjectsHint />
        </>
      )}

      {rows && rows.length > 0 && (
        <>
          <Stagger className="paper divide-y divide-border overflow-hidden">
            {rows.map((r) => (
              <RevealItem key={r.category}>
                <CategoryRow row={r} />
              </RevealItem>
            ))}
          </Stagger>
          <p className="text-xs text-muted-foreground">
            Budget, actual and remaining all come from{' '}
            <code className="text-[11px]">v_budget_vs_actual</code>. Categories
            marked <span className="font-medium">Unbudgeted</span> have spend but
            no budget set.
          </p>
        </>
      )}
    </div>
  )
}

function CategoryRow({ row }: { row: Row }) {
  const ratio = spendRatio(row.actual, row.budget)
  const over = row.remaining < 0

  // No budget row at all: "over by" would be nonsense — every rupee is
  // technically over. Flag it as unbudgeted and show the spend plainly.
  if (!row.has_budget) {
    return (
      <div className="space-y-1 px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm font-medium">{row.category}</p>
          <p className="shrink-0 font-heading text-base font-semibold tabular-nums">
            {formatInr(row.actual)}
          </p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Unbudgeted
          </span>
          <span className="text-xs text-muted-foreground">No budget set</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-sm font-medium">{row.category}</p>
        <p
          className={cn(
            'shrink-0 text-sm font-medium tabular-nums',
            over ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {over ? 'Over by ' : ''}
          {formatInr(Math.abs(row.remaining))}
          {!over && ' left'}
        </p>
      </div>

      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-label={`${row.category} spend against budget`}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            over ? 'bg-destructive' : 'bg-primary',
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>

      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>Actual {formatInr(row.actual)}</span>
        <span>Budget {formatInr(row.budget)}</span>
      </div>
    </div>
  )
}
