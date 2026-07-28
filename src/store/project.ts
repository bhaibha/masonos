import { create } from 'zustand'
import { fetchProjects } from '@/lib/queries/projects'
import type { Project } from '@/lib/types'
import { useAuth } from '@/store/auth'

/**
 * The selected project is remembered PER USER.
 *
 * It used to be one shared key, so signing out of the founder account and into
 * a supervisor's on the same browser inherited the other person's selection —
 * and since every list is scoped to the selected project, records raised on
 * project A were invisible to someone looking at project B with no hint why.
 */
const KEY_PREFIX = 'masonos.selectedProjectId'
const LEGACY_KEY = 'masonos.selectedProjectId'

function storageKey(userId: string | null): string {
  return userId ? `${KEY_PREFIX}.${userId}` : KEY_PREFIX
}

function readStored(userId: string | null): string | null {
  const own = localStorage.getItem(storageKey(userId))
  if (own) return own
  // One-time carry-over from the shared key so nobody's selection resets.
  return userId ? localStorage.getItem(LEGACY_KEY) : null
}

interface ProjectState {
  projects: Project[]
  selectedId: string | null
  loading: boolean
  error: string | null
  /** true when the stored selection was no longer valid and we picked another */
  autoSelected: boolean
  load: () => Promise<void>
  select: (id: string) => void
}

export const useProjects = create<ProjectState>((set, get) => ({
  projects: [],
  selectedId: null,
  loading: false,
  error: null,
  autoSelected: false,

  load: async () => {
    set({ loading: true, error: null })
    const userId = useAuth.getState().user?.id ?? null

    try {
      const projects = await fetchProjects()
      const current = get().selectedId ?? readStored(userId)
      const stillValid = Boolean(current && projects.some((p) => p.id === current))
      const selectedId = stillValid ? current : (projects[0]?.id ?? null)

      if (selectedId) localStorage.setItem(storageKey(userId), selectedId)

      set({
        projects,
        selectedId,
        loading: false,
        autoSelected: !stillValid && projects.length > 1,
      })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Could not load projects.',
      })
    }
  },

  select: (id) => {
    const userId = useAuth.getState().user?.id ?? null
    localStorage.setItem(storageKey(userId), id)
    set({ selectedId: id, autoSelected: false })
  },
}))
