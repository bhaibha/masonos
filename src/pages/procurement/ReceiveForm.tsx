import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { fetchReceivedByLine, receiveGoods } from '@/lib/queries/procurement'
import type { PoLine } from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'

const qfmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

/**
 * Record a delivery against an approved PO. Shows ordered vs already-received
 * per line; you enter what's arriving now. Saving posts to stock (the GRN
 * trigger writes material_inward) and advances the PO to receiving/received.
 */
export default function ReceiveForm({
  poId,
  lines,
  onDone,
}: {
  poId: string
  lines: PoLine[]
  onDone: () => Promise<void>
}) {
  const [received, setReceived] = useState<Map<string, number>>(new Map())
  const [qty, setQty] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetchReceivedByLine(lines.map((l) => l.id))
      .then((m) => setReceived(m))
      .catch(() => setReceived(new Map()))
      .finally(() => setLoaded(true))
  }, [lines])

  const remaining = useMemo(() => {
    const r = new Map<string, number>()
    for (const l of lines) {
      r.set(l.id, Math.max(l.qty_ordered - (received.get(l.id) ?? 0), 0))
    }
    return r
  }, [lines, received])

  async function submit() {
    const entries = lines
      .map((l) => ({ po_line_id: l.id, qty: Number(qty[l.id]) }))
      .filter((e) => Number.isFinite(e.qty) && e.qty > 0)

    if (entries.length === 0) {
      toast.error('Enter a received quantity for at least one line')
      return
    }
    // Warn (don't block) on over-receipt — partial/extra deliveries happen.
    const over = entries.find((e) => {
      const rem = remaining.get(e.po_line_id) ?? 0
      return e.qty > rem + 0.001
    })
    if (
      over &&
      !window.confirm(
        'One line is being received above the outstanding quantity. Record anyway?',
      )
    ) {
      return
    }

    setBusy(true)
    try {
      await receiveGoods(poId, todayIst(), note, entries)
      toast.success('Delivery recorded — stock updated')
      await onDone()
    } catch (err) {
      toast.error('Could not record the delivery', { description: errText(err) })
      setBusy(false)
    }
  }

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  const allDone = lines.every((l) => (remaining.get(l.id) ?? 0) <= 0)

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Enter what arrived. Stock updates automatically.
      </p>

      {lines.map((l) => {
        const rem = remaining.get(l.id) ?? 0
        return (
          <div key={l.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{l.material_name}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                Ordered {qfmt.format(l.qty_ordered)} {l.material_unit} · received{' '}
                {qfmt.format(received.get(l.id) ?? 0)} · left {qfmt.format(rem)}
              </p>
            </div>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={qty[l.id] ?? ''}
              onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))}
              placeholder="0"
              aria-label={`Received now for ${l.material_name}`}
              className="h-12 w-24 text-base tabular-nums"
              disabled={rem <= 0}
            />
          </div>
        )
      })}

      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (challan no, condition) — optional"
        className="h-12 text-base"
      />

      {allDone ? (
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm">
          Everything ordered has been received.
        </p>
      ) : (
        <Button className="h-12 w-full" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Recording…' : 'Record delivery'}
        </Button>
      )}
    </div>
  )
}
