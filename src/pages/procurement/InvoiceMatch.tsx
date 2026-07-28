import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  VoidBadge,
  VoidDialog,
  VoidNote,
  voidRowClass,
} from '@/components/VoidDialog'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import {
  createInvoice,
  fetchInvoices,
  fetchMatch,
  postInvoice,
} from '@/lib/queries/procurement'
import { fetchGoodsReceipts, fetchUserNames } from '@/lib/queries/voids'
import {
  canPostInvoice,
  canVoid,
  isVoid,
  MATCH_STATUS_LABEL,
  type GoodsReceiptRow,
  type MatchRow,
  type MatchStatus,
  type PoInvoiceRow,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { todayIst } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'

const MATCH_TONE: Record<MatchStatus, string> = {
  ok: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  pending: 'bg-secondary text-muted-foreground',
  qty_variance: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  rate_variance: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  both: 'bg-destructive/10 text-destructive',
}

export default function InvoiceMatch({ poId }: { poId: string }) {
  const role = useAuth((s) => s.role)
  const [match, setMatch] = useState<MatchRow[] | null>(null)
  const [invoices, setInvoices] = useState<PoInvoiceRow[]>([])
  const [receipts, setReceipts] = useState<GoodsReceiptRow[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [entering, setEntering] = useState(false)
  const [voidingInvoice, setVoidingInvoice] = useState<PoInvoiceRow | null>(null)
  const [voidingGrn, setVoidingGrn] = useState<GoodsReceiptRow | null>(null)

  const mayVoidInvoice = canVoid(role, 'po_invoices')
  const mayVoidGrn = canVoid(role, 'goods_receipts')

  const reload = useCallback(async () => {
    try {
      const [m, inv, grn] = await Promise.all([
        fetchMatch(poId),
        fetchInvoices(poId),
        fetchGoodsReceipts(poId),
      ])
      setMatch(m)
      setInvoices(inv)
      setReceipts(grn)
      setNames(
        await fetchUserNames([
          ...inv.map((i) => i.voided_by),
          ...grn.map((g) => g.voided_by),
        ]),
      )
    } catch (err) {
      toast.error('Could not load match', { description: errText(err) })
      setMatch([])
    }
  }, [poId])

  useEffect(() => {
    setMatch(null)
    void reload()
  }, [reload])

  async function post(invoiceId: string) {
    try {
      await postInvoice(invoiceId)
      toast.success('Invoice posted to Open Book')
      await reload()
    } catch (err) {
      toast.error('Could not post the invoice', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  if (match === null) {
    return <p className="text-sm text-muted-foreground">Loading match…</p>
  }

  // A voided invoice is neither posted nor pending — it's out of the picture.
  const unpostedInvoice = invoices.find((i) => !i.approved && !isVoid(i))
  const hasVariance = match.some(
    (m) => m.match_status !== 'ok' && m.match_status !== 'pending',
  )

  if (entering) {
    return (
      <InvoiceEntry
        poId={poId}
        match={match}
        onDone={() => {
          setEntering(false)
          void reload()
        }}
        onCancel={() => setEntering(false)}
      />
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        3-way match
      </p>

      <ul className="space-y-2">
        {match.map((m) => (
          <li key={m.po_line_id} className="rounded-lg bg-muted/40 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">
                {m.material_name}
              </span>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                  MATCH_TONE[m.match_status],
                )}
              >
                {MATCH_STATUS_LABEL[m.match_status]}
              </span>
            </div>
            <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground tabular-nums">
              <span>Ord {m.qty_ordered} @ {m.rate_ordered !== null ? formatInr(m.rate_ordered) : '—'}</span>
              <span>Recd {m.qty_received}</span>
              <span>
                Inv {m.qty_invoiced}
                {m.rate_invoiced !== null && ` @ ${formatInr(m.rate_invoiced)}`}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {/* Goods receipts — the only place a delivery gets reversed, because
          voiding the GRN is what reverses the stock it created. */}
      {receipts.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Deliveries received
          </p>
          {receipts.map((g) => {
            const voided = isVoid(g)
            return (
              <div
                key={g.id}
                className="rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div
                  className={cn(
                    'flex items-center justify-between gap-3',
                    voidRowClass(voided),
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2 truncate">
                    <span className="truncate">
                      {g.received_date} · {g.line_count}{' '}
                      {g.line_count === 1 ? 'line' : 'lines'}
                    </span>
                    {voided && <VoidBadge className="no-underline" />}
                  </span>
                  {!voided && mayVoidGrn && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setVoidingGrn(g)}
                      className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      Void
                    </Button>
                  )}
                </div>
                {voided && (
                  <VoidNote
                    reason={g.void_reason}
                    by={g.voided_by ? names.get(g.voided_by) : null}
                    at={g.voided_at}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {invoices.length > 0 && (
        <div className="space-y-2">
          {invoices.map((i) => {
            const voided = isVoid(i)
            return (
              <div
                key={i.id}
                className="rounded-lg border border-border px-3 py-2 text-sm"
              >
                <div
                  className={cn(
                    'flex items-center justify-between gap-3',
                    voidRowClass(voided),
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2 truncate">
                    <span className="truncate">
                      Invoice {i.invoice_no ?? '—'} · {i.invoice_date}
                    </span>
                    {voided && <VoidBadge className="no-underline" />}
                  </span>

                  {voided ? null : i.approved ? (
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-[var(--positive)]">
                        Posted
                      </span>
                      {mayVoidInvoice && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setVoidingInvoice(i)}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                          Void
                        </Button>
                      )}
                    </span>
                  ) : canPostInvoice(role) ? (
                    <span className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void post(i.id)}
                      >
                        Post to Open Book
                      </Button>
                      {mayVoidInvoice && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setVoidingInvoice(i)}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                          Void
                        </Button>
                      )}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Awaiting posting
                    </span>
                  )}
                </div>

                {voided && (
                  <VoidNote
                    reason={i.void_reason}
                    by={i.voided_by ? names.get(i.voided_by) : null}
                    at={i.voided_at}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {voidingInvoice && (
        <VoidDialog
          table="po_invoices"
          id={voidingInvoice.id}
          summary={`Invoice ${voidingInvoice.invoice_no ?? '—'} · ${voidingInvoice.invoice_date}`}
          consequence={
            voidingInvoice.approved
              ? 'The invoice drops out of the 3-way match, and the expense it posted to Open Book is voided with it.'
              : 'The invoice drops out of the 3-way match. Nothing was posted to Open Book yet.'
          }
          onDone={async () => {
            setVoidingInvoice(null)
            await reload()
          }}
          onCancel={() => setVoidingInvoice(null)}
        />
      )}

      {voidingGrn && (
        <VoidDialog
          table="goods_receipts"
          id={voidingGrn.id}
          summary={`Delivery received ${voidingGrn.received_date} · ${voidingGrn.line_count} ${
            voidingGrn.line_count === 1 ? 'line' : 'lines'
          }`}
          consequence="Every stock movement this receipt created is voided too, and the order goes back to the status the remaining deliveries justify. Blocked if an invoice is already posted, or if reversing would take stock below zero."
          onDone={async () => {
            setVoidingGrn(null)
            await reload()
          }}
          onCancel={() => setVoidingGrn(null)}
        />
      )}

      {hasVariance && unpostedInvoice && canPostInvoice(role) && (
        <p className="rounded-lg bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] px-3 py-2 text-xs text-[var(--warning)]">
          There's a variance above tolerance. Posting overrides it — check the
          figures first.
        </p>
      )}

      {!unpostedInvoice && (
        <Button
          variant="outline"
          className="h-11 w-full"
          onClick={() => setEntering(true)}
        >
          Enter vendor invoice
        </Button>
      )}
    </div>
  )
}

function InvoiceEntry({
  poId,
  match,
  onDone,
  onCancel,
}: {
  poId: string
  match: MatchRow[]
  onDone: () => void
  onCancel: () => void
}) {
  const [invNo, setInvNo] = useState('')
  const [invDate, setInvDate] = useState(todayIst())
  const [gst, setGst] = useState('')
  // Default each line to received qty at ordered rate — the common case.
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(match.map((m) => [m.po_line_id, String(m.qty_received)])),
  )
  const [rate, setRate] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      match.map((m) => [m.po_line_id, m.rate_ordered?.toString() ?? '']),
    ),
  )
  const [busy, setBusy] = useState(false)

  async function save() {
    const lines = match
      .map((m) => ({
        po_line_id: m.po_line_id,
        qty_invoiced: Number(qty[m.po_line_id]),
        rate_invoiced: Number(rate[m.po_line_id]),
      }))
      .filter((l) => l.qty_invoiced > 0)

    if (lines.length === 0) {
      toast.error('Enter at least one invoiced line')
      return
    }
    if (lines.some((l) => !Number.isFinite(l.rate_invoiced) || l.rate_invoiced < 0)) {
      toast.error('Each invoiced line needs a rate')
      return
    }

    setBusy(true)
    try {
      await createInvoice(
        poId,
        {
          invoice_no: invNo,
          invoice_date: invDate,
          gst_amount: gst === '' ? 0 : Number(gst),
        },
        lines,
      )
      toast.success('Invoice recorded — check the match, then post')
      onDone()
    } catch (err) {
      toast.error('Could not save the invoice', {
        description: err instanceof Error ? err.message : undefined,
      })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Vendor invoice
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Input
          value={invNo}
          onChange={(e) => setInvNo(e.target.value)}
          placeholder="Invoice no."
          className="h-12 text-base"
        />
        <Input
          type="date"
          value={invDate}
          onChange={(e) => setInvDate(e.target.value)}
          className="h-12 text-base"
        />
      </div>

      {match.map((m) => (
        <div key={m.po_line_id} className="rounded-lg bg-muted/40 p-2">
          <p className="text-sm font-medium">{m.material_name}</p>
          <div className="mt-1 flex gap-2">
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={qty[m.po_line_id] ?? ''}
              onChange={(e) =>
                setQty((q) => ({ ...q, [m.po_line_id]: e.target.value }))
              }
              placeholder="Qty"
              aria-label={`Invoiced qty for ${m.material_name}`}
              className="h-11 flex-1 text-base tabular-nums"
            />
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={rate[m.po_line_id] ?? ''}
              onChange={(e) =>
                setRate((r) => ({ ...r, [m.po_line_id]: e.target.value }))
              }
              placeholder="Rate ₹"
              aria-label={`Invoiced rate for ${m.material_name}`}
              className="h-11 flex-1 text-base tabular-nums"
            />
          </div>
        </div>
      ))}

      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        value={gst}
        onChange={(e) => setGst(e.target.value)}
        placeholder="GST amount ₹ (optional)"
        className="h-12 text-base tabular-nums"
      />

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="ghost"
          className="h-12"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button className="h-12" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save invoice'}
        </Button>
      </div>
    </div>
  )
}
