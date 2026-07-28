import { Select } from '@/components/Field'
import { useProjects } from '@/store/project'

/**
 * Which project everything below is scoped to.
 *
 * This used to render nothing when the user had a single project — which is
 * exactly the case for a supervisor. They had no way to know which project
 * they were logging against, and a founder looking at a different project saw
 * an empty list with no explanation. Now the active project is ALWAYS named;
 * only the ability to change it depends on having more than one.
 */
export function ProjectPicker() {
  const projects = useProjects((s) => s.projects)
  const selectedId = useProjects((s) => s.selectedId)
  const select = useProjects((s) => s.select)

  if (projects.length === 0) return null

  if (projects.length === 1) {
    return (
      <p className="flex items-baseline gap-2 px-1 py-1.5">
        <span className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
          Project
        </span>
        <span className="truncate text-sm font-medium">{projects[0].name}</span>
      </p>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
        Project
      </span>
      <Select
        aria-label="Project"
        value={selectedId ?? ''}
        onChange={(e) => select(e.target.value)}
        className="h-10 text-sm font-medium"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </div>
  )
}

/** The active project's name, for empty states that need to say where they looked. */
export function useSelectedProjectName(): string | null {
  const projects = useProjects((s) => s.projects)
  const selectedId = useProjects((s) => s.selectedId)
  return projects.find((p) => p.id === selectedId)?.name ?? null
}

/**
 * Shown under an empty list when the user can see more than one project.
 * An empty screen is ambiguous — "nothing was raised" and "you're looking at
 * the wrong project" look identical. This says which it is.
 */
export function OtherProjectsHint() {
  const projects = useProjects((s) => s.projects)
  const name = useSelectedProjectName()

  if (projects.length <= 1) return null

  return (
    <p className="px-6 pb-8 text-center text-xs text-muted-foreground">
      Showing <span className="font-medium text-foreground">{name}</span> only.
      You have {projects.length} projects — switch with the picker above if you
      expected something here.
    </p>
  )
}
