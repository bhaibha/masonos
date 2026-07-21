/* Mason OS service worker — hand-written, no Workbox.
 *
 * Deliberately narrow: it caches the app shell and Vite's content-hashed
 * assets, and nothing else. Every Supabase request (REST, auth, storage) is
 * cross-origin and falls straight through to the network — caching those would
 * serve stale money figures and could hand a signed-out user another session's
 * data. Storage objects are signed URLs with short expiries; caching them would
 * keep files readable past their window.
 *
 * Bump CACHE_VERSION on any change to this file.
 */

const CACHE_VERSION = 'mason-os-v1'
const SHELL_CACHE = `${CACHE_VERSION}-shell`
const ASSET_CACHE = `${CACHE_VERSION}-assets`

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // addAll is atomic: one 404 and nothing is cached. Add individually so a
      // missing optional file can't block the whole install.
      .then((cache) =>
        Promise.all(
          SHELL.map((url) => cache.add(url).catch(() => undefined)),
        ),
      )
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(CACHE_VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Never touch non-GET, and never touch another origin (i.e. Supabase).
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // SPA navigations: network first so a deploy is picked up immediately,
  // falling back to the cached shell when the site is offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy))
          return response
        })
        .catch(() =>
          caches
            .match('/index.html')
            .then((cached) => cached ?? Response.error()),
        ),
    )
    return
  }

  // Vite emits content-hashed filenames under /assets, so a cache hit is
  // always the right file — serve it immediately and fill the cache on miss.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            caches.open(ASSET_CACHE).then((c) => c.put(request, copy))
          }
          return response
        })
        .catch(() => cached ?? Response.error())
    }),
  )
})
