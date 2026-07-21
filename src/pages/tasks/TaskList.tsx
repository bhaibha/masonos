import { useCallback, useEffect, useState } from 'react'
import { Textarea } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchTasks, rolloverTasks, updateTaskStatus } from '@/lib/queries/tasks'
import {
  canWriteTasks,
  TASK_STATUS_LABEL,
  type TaskRow,
  type TaskStatus,
} from '@/lib/types'
import { addDays, formatDayLabel, useSelectedDate } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function TaskList() {
  // Project comes from the store — the single source of truth, and immune to
  // where this screen sits in the route tree.
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const canWrite = canWriteTasks(role)
  const [date] = useSelectedDate()

  const [tasks, setTasks] = useState<TaskRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rolling, setRolling] = useState(false)
  const [rollNotice, setRollNotice] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    setError(null)
    try {
      setTasks(await fetchTasks(projectId, date))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load tasks.')
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
    setRollNotice(null)
    setError(null)
    try {
      const n = await rolloverTasks(projectId, date)
      setRollNotice(
        n === 0
          ? 'Nothing to roll over — everything was already carried forward or done.'
          : `${n} task${n === 1 ? '' : 's'} rolled over to ${formatDayLabel(addDays(date, 1))}.`,
      )
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollover failed.')
    }
    setRolling(false)
  }

  return (
    <div className="space-y-4 pb-6">
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {rollNotice && !error && (
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm">{rollNotice}</p>
      )}

      {tasks === null && !error && (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      )}

      {tasks?.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No tasks planned for this day.
        </p>
      )}

      {tasks && tasks.length > 0 && (
        <ul className="space-y-3">
          {tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              canWrite={canWrite}
              onChanged={reload}
              onError={setError}
            />
          ))}
        </ul>
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
  onChanged,
  onError,
}: {
  task: TaskRow
  canWrite: boolean
  onChanged: () => Promise<void>
  onError: (msg: string) => void
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
      onError(err instanceof Error ? err.message : 'Could not update the task.')
    }
    setBusy(false)
  }

  async function savePartial() {
    const qty = Number(doneQty)
    if (!Number.isFinite(qty) || qty < 0) {
      onError('Enter the quantity completed.')
      return
    }
    await apply('partial', { done_qty: qty })
  }

  async function saveNotDone() {
    if (reason.trim() === '') {
      onError('A reason is required when a task is not done.')
      return
    }
    await apply('not_done', { not_done_reason: reason.trim() })
  }

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
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
    </li>
  )
}
