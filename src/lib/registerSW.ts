/**
 * Registers the service worker in production builds only — in dev it would
 * shadow Vite's HMR responses and serve stale modules.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // A new build is waiting: activate it, then reload once so the user
        // isn't left on a half-old shell.
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            if (
              installing.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              installing.postMessage('SKIP_WAITING')
            }
          })
        })
      })
      .catch(() => {
        // A failed registration must never break the app.
      })
  })

  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })
}
