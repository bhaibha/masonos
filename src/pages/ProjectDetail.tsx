import {
  Archive,
  ArrowLeft,
  BadgeCheck,
  ClipboardCheck,
  ClipboardList,
  FileText,
  Package,
  Receipt,
  Activity,
  ShieldCheck,
  Stamp,
  Wallet,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { Figure } from '@/components/Figure'
import { FadeUp, RevealItem, Stagger } from '@/components/Reveal'
import { Skeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { barGeometry, formatInr } from '@/lib/format'
import {
  type ArchiveProgress,
  buildProjectArchive,
  saveArchive,
} from '@/lib/projectArchive'
import {
  fetchProjectSummary,
  fetchRecentActivity,
} from '@/lib/queries/projectDetail'
import { fetchSafetySummary } from '@/lib/queries/safety'
import { fetchQaSummary } from '@/lib/queries/qa'
import { fetchSnagSummary } from '@/lib/queries/snags'
import { fetchApprovalSummary } from '@/lib/queries/approvals'
import { fetchHealthFlags } from '@/lib/queries/signals'
import { fetchProjectContract } from '@/lib/queries/variations'
import {
  fetchProject,
  fetchProjectCommercials,
  fetchProjectSpend,
  type ProjectCommercials,
} from '@/lib/queries/projects'
import {
  type ActivityItem,
  canAdminister,
  canLogMaterials,
  canSeeMoney,
  DOC_FOLDER_LABEL,
  type DocFolder,
  type Project,
  PROJECT_STATUS_LABEL,
  type ProjectContract,
  type ProjectSpend,
  type ProjectSummary,
  type SafetySummary,
  DLP_WARN_DAYS,
  SNAG_SEVERITY_LABEL,
  type QaSummary,
  type SnagSummary,
  type ApprovalSummary,
  type HealthFlag,
  canSeeSignals,
  SIGNAL_LEVEL_LABEL,
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
  const [commercials, setCommercials] = useState<ProjectCommercials | null>(null)
  const [contract, setContract] = useState<ProjectContract | null>(null)
  const [spend, setSpend] = useState<ProjectSpend | null>(null)
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [safety, setSafety] = useState<SafetySummary | null>(null)
  const [snags, setSnags] = useState<SnagSummary | null>(null)
  const [qa, setQa] = useState<QaSummary | null>(null)
  const [approvals, setApprovals] = useState<ApprovalSummary | null>(null)
  const [signals, setSignals] = useState<HealthFlag[] | null>(null)
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

    // Contract value + fee come from the role-gated view, and only for
    // money-roles. Supervisors never fetch them.
    if (showMoney) {
      fetchProjectCommercials(id)
        .then((c) => {
          if (!cancelled) setCommercials(c)
        })
        .catch(() => {})
      fetchProjectContract(id)
        .then((c) => {
          if (!cancelled) setContract(c)
        })
        .catch(() => {})
    }

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

    fetchSafetySummary(id)
      .then((s) => {
        if (!cancelled) setSafety(s)
      })
      .catch(() => {})

    // Counts and DLP position both come from fn_project_snag_summary — no
    // tallying here.
    // Same shape as the snag summary: one server-side function, so the card
    // and the QA screen can never disagree about how many NCRs are open.
    fetchQaSummary(id).then(setQa).catch(() => setQa(null))
    // Same shape again: one server-side function, so the card cannot disagree
    // with the register it links to.
    fetchApprovalSummary(id).then(setApprovals).catch(() => setApprovals(null))
    // D3 signals for this project only. canSeeSignals and canSeeMoney are the
    // same three roles, so `showMoney` is reused here rather than reading
    // `role` again — which would add a dependency to an effect that
    // deliberately runs on `id` alone. Supervisors get zero rows from the
    // server regardless; the card is hidden for them because an always-empty
    // card is clutter, not because it would leak.
    if (showMoney) {
      fetchHealthFlags(id).then(setSignals).catch(() => setSignals([]))
    } else {
      setSignals([])
    }

    fetchSnagSummary(id)
      .then((s) => {
        if (!cancelled) setSnags(s)
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
      <div className="page-w-wide px-5 py-6">
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
          <ProjectHeading
            project={project}
            commercials={commercials}
            contract={contract}
            showMoney={showMoney}
          />
        </FadeUp>
      )}

      {/* Money and Activity span the full width; the three compact summaries
          sit two-up from 640px. One column on a phone — money figures don't
          survive a 180px column. */}
      <Stagger className="card-grid card-grid-3 mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
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

        <RevealItem className="h-full">
          <DocsCard summary={summary} onOpen={() => navigate('/docs')} />
        </RevealItem>

        <RevealItem className="h-full">
          <SafetyCard safety={safety} onOpen={() => navigate('/tasks/safety')} />
        </RevealItem>

        <RevealItem className="h-full">
          <SnagsCard snags={snags} onOpen={() => navigate('/tasks/snags')} />
        </RevealItem>

        <RevealItem className="h-full">
          <QaCard qa={qa} onOpen={() => navigate('/tasks/qa')} />
        </RevealItem>

        {canSeeSignals(role) && (signals === null || signals.length > 0) && (
          <RevealItem className="h-full sm:col-span-2">
            <SignalsCard
              flags={signals}
              onOpen={() => navigate('/money/signals')}
            />
          </RevealItem>
        )}

        <RevealItem className="h-full">
          <ApprovalsCard
            a={approvals}
            onOpen={() => navigate('/tasks/approvals')}
          />
        </RevealItem>

        <RevealItem className="h-full sm:col-span-2">
          <ActivityCard items={activity} />
        </RevealItem>
      </Stagger>

      {/* Founder only: an archive contains every figure on the project. */}
      {canAdminister(role) && project !== null && (
        <ArchiveCard projectId={project.id} projectName={project.name} />
      )}
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
  commercials,
  contract,
  showMoney,
}: {
  project: Project
  commercials: ProjectCommercials | null
  contract: ProjectContract | null
  showMoney: boolean
}) {
  // Commercials come from the role-gated view (migration 010), never off the
  // project row. Supervisors never fetch them, so this block stays empty.
  const contractVal = commercials?.contract_value ?? null
  const feePct = commercials?.management_fee_pct ?? null
  const feeAmount = commercials?.management_fee_amount ?? null
  // Revised value only when approved variations exist (migration 016).
  const hasVariations = contract !== null && contract.variations_value !== 0

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

      {showMoney && (contractVal !== null || feePct !== null) && (
        <div className="mt-5 flex gap-8 border-t border-border pt-4">
          {contractVal !== null && (
            <div>
              <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                {hasVariations ? 'Revised contract' : 'Contract'}
              </p>
              <p className="figure mt-1 text-[19px] font-semibold">
                {formatInr(
                  hasVariations && contract
                    ? contract.revised_contract_value
                    : contractVal,
                )}
              </p>
              {hasVariations && contract && (
                <p className="mt-0.5 text-[13px] text-muted-foreground tabular-nums">
                  {formatInr(contract.contract_value)}{' '}
                  {contract.variations_value >= 0 ? '+' : '−'}{' '}
                  {formatInr(Math.abs(contract.variations_value))} VOs
                </p>
              )}
            </div>
          )}
          {feePct !== null && (
            <div>
              <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                Mgmt fee
              </p>
              <p className="figure mt-1 text-[19px] font-semibold">
                {feePct}%
              </p>
              {/* Rupee value is the generated column from migration 008 —
                  never contract x pct computed here. */}
              {feeAmount !== null && (
                <p className="mt-0.5 text-[13px] text-muted-foreground tabular-nums">
                  {formatInr(feeAmount)}
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
    <section
      className={cn(
        'paper flex h-full flex-col p-6',
        // Only a card you can actually open lifts. A lift on a card that does
        // nothing is a promise the UI does not keep.
        onAction && 'card-interactive',
      )}
    >
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
            <Figure value={spend.total_spent} />
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
  /** ReactNode, so a <Figure> can count up in place of a formatted string. */
  value: React.ReactNode
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

function SafetyCard({
  safety,
  onOpen,
}: {
  safety: SafetySummary | null
  onOpen: () => void
}) {
  const pct =
    safety && safety.week_days_elapsed > 0
      ? Math.round((safety.week_checklist_days / safety.week_days_elapsed) * 100)
      : null

  return (
    <SectionCard
      icon={ShieldCheck}
      title="Safety"
      action="Open checklist"
      onAction={onOpen}
    >
      {safety === null ? (
        <Skeleton className="h-8 w-40" />
      ) : (
        <div className="flex gap-8">
          <Stat
            label="Days incident-free"
            value={
              safety.days_since_incident === null
                ? '—'
                : String(safety.days_since_incident)
            }
            tone={
              safety.days_since_incident !== null &&
              safety.days_since_incident === 0
                ? 'danger'
                : undefined
            }
          />
          <Stat
            label="Checklist this week"
            value={pct === null ? '—' : `${pct}%`}
          />
          {safety.open_incidents > 0 && (
            <Stat
              label="Open"
              value={String(safety.open_incidents)}
              tone="warning"
            />
          )}
        </div>
      )}
    </SectionCard>
  )
}

/**
 * Handover archive. Everything about the project as CSV, plus every file, in
 * one zip — the pack you hand over at completion, or keep when the project is
 * archived.
 */
function ArchiveCard({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ArchiveProgress | null>(null)

  async function run() {
    setBusy(true)
    try {
      const { blob, fileCount, missing } = await buildProjectArchive(
        projectId,
        projectName,
        setProgress,
      )
      saveArchive(blob, projectName)
      toast.success('Archive downloaded', {
        description:
          `${fileCount} file${fileCount === 1 ? '' : 's'} and every record as CSV.` +
          (missing > 0 ? ` ${missing} file(s) could not be read.` : ''),
      })
    } catch (err) {
      toast.error('Could not build the archive', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    setBusy(false)
    setProgress(null)
  }

  return (
    <FadeUp>
      <section className="paper mt-4 p-6">
        <div className="flex items-center gap-2.5">
          <Archive className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Handover archive
          </h2>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          One zip with every record as a CSV, every document, drawing, photo,
          receipt and scan, and an index page to read it offline. Save it
          wherever you keep project records — it needs nothing from this app to
          open.
        </p>

        {progress && (
          <div className="mt-4">
            <p className="text-xs text-muted-foreground">{progress.label}</p>
            <div className="mt-2 h-[6px] w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${progress.pct}%` }}
              />
            </div>
          </div>
        )}

        <Button
          variant="outline"
          className="mt-5 h-11 w-full"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? 'Building…' : 'Export project archive'}
        </Button>

        <p className="mt-3 text-xs text-muted-foreground">
          Large projects take a minute or two — keep this tab open while it
          builds.
        </p>
      </section>
    </FadeUp>
  )
}

/**
 * Quality at a glance.
 *
 * Blocking hold points come first and in danger colour, because that is the
 * only line on this whole screen that means work has stopped. Everything else
 * on the card is a number; that one is an instruction.
 */
function QaCard({
  qa: q,
  onOpen,
}: {
  qa: QaSummary | null
  onOpen: () => void
}) {
  return (
    <SectionCard
      icon={BadgeCheck}
      title="Quality"
      action="View QA"
      onAction={onOpen}
    >
      {q === null ? (
        <Skeleton className="h-8 w-40" />
      ) : (
        <>
          {q.urgent_comments > 0 && (
            <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
              {q.urgent_comments} urgent observation
              {q.urgent_comments === 1 ? '' : 's'} open
            </p>
          )}

          <div className="flex gap-8">
            <Stat
              label="Open comments"
              value={String(q.open_comments)}
              tone={
                q.urgent_comments > 0
                  ? 'danger'
                  : q.open_comments > 0
                    ? 'warning'
                    : undefined
              }
            />
            <Stat
              label="Open NCRs"
              value={String(q.open_ncrs)}
              tone={
                q.ncr_critical > 0
                  ? 'danger'
                  : q.open_ncrs > 0
                    ? 'warning'
                    : undefined
              }
            />
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            {q.total_comments === 0
              ? 'No site observations logged yet.'
              : `${q.total_comments} observation${q.total_comments === 1 ? '' : 's'} logged`}
            {q.qa_docs > 0 && ` · ${q.qa_docs} QA document${q.qa_docs === 1 ? '' : 's'}`}
          </p>
        </>
      )}
    </SectionCard>
  )
}

/**
 * Client approvals (C2). Two numbers a founder wants at a glance: what the
 * client has not come back on, and how many decided approvals have nothing
 * attached to them.
 *
 * No amounts here, ever — the table carries none, so this card is safe for a
 * supervisor without a role check.
 */
/**
 * D3 health signals for this project.
 *
 * Rendered only when something is flagging — an "all clear" card would be
 * claiming something these checks cannot support. The panel itself says the
 * same thing in its empty state.
 */
function SignalsCard({
  flags,
  onOpen,
}: {
  flags: HealthFlag[] | null
  onOpen: () => void
}) {
  return (
    <SectionCard
      icon={Activity}
      title="Signals"
      action="View all"
      onAction={onOpen}
    >
      {flags === null ? (
        <Skeleton className="h-8 w-40" />
      ) : (
        <div className="space-y-2">
          {flags.slice(0, 3).map((f) => (
            <div
              key={f.code}
              className="flex items-start justify-between gap-3 rounded-lg bg-secondary/50 px-3 py-2"
            >
              <p className="text-xs leading-relaxed">{f.headline}</p>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                  f.level === 'concern'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
                )}
              >
                {SIGNAL_LEVEL_LABEL[f.level]}
              </span>
            </div>
          ))}
          {flags.length > 3 && (
            <p className="text-[11px] text-muted-foreground">
              and {flags.length - 3} more.
            </p>
          )}
          {/* The framing travels with the signals, not just on the panel. */}
          <p className="text-[10px] text-muted-foreground">
            Early signals, not forecasts — indicative only.
          </p>
        </div>
      )}
    </SectionCard>
  )
}

function ApprovalsCard({
  a,
  onOpen,
}: {
  a: ApprovalSummary | null
  onOpen: () => void
}) {
  return (
    <SectionCard
      icon={Stamp}
      title="Client approvals"
      action="View register"
      onAction={onOpen}
    >
      {a === null ? (
        <Skeleton className="h-8 w-40" />
      ) : (
        <>
          <div className="flex gap-8">
            <Stat
              label="Awaiting client"
              value={String(a.pending_count)}
              tone={a.pending_count > 0 ? 'warning' : undefined}
            />
            <Stat label="Approved" value={String(a.approved_count)} />
          </div>

          {/* An age, not just a count: three pending approvals is normal, one
              of them sitting nine weeks is what stalls a job. */}
          {a.oldest_pending_days !== null && a.oldest_pending_days > 0 && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Oldest has been waiting {a.oldest_pending_days} day
              {a.oldest_pending_days === 1 ? '' : 's'}.
            </p>
          )}

          {/* Named rather than hidden: this is the number that matters if an
              approval is ever questioned. */}
          {a.no_evidence_count > 0 && (
            <p className="mt-2 text-[11px] text-[var(--warning)]">
              {a.no_evidence_count} decided approval
              {a.no_evidence_count === 1 ? '' : 's'} with no evidence attached.
            </p>
          )}

          {a.pending_count === 0 &&
            a.approved_count === 0 &&
            a.rejected_count === 0 && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Nothing logged yet. Client decisions recorded here stay
                answerable months later.
              </p>
            )}
        </>
      )}
    </SectionCard>
  )
}

function SnagsCard({
  snags: s,
  onOpen,
}: {
  snags: SnagSummary | null
  onOpen: () => void
}) {
  const dlpEnding =
    s !== null &&
    s.dlp_active &&
    s.dlp_days_left !== null &&
    s.dlp_days_left <= DLP_WARN_DAYS

  return (
    <SectionCard
      icon={ClipboardCheck}
      title="Snags"
      action="View snags"
      onAction={onOpen}
    >
      {s === null ? (
        <Skeleton className="h-8 w-40" />
      ) : (
        <>
          <div className="flex gap-8">
            <Stat
              label="Open"
              value={String(s.open_count + s.in_progress_count)}
              tone={s.open_high > 0 ? 'danger' : undefined}
            />
            <Stat
              label="Awaiting sign-off"
              value={String(s.resolved_count)}
              tone={s.resolved_count > 0 ? 'warning' : undefined}
            />
          </div>

          {(s.open_high > 0 || s.open_medium > 0 || s.open_low > 0) && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {(['high', 'medium', 'low'] as const).map((sev) => {
                const n =
                  sev === 'high'
                    ? s.open_high
                    : sev === 'medium'
                      ? s.open_medium
                      : s.open_low
                if (n === 0) return null
                return (
                  <span
                    key={sev}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-[11px]',
                      sev === 'high'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-secondary text-muted-foreground',
                    )}
                  >
                    {SNAG_SEVERITY_LABEL[sev]} · {n}
                  </span>
                )
              })}
            </div>
          )}

          {/* The DLP line is the one that costs money if it's missed: after the
              end date, defects stop being ours to fix under the contract. */}
          {s.dlp_end && (
            <p
              className={cn(
                'mt-4 text-[13px]',
                dlpEnding ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {s.dlp_active
                ? `DLP ends ${s.dlp_end}${s.dlp_days_left !== null ? ` · ${s.dlp_days_left} days left` : ''}`
                : s.dlp_days_left !== null && s.dlp_days_left < 0
                  ? `DLP ended ${s.dlp_end}`
                  : `DLP starts ${s.dlp_start ?? '—'}`}
              {s.dlp_snag_count > 0 && ` · ${s.dlp_snag_count} open in period`}
            </p>
          )}
        </>
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
