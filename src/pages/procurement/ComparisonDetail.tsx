import {
  ArrowLeft,
  Check,
  Download,
  FileText,
  Plus,
  ShoppingCart,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { EMPTY_VENDOR, VendorField, type VendorValue } from '@/components/VendorField'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { COMPANY } from '@/lib/company'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import { createDocument } from '@/lib/queries/documents'
import { fetchMaterials } from '@/lib/queries/materials'
import { fetchProject } from '@/lib/queries/projects'
import {
  addItem,
  addVendorColumn,
  awardAll,
  awardItem,
  clearAward,
  type ComparisonGrid,
  convertToPo,
  deleteComparison,
  fetchComparison,
  fetchGrid,
  removeItem,
  removeVendorColumn,
  setQuote,
} from '@/lib/queries/rateComparison'
import { generateRcFile, generateRcPdf } from '@/lib/rcPdf'
import { uploadDocument } from '@/lib/storage'
import {
  canAwardComparison,
  type ComparisonSummary,
  type Material,
  RC_STATUS_LABEL,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

type View = 'lines' | 'grid'

/**
 * One comparative statement.
 *
 * Two ways to read the same data: LINES (one card per item, vendors listed
 * inside) is the phone view and the one you enter rates in one-handed; GRID is
 * the real items-as-rows / vendors-as-columns statement, horizontally scrolled.
 * They read the same server-computed numbers — the grid is not a second
 * calculation of the lines.
 */
export default function ComparisonDetail({
  comparisonId,
  onBack,
}: {
  comparisonId: string
  onBack: () => void
}) {
  const role = useAuth((s) => s.role)
  const mayAward = canAwardComparison(role)

  const [summary, setSummary] = useState<ComparisonSummary | null>(null)
  const [grid, setGrid] = useState<ComparisonGrid | null>(null)
  const [view, setView] = useState<View>('lines')
  const [addingVendor, setAddingVendor] = useState(false)
  const [addingItem, setAddingItem] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [s, g] = await Promise.all([
        fetchComparison(comparisonId),
        fetchGrid(comparisonId),
      ])
      setSummary(s)
      setGrid(g)
    } catch (err) {
      toast.error('Could not load the comparison', { description: errText(err) })
    }
  }, [comparisonId])

  useEffect(() => {
    setGrid(null)
    void reload()
  }, [reload])

  if (!summary || !grid) return <ListSkeleton rows={5} />

  const frozen = summary.status === 'ordered'
  const canEdit = !frozen

  return (
    <div className="space-y-4 pb-6">
      <button
        type="button"
        onClick={onBack}
        className="flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        All comparisons
      </button>

      <section className="paper p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-heading text-lg font-semibold">{summary.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {summary.comparison_no}
              {summary.need_by && ` · need by ${summary.need_by}`}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium text-secondary-foreground">
            {RC_STATUS_LABEL[summary.status]}
          </span>
        </div>

        {frozen && (
          <p className="mt-4 rounded-lg bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
            A purchase order has been raised from this statement, so the quotes
            are now locked. It is the evidence of how that order was decided — if
            it could still be edited it would stop being evidence.
          </p>
        )}

        <VendorTotals grid={grid} canEdit={canEdit} onChanged={reload} />
      </section>

      <div className="flex gap-1">
        {(
          [
            ['lines', 'Lines'],
            ['grid', 'Statement'],
          ] as [View, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={cn(
              'min-h-11 flex-1 rounded-lg px-3 text-sm font-medium transition-colors',
              view === v
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {canEdit && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="h-11"
            onClick={() => setAddingVendor((v) => !v)}
          >
            <Plus className="size-4" /> Vendor
          </Button>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => setAddingItem((v) => !v)}
          >
            <Plus className="size-4" /> Item
          </Button>
        </div>
      )}

      {addingVendor && canEdit && (
        <AddVendorForm
          comparisonId={comparisonId}
          nextOrder={(grid.vendors.length + 1) * 10}
          onDone={async () => {
            setAddingVendor(false)
            await reload()
          }}
        />
      )}

      {addingItem && canEdit && (
        <AddItemForm
          comparisonId={comparisonId}
          nextOrder={(grid.items.length + 1) * 10}
          onDone={async () => {
            setAddingItem(false)
            await reload()
          }}
        />
      )}

      {grid.vendors.length === 0 && (
        <p className="rounded-lg bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] px-3 py-2.5 text-xs text-[var(--warning)]">
          No vendors yet. Add at least two — one quote is a price, not a
          comparison.
        </p>
      )}

      {view === 'lines' ? (
        <Stagger className="card-grid">
          {grid.items.map((it) => (
            <RevealItem key={it.id}>
              <ItemCard
                item={it}
                grid={grid}
                canEdit={canEdit}
                mayAward={mayAward}
                onChanged={reload}
              />
            </RevealItem>
          ))}
        </Stagger>
      ) : (
        <StatementGrid grid={grid} />
      )}

      {grid.items.length > 0 && grid.vendors.length > 0 && (
        <AwardBar
          summary={summary}
          grid={grid}
          mayAward={mayAward}
          onChanged={reload}
        />
      )}

      <Actions
        summary={summary}
        grid={grid}
        mayAward={mayAward}
        onChanged={reload}
        onDeleted={onBack}
      />
    </div>
  )
}

/* ---------------- vendor totals strip ---------------- */

function VendorTotals({
  grid,
  canEdit,
  onChanged,
}: {
  grid: ComparisonGrid
  canEdit: boolean
  onChanged: () => Promise<void>
}) {
  if (grid.totals.length === 0) return null

  return (
    <div className="mt-4 space-y-2 border-t border-border pt-4">
      {/* Cheapest first. The order on screen is a reading aid only — which
          vendor is actually lowest is the server's flag, not this sort. */}
      {[...grid.totals]
        .sort((a, b) => a.grand_total - b.grand_total)
        .map((t) => (
          <div
            key={t.vendor_col_id}
            className="flex items-baseline justify-between gap-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {t.vendor_display}
                {t.is_lowest_total && (
                  <span className="ml-2 rounded-full bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[var(--positive)]">
                    Lowest
                  </span>
                )}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t.items_missing > 0
                  ? `${t.items_missing} item${t.items_missing === 1 ? '' : 's'} not quoted`
                  : `all ${t.items_quoted} quoted`}
                {t.delivery_days !== null && ` · ${t.delivery_days} days`}
                {` · GST ${t.gst_pct}%`}
              </p>
            </div>
            <span
              className={cn(
                'figure shrink-0 text-sm font-semibold',
                t.is_lowest_total && 'text-[var(--positive)]',
              )}
            >
              {formatInr(t.grand_total)}
            </span>
            {canEdit && (
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Remove ${t.vendor_display}`}
                onClick={async () => {
                  try {
                    await removeVendorColumn(t.vendor_col_id)
                    toast.success('Quote removed')
                    await onChanged()
                  } catch (err) {
                    toast.error('Could not remove the quote', {
                      description: errText(err),
                    })
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
      <p className="pt-1 text-[10px] text-muted-foreground">
        Totals include GST at each vendor's own rate. Only a vendor who priced
        every line can be marked lowest.
      </p>
    </div>
  )
}

/* ---------------- one item, vendors inside ---------------- */

function ItemCard({
  item,
  grid,
  canEdit,
  mayAward,
  onChanged,
}: {
  item: ComparisonGrid['items'][number]
  grid: ComparisonGrid
  canEdit: boolean
  mayAward: boolean
  onChanged: () => Promise<void>
}) {
  const [reasonFor, setReasonFor] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const cells = grid.vendors.map((v) => ({
    vendor: v,
    cell: grid.cells.find(
      (c) => c.item_id === item.id && c.vendor_col_id === v.id,
    ),
  }))

  async function saveRate(vendorColId: string, raw: string) {
    const trimmed = raw.trim()
    const value = trimmed === '' ? null : Number(trimmed)
    if (value !== null && (Number.isNaN(value) || value < 0)) {
      toast.error('Enter a rate of zero or more')
      return
    }
    try {
      await setQuote(item.id, vendorColId, value)
      await onChanged()
    } catch (err) {
      toast.error('Could not save the rate', { description: errText(err) })
    }
  }

  async function award(quoteId: string, isLowest: boolean) {
    // The reason is demanded by the RPC. Asking for it here first is a
    // courtesy, not the control — an award posted straight to the API without
    // one is refused by Postgres.
    if (!isLowest && reasonFor !== quoteId) {
      setReasonFor(quoteId)
      setReason('')
      return
    }
    setBusy(true)
    try {
      await awardItem(item.id, quoteId, isLowest ? undefined : reason)
      setReasonFor(null)
      toast.success('Line awarded')
      await onChanged()
    } catch (err) {
      toast.error('Could not award this line', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{item.description}</p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {item.qty} {item.unit}
            {item.material_id === null && ' · free text'}
          </p>
        </div>
        {canEdit && (
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Remove item"
            onClick={async () => {
              try {
                await removeItem(item.id)
                toast.success('Item removed')
                await onChanged()
              } catch (err) {
                toast.error('Could not remove the item', {
                  description: errText(err),
                })
              }
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>

      {cells.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Add a vendor to start pricing this line.
        </p>
      ) : (
        <ul className="mt-4 space-y-2 border-t border-border pt-3">
          {cells.map(({ vendor, cell }) => (
            <li key={vendor.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {vendor.vendor_display}
                {cell?.is_lowest && (
                  <span className="ml-1.5 text-[10px] font-medium text-[var(--positive)]">
                    lowest
                  </span>
                )}
              </span>

              {canEdit ? (
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  defaultValue={cell?.rate ?? ''}
                  onBlur={(e) => void saveRate(vendor.id, e.target.value)}
                  placeholder="Rate"
                  aria-label={`Rate from ${vendor.vendor_display}`}
                  className={cn(
                    'h-11 w-28 shrink-0 text-right text-base tabular-nums',
                    cell?.is_lowest && 'border-[var(--positive)]',
                  )}
                />
              ) : (
                <span className="w-28 shrink-0 text-right text-sm tabular-nums">
                  {cell?.rate === null || cell?.rate === undefined
                    ? '—'
                    : formatInr(cell.rate)}
                </span>
              )}

              <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {cell?.line_total !== null && cell?.line_total !== undefined
                  ? formatInr(cell.line_total)
                  : '—'}
              </span>

              {mayAward && cell?.quote_id && (
                <Button
                  type="button"
                  size="xs"
                  variant={cell.is_awarded ? 'default' : 'outline'}
                  disabled={busy}
                  aria-label={`Award to ${vendor.vendor_display}`}
                  onClick={() =>
                    void award(cell.quote_id as string, cell.is_lowest)
                  }
                >
                  {cell.is_awarded ? <Check className="size-3.5" /> : 'Pick'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {reasonFor && (
        <div className="mt-4 space-y-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            This is not the lowest rate on the line. Why is it being chosen?
            This sentence prints on the comparative statement.
          </p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Only vendor who can deliver before the pour"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setReasonFor(null)}
            >
              Cancel
            </Button>
            <Button
              className="h-11"
              disabled={busy || reason.trim().length < 3}
              onClick={() => void award(reasonFor, false)}
            >
              Award with this reason
            </Button>
          </div>
        </div>
      )}

      {item.award_reason && (
        <p className="mt-3 rounded-lg bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] px-3 py-2 text-xs text-[var(--warning)]">
          Not the lowest — {item.award_reason}
        </p>
      )}
    </article>
  )
}

/* ---------------- the real statement ---------------- */

function StatementGrid({ grid }: { grid: ComparisonGrid }) {
  if (grid.items.length === 0 || grid.vendors.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        The statement appears once there is at least one item and one vendor.
      </p>
    )
  }

  const cellAt = new Map(
    grid.cells.map((c) => [`${c.item_id}|${c.vendor_col_id}`, c]),
  )
  const totalFor = new Map(grid.totals.map((t) => [t.vendor_col_id, t]))

  return (
    <div className="paper overflow-x-auto p-0">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="sticky left-0 z-10 bg-[var(--surface)] px-4 py-3 text-left text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Item
            </th>
            {grid.vendors.map((v) => (
              <th
                key={v.id}
                className="px-4 py-3 text-right text-xs font-semibold whitespace-nowrap"
              >
                {v.vendor_display}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.items.map((it) => (
            <tr key={it.id} className="border-b border-border/60">
              <td className="sticky left-0 z-10 max-w-[180px] bg-[var(--surface)] px-4 py-3">
                <span className="block truncate">{it.description}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {it.qty} {it.unit}
                </span>
              </td>
              {grid.vendors.map((v) => {
                const c = cellAt.get(`${it.id}|${v.id}`)
                return (
                  <td
                    key={v.id}
                    className={cn(
                      'px-4 py-3 text-right tabular-nums',
                      c?.is_lowest &&
                        'bg-[color-mix(in_oklab,var(--positive)_8%,transparent)] font-semibold text-[var(--positive)]',
                    )}
                  >
                    {c?.rate === null || c?.rate === undefined ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        <span className="block">
                          {c.is_awarded && '✓ '}
                          {formatInr(c.rate)}
                        </span>
                        <span className="block text-[11px] font-normal text-muted-foreground">
                          {formatInr(c.line_total)}
                        </span>
                      </>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border">
            <td className="sticky left-0 z-10 bg-[var(--surface)] px-4 py-3 text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Grand total
            </td>
            {grid.vendors.map((v) => {
              const t = totalFor.get(v.id)
              return (
                <td
                  key={v.id}
                  className={cn(
                    'px-4 py-3 text-right font-semibold tabular-nums',
                    t?.is_lowest_total && 'text-[var(--positive)]',
                  )}
                >
                  {t ? formatInr(t.grand_total) : '—'}
                  {t && t.items_missing > 0 && (
                    <span className="block text-[10px] font-normal text-[var(--warning)]">
                      {t.items_missing} not quoted
                    </span>
                  )}
                </td>
              )
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/* ---------------- award the whole thing ---------------- */

function AwardBar({
  summary,
  grid,
  mayAward,
  onChanged,
}: {
  summary: ComparisonSummary
  grid: ComparisonGrid
  mayAward: boolean
  onChanged: () => Promise<void>
}) {
  const [vendorCol, setVendorCol] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  if (!mayAward || summary.status === 'ordered') return null

  const chosen = grid.totals.find((t) => t.vendor_col_id === vendorCol)
  const needsReason = chosen !== undefined && !chosen.is_lowest_total

  async function submit() {
    setBusy(true)
    try {
      const n = await awardAll(summary.comparison_id, vendorCol, reason)
      toast.success(`${n} line${n === 1 ? '' : 's'} awarded`)
      setVendorCol('')
      setReason('')
      await onChanged()
    } catch (err) {
      toast.error('Could not award', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <section className="paper space-y-3 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Award all lines to one vendor
      </p>

      <Select
        aria-label="Winning vendor"
        value={vendorCol}
        onChange={(e) => setVendorCol(e.target.value)}
      >
        <option value="">Choose a vendor…</option>
        {grid.totals.map((t) => (
          <option key={t.vendor_col_id} value={t.vendor_col_id}>
            {t.vendor_display} — {formatInr(t.grand_total)}
            {t.items_missing > 0 ? ` (${t.items_missing} not quoted)` : ''}
          </option>
        ))}
      </Select>

      {chosen && chosen.items_missing > 0 && (
        <p className="rounded-lg bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] px-3 py-2 text-xs text-[var(--warning)]">
          {chosen.vendor_display} has not priced {chosen.items_missing} line
          {chosen.items_missing === 1 ? '' : 's'}. Award those individually
          instead — a split award is the normal answer here.
        </p>
      )}

      {needsReason && chosen.items_missing === 0 && (
        <FieldRow
          label="Why not the lowest?"
          htmlFor="rc_reason"
          hint="Prints on the comparative statement. Postgres refuses the award without it."
        >
          <Textarea
            id="rc_reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Higher rate, but the only vendor with the specified finish in stock"
          />
        </FieldRow>
      )}

      <div className="grid grid-cols-2 gap-2">
        {summary.items_awarded > 0 && (
          <Button
            variant="ghost"
            className="h-11"
            disabled={busy}
            onClick={async () => {
              try {
                await clearAward(summary.comparison_id)
                toast.success('Award cleared')
                await onChanged()
              } catch (err) {
                toast.error('Could not clear the award', {
                  description: errText(err),
                })
              }
            }}
          >
            Clear award
          </Button>
        )}
        <Button
          className={cn('h-11', summary.items_awarded === 0 && 'col-span-2')}
          disabled={
            busy ||
            !vendorCol ||
            (chosen?.items_missing ?? 0) > 0 ||
            (needsReason && reason.trim().length < 3)
          }
          onClick={() => void submit()}
        >
          {busy ? 'Awarding…' : 'Award all'}
        </Button>
      </div>
    </section>
  )
}

/* ---------------- PDF, convert, delete ---------------- */

function Actions({
  summary,
  grid,
  mayAward,
  onChanged,
  onDeleted,
}: {
  summary: ComparisonSummary
  grid: ComparisonGrid
  mayAward: boolean
  onChanged: () => Promise<void>
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const hasStatement = grid.items.length > 0 && grid.vendors.length > 0

  async function pdfOpts() {
    const project = await fetchProject(summary.project_id)
    return {
      summary,
      items: grid.items,
      vendors: grid.vendors,
      cells: grid.cells,
      totals: grid.totals,
      projectName: project?.name ?? '',
      siteAddress: project?.site_address ?? null,
    }
  }

  async function download() {
    setBusy('pdf')
    try {
      generateRcPdf(await pdfOpts())
    } catch (err) {
      toast.error('Could not build the statement', {
        description: errText(err),
      })
    }
    setBusy(null)
  }

  async function fileToDocs() {
    setBusy('file')
    try {
      const opts = await pdfOpts()
      const file = generateRcFile(opts)
      const up = await uploadDocument(summary.project_id, file)
      await createDocument({
        project_id: summary.project_id,
        folder: 'purchase_orders',
        title: `${summary.comparison_no} · ${summary.title}`,
        file_path: up.path,
        file_type: up.fileType,
        // It carries every vendor's rates, so it is confidential exactly like
        // the priced PO copy — a supervisor must not open it from the vault.
        is_confidential: true,
        doc_kind: 'comparative_statement',
      })
      toast.success('Filed to Docs → Purchase Orders')
    } catch (err) {
      toast.error('Could not file the statement', { description: errText(err) })
    }
    setBusy(null)
  }

  async function convert() {
    setBusy('convert')
    try {
      const n = await convertToPo(summary.comparison_id, summary.need_by)
      toast.success(
        `${n} purchase order${n === 1 ? '' : 's'} raised`,
        {
          description:
            'Approved with the awarded rates already on the lines — receiving and the 3-way match work on them as usual.',
        },
      )
      await onChanged()
    } catch (err) {
      toast.error('Could not raise the purchase order', {
        description: errText(err),
      })
    }
    setBusy(null)
  }

  return (
    <section className="space-y-2">
      {hasStatement && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="h-11"
            disabled={busy !== null}
            onClick={() => void download()}
          >
            <Download className="size-4" />
            {busy === 'pdf' ? 'Building…' : 'Statement PDF'}
          </Button>
          <Button
            variant="outline"
            className="h-11"
            disabled={busy !== null}
            onClick={() => void fileToDocs()}
          >
            <FileText className="size-4" />
            {busy === 'file' ? 'Filing…' : 'File to Docs'}
          </Button>
        </div>
      )}

      {mayAward &&
        summary.status === 'decided' &&
        summary.items_awarded > 0 && (
          <Button
            className="h-12 w-full text-base"
            disabled={busy !== null}
            onClick={() => void convert()}
          >
            <ShoppingCart className="size-4" />
            {busy === 'convert' ? 'Raising…' : 'Convert to purchase order'}
          </Button>
        )}

      {summary.status === 'ordered' && (
        <p className="rounded-lg bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
          Purchase order raised. Find it under Money → Orders, already approved
          with these rates.
        </p>
      )}

      {mayAward && summary.status !== 'ordered' && (
        <>
          {confirmDelete ? (
            <div className="paper space-y-3 p-4">
              <p className="text-sm">
                Delete {summary.comparison_no}? The quotes and the award go with
                it.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  className="h-11"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep
                </Button>
                <Button
                  variant="destructive"
                  className="h-11"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy('delete')
                    try {
                      await deleteComparison(summary.comparison_id)
                      toast.success('Comparison deleted')
                      onDeleted()
                    } catch (err) {
                      toast.error('Could not delete', {
                        description: errText(err),
                      })
                      setBusy(null)
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="ghost"
              className="h-11 w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              Delete comparison
            </Button>
          )}
        </>
      )}
    </section>
  )
}

/* ---------------- add forms ---------------- */

function AddVendorForm({
  comparisonId,
  nextOrder,
  onDone,
}: {
  comparisonId: string
  nextOrder: number
  onDone: () => Promise<void>
}) {
  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
  const [quoteRef, setQuoteRef] = useState('')
  const [quoteDate, setQuoteDate] = useState('')
  const [days, setDays] = useState('')
  const [gst, setGst] = useState(String(COMPANY.defaultGstPct))
  const [terms, setTerms] = useState('')
  const [payment, setPayment] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!vendor.vendorName.trim()) {
      toast.error('Name the vendor who quoted')
      return
    }
    setBusy(true)
    try {
      await addVendorColumn(
        comparisonId,
        {
          vendor_id: vendor.vendorId,
          vendor_name: vendor.vendorName,
          quote_ref: quoteRef,
          quote_date: quoteDate || null,
          terms,
          payment_terms: payment,
          delivery_days: days === '' ? null : Number(days),
          gst_pct: Number(gst) || 0,
        },
        nextOrder,
      )
      toast.success('Vendor added')
      await onDone()
    } catch (err) {
      toast.error('Could not add the vendor', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <section className="paper space-y-4 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Add a quote
      </p>

      <FieldRow
        label="Vendor"
        htmlFor="rc_vendor"
        hint="Type to search, or enter a name that isn't registered yet."
      >
        <VendorField id="rc_vendor" value={vendor} onChange={setVendor} />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Quote ref" htmlFor="rc_qref">
          <Input
            id="rc_qref"
            value={quoteRef}
            onChange={(e) => setQuoteRef(e.target.value)}
            placeholder="Their number"
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Quote date" htmlFor="rc_qdate">
          <Input
            id="rc_qdate"
            type="date"
            value={quoteDate}
            onChange={(e) => setQuoteDate(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Delivery (days)" htmlFor="rc_days">
          <Input
            id="rc_days"
            type="number"
            inputMode="numeric"
            min="0"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
        <FieldRow label="GST %" htmlFor="rc_gst">
          <Input
            id="rc_gst"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={gst}
            onChange={(e) => setGst(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
      </div>

      <FieldRow label="Payment terms" htmlFor="rc_pay">
        <Input
          id="rc_pay"
          value={payment}
          onChange={(e) => setPayment(e.target.value)}
          placeholder="e.g. 30 days from delivery"
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Other terms" htmlFor="rc_terms">
        <Textarea
          id="rc_terms"
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          placeholder="Freight, unloading, validity"
        />
      </FieldRow>

      <Button
        className="h-12 w-full"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? 'Adding…' : 'Add vendor'}
      </Button>
    </section>
  )
}

function AddItemForm({
  comparisonId,
  nextOrder,
  onDone,
}: {
  comparisonId: string
  nextOrder: number
  onDone: () => Promise<void>
}) {
  const [materials, setMaterials] = useState<Material[]>([])
  const [materialId, setMaterialId] = useState('')
  const [description, setDescription] = useState('')
  const [unit, setUnit] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void fetchMaterials()
      .then(setMaterials)
      .catch(() => setMaterials([]))
  }, [])

  function pick(id: string) {
    const m = materials.find((x) => x.id === id)
    setMaterialId(id)
    if (m) {
      setDescription(m.name)
      setUnit(m.unit)
    }
  }

  async function submit() {
    if (!description.trim() || Number(qty) <= 0) {
      toast.error('A description and a quantity are needed')
      return
    }
    setBusy(true)
    try {
      await addItem(
        comparisonId,
        {
          material_id: materialId || null,
          description,
          unit: unit.trim() || 'nos',
          qty: Number(qty),
        },
        nextOrder,
      )
      toast.success('Item added')
      await onDone()
    } catch (err) {
      toast.error('Could not add the item', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <section className="paper space-y-4 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Add an item
      </p>

      <Select
        aria-label="Material"
        value={materialId}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="">Free text (not a stock item)…</option>
        {materials.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.unit})
          </option>
        ))}
      </Select>

      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description as quoted"
        className="h-12 text-base"
      />

      <div className="grid grid-cols-2 gap-2">
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0.01"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="Quantity"
          className="h-12 text-base tabular-nums"
        />
        <Input
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="Unit"
          className="h-12 text-base"
        />
      </div>

      <Button
        className="h-12 w-full"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? 'Adding…' : 'Add item'}
      </Button>
    </section>
  )
}
