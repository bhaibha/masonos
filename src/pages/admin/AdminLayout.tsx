import { NavLink, Outlet } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { cn } from '@/lib/utils'

const tabs = [
  { to: '/admin', label: 'Projects', end: true },
  { to: '/admin/team', label: 'Team' },
  // Clients are a SEPARATE tab from Team on purpose. Sharing one screen would
  // eventually mean sharing one role picker, and an outsider created as a `pm`
  // is the one mistake in this app that cannot be undone quietly.
  { to: '/admin/clients', label: 'Clients' },
]

export default function AdminLayout() {
  return (
    <>
      <PageHeader title="Manage" eyebrow="Founder only" />

      {/* Same offset as the other four layouts — keeps the tab strip aligned. */}
      <div className="sticky top-[61px] z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-2xl px-5 py-2">
          <nav className="-mx-1 flex gap-1">
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
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-5 py-5">
        <Outlet />
      </div>
    </>
  )
}
