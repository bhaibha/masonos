import { Bell, BellOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import {
  currentPushState,
  disablePush,
  enablePush,
  isStandalone,
  pushConfigured,
  type PushState,
} from '@/lib/push'

/**
 * Turning the morning task notification on for THIS device.
 *
 * Per device, not per person: the browser issues one endpoint per install, so
 * someone with a phone and a tablet enables it on each. The card says so
 * rather than pretending the setting follows the account.
 */
export function PushCard() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setState(await currentPushState())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Nothing to offer, and nothing useful to say about it. `pushConfigured`
  // covers the window between deploying this code and setting the VAPID key —
  // better to show no card than a button that fails.
  if (state === null || state === 'unsupported' || !pushConfigured()) return null

  async function toggle() {
    setBusy(true)
    // try/finally, not a trailing setBusy: an exception used to leave the
    // button stuck on "Working…" with no way back.
    try {
      if (state === 'on') {
        setState(await disablePush())
        toast.success('Notifications off for this device')
      } else {
        const next = await enablePush()
        setState(next)
        if (next === 'on') {
          toast.success('Notifications on', {
            description: "You'll get your task list at 7am.",
          })
        } else if (next === 'denied') {
          toast.error('Permission was refused', {
            description:
              'Turn notifications back on for this site in your browser settings.',
          })
        }
      }
    } catch (err) {
      toast.error('Could not change notifications', {
        description: errText(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="paper mt-4 flex flex-wrap items-center gap-4 p-5">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          {state === 'on' ? (
            <Bell className="size-4" aria-hidden="true" />
          ) : (
            <BellOff className="size-4" aria-hidden="true" />
          )}
          Daily task reminder
        </p>

        <p className="mt-2 text-sm text-muted-foreground">
          {state === 'on'
            ? "This device gets your task list each morning at 7am. It's a nudge — the app stays the record."
            : state === 'denied'
              ? 'This browser is blocking notifications. Allow them for this site in your browser settings, then come back.'
              : state === 'needs-install'
                ? 'On iPhone, add Mason OS to your Home Screen first — Apple only allows notifications for installed apps. Share → Add to Home Screen, then open it from there.'
                : 'Get your task list on this phone each morning at 7am.'}
        </p>

        {state === 'on' && !isStandalone() && (
          <p className="mt-2 text-xs text-muted-foreground">
            Installing the app to your Home Screen makes these more reliable.
          </p>
        )}
      </div>

      {(state === 'on' || state === 'off') && (
        <Button
          variant={state === 'on' ? 'outline' : 'default'}
          className="h-11"
          disabled={busy}
          onClick={() => void toggle()}
        >
          {busy ? 'Working…' : state === 'on' ? 'Turn off' : 'Turn on'}
        </Button>
      )}
    </section>
  )
}
