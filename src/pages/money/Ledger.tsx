import { Receipt } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import {
  VoidBadge,
  VoidDialog,
  VoidNote,
  voidRowClass,
} from '@/components/VoidDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import {
  fetchCategories,
  fetchExpenses,
  fetchExpenseTotal,
} from '@/lib/queries/expenses'
import { fetchActivities, retagExpense } from '@/lib/queries/schedule'
import { fetchUserNames } from '@/lib/queries/voids'
import { signedReceiptUrl } from '@/lib/storage'
import {
  canVoid,
  EXPENSE_SOURCES,
  isVoid,
  type ExpenseCategory,
  type ExpenseFilters,
  type ExpenseRow,
  type ExpenseSource,
  type ExpenseTotal,
  type ScheduleActivity,
} from '@/lib/types'
import { useAuth } from '@/store/auth'
import type { MoneyContext } from './MoneyLayout'

const SOURCE_LABEL = Object.fromEntries(
  EXPENSE_SOURCES.map((s) => [s.value, s.label]),
) as Record<ExpenseSource, string>

export default function Ledger() {
  const { projectId } = useOutletContext<MoneyContext>()
  const navigate = useNavigate()
  const role = useAuth((s) => s.role)
  const mayVoid = canVoid(role, 'expenses')

  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [rows, setRows] = useState<ExpenseRow[] | null>(null)
  const [total, setTotal] = useState<ExpenseTotal | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [showFilters, setShowFilters] = useState(false)
  const [voiding, setVoiding] = useState<ExpenseRow | null>(null)
  const [activities, setActivities] = useState<ScheduleActivity[]>([])

  const [categoryId, setCategoryId] = useState('')
  const [source, setSource] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  useEffect(() => {
    fetchCategories().then(setCategories).catch(() => setCategories([]))
  }, [])

  // The programme, for re-tagging. A project without one shows no control at
  // all rather than an empty select.
  useEffect(() => {
    fetchActivities(projectId).then(setActivities).catch(() => setActivities([]))
  }, [projectId])

  const filtered = Boolean(categoryId || source || from || to)

  const load = useCallback(async () => {
    const filters: ExpenseFilters = {}
    if (categoryId) filters.categoryId = Number(categoryId)
    if (source) filters.source = source as ExpenseSource
    if (from) filters.from = from
    if (to) filters.to = to

    // List and total use identical filters. The sum is computed by
    // fn_expense_total in Postgres — never added up from `rows`. Since
    // migration 020 that function excludes voided rows, which is why a voided
    // entry can stay in this list without changing the figure above it.
    const [data, sum] = await Promise.all([
      fetchExpenses(projectId, filters),
      fetchExpenseTotal(projectId, filters),
    ])
    setRows(data)
    setTotal(sum)
    setNames(await fetchUserNames(data.map((r) => r.voided_by)))
  }, [projectId, categoryId, source, from, to])

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setTotal(null)

    load().catch((err: unknown) => {
      if (cancelled) return
      toast.error('Could not load the ledger', { description: errText(err) })
      setRows([])
    })

    return () => {
      cancelled = true
    }
  }, [load])

  function clearFilters() {
    setCategoryId('')
    setSource('')
    setFrom('')
    setTo('')
  }

  return (
    <div className="space-y-4">
      <div className="paper flex items-center justify-between gap-3 p-5">
        <div className="min-w-0">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            {filtered ? 'Filtered total' : 'Project total spent'}
          </p>
          <p className="figure mt-1 text-[28px] leading-none font-semibold">
            {total === null ? '—' : formatInr(total.total_with_gst)}
          </p>
          {total !== null && total.total_gst > 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
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
        <div className="paper space-y-3 p-5">
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
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-11">
              Clear filters
            </Button>
          )}
        </div>
      )}

      {rows === null && <ListSkeleton rows={5} />}

      {rows?.length === 0 &&
        (filtered ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No expenses match these filters.
          </p>
        ) : (
          <EmptyState
            icon={Receipt}
            title="No expenses yet"
            body="Record what's been spent on this project — every entry lands in the ledger and counts against the budget."
            actionLabel="Add your first expense"
            onAction={() => navigate('/money/new')}
          />
        ))}

      {rows && rows.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            {total?.entry_count ?? rows.length}{' '}
            {(total?.entry_count ?? rows.length) === 1 ? 'entry' : 'entries'}
            {filtered && ' matching filters'}
            {rows.length === 500 &&
              ' — listing the most recent 500, total covers all'}
          </p>
          <Stagger className="paper divide-y divide-border overflow-hidden">
            {rows.map((r) => (
              <RevealItem key={r.id}>
                <LedgerRow
                  row={r}
                  mayVoid={mayVoid}
                  activities={activities}
                  voidedByName={r.voided_by ? names.get(r.voided_by) : null}
                  onVoid={() => setVoiding(r)}
                  onRetagged={load}
                />
              </RevealItem>
            ))}
          </Stagger>
        </>
      )}

      {voiding && (
        <VoidDialog
          table="expenses"
          id={voiding.id}
          summary={`${formatInr(voiding.amount + voiding.gst_amount)} · ${
            voiding.category_name ?? 'Uncategorised'
          } · ${voiding.expense_date}`}
          consequence="The entry stays in the ledger marked VOID, but stops counting towards project spend, the budget and every dashboard figure."
          onDone={async () => {
            setVoiding(null)
            await load()
          }}
          onCancel={() => setVoiding(null)}
        />
      )}
    </div>
  )
}

