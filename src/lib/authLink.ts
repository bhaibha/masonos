/**
 * INVITE / RECOVERY LINK CAPTURE — runs at module load, before React renders.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * The invite email landed on /login every time, and no amount of editing the
 * email template could have fixed it. Two independent reasons:
 *
 *   1. `supabase.ts` sets `detectSessionInUrl: false`, so supabase-js never
 *      consumed the token in the URL. No session appeared.
 *   2. With no session, `RequireAuth` renders `<Navigate to="/login">`, and a
 *      react-router navigation to a new path DISCARDS the hash. The token was
 *      destroyed on the way to the wrong screen, so by the time anyone looked
 *      at the address bar the evidence was gone.
 *
 * So the token has to be read and stashed BEFORE the router mounts. This module
 * does that as a side effect of being imported, which is why `App.tsx` imports
 * it first and why the captured value lives in a module-level variable rather
 * than in React state — a redirect, a StrictMode double-render or a remount
 * must not be able to lose it.
 *
 * WHY NOT JUST SET `detectSessionInUrl: true`
 * -------------------------------------------
 * Because it would create a subtler bug. supabase-js would swallow the hash and
 * hand us a valid session, `RequireAuth` would be satisfied, and the invited
 * client would land in the portal WITH NO PASSWORD SET — able to use the app
 * once and never able to sign in again. The whole point of an invite is that it
 * must terminate at a password prompt, so consuming the token is our decision to
 * make, at the moment we are ready to make it.
 *
 * TWO WIRE FORMATS, because Supabase uses both depending on how the link was
 * built:
 *   hash   #access_token=…&refresh_token=…&type=invite   (already verified;
 *          the user came via /auth/v1/verify and was redirected here)
 *   query  ?token_hash=…&type=invite                     (not yet verified; we
 *          call verifyOtp ourselves — this is the template we recommend)
 * Errors arrive the same two ways: #error=…&error_code=otp_expired.
 */

import type { EmailOtpType } from '@supabase/supabase-js'

/** The link types that must end at a password prompt. */
const PASSWORD_TYPES = new Set(['invite', 'recovery'])

/** Types we understand at all. `email_change` deliberately excluded — it is not ours. */
const KNOWN_TYPES = new Set(['invite', 'recovery', 'signup', 'magiclink', 'email'])

export interface AuthLink {
  /** 'invite' | 'recovery' | 'signup' | 'magiclink' | 'email' */
  type: EmailOtpType
  /** Present on the hash form: already verified, just needs installing. */
  accessToken?: string
  refreshToken?: string
  /** Present on the query form: still needs verifyOtp. */
  tokenHash?: string
  /** Set when Supabase reported a failure instead of a token. */
  error?: string
  errorCode?: string
  errorDescription?: string
}

function parse(): AuthLink | null {
  if (typeof window === 'undefined') return null

  // The hash arrives as `#a=b&c=d`, which URLSearchParams reads once the
  // leading '#' is removed.
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const query = new URLSearchParams(window.location.search)

  // Hash first: when a link has been through /auth/v1/verify it carries BOTH a
  // hash session and leftover query params, and the hash is the authoritative
  // half.
  const pick = (k: string) => hash.get(k) ?? query.get(k)

  const error = pick('error')
  const errorCode = pick('error_code')
  const rawType = pick('type')
  const accessToken = pick('access_token')
  const refreshToken = pick('refresh_token')
  const tokenHash = pick('token_hash')

  // An error with no type still has to be shown — an expired invite reports
  // `error_code=otp_expired` and nothing else, and silently ignoring it is how
  // the user ends up back on /login with no explanation.
  if (error || errorCode) {
    return {
      type: (rawType && KNOWN_TYPES.has(rawType) ? rawType : 'invite') as EmailOtpType,
      error: error ?? 'invalid_request',
      errorCode: errorCode ?? undefined,
      errorDescription: pick('error_description')?.replace(/\+/g, ' ') ?? undefined,
    }
  }

  if (!rawType || !KNOWN_TYPES.has(rawType)) return null
  if (!accessToken && !tokenHash) return null

  return {
    type: rawType as EmailOtpType,
    accessToken: accessToken ?? undefined,
    refreshToken: refreshToken ?? undefined,
    tokenHash: tokenHash ?? undefined,
  }
}

/**
 * Captured once, at import time. Module-level on purpose: see the header.
 */
const captured: AuthLink | null = parse()

/**
 * Strip the credentials from the address bar immediately.
 *
 * An access token in `window.location` is readable by anything that can see the
 * URL — the browser history, a screenshot, a shoulder, a `Referer` header on the
 * next outbound request. It is already in memory by this point, so the copy in
 * the URL buys nothing and costs that exposure. `replaceState` also means the
 * back button cannot replay a consumed link.
 */
if (captured && typeof window !== 'undefined') {
  window.history.replaceState({}, document.title, window.location.pathname)
}

/** The link this page load arrived with, or null. */
export function getAuthLink(): AuthLink | null {
  return captured
}

/**
 * True when this load must end at /set-password rather than anywhere else —
 * including an error, because "your invite expired" is a message somebody needs
 * to read, not a reason to show them a login form they cannot use.
 */
export function needsPasswordSetup(): boolean {
  if (!captured) return false
  if (captured.error) return true
  return PASSWORD_TYPES.has(captured.type)
}

/** Human wording for the failure cases. Never shown raw Supabase text. */
export function describeLinkError(link: AuthLink): {
  title: string
  body: string
} {
  const expired =
    link.errorCode === 'otp_expired' ||
    /expired/i.test(link.errorDescription ?? '') ||
    /expired/i.test(link.error ?? '')

  if (expired) {
    return {
      title: 'This link has expired',
      body:
        'Invitation links are valid for a short time and can only be used once. ' +
        'Ask your project team to send a new one — it takes them a moment.',
    }
  }

  if (link.errorCode === 'access_denied') {
    return {
      title: 'This link has already been used',
      body:
        'If you have already set a password, sign in below. If not, ask your ' +
        'project team for a fresh invitation.',
    }
  }

  return {
    title: 'This link did not work',
    body:
      'It may have been copied incompletely, or opened after it expired. Ask ' +
      'your project team to send a new invitation.',
  }
}
