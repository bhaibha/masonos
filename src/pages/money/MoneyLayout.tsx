import { useEffect } from 'react'
import { toast } from 'sonner'
import { NavLink, Outlet } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { ListSkeleton } from '@/components/Skeleton'
import { ProjectPicker } from '@/components/ProjectPicker'
import { canEditBudgets, canIssueInvoice } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function MoneyLayout() {
  const role = useAuth((s) => s.role)
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

  const tabs = [
    { to: '/money', label: 'Ledger', end: true },
    { to: '/money/new', label: 'Add' },
    { to: '/money/budget', label: 'Budget' },
    ...(canEditBudgets(role)
      ? [{ to: '/money/budget/edit', label: 'Set budgets' }]
      : []),
    { to: '/money/orders', label: 'Orders' },
    { to: '/money/variations', label: 'Variations' },
    // Founder/accounts only — the invoices table's RLS enforces it; the tab is
    // hidden for a PM so they don't hit an empty screen.
    ...(canIssueInvoice(role) ? [{ to: '/money/invoices', label: 'Invoices' }] : []),
    { to: '/money/bills', label: 'RA bills' },
    { to: '/money/retention', label: 'Retention & BG' },
    { to: '/money/insurance', label: 'Insurance' },
    { to: '/money/vendors', label: 'Vendors' },
    // Company-wide as well as per-project, so it is not scoped by the picker.
    { to: '/money/compliance', label: 'Compliance' },
  ]

  return (
    <>
      <PageHeader title="Money" />

      <div className="sticky top-[61px] z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-lg space-y-2 px-4 py-2">
          <ProjectPicker />
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
        </div>
      </div>

      <div className="mx-auto max-w-lg px-4 py-4">

        {loading && projects.length === 0 && <ListSkeleton rows={3} />}

        {!loading && !error && projects.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No projects visible to your account.
          </p>
        )}

        {selectedId && <Outlet context={{ projectId: selectedId }} />}
      </div>
    </>
  )
}

export interface MoneyContext {
  projectId: string
}
