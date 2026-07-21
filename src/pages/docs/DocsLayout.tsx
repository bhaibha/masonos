import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { ProjectPicker } from '@/components/ProjectPicker'
import { canUploadDocs } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function DocsLayout() {
  const role = useAuth((s) => s.role)
  const load = useProjects((s) => s.load)
  const projects = useProjects((s) => s.projects)
  const selectedId = useProjects((s) => s.selectedId)
  const loading = useProjects((s) => s.loading)
  const error = useProjects((s) => s.error)

  useEffect(() => {
    void load()
  }, [load])

  const tabs = [
    { to: '/docs', label: 'Folders', end: true },
    ...(canUploadDocs(role) ? [{ to: '/docs/upload', label: 'Upload' }] : []),
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
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {loading && projects.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        )}

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
