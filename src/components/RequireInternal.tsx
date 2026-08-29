import { Navigate, Outlet, useOutletContext } from 'react-router-dom'
import { useAuth } from '@/store/auth'

/**
 * Keeps a client out of the internal app entirely.
 *
 * WHY THIS IS ONE GUARD AND NOT FORTY
 * -----------------------------------
 * It wraps the whole `<AppShell>` route, so every internal screen — including
 * ones added next year by somebody who has never read migration 065 — is
 * covered by default. A per-screen check would be a list somebody eventually
 * forgets to add to, and the thing they forget would be the leak.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not the security boundary. Migration 065 is: `is_member()` returns
 * false for a client, every internal table's RLS refuses them, and the fourteen
 * `using (true)` policies were closed. A client who defeated this guard would
 * reach a set of screens that all render empty.
 *
 * This exists because "empty internal screens" is a bad experience and a
 * confusing one — a client seeing "No projects yet" on a Command dashboard
 * reasonably concludes the app is broken, not that they are in the wrong
 * building.
 */
export function RequireInternal() {
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

  if (role === 'client') {
    return <Navigate to="/portal" replace />
  }

  // Forwards the parent outlet context for the same reason RequireRole does —
  // a bare <Outlet /> publishes undefined and children lose what their siblings
  // receive.
  return <Outlet context={parentContext} />
}

/**
 * The mirror: keeps internal staff out of the client portal.
 *
 * Not a security matter — a founder seeing the portal leaks nothing, and every
 * `v_client_*` view returns zero rows for them anyway because
 * `fn_client_project()` is null. It is here so a founder who follows a link
 * lands somewhere useful instead of on an empty portal wondering what broke.
 */
export function RequireClient() {
  const role = useAuth((s) => s.role)
  const loading = useAuth((s) => s.loading)

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  if (role !== 'client') {
    return <Navigate to="/dashboard" replace />
  }

  return <Outlet />
}
