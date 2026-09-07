import type { Session, User } from '@supabase/supabase-js'
import { create } from 'zustand'
import { mfaChallengeOwed } from '@/lib/mfa'
import { fetchMyProfile } from '@/lib/queries/profile'
import { supabase } from '@/lib/supabase'
import type { Profile, UserRole } from '@/lib/types'

interface AuthState {
  user: User | null
  session: Session | null
  profile: Profile | null
  role: UserRole | null
  /** false once the initial session lookup has settled */
  loading: boolean
  initialised: boolean

  /**
   * True when this session has a verified TOTP factor it has not used yet —
   * i.e. signed in with a password (aal1) but owing a code (aal2).
   *
   * `signInWithPassword` succeeds either way, so this is the only thing
   * standing between a stolen password and the app. It is resolved on every
   * session change, not just at login, because an aal1 session survives a
   * reload.
   */
  mfaPending: boolean

  init: () => () => void
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** Re-reads the assurance level after enrolling, challenging or unenrolling. */
  refreshAal: () => Promise<void>
  /**
   * Re-reads the profile without touching the session. Needed after something
   * changes a column the guards read — clearing `must_change_password` (077)
   * being the case that exists: without this the app would keep routing them
   * back to /set-password until a full reload.
   */
  refreshProfile: () => Promise<void>
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  session: null,
  profile: null,
  role: null,
  loading: true,
  initialised: false,
  mfaPending: false,

  /**
   * Hydrates from the persisted session and subscribes to auth changes.
   * Returns an unsubscribe function. Safe to call once from the app root.
   */
  init: () => {
    const applySession = async (session: Session | null) => {
      if (!session?.user) {
        set({
          user: null,
          session: null,
          profile: null,
          role: null,
          mfaPending: false,
          loading: false,
        })
        return
      }

      set({ user: session.user, session })

      // Resolved on EVERY session change. A session left at aal1 survives a
      // reload, so deciding this once at login would leave a door open.
      const owed = await mfaChallengeOwed().catch(() => false)
      set({ mfaPending: owed })

      try {
        const profile = await fetchMyProfile(session.user.id)
        set({ profile, role: profile?.role ?? null, loading: false })
      } catch {
        // Profile fetch failed (offline, RLS, or trigger not yet run).
        // Keep the session — the guard will still let them in, role-gated UI hides.
        set({ profile: null, role: null, loading: false })
      }
    }

    if (!get().initialised) {
      set({ initialised: true })
      void supabase.auth.getSession().then(({ data }) => applySession(data.session))
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session)
    })

    return () => sub.subscription.unsubscribe()
  },

  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (error) throw error
    // onAuthStateChange fires and applySession fills user/profile/role.
  },

  refreshProfile: async () => {
    const uid = get().user?.id
    if (!uid) return
    try {
      const profile = await fetchMyProfile(uid)
      set({ profile, role: profile?.role ?? null })
    } catch {
      // Leave what we have. A stale profile is better than none — the guards
      // would otherwise treat the user as roleless and bounce them.
    }
  },

  refreshAal: async () => {
    if (!get().user) return
    set({ mfaPending: await mfaChallengeOwed().catch(() => false) })
  },

  signOut: async () => {
    await supabase.auth.signOut()
    set({ user: null, session: null, profile: null, role: null, mfaPending: false })
  },
}))
