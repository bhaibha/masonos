import { CheckCircle2, KeyRound, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { FieldRow } from '@/components/Field'
import { FadeUp } from '@/components/Reveal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  type AuthLink,
  describeLinkError,
  getAuthLink,
} from '@/lib/authLink'
import { errText } from '@/lib/errText'
import { fetchMyProfile } from '@/lib/queries/profile'
import { supabase } from '@/lib/supabase'

/**
 * WHERE AN INVITE ENDS.
 *
 * Three phases, and the screen says which one it is in rather than showing a
 * spinner and hoping:
 *
 *   consuming  the token from the link is being exchanged for a session
 *   ready      the session exists; choose a password
 *   dead       the link was expired, used, or malformed
 *
 * The token is consumed HERE and nowhere else. `detectSessionInUrl` is off (see
 * lib/authLink.ts), so a session cannot appear behind our back and let somebody
 * into the portal without ever choosing a password.
 */
type Phase = 'consuming' | 'ready' | 'dead'

export default function SetPassword() {
  const navigate = useNavigate()
  const link = useRef<AuthLink | null>(getAuthLink()).current

  const [phase, setPhase] = useState<Phase>(link ? 'consuming' : 'dead')
  const [dead, setDead] = useState<{ title: string; body: string } | null>(
    link ? null : {
      title: 'Nothing to set up here',
      body:
        'This page is reached from an invitation email. If you already have a ' +
        'password, sign in below.',
    },
  )

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [email, setEmail] = useState<string | null>(null)

  /* ---------------- phase 1: consume the token ---------------- */
  useEffect(() => {
    if (!link) return

    // The link itself reported a failure — no point calling Supabase to be told
    // the same thing more slowly.
    if (link.error) {
      setDead(describeLinkError(link))
      setPhase('dead')
      return
    }

    let cancelled = false

    void (async () => {
      try {
        if (link.accessToken && link.refreshToken) {
          // Hash form: /auth/v1/verify already checked the token and handed us
          // a session to install.
          const { error } = await supabase.auth.setSession({
            access_token: link.accessToken,
            refresh_token: link.refreshToken,
          })
          if (error) throw error
        } else if (link.tokenHash) {
          // Query form: the token is unverified and this is the exchange.
          const { error } = await supabase.auth.verifyOtp({
            token_hash: link.tokenHash,
            type: link.type,
          })
          if (error) throw error
        } else {
          throw new Error('The link did not carry a token.')
        }

        if (cancelled) return

        const { data } = await supabase.auth.getUser()
        if (cancelled) return

        setEmail(data.user?.email ?? null)
        setPhase('ready')
      } catch (err) {
        if (cancelled) return
        // Supabase says "Token has expired or is invalid" for every failure
        // here, so the wording comes from our own reading of the link rather
        // than from the API — a client should not be shown "otp_expired".
        // errText is `string | undefined` — a Supabase error with no message
        // is exactly the case that would otherwise render a blank panel.
        const msg = errText(err) ?? 'The link could not be verified.'
        setDead(
          /expired|invalid/i.test(msg)
            ? describeLinkError({ ...link, errorCode: 'otp_expired' })
            : {
                title: 'This link did not work',
                body: msg,
              },
        )
        setPhase('dead')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [link])

  /* ---------------- phase 2: choose a password ---------------- */
  async function save(e: React.FormEvent) {
    e.preventDefault()

    if (password.length < 8) {
      toast.error('Use at least 8 characters')
      return
    }
    if (password !== confirm) {
      toast.error('The two passwords do not match')
      return
    }

    setSaving(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error

      toast.success('Password set', {
        description: 'You are signed in. Welcome.',
      })

      // Route by role rather than to a fixed path: this same screen serves a
      // client accepting an invite and a staff member resetting a password.
      // Read the profile directly — the auth store's own fetch may not have
      // landed yet, and guessing wrong means a visible bounce.
      const { data } = await supabase.auth.getUser()
      let dest = '/dashboard'
      if (data.user) {
        try {
          const profile = await fetchMyProfile(data.user.id)
          if (profile?.role === 'client') dest = '/portal'
        } catch {
          // Falls through to /dashboard, where RequireInternal redirects a
          // client to /portal anyway. One extra hop, never a dead end.
        }
      }
      navigate(dest, { replace: true })
    } catch (err) {
      toast.error('Could not set your password', { description: errText(err) })
      setSaving(false)
    }
  }

  /* ---------------- render ---------------- */
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b border-border">
        <div className="page-w px-5 pt-8 pb-6">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Your Masons
          </p>
          <h1 className="font-heading mt-0.5 text-[26px] leading-none font-semibold">
            Mason OS
          </h1>
        </div>
      </header>

      <main className="page-w flex-1 px-5 py-10">
        {phase === 'consuming' && (
          <div className="paper p-6">
            <p className="text-sm text-muted-foreground">Checking your link…</p>
          </div>
        )}

        {phase === 'dead' && dead && (
          <FadeUp>
            <div className="paper p-6">
              <div className="flex items-start gap-3">
                <TriangleAlert
                  className="mt-0.5 size-5 shrink-0 text-[var(--warning)]"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-heading text-[19px] leading-tight font-semibold">
                    {dead.title}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {dead.body}
                  </p>
                </div>
              </div>

              <Link
                to="/login"
                className="mt-6 inline-flex h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
              >
                Go to sign in
              </Link>
            </div>
          </FadeUp>
        )}

        {phase === 'ready' && (
          <FadeUp>
            <form onSubmit={save} className="paper space-y-5 p-6">
              <div className="flex items-start gap-3">
                <KeyRound
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-heading text-[19px] leading-tight font-semibold">
                    Choose a password
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    {email
                      ? `You are setting the password for ${email}.`
                      : 'Set the password you will use to sign in.'}
                  </p>
                </div>
              </div>

              <FieldRow
                label="New password"
                htmlFor="sp-pass"
                hint="At least 8 characters."
              >
                <Input
                  id="sp-pass"
                  type="password"
                  className="h-12"
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </FieldRow>

              <FieldRow label="Confirm password" htmlFor="sp-confirm">
                <Input
                  id="sp-confirm"
                  type="password"
                  className="h-12"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                />
              </FieldRow>

              {confirm.length > 0 && password === confirm && (
                <p className="flex items-center gap-1.5 text-xs text-[var(--positive)]">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  Passwords match
                </p>
              )}

              <Button
                type="submit"
                className="h-12 w-full text-base"
                disabled={saving}
              >
                {saving ? 'Setting…' : 'Set password and continue'}
              </Button>

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Nobody at Your Masons can see this password, including your
                project team.
              </p>
            </form>
          </FadeUp>
        )}
      </main>
    </div>
  )
}
