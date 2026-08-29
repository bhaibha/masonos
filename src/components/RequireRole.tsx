import { Outlet, useOutletContext } from 'react-router-dom'
import type { UserRole } from '@/lib/types'
import { useAuth } from '@/store/auth'

/**
 * Second line of defence only. RLS in Postgres is the real boundary — this
 * just avoids showing a screen that would return empty or error.
 *
 * Forwards the parent route's outlet context. A bare <Outlet /> here would
 * publish `undefined` to children, so any screen nested inside this guard
 * would lose the context its siblings receive (this is what crashed
 * BudgetEditor: /money/budget/edit sits inside a second RequireRole, while
 * Ledger and ExpenseForm hang directly off MoneyLayout).
 */
export function RequireRole({ allow }: { allow: UserRole[] }) {
  const role = useAuth((s) => s.role)
  const loading = useAuth((s) => s.loading)
  const parentContext = useOutletContext<unknown>()

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  if (!role || !allow.includes(role)) {
    return (
      <div className="page-w px-6 py-20 text-center">
        <p className="text-sm text-muted-foreground">
          This section isn't available for your role.
        </p>
      </div>
    )
  }

  return <Outlet context={parentContext} />
}
