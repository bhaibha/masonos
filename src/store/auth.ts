import type { Session, User } from '@supabase/supabase-js'
import { create } from 'zustand'
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

  init: () => () => void
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
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

  /**
   * Hydrates from the persisted session and subscribes to auth changes.
   * Returns an unsubscribe function. Safe to call once from the app root.
   */
  init: () => {
    const applySession = async (session: Session | null) => {
      if (!session?.user) {
        set({ user: null, session: null, profile: null, role: null, loading: false })
        return
      }

      set({ user: session.user, session })

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

  signOut: async () => {
    await supabase.auth.signOut()
    set({ user: null, session: null, profile: null, role: null })
  },
}))