function LedgerRow({
  row,
  mayVoid,
  activities,
  voidedByName,
  onVoid,
  onRetagged,
}: {
  row: ExpenseRow
  mayVoid: boolean
  activities: ScheduleActivity[]
  voidedByName?: string | null
  onVoid: () => void
  onRetagged: () => Promise<void>
}) {
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const [loadingReceipt, setLoadingReceipt] = useState(false)
  const [retagging, setRetagging] = useState(false)

  /**
   * Changing which activity this cost is measured against.
   *
   * Not a void — no total on this screen, the P&L or the dashboard moves when
   * a tag changes. Only earned value does, and only to become right. Voiding
   * would put VOID on a payment that was fine and leave the audit log implying
   * something was wrong with it.
   */
  async function retag(activityId: string) {
    setRetagging(true)
    try {
      await retagExpense(row.id, activityId || null)
      toast.success(
        activityId
          ? `Moved to ${activities.find((a) => a.id === activityId)?.code ?? 'that activity'}`
          : 'Removed from the programme',
        { description: 'Earned value recalculates; no ledger figure changes.' },
      )
      await onRetagged()
    } catch (err) {
      toast.error('Could not change the activity', { description: errText(err) })
    } finally {
      setRetagging(false)
    }
  }

  async function openReceipt() {
    if (!row.receipt_path || receiptUrl) return
    setLoadingReceipt(true)
    const url = await signedReceiptUrl(row.receipt_path)
    if (!url) toast.error('Could not open the receipt')
    setReceiptUrl(url)
    setLoadingReceipt(false)
  }

  const voided = isVoid(row)

  return (
    <div className="px-5 py-4">
      <div className={voidRowClass(voided)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate text-sm font-medium">
            {row.category_name ?? 'Uncategorised'}
            {voided && <VoidBadge className="no-underline" />}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {row.expense_date}
            {row.vendor_display && (
              <>
                {' · '}
                {row.vendor_display}
                {!row.vendor_registered && (
                  <span
                    className="ml-1 inline-block size-1.5 rounded-full bg-[var(--warning)] align-middle"
                    title="Unregistered vendor"
                    aria-label="Unregistered vendor"
                  />
                )}
              </>
            )}
            {` · ${SOURCE_LABEL[row.source] ?? row.source}`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="figure text-[17px] font-semibold">
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
      </div>

      {/* Founder/PM/accounts only — the whole Money module already is, and
          fn_retag_expense re-checks. Hidden on a voided row: it counts for
          nothing, so its tag makes no difference. */}
      {!voided && activities.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <label
            htmlFor={`act-${row.id}`}
            className="shrink-0 text-xs text-muted-foreground"
          >
            Activity
          </label>
          <Select
            id={`act-${row.id}`}
            value={row.activity_id ?? ''}
            disabled={retagging}
            onChange={(e) => void retag(e.target.value)}
            className="h-9 flex-1 text-xs"
          >
            <option value="">Not tied to an activity</option>
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {voided ? (
        <VoidNote
          reason={row.void_reason}
          by={voidedByName}
          at={row.voided_at}
        />
      ) : (
        mayVoid && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onVoid}
            className="mt-1 -ml-2 h-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Void
          </Button>
        )
      )}
    </div>
  )
}
