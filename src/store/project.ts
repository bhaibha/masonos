import { create } from 'zustand'
import { fetchProjects } from '@/lib/queries/projects'
import type { Project } from '@/lib/types'

const STORAGE_KEY = 'masonos.selectedProjectId'

interface ProjectState {
  projects: Project[]
  selectedId: string | null
  loading: boolean
  error: string | null
  load: () => Promise<void>
  select: (id: string) => void
}

export const useProjects = create<ProjectState>((set, get) => ({
  projects: [],
  selectedId: localStorage.getItem(STORAGE_KEY),
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const projects = await fetchProjects()
      const current = get().selectedId
      const stillValid = current && projects.some((p) => p.id === current)
      const selectedId = stillValid ? current : (projects[0]?.id ?? null)
      if (selectedId && selectedId !== current) {
        localStorage.setItem(STORAGE_KEY, selectedId)
      }
      set({ projects, selectedId, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Could not load projects.',
      })
    }
  },

  select: (id) => {
    localStorage.setItem(STORAGE_KEY, id)
    set({ selectedId: id })
  },
}))
