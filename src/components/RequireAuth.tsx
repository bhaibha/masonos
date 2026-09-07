import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { AccountClosed } from '@/components/AccountClosed'
import { useAuth } from '@/store/auth'

export function RequireAuth() {
  const user = useAuth((s) => s.user)
  const loading = useAuth((s) => s.loading)
  const profile = useAuth((s) => s.profile)
  const mfaPending = useAuth((s) => s.mfaPending)
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
   * MFA. Checked FIRST of the three, because it is the only one that answers
   * "is this really them". A password alone got us this far: signInWithPassword
   * succeeds for a user with a verified factor and hands back an aal1 session.
   * Sending somebody to set a password, or telling them their account is
   * closed, before they have proved who they are would be answering the wrong
   * question in the wrong order.
   *
   * The gate lives here rather than in the login form because an aal1 session
   * survives a reload — a check that only ran after the password was typed
   * could be walked past by refreshing.
   */
  if (mfaPending && location.pathname !== '/mfa') {
    return <Navigate to="/mfa" replace />
  }

  /**
   * 078. A deactivated account. It signs in — Supabase issues a JWT whatever
   * `profiles.is_active` says — but my_role() now returns NULL, so every policy
   * refuses and every screen would render empty. Saying so beats showing a
   * dashboard of zeros, which reads as a fact about the company rather than a
   * refusal (the 056/063/066 rule).
   *
   * Checked BEFORE the password prompt below: sending somebody to choose a
   * password for an account that is closed would be the worse of the two.
   *
   * `profile === null` deliberately does NOT land here — that is a failed fetch
   * (offline, or a pending migration), and treating it as deactivation would
   * lock the whole firm out of a working app on one bad request.
   */
  if (profile && !profile.is_active) {
    return <AccountClosed />
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
