import {
  FileText,
  LayoutDashboard,
  ListChecks,
  Package,
  Wallet,
} from 'lucide-react'
import { motion } from 'motion/react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/lib/types'
import { useAuth } from '@/store/auth'

interface Tab {
  to: string
  label: string
  icon: typeof LayoutDashboard
  /** null = visible to every role */
  roles: UserRole[] | null
}

const TABS: Tab[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: null },
  {
    to: '/tasks',
    label: 'Tasks',
    icon: ListChecks,
    roles: ['founder', 'pm', 'supervisor', 'accounts'],
  },
  // Supervisors must not see money (RLS in 002_money.sql) — hide the tab too.
  { to: '/money', label: 'Money', icon: Wallet, roles: ['founder', 'pm', 'accounts'] },
  {
    to: '/materials',
    label: 'Materials',
    icon: Package,
    roles: ['founder', 'pm', 'supervisor'],
  },
  { to: '/docs', label: 'Docs', icon: FileText, roles: null },
]

export function AppShell() {
  const role = useAuth((s) => s.role)
  const location = useLocation()
  const tabs = TABS.filter((t) => t.roles === null || (role && t.roles.includes(role)))

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <main className="flex-1 pb-[calc(4.75rem+env(safe-area-inset-bottom))]">
        {/* Keyed on the section, so switching tabs cross-fades rather than
            snapping — but navigating within a tab doesn't re-animate. */}
        <motion.div
          key={location.pathname.split('/')[1] ?? 'root'}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          <Outlet />
        </motion.div>
      </main>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl"
      >
        <ul className="mx-auto flex max-w-lg">
          {tabs.map(({ to, label, icon: Icon }) => (
            <li key={to} className="flex-1">
              <NavLink
                to={to}
                className={({ isActive }) =>
                  cn(
                    // 68px tall target — thumb-sized for site use
                    'relative flex h-[68px] flex-col items-center justify-center gap-1.5 text-[11px] tracking-[0.01em]',
                    isActive
                      ? 'text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span
                        layoutId="tab-indicator"
                        aria-hidden="true"
                        className="absolute top-0 h-[2px] w-8 rounded-full bg-primary"
                        transition={{
                          type: 'spring',
                          stiffness: 420,
                          damping: 34,
                        }}
                      />
                    )}
                    <Icon
                      className={cn(
                        'size-[22px] transition-transform',
                        isActive && 'scale-105',
                      )}
                      strokeWidth={isActive ? 2 : 1.6}
                      aria-hidden="true"
                    />
                    <span className={cn(isActive && 'font-medium')}>{label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
