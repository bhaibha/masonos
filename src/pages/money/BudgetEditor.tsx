import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useOutletContext } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import { Input } from '@/components/ui/input'
import { formatInr } from '@/lib/format'
import {
  deleteBudget,
  fetchBudgets,
  fetchCategories,
  upsertBudget,
} from '@/lib/queries/expenses'
import type { ExpenseCategory } from '@/lib/types'
import type { MoneyContext } from './MoneyLayout'

export default function BudgetEditor() {
  const { projectId } = useOutletContext<MoneyContext>()

  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  /** categoryId → saved amount from Postgres */
  const [saved, setSaved] = useState<Record<number, number>>({})
  /** categoryId → raw text in the input */
  const [draft, setDraft] = useState<Record<number, string>>({})

  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([fetchCategories(), fetchBudgets(projectId)])
      .then(([cats, budgets]) => {
        if (cancelled) return
        const map: Record<number, number> = {}
        for (const b of budgets) map[b.category_id] = b.amount
        setCategories(cats)
        setSaved(map)
        setDraft(
          Object.fromEntries(
            Object.entries(map).map(([k, v]) => [k, String(v)]),
          ),
        )
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        toast.error('Could not load budgets.', { description: errText(err) })
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  async function save(categoryId: number) {
    const raw = draft[categoryId] ?? ''

    setSavingId(categoryId)
    try {
      if (raw.trim() === '') {
        await deleteBudget(projectId, categoryId)
        setSaved((s) => {
          const next = { ...s }
          delete next[categoryId]
          return next
        })
        toast.success('Budget removed.')
      } else {
        const amount = Number(raw)
        if (!Number.isFinite(amount) || amount < 0) {
          toast.error('Budget must be zero or more.')
          setSavingId(null)
          return
        }
        await upsertBudget(projectId, categoryId, amount)
        setSaved((s) => ({ ...s, [categoryId]: amount }))
        toast.success('Saved.')
      }
    } catch (err) {
      toast.error('Could not save the budget.', { description: errText(err) })
    }
    setSavingId(null)
  }

  if (loading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
  }

  return (
    <div className="space-y-4 pb-6">
      <p className="text-sm text-muted-foreground">
        Set a budget per category. Leave a field blank and save to remove it.
      </p>

      <ul className="paper divide-y divide-border overflow-hidden">
        {categories.map((c) => {
          const current = saved[c.id]
          const value = draft[c.id] ?? ''
          const dirty = String(current ?? '') !== value.trim()

          return (
            <li key={c.id} className="space-y-2 px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium">{c.name}</p>
                <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {current === undefined ? 'Not set' : formatInr(current)}
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={value}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [c.id]: e.target.value }))
                  }
                  className="h-12 flex-1 text-base tabular-nums"
                  placeholder="0.00"
                  aria-label={`Budget for ${c.name}`}
                />
                <Button
                  type="button"
                  variant={dirty ? 'default' : 'outline'}
                  className="h-12 px-5"
                  disabled={!dirty || savingId === c.id}
                  onClick={() => void save(c.id)}
                >
                  {savingId === c.id ? '…' : 'Save'}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
