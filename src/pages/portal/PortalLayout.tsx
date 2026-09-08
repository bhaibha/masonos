import {
  FileText,
  Hammer,
  Image,
  LogOut,
  MessageSquare,
  Receipt,
  ShieldCheck,
  Stamp,
} from 'lucide-react'
import { motion } from 'motion/react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Logo } from '@/components/Logo'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

/**
 * THE CLIENT'S SHELL — deliberately its own component, never AppShell.
 *
 * A client must not render one pixel of internal chrome, so this shares no
 * layout code with the team's app. That duplication is the point: if somebody
 * adds a "Money" tab to AppShell in a year, there is no mechanism by which it
 * could appear here.
 *
 * It also looks calmer than the internal app on purpose. The team's screens are
 * dense because they are a working tool; a client opens this a few times a
 * month to see how their house is coming along.
 */
const TABS = [
  { to: '/portal', label: 'Progress', icon: Hammer, end: true },
  { to: '/portal/photos', label: 'Photos', icon: Image },
  { to: '/portal/documents', label: 'Documents', icon: FileText },
  { to: '/portal/bills', label: 'Bills', icon: Receipt },
  { to: '/portal/approvals', label: 'Approvals', icon: Stamp },
  { to: '/portal/messages', label: 'Messages', icon: MessageSquare },
]

export default function PortalLayout() {
  const profile = useAuth((s) => s.profile)
  const signOut = useAuth((s) => s.signOut)
  const location = useLocation()

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="page-w-wide flex items-center justify-between gap-3 px-5 pt-5 pb-4">
          {/* The mark, not the full arch: this header is sticky and 44px of
              vertical space is all it can spend, which is below the point at
              which the columns hold together. */}
          <div className="flex min-w-0 items-center gap-3">
            <Logo variant="mark" height={38} className="shrink-0" />
            <div className="min-w-0">
              <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                Your Masons
              </p>
              <h1 className="font-heading mt-0.5 text-[22px] leading-none font-semibold">
                Client portal
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <p className="hidden truncate text-xs text-muted-foreground sm:block">
              {profile?.full_name ?? ''}
            </p>
            {/* A client's login reaches their bills and their approvals, so
                they get the same option to protect it. */}
            <Link
              to="/security"
              aria-label="Security"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'icon-lg' }),
                'text-muted-foreground',
              )}
            >
              <ShieldCheck className="size-[18px]" />
            </Link>

            <Button
              variant="ghost"
              size="icon-lg"
              aria-label="Sign out"
              onClick={() => void signOut()}
              className="text-muted-foreground"
            >
              <LogOut className="size-[18px]" />
            </Button>
          </div>
        </div>

        {/* Horizontal scroll rather than a bottom bar: six destinations is too
            many for thumb tabs, and a client is as likely to be on a laptop as
            a phone — unlike the site team, who are always on a phone. */}
        <nav aria-label="Portal" className="page-w-wide px-5">
          <ul className="-mx-1 flex gap-1 overflow-x-auto pb-2">
            {TABS.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'relative flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        className="size-4 shrink-0"
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
      </header>

      <main className="page-w-wide px-5 py-6">
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: 'easeOut' }}
        >
          <Outlet />
        </motion.div>
      </main>
    </div>
  )
}
