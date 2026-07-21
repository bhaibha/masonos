import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldRow, Select } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createTask } from '@/lib/queries/tasks'
import { canWriteTasks, QTY_UNITS, TRADES } from '@/lib/types'
import { useSelectedDate } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function TaskForm() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const navigate = useNavigate()
  const [date, setDate] = useSelectedDate()

  const [title, setTitle] = useState('')
  const [trade, setTrade] = useState('')
  const [workArea, setWorkArea] = useState('')
  const [targetQty, setTargetQty] = useState('')
  const [qtyUnit, setQtyUnit] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canWriteTasks(role)) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Your role can view tasks but not add them.
      </p>
    )
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!projectId) {
      setError('No project selected.')
      return
    }
    if (title.trim() === '') {
      setError('Give the task a title.')
      return
    }

    let qty: number | null = null
    if (targetQty.trim() !== '') {
      qty = Number(targetQty)
      if (!Number.isFinite(qty) || qty < 0) {
        setError('Target quantity must be zero or more.')
        return
      }
    }

    setBusy(true)
    try {
      await createTask({
        project_id: projectId,
        title: title.trim(),
        trade,
        work_area: workArea.trim(),
        planned_date: date,
        target_qty: qty,
        qty_unit: qtyUnit,
      })
      navigate({ pathname: '/tasks', search: `?date=${date}` })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the task.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 pb-6" noValidate>
      <FieldRow label="Task" htmlFor="title">
        <Input
          id="title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-12 text-base"
          placeholder="Slab shuttering — east wing"
        />
      </FieldRow>

      <FieldRow label="Trade" htmlFor="trade">
        <Select
          id="trade"
          value={trade}
          onChange={(e) => setTrade(e.target.value)}
        >
          <option value="">Not specified</option>
          {TRADES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow label="Work area" htmlFor="work_area">
        <Input
          id="work_area"
          value={workArea}
          onChange={(e) => setWorkArea(e.target.value)}
          className="h-12 text-base"
          placeholder="First floor slab"
        />
      </FieldRow>

      <FieldRow
        label="Planned date"
        htmlFor="planned_date"
        hint="Changing this also moves the day you're viewing."
      >
        <Input
          id="planned_date"
          type="date"
          required
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Target qty" htmlFor="target_qty">
          <Input
            id="target_qty"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={targetQty}
            onChange={(e) => setTargetQty(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="Optional"
          />
        </FieldRow>

        <FieldRow label="Unit" htmlFor="qty_unit">
          <Select
            id="qty_unit"
            value={qtyUnit}
            onChange={(e) => setQtyUnit(e.target.value)}
          >
            <option value="">—</option>
            {QTY_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </FieldRow>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        {busy ? 'Adding…' : 'Add task'}
      </Button>
    </form>
  )
}
