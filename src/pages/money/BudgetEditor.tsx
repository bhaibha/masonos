import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Button } from '@/components/ui/button'
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
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
        setError(err instanceof Error ? err.message : 'Could not load budgets.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  async function save(categoryId: number) {
    setError(null)
    setNotice(null)
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
        setNotice('Budget removed.')
      } else {
        const amount = Number(raw)
        if (!Number.isFinite(amount) || amount < 0) {
          setError('Budget must be zero or more.')
          setSavingId(null)
          return
        }
        await upsertBudget(projectId, categoryId, amount)
        setSaved((s) => ({ ...s, [categoryId]: amount }))
        setNotice('Saved.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the budget.')
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

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm">{notice}</p>
      )}

      <ul className="divide-y divide-border rounded-xl border border-border">
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
