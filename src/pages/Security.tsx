import { Check, KeyRound, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FieldRow } from '@/components/Field'
import { PageHeader } from '@/components/PageHeader'
import { FadeUp } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  type EnrolStart,
  type MfaFactor,
  cancelEnrolment,
  finishEnrolment,
  listFactors,
  removeFactor,
  startEnrolment,
} from '@/lib/mfa'
import { useAuth } from '@/store/auth'

/**
 * TWO-FACTOR SETUP — for the person's OWN account, whoever they are.
 *
 * Deliberately not founder-only. The founder asked for it first because they
 * hold the keys to the money, but a PM with the vendor rates and an accounts
 * user with every invoice are worth protecting too, and there is no version of
 * "only the boss may secure their login" that makes sense.
 *
 * Three states, and the screen says which one it is in:
 *   off        no verified factor — offer to turn it on
 *   enrolling  QR on screen, waiting for the first code
 *   on         a verified factor exists — offer to remove it
 */
export default function Security() {
  const refreshAal = useAuth((s) => s.refreshAal)

  const [factors, setFactors] = useState<MfaFactor[] | null>(null)
  const [enrol, setEnrol] = useState<EnrolStart | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setFactors(await listFactors())
    } catch (err) {
      toast.error('Could not read your security settings', {
        description: errText(err),
      })
      setFactors([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const verified = (factors ?? []).filter((f) => f.status === 'verified')
  const isOn = verified.length > 0

  async function begin() {
    setBusy(true)
    try {
      setEnrol(await startEnrolment())
      setCode('')
    } catch (err) {
      // The most likely first-time failure is the project setting, and the raw
      // message ("MFA enrollment is disabled") reads like an app bug rather
      // than a switch somebody has to flip.
      const msg = errText(err) ?? ''
      toast.error('Could not start setup', {
        description: /disabled|not enabled|unsupported/i.test(msg)
          ? 'Two-factor is switched off for this Supabase project. Turn on TOTP under Authentication → Multi-Factor, then try again.'
          : msg,
      })
    }
    setBusy(false)
  }

  async function confirm() {
    if (!enrol) return
    if (code.trim().length < 6) {
      toast.error('Enter the 6-digit code from your app')
      return
    }
    setBusy(true)
    try {
      await finishEnrolment(enrol.factorId, code)
      setEnrol(null)
      setCode('')
      await refreshAal()
      await reload()
      toast.success('Two-factor is on', {
        description: 'You will be asked for a code the next time you sign in.',
      })
    } catch (err) {
      toast.error('That code was not accepted', {
        description:
          'Check the six digits currently showing in your app — they change every 30 seconds.',
      })
      console.error('[mfa] verify failed', err)
    }
    setBusy(false)
  }

  async function abandon() {
    if (!enrol) return
    await cancelEnrolment(enrol.factorId).catch(() => {})
    setEnrol(null)
    setCode('')
    await reload()
  }

  async function turnOff(factor: MfaFactor) {
    if (
      !window.confirm(
        'Turn off two-factor? Your password alone will get into this account ' +
          'again. You can set it up any time.',
      )
    )
      return

    setBusy(true)
    try {
      await removeFactor(factor.id)
      await refreshAal()
      await reload()
      toast.success('Two-factor is off')
    } catch (err) {
      const msg = errText(err) ?? ''
      toast.error('Could not turn it off', {
        description: /aal2|assurance|insufficient/i.test(msg)
          ? 'Sign out and back in, enter a code, then try again — removing a factor needs proof you still hold it.'
          : msg,
      })
    }
    setBusy(false)
  }

  return (
    <>
      <PageHeader title="Security" eyebrow="Your account" />

      <main className="page-w space-y-5 px-5 py-6">
        {factors === null && <ListSkeleton rows={2} />}

        {/* ---------------- ON ---------------- */}
        {factors !== null && isOn && !enrol && (
          <FadeUp>
            <div className="paper p-6">
              <div className="flex items-start gap-3">
                <ShieldCheck
                  className="mt-0.5 size-5 shrink-0 text-[var(--positive)]"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="font-heading text-[19px] leading-tight font-semibold">
                    Two-factor is on
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    Signing in asks for your password and then a six-digit code
                    from your authenticator app. A stolen password on its own is
                    not enough.
                  </p>
                </div>
              </div>

              <dl className="mt-5 space-y-2 border-t border-border pt-4 text-sm">
                {verified.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-baseline justify-between gap-4"
                  >
                    <dt className="text-muted-foreground">{f.friendlyName}</dt>
                    <dd className="text-xs text-muted-foreground tabular-nums">
                      added {new Date(f.createdAt).toLocaleDateString('en-IN')}
                    </dd>
                  </div>
                ))}
              </dl>

              <Button
                variant="ghost"
                className="mt-5 h-11 text-[var(--danger)]"
                disabled={busy}
                onClick={() => void turnOff(verified[0])}
              >
                <ShieldOff className="size-4" />
                Turn off two-factor
              </Button>
            </div>
          </FadeUp>
        )}

        {/* ---------------- OFF ---------------- */}
        {factors !== null && !isOn && !enrol && (
          <FadeUp>
            <div className="paper p-6">
              <div className="flex items-start gap-3">
                <KeyRound
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-heading text-[19px] leading-tight font-semibold">
                    Add an authenticator app
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    A second step at sign-in: your password, then a six-digit
                    code that changes every thirty seconds. Google
                    Authenticator, Authy and 1Password all work — anything that
                    scans a QR code.
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    Keep the app on a phone you will still have next month. If
                    you lose it, only somebody with database access can let you
                    back in.
                  </p>
                </div>
              </div>

              <Button
                className="mt-6 h-12 w-full text-base"
                disabled={busy}
                onClick={() => void begin()}
              >
                {busy ? 'Starting…' : 'Set up two-factor'}
              </Button>
            </div>
          </FadeUp>
        )}

        {/* ---------------- ENROLLING ---------------- */}
        {enrol && (
          <FadeUp>
            <div className="paper p-6">
              <div className="flex items-start gap-3">
                <Smartphone
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div>
                  <p className="font-heading text-[19px] leading-tight font-semibold">
                    Scan this with your app
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    Then type the six digits it shows. Nothing is switched on
                    until that code is accepted.
                  </p>
                </div>
              </div>

              <div className="mt-5 flex justify-center rounded-xl border border-border bg-white p-4">
                {/* Supabase returns an SVG data-URL. */}
                <img
                  src={enrol.qrCode}
                  alt="Two-factor QR code"
                  className="size-[200px]"
                />
              </div>

              {/* The manual key matters when the phone IS the screen and there
                  is nothing to point a camera at. */}
              <details className="mt-4">
                <summary className="cursor-pointer text-xs text-muted-foreground underline underline-offset-4">
                  Can't scan it?
                </summary>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  Enter this key in your app by hand:
                </p>
                <p className="mt-1 font-mono text-[13px] break-all select-all">
                  {enrol.secret}
                </p>
              </details>

              <form
                className="mt-5 space-y-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  void confirm()
                }}
              >
                <FieldRow label="Six-digit code" htmlFor="mfa-code">
                  <Input
                    id="mfa-code"
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

                <div className="flex gap-3">
                  <Button
                    type="submit"
                    className="h-12 flex-1 text-base"
                    disabled={busy || code.length < 6}
                  >
                    <Check className="size-4" />
                    {busy ? 'Checking…' : 'Turn it on'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-12"
                    disabled={busy}
                    onClick={() => void abandon()}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
          </FadeUp>
        )}
      </main>
    </>
  )
}
