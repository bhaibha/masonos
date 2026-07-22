import { createClient } from '@supabase/supabase-js'

const rawUrl = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!rawUrl || !anonKey) {
  throw new Error(
    'Missing Supabase env vars. Create .env.local in the project root with ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart `npm run dev`.',
  )
}

/**
 * supabase-js wants the BASE project URL and appends /rest/v1, /auth/v1 etc.
 * itself. A URL copied from the API page with a trailing /rest/v1/ (or any
 * trailing slash) doubles the path and every request fails with
 * "Invalid path specified in request URL". Normalise defensively so it can't
 * matter where the value came from — committed .env, or a dashboard override.
 */
const url = rawUrl
  .trim()
  .replace(/\/+$/, '') // drop trailing slashes
  .replace(/\/(rest|auth|storage|realtime)\/v1$/, '') // drop an appended API path
  .replace(/\/+$/, '')

/**
 * Browser Supabase client. Anon key only — RLS is the security boundary.
 * Never import the service-role key here (CLAUDE.md rule 1).
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})
