import { Select } from '@/components/Field'
import { useProjects } from '@/store/project'

export function ProjectPicker() {
  const projects = useProjects((s) => s.projects)
  const selectedId = useProjects((s) => s.selectedId)
  const select = useProjects((s) => s.select)

  if (projects.length <= 1) return null

  return (
    <Select
      aria-label="Project"
      value={selectedId ?? ''}
      onChange={(e) => select(e.target.value)}
      className="h-10 text-sm"
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  )
}
