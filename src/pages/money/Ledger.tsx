import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { FieldRow, Select } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatInr } from '@/lib/format'
import {
  fetchCategories,
  fetchExpenses,
  fetchExpenseTotal,
} from '@/lib/queries/expenses'
import { signedReceiptUrl } from '@/lib/storage'
import {
  EXPENSE_SOURCES,
  type ExpenseCategory,
  type ExpenseFilters,
  type ExpenseRow,
  type ExpenseSource,
  type ExpenseTotal,
} from '@/lib/types'
import type { MoneyContext } from './MoneyLayout'

const SOURCE_LABEL = Object.fromEntries(
  EXPENSE_SOURCES.map((s) => [s.value, s.label]),
) as Record<ExpenseSource, string>

export default function Ledger() {
  const { projectId } = useOutletContext<MoneyContext>()

  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [rows, setRows] = useState<ExpenseRow[] | null>(null)
  const [total, setTotal] = useState<ExpenseTotal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)

  const [categoryId, setCategoryId] = useState('')
  const [source, setSource] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    fetchCategories().then(setCategories).catch(() => setCategories([]))
  }, [])

  const filtered = Boolean(categoryId || source || from || to)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setTotal(null)
    setError(null)

    const filters: ExpenseFilters = {}
    if (categoryId) filters.categoryId = Number(categoryId)
    if (source) filters.source = source as ExpenseSource
    if (from) filters.from = from
    if (to) filters.to = to

    // List and total use identical filters. The sum is computed by
    // fn_expense_total in Postgres — never added up from `rows`.
    Promise.all([
      fetchExpenses(projectId, filters),
      fetchExpenseTotal(projectId, filters),
    ])
      .then(([data, sum]) => {
        if (cancelled) return
        setRows(data)
        setTotal(sum)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the ledger.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectId, categoryId, source, from, to])

  function clearFilters() {
    setCategoryId('')
    setSource('')
    setFrom('')
    setTo('')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-xl bg-secondary px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {filtered ? 'Filtered total' : 'Project total spent'}
          </p>
          <p className="font-heading text-xl font-semibold tabular-nums">
            {total === null ? '—' : formatInr(total.total_with_gst)}
          </p>
          {total !== null && total.total_gst > 0 && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatInr(total.total_amount)} + {formatInr(total.total_gst)} GST
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFilters((v) => !v)}
        >
          {showFilters ? 'Hide filters' : 'Filters'}
        </Button>
      </div>

      {showFilters && (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <FieldRow label="Category" htmlFor="f_category">
            <Select
              id="f_category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FieldRow>

          <FieldRow label="Paid by" htmlFor="f_source">
            <Select
              id="f_source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">All sources</option>
              {EXPENSE_SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </FieldRow>

          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="From" htmlFor="f_from">
              <Input
                id="f_from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-12 text-base"
              />
            </FieldRow>
            <FieldRow label="To" htmlFor="f_to">
              <Input
                id="f_to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-12 text-base"
              />
            </FieldRow>
          </div>

          {filtered && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {rows === null && !error && (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      )}

      {rows?.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {filtered ? 'No expenses match these filters.' : 'No expenses recorded yet.'}
        </p>
      )}

      {rows && rows.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            {total?.entry_count ?? rows.length}{' '}
            {(total?.entry_count ?? rows.length) === 1 ? 'entry' : 'entries'}
            {filtered && ' matching filters'}
            {rows.length === 500 &&
              ' — listing the most recent 500, total covers all'}
          </p>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {rows.map((r) => (
              <LedgerRow key={r.id} row={r} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function LedgerRow({ row }: { row: ExpenseRow }) {
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const [loadingReceipt, setLoadingReceipt] = useState(false)

  async function openReceipt() {
    if (!row.receipt_path || receiptUrl) return
    setLoadingReceipt(true)
    const url = await signedReceiptUrl(row.receipt_path)
    setReceiptUrl(url)
    setLoadingReceipt(false)
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {row.category_name ?? 'Uncategorised'}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {row.expense_date}
            {row.vendor_name && ` · ${row.vendor_name}`}
            {` · ${SOURCE_LABEL[row.source] ?? row.source}`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-heading text-base font-semibold tabular-nums">
            {formatInr(row.amount)}
          </p>
          {row.gst_amount > 0 && (
            <p className="text-xs text-muted-foreground tabular-nums">
              + {formatInr(row.gst_amount)} GST
            </p>
          )}
        </div>
      </div>

      {row.description && (
        <p className="mt-1 text-xs text-muted-foreground">{row.description}</p>
      )}

      {row.invoice_no && (
        <p className="mt-1 text-xs text-muted-foreground">
          Invoice {row.invoice_no}
        </p>
      )}

      {row.receipt_path && (
        <div className="mt-2">
          {receiptUrl ? (
            <a
              href={receiptUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block"
            >
              <img
                src={receiptUrl}
                alt="Receipt"
                className="max-h-40 rounded-lg object-contain ring-1 ring-foreground/10"
              />
            </a>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void openReceipt()}
              disabled={loadingReceipt}
            >
              {loadingReceipt ? 'Loading…' : 'View receipt'}
            </Button>
          )}
        </div>
      )}
    </li>
  )
}
