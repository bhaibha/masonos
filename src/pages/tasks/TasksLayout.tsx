import { useEffect } from 'react'
import { toast } from 'sonner'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { ListSkeleton } from '@/components/Skeleton'
import { ProjectPicker } from '@/components/ProjectPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { addDays, formatDayLabel, todayIst, useSelectedDate } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function TasksLayout() {
  const role = useAuth((s) => s.role)
  const load = useProjects((s) => s.load)
  const projects = useProjects((s) => s.projects)
  const selectedId = useProjects((s) => s.selectedId)
  const loading = useProjects((s) => s.loading)
  const error = useProjects((s) => s.error)

  const [date, setDate] = useSelectedDate()

  // History spans a range and carries its own from/to controls — leaving the
  // single-day picker above it would suggest the two are connected.
  const { pathname } = useLocation()
  // History spans a range; Schedule spans the whole programme and carries its
  // own data date. A single-day picker above either would suggest a connection
  // that isn't there.
  // The bar schedule belongs to the drawing, not to a day — it is the same
  // document in March as in June.
  const showDayPicker =
    !pathname.startsWith('/tasks/history') &&
    !pathname.startsWith('/tasks/schedule') &&
    !pathname.startsWith('/tasks/bbs') &&
    !pathname.startsWith('/tasks/qa') &&
    !pathname.startsWith('/tasks/messages')

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (error) toast.error('Could not load projects', { description: error })
  }, [error])

  const tabs = [
    { to: '/tasks', label: 'Tasks', end: true },
    { to: '/tasks/new', label: 'Add task' },
    { to: '/tasks/history', label: 'History' },
    { to: '/tasks/schedule', label: 'Schedule' },
    { to: '/tasks/qa', label: 'Quality' },
    { to: '/tasks/bbs', label: 'Bar schedule' },
    { to: '/tasks/labour', label: 'Labour' },
    { to: '/tasks/log', label: 'Site log' },
    // M21, supervisors only — everyone else reaches the same screen under
    // Money → Petty cash. A supervisor cannot: /money is MONEY_ROLES, and the
    // holder of the tin is usually the person on site. Not a wider permission,
    // just the doorway to one RLS already opens for them (pca_read).
    ...(role === 'supervisor'
      ? [{ to: '/tasks/petty-cash', label: 'Petty cash' }]
      : []),
    { to: '/tasks/safety', label: 'Safety' },
    { to: '/tasks/incidents', label: 'Incidents' },
    { to: '/tasks/instructions', label: 'Instructions' },
    { to: '/tasks/rfis', label: 'RFIs' },
    { to: '/tasks/snags', label: 'Snags' },
    { to: '/tasks/approvals', label: 'Approvals' },
    { to: '/tasks/clashes', label: 'Clashes' },
    // The team half of the client portal thread. Under Tasks, not Admin: this
    // is project conversation, and it belongs beside the work being discussed.
    { to: '/tasks/messages', label: 'Client messages' },
    // M36. Supervisors get here too — cce_read gives them their project's
    // non-commercial entries and the commitments the site has to deliver.
    { to: '/tasks/client-log', label: 'Client log' },
  ]

  return (
    <>
      <PageHeader title="Tasks" width="wide" />

      <div className="sticky top-[61px] z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="page-w-wide space-y-2 px-4 py-2">
          <ProjectPicker />

          {showDayPicker && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-lg"
              aria-label="Previous day"
              onClick={() => setDate(addDays(date, -1))}
            >
              ‹
            </Button>
            <Input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="h-10 flex-1 text-center text-sm"
              aria-label="Date"
            />
            <Button
              variant="outline"
              size="icon-lg"
              aria-label="Next day"
              onClick={() => setDate(addDays(date, 1))}
            >
              ›
            </Button>
          </div>
          )}

          {showDayPicker && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {formatDayLabel(date)}
                {date === todayIst() && ' · Today'}
              </p>
              {date !== todayIst() && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setDate(todayIst())}
                >
                  Jump to today
                </Button>
              )}
            </div>
          )}

          <nav className="-mx-1 flex gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={{ pathname: t.to, search: `?date=${date}` }}
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
        </div>
      </div>

      <div className="page-w-wide px-4 py-4">

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
