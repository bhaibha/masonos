import {
  ArrowLeft,
  ClipboardList,
  FileText,
  Package,
  Receipt,
  Wallet,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FadeUp, RevealItem, Stagger } from '@/components/Reveal'
import { Skeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { barGeometry, formatInr } from '@/lib/format'
import {
  fetchProjectSummary,
  fetchRecentActivity,
} from '@/lib/queries/projectDetail'
import { fetchProject, fetchProjectSpend } from '@/lib/queries/projects'
import {
  type ActivityItem,
  canLogMaterials,
  canSeeMoney,
  DOC_FOLDER_LABEL,
  type DocFolder,
  type Project,
  PROJECT_STATUS_LABEL,
  type ProjectSpend,
  type ProjectSummary,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const role = useAuth((s) => s.role)
  const showMoney = canSeeMoney(role)
  const select = useProjects((s) => s.select)

  const [project, setProject] = useState<Project | null | 'missing'>(null)
  const [spend, setSpend] = useState<ProjectSpend | null>(null)
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [activity, setActivity] = useState<ActivityItem[] | null>(null)

  // Scope every tab to this project the moment the screen opens.
  useEffect(() => {
    if (id) select(id)
  }, [id, select])

  useEffect(() => {
    if (!id) return
    let cancelled = false

    fetchProject(id)
      .then((p) => {
        if (!cancelled) setProject(p ?? 'missing')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setProject('missing')
        toast.error('Could not load project', {
          description: err instanceof Error ? err.message : undefined,
        })
      })

    fetchProjectSpend()
      .then((all) => {
        if (!cancelled) setSpend(all.find((s) => s.project_id === id) ?? null)
      })
      .catch(() => {})

    fetchProjectSummary(id)
      .then((s) => {
        if (!cancelled) setSummary(s)
      })
      .catch(() => {})

    fetchRecentActivity(id)
      .then((a) => {
        if (!cancelled) setActivity(a)
      })
      .catch(() => setActivity([]))

    return () => {
      cancelled = true
    }
  }, [id])

  if (project === 'missing') {
    return (
      <div className="mx-auto max-w-lg px-5 py-6">
        <BackBar />
        <EmptyState
          icon={ClipboardList}
          title="Project not available"
          body="It may have been removed, or your account isn't assigned to it."
          actionLabel="Back to dashboard"
          actionTo="/dashboard"
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-5 pt-4 pb-6">
      <BackBar />

      {project === null ? (
        <HeaderSkeleton />
      ) : (
        <FadeUp>
          <ProjectHeading project={project} showMoney={showMoney} />
        </FadeUp>
      )}

      {/* Money and Activity span the full width; the three compact summaries
          sit two-up from 640px. One column on a phone — money figures don't
          survive a 180px column. */}
      <Stagger className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <RevealItem className="h-full sm:col-span-2">
          <MoneyCard
            spend={spend}
            showMoney={showMoney}
            onOpen={() => navigate('/money')}
          />
        </RevealItem>

        <RevealItem className="h-full">
          <TasksCard summary={summary} onOpen={() => navigate('/tasks')} />
        </RevealItem>

        {canLogMaterials(role) && (
          <RevealItem className="h-full">
            <MaterialsCard
              summary={summary}
              onOpen={() => navigate('/materials')}
            />
          </RevealItem>
        )}

        <RevealItem
          className={cn('h-full', !canLogMaterials(role) && 'sm:col-span-1')}
        >
          <DocsCard summary={summary} onOpen={() => navigate('/docs')} />
        </RevealItem>

        <RevealItem className="h-full sm:col-span-2">
          <ActivityCard items={activity} />
        </RevealItem>
      </Stagger>
    </div>
  )
}

function BackBar() {
  return (
    <Link
      to="/dashboard"
      className="-ml-2 inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Dashboard
    </Link>
  )
}

function ProjectHeading({
  project,
  showMoney,
}: {
  project: Project
  showMoney: boolean
}) {
  return (
    <div className="mt-2">
      <div className="flex items-start justify-between gap-4">
        <h1 className="font-heading text-[30px] leading-[1.1] font-semibold">
          {project.name}
        </h1>
        <StatusPill status={project.status} />
      </div>

      {project.client_name && (
        <p className="mt-2 text-sm text-muted-foreground">
          {project.client_name}
        </p>
      )}
      {project.site_address && (
        <p className="mt-0.5 text-sm text-muted-foreground">
          {project.site_address}
        </p>
      )}

      {/* Contract value and fee are commercial figures — same restriction as
          the rest of the money surface. */}
      {showMoney && (project.contract_value !== null || project.management_fee_pct !== null) && (
        <div className="mt-5 flex gap-8 border-t border-border pt-4">
          {project.contract_value !== null && (
            <div>
              <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                Contract
              </p>
              <p className="figure mt-1 text-[19px] font-semibold">
                {formatInr(project.contract_value)}
              </p>
            </div>
          )}
          {project.management_fee_pct !== null && (
            <div>
              <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                Mgmt fee
              </p>
              <p className="figure mt-1 text-[19px] font-semibold">
                {project.management_fee_pct}%
              </p>
              {/* Rupee value is the generated column from migration 008 —
                  never contract x pct computed here. */}
              {project.management_fee_amount !== null && (
                <p className="mt-0.5 text-[13px] text-muted-foreground tabular-nums">
                  {formatInr(project.management_fee_amount)}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatusPill({ status }: { status: Project['status'] }) {
  const tone =
    status === 'active'
      ? 'bg-[color-mix(in_oklab,var(--positive)_12%,transparent)] text-[var(--positive)]'
      : status === 'on_hold'
        ? 'bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-[var(--warning)]'
        : 'bg-secondary text-muted-foreground'

  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-3 py-1 text-[11px] font-medium tracking-wide',
        tone,
      )}
    >
      {PROJECT_STATUS_LABEL[status]}
    </span>
  )
}

function SectionCard({
  icon: Icon,
  title,
  action,
  onAction,
  children,
}: {
  icon: typeof Wallet
  title: string
  action?: string
  onAction?: () => void
  children: React.ReactNode
}) {
  return (
    <section className="paper flex h-full flex-col p-6">
      <div className="flex items-center gap-2.5">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          {title}
        </h2>
      </div>

      {/* flex-1 lets side-by-side tiles align their buttons at the bottom
          even when their content is different heights. */}
      <div className="mt-4 flex-1">{children}</div>

      {action && onAction && (
        <Button variant="outline" className="mt-5 h-11 w-full" onClick={onAction}>
          {action}
        </Button>
      )}
    </section>
  )
}

function MoneyCard({
  spend,
  showMoney,
  onOpen,
}: {
  spend: ProjectSpend | null
  showMoney: boolean
  onOpen: () => void
}) {
  if (!showMoney) {
    return (
      <SectionCard icon={Wallet} title="Money">
        <p className="text-sm text-muted-foreground">
          Budget figures are restricted for your role.
        </p>
      </SectionCard>
    )
  }

  if (!spend) {
    return (
      <SectionCard icon={Wallet} title="Money">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="mt-3 h-3.5 w-28" />
        <Skeleton className="mt-6 h-[6px] w-full rounded-full" />
      </SectionCard>
    )
  }

  const bar = barGeometry(spend.total_spent, spend.total_budget)
  const over = spend.remaining !== null && spend.remaining < 0

  return (
    <SectionCard
      icon={Wallet}
      title="Money"
      action="View ledger"
      onAction={onOpen}
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Spent
          </p>
          <p
            className={cn(
              'figure mt-1 text-[30px] leading-none font-semibold',
              bar.over && 'text-destructive',
            )}
          >
            {formatInr(spend.total_spent)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Budget
          </p>
          <p className="mt-1 text-base font-medium tabular-nums">
            {bar.hasBudget ? formatInr(spend.total_budget) : '—'}
          </p>
        </div>
      </div>

      {spend.remaining !== null && bar.hasBudget && (
        <p
          className={cn(
            'mt-2.5 text-[13px] font-medium tabular-nums',
            over ? 'text-destructive' : 'text-positive',
          )}
        >
          {over
            ? `${formatInr(Math.abs(spend.remaining))} over budget`
            : `${formatInr(spend.remaining)} remaining`}
        </p>
      )}

      <div className="relative mt-6 h-[6px] w-full overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            bar.over ? 'bg-destructive/45' : 'bg-primary',
          )}
          style={{ width: `${Math.min(bar.fillTo, bar.budgetAt) * 100}%` }}
        />
        {bar.over && (
          <>
            <div
              className="absolute inset-y-0 rounded-full bg-destructive"
              style={{
                left: `${bar.budgetAt * 100}%`,
                width: `${(bar.fillTo - bar.budgetAt) * 100}%`,
              }}
            />
            <div
              className="absolute inset-y-[-2px] w-[2px] bg-card"
              style={{ left: `${bar.budgetAt * 100}%` }}
              aria-hidden="true"
            />
          </>
        )}
      </div>
    </SectionCard>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'danger' | 'warning'
}) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'figure mt-1 text-[24px] leading-none font-semibold',
          tone === 'danger' && 'text-destructive',
          tone === 'warning' && 'text-[var(--warning)]',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function TasksCard({
  summary,
  onOpen,
}: {
  summary: ProjectSummary | null
  onOpen: () => void
}) {
  return (
    <SectionCard
      icon={ClipboardList}
      title="Tasks"
      action="View tasks"
      onAction={onOpen}
    >
      {summary === null ? (
        <Skeleton className="h-8 w-full" />
      ) : (
        <div className="flex gap-8">
          <Stat
            label="This week"
            value={summary.task_pct === null ? '—' : `${summary.task_pct}%`}
          />
          <Stat label="Open" value={String(summary.tasks_open)} />
          <Stat
            label="Overdue"
            value={String(summary.tasks_overdue)}
            tone={summary.tasks_overdue > 0 ? 'danger' : undefined}
          />
        </div>
      )}
    </SectionCard>
  )
}

function MaterialsCard({
  summary,
  onOpen,
}: {
  summary: ProjectSummary | null
  onOpen: () => void
}) {
  return (
    <SectionCard
      icon={Package}
      title="Materials"
      action="View stock"
      onAction={onOpen}
    >
      {summary === null ? (
        <Skeleton className="h-8 w-32" />
      ) : (
        <Stat
          label="Stock alerts"
          value={String(summary.low_stock_count)}
          tone={summary.low_stock_count > 0 ? 'danger' : undefined}
        />
      )}
    </SectionCard>
  )
}

function DocsCard({
  summary,
  onOpen,
}: {
  summary: ProjectSummary | null
  onOpen: () => void
}) {
  const entries = Object.entries(summary?.doc_counts ?? {}).filter(
    ([, n]) => n > 0,
  )

  return (
    <SectionCard
      icon={FileText}
      title="Documents"
      action="View documents"
      onAction={onOpen}
    >
      {summary === null ? (
        <Skeleton className="h-8 w-40" />
      ) : summary.doc_total === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing filed for this project yet.
        </p>
      ) : (
        <>
          <Stat label="Files" value={String(summary.doc_total)} />
          <div className="mt-4 flex flex-wrap gap-1.5">
            {entries.map(([folder, n]) => (
              <span
                key={folder}
                className="rounded-full bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground"
              >
                {DOC_FOLDER_LABEL[folder as DocFolder] ?? folder} · {n}
              </span>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  )
}

const KIND_ICON = {
  expense: Receipt,
  task: ClipboardList,
  site_log: FileText,
} as const

function ActivityCard({ items }: { items: ActivityItem[] | null }) {
  return (
    <SectionCard icon={ClipboardList} title="Recent activity">
      {items === null && (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {items?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing recorded on this project yet.
        </p>
      )}

      {items && items.length > 0 && (
        <ul className="-my-1 divide-y divide-border">
          {items.map((it) => {
            const Icon = KIND_ICON[it.kind]
            return (
              <li key={`${it.kind}-${it.id}`} className="flex gap-3 py-3">
                <Icon
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-medium">{it.title}</p>
                    {it.amount !== null && (
                      <p className="shrink-0 text-sm font-medium tabular-nums">
                        {formatInr(it.amount)}
                      </p>
                    )}
                  </div>
                  {it.subtitle && (
                    <p className="truncate text-xs text-muted-foreground">
                      {it.subtitle}
                    </p>
                  )}
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {relativeIst(it.at)}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </SectionCard>
  )
}

function relativeIst(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

function HeaderSkeleton() {
  return (
    <div className="mt-2">
      <Skeleton className="h-8 w-3/4" />
      <Skeleton className="mt-3 h-4 w-1/2" />
      <Skeleton className="mt-2 h-4 w-2/3" />
    </div>
  )
}
