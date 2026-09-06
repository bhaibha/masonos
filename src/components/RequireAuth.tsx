import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/store/auth'

export function RequireAuth() {
  const user = useAuth((s) => s.user)
  const loading = useAuth((s) => s.loading)
  const profile = useAuth((s) => s.profile)
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  /**
   * 077. An account created with a password the FOUNDER chose does not get to
   * carry on until they pick their own. Placed here rather than on each screen
   * so it covers every internal route AND the client portal — both trees sit
   * under this guard.
   *
   * It is a ROUTE, not a security boundary: RLS cannot refuse a query because
   * somebody has not changed their password, and the flag is cleared by the
   * user themselves through fn_clear_password_change. What it protects against
   * is a password the founder knows staying live for a year, not against the
   * account's own owner.
   */
  if (profile?.must_change_password && location.pathname !== '/set-password') {
    return <Navigate to="/set-password" replace />
  }

  return <Outlet />
}
