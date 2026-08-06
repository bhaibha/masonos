import { supabase } from '@/lib/supabase'

/**
 * Web push subscription, browser side (migration 036).
 *
 * A push is a NUDGE, not a delivery guarantee: a phone that is off or out of
 * coverage misses it, and nothing in the app depends on one having arrived.
 * The task list stays the record.
 *
 * Platform reality worth knowing rather than discovering:
 *   • Android Chrome works in a normal tab.
 *   • iOS needs the app added to the Home Screen first — Apple only exposes
 *     the Push API to installed PWAs. `isStandalone()` is how we tell.
 *   • Permission can only be requested from a user gesture, once. A denial is
 *     sticky and can only be undone in browser settings, which is why the UI
 *     says so instead of asking again.
 */

export type PushState =
  | 'unsupported'
  | 'needs-install' // iOS, not added to Home Screen
  | 'denied'
  | 'off'
  | 'on'

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's own flag, absent from the standard.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent)
}

/**
 * Whether push has been set up at all. Without the VAPID public key the
 * browser cannot subscribe, so the card hides itself rather than offering a
 * button that throws.
 */
export function pushConfigured(): boolean {
  return Boolean(import.meta.env.VITE_VAPID_PUBLIC_KEY)
}

export function pushSupported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** What to show the user right now, without asking for anything. */
export async function currentPushState(): Promise<PushState> {
  if (!pushSupported()) {
    return isIos() && !isStandalone() ? 'needs-install' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'denied'

  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  return sub ? 'on' : 'off'
}

/**
 * VAPID public keys are base64url; PushManager wants raw bytes.
 *
 * Typed as ArrayBuffer rather than Uint8Array because lib.dom's
 * `applicationServerKey` insists on a buffer backed by ArrayBuffer, and a
 * plain Uint8Array is `ArrayBufferLike` — which could be a SharedArrayBuffer.
 */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(normalised)
  const buffer = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return buffer
}

/**
 * `navigator.serviceWorker.ready` never resolves when nothing is registered —
 * and registerSW.ts deliberately skips registration in dev, where a service
 * worker would shadow Vite's HMR. Awaiting it there leaves the caller hanging
 * with no error, which is worse than failing.
 *
 * So: fail fast with an explanation rather than waiting for something that is
 * never going to happen.
 */
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration()
  if (!existing) {
    throw new Error(
      import.meta.env.PROD
        ? 'The service worker is not registered yet. Reload the page and try again.'
        : 'Notifications need the built app — the dev server runs without a service worker. Try `npm run build && npm run preview`, or use the deployed site.',
    )
  }

  // Registered but not yet active (first load). Bounded, because "waiting
  // forever" is the failure this whole function exists to avoid.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<ServiceWorkerRegistration>((_, reject) =>
      setTimeout(
        () => reject(new Error('The service worker did not start in time.')),
        10_000,
      ),
    ),
  ])
}

/**
 * Asks permission, subscribes, and records the endpoint. Safe to call twice —
 * the endpoint is unique in the database, so re-subscribing on the same device
 * updates rather than duplicating.
 */
export async function enablePush(): Promise<PushState> {
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  if (!key) {
    throw new Error(
      'VITE_VAPID_PUBLIC_KEY is not set — notifications cannot be enabled.',
    )
  }
  if (!pushSupported()) return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const reg = await readyRegistration()
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      // Chrome refuses a subscription without this, and a silent push would be
      // useless to us anyway.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(key),
    }))

  const json = sub.toJSON()
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!p256dh || !auth) throw new Error('The browser returned an incomplete subscription.')

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      endpoint: sub.endpoint,
      p256dh,
      auth,
      user_agent: navigator.userAgent.slice(0, 300),
      // Re-enabling on a device that was marked dead should bring it back.
      disabled_at: null,
      failure_count: 0,
    },
    { onConflict: 'endpoint' },
  )
  if (error) throw error

  return 'on'
}

/** Unsubscribes this device and removes the row. */
export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return 'off'

  const endpoint = sub.endpoint
  await sub.unsubscribe()

  // RLS limits this to the caller's own rows, so a stale endpoint belonging to
  // someone else simply isn't matched.
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint)
  if (error) throw error

  return 'off'
}
