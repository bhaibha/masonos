import { supabase } from '@/lib/supabase'

/**
 * TWO-FACTOR AUTHENTICATION (TOTP).
 *
 * Thin wrappers over `supabase.auth.mfa`, in one file so the rest of the app
 * never has to remember the enroll -> challenge -> verify sequence or which of
 * the three returns what.
 *
 * THE ONE THING TO UNDERSTAND: `signInWithPassword` SUCCEEDS for a user who has
 * a verified factor. It returns a real session at assurance level **aal1**. The
 * password alone is never refused — what changes is that the session is not yet
 * aal2, and it is the APP that must refuse to go further until the code is
 * entered. That is why the gate lives in RequireAuth (see the 078 branch beside
 * it) and not only in the login form: a session left at aal1 survives a reload,
 * and a check that only runs on the login screen would be walked straight past.
 *
 * `nextLevel` is 'aal2' whenever the user has at least one VERIFIED factor.
 * An abandoned enrolment leaves an UNVERIFIED factor, which does not raise
 * nextLevel — so a half-finished setup can never lock anybody out.
 */

export interface MfaFactor {
  id: string
  friendlyName: string
  status: 'verified' | 'unverified'
  createdAt: string
}

export interface EnrolStart {
  factorId: string
  /** SVG data-URL from Supabase — safe in an <img src>. */
  qrCode: string
  /** The same secret in text, for typing in by hand when the QR cannot be scanned. */
  secret: string
}

/* ---------------- reading state ---------------- */

/**
 * Does this session still owe a code?
 *
 * currentLevel is what the session HAS; nextLevel is what it COULD reach. A
 * gap between them means a verified factor exists and has not been used yet.
 * Both null (no session, or the call failed) is treated as "nothing owed" —
 * refusing entry on a failed lookup would lock the firm out of a working app
 * on one bad request, the same judgement as the 078 profile branch.
 */
export async function mfaChallengeOwed(): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (error || !data) return false
  return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2'
}

export async function listFactors(): Promise<MfaFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw error
  return (data?.all ?? []).map((f) => ({
    id: f.id,
    friendlyName: f.friendly_name ?? 'Authenticator app',
    status: f.status === 'verified' ? 'verified' : 'unverified',
    createdAt: f.created_at,
  }))
}

/** The factor to challenge at sign-in. Only a verified one can be used. */
export async function firstVerifiedFactor(): Promise<MfaFactor | null> {
  const all = await listFactors()
  return all.find((f) => f.status === 'verified') ?? null
}

/* ---------------- enrolling ---------------- */

/**
 * Starts enrolment and returns what the screen has to show.
 *
 * Abandoned attempts are cleaned up first. Supabase refuses a second factor
 * with the same friendly name, so without this a founder who closed the tab
 * half way through could never start again — and the error message
 * ("friendly name already exists") describes a row they cannot see and have no
 * way to remove from the UI.
 */
export async function startEnrolment(
  friendlyName = 'Authenticator app',
): Promise<EnrolStart> {
  for (const f of await listFactors()) {
    if (f.status === 'unverified') {
      await supabase.auth.mfa.unenroll({ factorId: f.id })
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName,
  })
  if (error) throw error
  if (!data) throw new Error('Enrolment returned nothing.')

  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
  }
}

/**
 * Finishes enrolment. The code proves the authenticator app and this account
 * agree about the secret AND about the time — a factor verified any other way
 * would be a factor nobody can actually use tomorrow morning.
 *
 * On success the session is upgraded to aal2 in place, so the person who just
 * enrolled is not immediately asked to challenge.
 */
export async function finishEnrolment(factorId: string, code: string) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: code.trim(),
  })
  if (error) throw error
}

/** Throws away a half-finished enrolment. Never touches a verified factor. */
export async function cancelEnrolment(factorId: string) {
  await supabase.auth.mfa.unenroll({ factorId })
}

/* ---------------- the sign-in challenge ---------------- */

/** Answers the challenge and upgrades the current session to aal2. */
export async function answerChallenge(factorId: string, code: string) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: code.trim(),
  })
  if (error) throw error
}

/* ---------------- removing ---------------- */

/**
 * Turning two-factor off.
 *
 * Supabase requires an aal2 session to unenrol a verified factor — you must
 * prove you still hold the authenticator before you may remove it. That is
 * correct and deliberately not worked around: if it were possible from an aal1
 * session, a stolen password would be enough to strip the second factor, which
 * is the whole thing this exists to prevent.
 *
 * The caller surfaces the refusal rather than dressing it up, because the
 * remedy — sign in again and enter a code — is something the person can do.
 */
export async function removeFactor(factorId: string) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId })
  if (error) throw error
}
