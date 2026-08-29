import {
  FileText,
  LayoutDashboard,
  ListChecks,
  Package,
  Wallet,
} from 'lucide-react'
import { motion } from 'motion/react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { AssistantLauncher } from '@/components/AssistantPanel'
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

/**
 * TWO NAVIGATIONS, ONE SOURCE OF DESTINATIONS.
 *
 * Below `lg` the bottom tab bar is unchanged — 68px thumb targets, the layout
 * that has actually been used on site. At `lg` and above it is replaced by a
 * left rail, because a bottom tab bar is a phone idiom: with a mouse it is the
 * furthest point from where the eye already is, and it spends vertical space
 * that a laptop has least of.
 *
 * Both read from the same TABS array and the same role filter, so a
 * destination cannot appear in one and not the other — which is how a
 * supervisor would eventually find Money on a desktop.
 */
export function AppShell() {
  const role = useAuth((s) => s.role)
  const location = useLocation()
  const tabs = TABS.filter((t) => t.roles === null || (role && t.roles.includes(role)))

  return (
    <div className="min-h-svh bg-background">
      {/* ---------- desktop: left rail ---------- */}
      <nav
        aria-label="Primary"
        className="fixed inset-y-0 left-0 z-50 hidden w-[232px] flex-col border-r border-border bg-surface/60 px-3 py-6 lg:flex"
      >
        <div className="px-3 pb-6">
          <p className="text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            Your Masons
          </p>
          <p className="font-heading mt-0.5 text-[19px] leading-tight font-semibold">
            Mason OS
          </p>
        </div>

        <ul className="space-y-1">
          {tabs.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  cn(
                    'relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
                    isActive
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span
                        layoutId="rail-indicator"
                        aria-hidden="true"
                        className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary"
                        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                      />
                    )}
                    <Icon
                      className="size-[18px] shrink-0"
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

      {/* The rail is fixed, so the content is inset rather than flexed beside
          it — that keeps every page's own `mx-auto` centring working unchanged
          instead of centring inside a flex child. */}
      <main
        className={cn(
          'pb-[calc(4.75rem+env(safe-area-inset-bottom))]',
          'lg:pb-10 lg:pl-[232px]',
        )}
      >
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

      {/* Reachable from every screen. The panel itself decides what the user's
          role may see and do — it is not hidden from anyone, because the limits
          are enforced in the database, not by hiding the button. */}
      <AssistantLauncher />

      {/* ---------- phone: bottom tabs, unchanged ---------- */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
      >
        <ul className="page-w flex">
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
