import { ListChecks } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { DeleteButton } from '@/components/DeleteAction'
import { Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { EmptyState } from '@/components/EmptyState'
import { OpenInstructions } from '@/components/OpenInstructions'
import {
  OtherProjectsHint,
  useSelectedProjectName,
} from '@/components/ProjectPicker'
import { SendTaskList } from '@/components/SendTaskList'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { fetchTasks, rolloverTasks, updateTaskStatus } from '@/lib/queries/tasks'
import {
  canWriteTasks,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  TASK_STATUS_LABEL,
  type TaskRow,
  type TaskStatus,
  type UserRole,
} from '@/lib/types'
import { addDays, formatDayLabel, useSelectedDate } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function TaskList() {
  const navigate = useNavigate()
  // Project comes from the store — the single source of truth, and immune to
  // where this screen sits in the route tree.
  const projectId = useProjects((s) => s.selectedId)
  const projectName = useSelectedProjectName()
  const role = useAuth((s) => s.role)
  const canWrite = canWriteTasks(role)
  const [date] = useSelectedDate()

  const [tasks, setTasks] = useState<TaskRow[] | null>(null)
  const [rolling, setRolling] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setTasks(await fetchTasks(projectId, date))
    } catch (err) {
      toast.error('Could not load tasks.', { description: errText(err) })
    }
  }, [projectId, date])

  useEffect(() => {
    setTasks(null)
    void reload()
  }, [reload])

  const incomplete =
    tasks?.filter((t) => t.status !== 'done').length ?? 0

  async function onRollover() {
    if (!projectId) return

    const ok = window.confirm(
      `Roll over ${incomplete} unfinished task${incomplete === 1 ? '' : 's'} ` +
        `from ${formatDayLabel(date)} to ${formatDayLabel(addDays(date, 1))}?\n\n` +
        `This affects the selected project only.`,
    )
    if (!ok) return

    setRolling(true)
    try {
      const n = await rolloverTasks(projectId, date)
      toast.success(
        n === 0
          ? 'Nothing to roll over — everything was already carried forward or done.'
          : `${n} task${n === 1 ? '' : 's'} rolled over to ${formatDayLabel(addDays(date, 1))}.`,
      )
      await reload()
    } catch (err) {
      toast.error('Rollover failed.', { description: errText(err) })
    }
    setRolling(false)
  }

  return (
    <div className="space-y-4 pb-6">
      {/* Outstanding instructions sit above the day's work and stay there until
          they're marked complete — they have no planned date, so they'd
          otherwise only be visible on their own tab. Renders nothing when
          there are none. */}
      <OpenInstructions projectId={projectId} />

      {tasks === null && <ListSkeleton rows={4} />}

      {tasks?.length === 0 && (
        <>
          <EmptyState
            icon={ListChecks}
            title="Nothing planned for this day"
            body="Add the work you want done today — mark each one Done, Partial or Not done as the day goes."
            actionLabel={canWrite ? 'Add a task' : undefined}
            onAction={canWrite ? () => navigate('/tasks/new') : undefined}
          />
          <OtherProjectsHint />
        </>
      )}

      {tasks && tasks.length > 0 && (
        <Stagger className="card-grid">
          {tasks.map((t) => (
            <RevealItem key={t.id}>
              <TaskCard
                task={t}
                canWrite={canWrite}
                role={role}
                onChanged={reload}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}

      {/* Sits alongside the 7am push, not instead of it: the push only reaches
          people who installed the app and granted permission. */}
      {canWrite && projectId && tasks && tasks.length > 0 && (
        <SendTaskList
          projectId={projectId}
          projectName={projectName}
          date={date}
          tasks={tasks}
        />
      )}

      {canWrite && tasks && tasks.length > 0 && incomplete > 0 && (
        <Button
          variant="outline"
          className="h-12 w-full text-base"
          disabled={rolling}
          onClick={() => void onRollover()}
        >
          {rolling
            ? 'Rolling over…'
            : `Roll over ${incomplete} unfinished to tomorrow`}
        </Button>
      )}
    </div>
  )
}

const STATUS_STYLE: Record<TaskStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  done: 'bg-primary text-primary-foreground',
  partial: 'bg-chart-4/30 text-foreground',
  not_done: 'bg-destructive/15 text-destructive',
}

function TaskCard({
  task,
  canWrite,
  role,
  onChanged,
}: {
  task: TaskRow
  canWrite: boolean
  role: UserRole | null
  onChanged: () => Promise<void>
}) {
  const [mode, setMode] = useState<'idle' | 'partial' | 'not_done'>('idle')
  const [doneQty, setDoneQty] = useState(
    task.done_qty === null ? '' : String(task.done_qty),
  )
  const [reason, setReason] = useState(task.not_done_reason ?? '')
  const [busy, setBusy] = useState(false)

  async function apply(status: TaskStatus, extra?: Record<string, unknown>) {
    setBusy(true)
    try {
      await updateTaskStatus(task.id, { status, ...extra })
      setMode('idle')
      await onChanged()
    } catch (err) {
      toast.error('Could not update the task.', { description: errText(err) })
    }
    setBusy(false)
  }

  async function savePartial() {
    const qty = Number(doneQty)
    if (!Number.isFinite(qty) || qty < 0) {
      toast.error('Enter the quantity completed.')
      return
    }
    await apply('partial', { done_qty: qty })
  }

  async function saveNotDone() {
    if (reason.trim() === '') {
      toast.error('A reason is required when a task is not done.')
      return
    }
    await apply('not_done', { not_done_reason: reason.trim() })
  }

  return (
    <div
      className={cn(
        'paper p-5',
        task.priority === 'urgent' &&
          task.status !== 'done' &&
          'border-l-[3px] border-l-destructive',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Only urgent and high get a badge. Normal is the default and
              silent — a badge on every row is a badge on none. */}
          {(task.priority === 'urgent' || task.priority === 'high') && (
            <span
              className={cn(
                'mb-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
                PRIORITY_TONE[task.priority],
              )}
            >
              {PRIORITY_LABEL[task.priority]}
            </span>
          )}
          <p className="font-medium">{task.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {[task.trade, task.work_area].filter(Boolean).join(' · ') || '—'}
          </p>
          {task.target_qty !== null && (
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              Target {task.target_qty} {task.qty_unit ?? ''}
              {task.status === 'partial' && task.done_qty !== null && (
                <> · done {task.done_qty}</>
              )}
            </p>
          )}
        </div>
        <span
          className={cn(
            'shrink-0 rounded-md px-2 py-1 text-[11px] font-medium',
            STATUS_STYLE[task.status],
          )}
        >
          {TASK_STATUS_LABEL[task.status]}
        </span>
      </div>

      {task.rolled_from && (
        <p className="mt-2 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
          Rolled over from{' '}
          {task.rolled_from_date ? formatDayLabel(task.rolled_from_date) : 'a previous day'}
        </p>
      )}

      {task.status === 'not_done' && task.not_done_reason && (
        <p className="mt-2 text-xs text-destructive">
          Reason: {task.not_done_reason}
        </p>
      )}

      {canWrite && mode === 'idle' && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Button
            variant={task.status === 'done' ? 'default' : 'outline'}
            className="h-12"
            disabled={busy}
            onClick={() => void apply('done')}
          >
            Done
          </Button>
          <Button
            variant={task.status === 'partial' ? 'default' : 'outline'}
            className="h-12"
            disabled={busy}
            onClick={() => setMode('partial')}
          >
            Partial
          </Button>
          <Button
            variant={task.status === 'not_done' ? 'default' : 'outline'}
            className="h-12"
            disabled={busy}
            onClick={() => setMode('not_done')}
          >
            Not done
          </Button>
        </div>
      )}

      {/* A task has no downstream effect, so it's a real delete — unless it
          was rolled over, which fn_delete_record refuses and explains. */}
      {mode === 'idle' && (
        <DeleteButton
          table="tasks"
          id={task.id}
          name={task.title}
          role={role}
          onDeleted={onChanged}
          className="mt-2 -ml-2"
        />
      )}

      {canWrite && mode === 'partial' && (
        <div className="mt-3 space-y-2">
          <label htmlFor={`qty-${task.id}`} className="text-sm font-medium">
            Quantity completed {task.qty_unit ? `(${task.qty_unit})` : ''}
          </label>
          <Input
            id={`qty-${task.id}`}
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={doneQty}
            onChange={(e) => setDoneQty(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="0"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              className="h-12"
              onClick={() => setMode('idle')}
            >
              Cancel
            </Button>
            <Button
              className="h-12"
              disabled={busy}
              onClick={() => void savePartial()}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      {canWrite && mode === 'not_done' && (
        <div className="mt-3 space-y-2">
          <label htmlFor={`reason-${task.id}`} className="text-sm font-medium">
            Why not? <span className="text-destructive">*</span>
          </label>
          <Textarea
            id={`reason-${task.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Material not delivered, rain, labour short…"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              className="h-12"
              onClick={() => setMode('idle')}
            >
              Cancel
            </Button>
            <Button
              className="h-12"
              disabled={busy}
              onClick={() => void saveNotDone()}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
