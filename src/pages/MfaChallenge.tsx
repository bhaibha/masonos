import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { FieldRow } from '@/components/Field'
import { FadeUp } from '@/components/Reveal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { type MfaFactor, answerChallenge, firstVerifiedFactor } from '@/lib/mfa'
import { useAuth } from '@/store/auth'

/**
 * THE SECOND STEP AT SIGN-IN.
 *
 * Reached from RequireAuth, not from the login form — a session sitting at
 * aal1 survives a reload, so a check that only ran after the password was
 * typed could be skipped by refreshing the page. Every route goes through
 * RequireAuth, so there is nowhere to land while the code is still owed.
 *
 * Sign out is on this screen on purpose: somebody who has lost their phone is
 * otherwise stuck on a page they cannot pass and cannot leave.
 */
export default function MfaChallenge() {
  const navigate = useNavigate()
  const refreshAal = useAuth((s) => s.refreshAal)
  const signOut = useAuth((s) => s.signOut)
  const role = useAuth((s) => s.role)

  const [factor, setFactor] = useState<MfaFactor | null>(null)
  const [loading, setLoading] = useState(true)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const f = await firstVerifiedFactor()
        if (!cancelled) setFactor(f)
      } catch (err) {
        console.error('[mfa] could not list factors', err)
      }
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!factor) return
    if (code.trim().length < 6) {
      toast.error('Enter the 6-digit code from your app')
      return
    }

    setBusy(true)
    try {
      await answerChallenge(factor.id, code)
      await refreshAal()
      // Route by role for the same reason SetPassword does: this screen sits in
      // front of both the internal app and the client portal.
      navigate(role === 'client' ? '/portal' : '/dashboard', { replace: true })
    } catch (err) {
      toast.error('That code was not accepted', {
        description:
          'Use the six digits showing right now — they change every 30 seconds.',
      })
      console.error('[mfa] challenge failed', errText(err))
      setCode('')
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Your Masons
          </p>
          <h1 className="font-heading mt-0.5 text-2xl font-semibold tracking-tight">
            Mason OS
          </h1>
        </div>

        <FadeUp>
          <div className="paper p-6">
            <div className="flex items-start gap-3">
              <ShieldCheck
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="font-heading text-[19px] leading-tight font-semibold">
                  Enter your code
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {loading
                    ? 'Checking your account…'
                    : factor
                      ? `Open ${factor.friendlyName} and type the six digits it is showing.`
                      : 'Your account is set up for two-factor, but no usable authenticator was found. Ask the office to reset it for you.'}
                </p>
              </div>
            </div>

            {factor && (
              <form onSubmit={submit} className="mt-5 space-y-4">
                <FieldRow label="Six-digit code" htmlFor="mfa-challenge">
                  <Input
                    id="mfa-challenge"
                    className="h-12 text-center font-mono text-lg tracking-[0.3em]"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                  />
                </FieldRow>

                <Button
                  type="submit"
                  className="h-12 w-full text-base"
                  disabled={busy || code.length < 6}
                >
                  {busy ? 'Checking…' : 'Continue'}
                </Button>
              </form>
            )}

            <button
              type="button"
              onClick={() => void signOut()}
              className="mt-6 w-full text-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </FadeUp>
      </div>
    </div>
  )
}
