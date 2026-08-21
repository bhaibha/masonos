import { useEffect } from 'react'
import { toast } from 'sonner'
import { NavLink, Outlet } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { ListSkeleton } from '@/components/Skeleton'
import { ProjectPicker } from '@/components/ProjectPicker'
import { cn } from '@/lib/utils'
import { useProjects } from '@/store/project'

export default function DocsLayout() {
  const load = useProjects((s) => s.load)
  const projects = useProjects((s) => s.projects)
  const selectedId = useProjects((s) => s.selectedId)
  const loading = useProjects((s) => s.loading)
  const error = useProjects((s) => s.error)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (error) toast.error('Could not load projects', { description: error })
  }, [error])

  // No Upload tab: uploading belongs inside the folder you're filing into, so
  // it lives on the folder screen where it can prefill that folder.
  const tabs = [
    { to: '/docs', label: 'Folders', end: true },
    // Visible to every role: a supervisor needs the current sheet more than
    // anyone. RLS limits them to Issued-For-Construction revisions.
    // Path is /docs/register — /docs/drawings belongs to the vault folder.
    { to: '/docs/register', label: 'Drawings' },
    // Mason Learn is not project-scoped, so it is its own route rather than a
    // Docs child — but this is where people look for reference material, so
    // the way in is here.
    { to: '/learn', label: 'Learn' },
  ]

  return (
    <>
      <PageHeader title="Docs" />

      <div className="sticky top-[61px] z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-lg space-y-2 px-4 py-2">
          <ProjectPicker />
          {tabs.length > 1 && (
            <nav className="-mx-1 flex gap-1 overflow-x-auto">
              {tabs.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  end={t.end}
                  className={({ isActive }) =>
                    cn(
                      'shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-secondary text-secondary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </nav>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-lg px-4 py-4">

        {loading && projects.length === 0 && <ListSkeleton rows={3} />}

        {!loading && !error && projects.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No projects assigned to your account.
          </p>
        )}

        {selectedId && <Outlet />}
      </div>
    </>
  )
}
