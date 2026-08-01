import { useEffect } from 'react'
import { toast } from 'sonner'
import { NavLink, Outlet } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { ListSkeleton } from '@/components/Skeleton'
import { ProjectPicker } from '@/components/ProjectPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { addDays, formatDayLabel, todayIst, useSelectedDate } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useProjects } from '@/store/project'

export default function TasksLayout() {
  const load = useProjects((s) => s.load)
  const projects = useProjects((s) => s.projects)
  const selectedId = useProjects((s) => s.selectedId)
  const loading = useProjects((s) => s.loading)
  const error = useProjects((s) => s.error)

  const [date, setDate] = useSelectedDate()

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (error) toast.error('Could not load projects', { description: error })
  }, [error])

  const tabs = [
    { to: '/tasks', label: 'Tasks', end: true },
    { to: '/tasks/new', label: 'Add task' },
    { to: '/tasks/log', label: 'Site log' },
    { to: '/tasks/safety', label: 'Safety' },
    { to: '/tasks/incidents', label: 'Incidents' },
    { to: '/tasks/instructions', label: 'Instructions' },
    { to: '/tasks/rfis', label: 'RFIs' },
  ]

  return (
    <>
      <PageHeader title="Tasks" />

      <div className="sticky top-[61px] z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-lg space-y-2 px-4 py-2">
          <ProjectPicker />

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
