import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Textarea } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import {
  cancelDocument,
  rejectVariation,
  voidRecord,
} from '@/lib/queries/voids'
import {
  CANCELLABLE_LABEL,
  VOIDABLE_LABEL,
  type CancellableTable,
  type VoidableTable,
} from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Shared destructive-confirm shell. Deliberately not a plain window.confirm:
 * the reason is mandatory (Postgres rejects a blank one anyway — this just says
 * so before the round trip) and the consequence is spelled out, because these
 * actions move money, stock or the contract value.
 *
 * Used by both VoidDialog (financial/stock rows) and CancelDialog (workflow
 * documents), so the two read identically and neither can drift.
 */
function DestructiveDialog({
  title,
  verb,
  summary,
  consequence,
  placeholder,
  successTitle,
  successBody,
  failTitle,
  run,
  onDone,
  onCancel,
}: {
  title: string
  /** button text, e.g. "Void expense" */
  verb: string
  summary: string
  consequence: string
  placeholder: string
  successTitle: string
  successBody: string
  failTitle: string
  run: (reason: string) => Promise<void>
  onDone: () => void | Promise<void>
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  // Escape closes — a destructive dialog should always have a fast way out.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, saving])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (reason.trim().length < 3) {
      toast.error('Enter a reason', {
        description: 'The reason is stored in the audit log — make it useful.',
      })
      ref.current?.focus()
      return
    }

    setSaving(true)
    try {
      await run(reason.trim())
      toast.success(successTitle, { description: successBody })
      await onDone()
    } catch (err) {
      // The RPCs raise readable, specific messages — surface them as-is
      // ("Void the goods receipt instead", "would put stock below zero",
      // "Void the receipt(s) first, then cancel the order"…).
      toast.error(failTitle, { description: errText(err) })
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/25 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="destructive-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onCancel()
      }}
    >
      <form
        onSubmit={submit}
        className="paper w-full max-w-md space-y-5 rounded-b-none p-6 sm:rounded-2xl"
      >
        <div className="flex gap-3">
          <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle
              className="size-5 text-destructive"
              aria-hidden="true"
            />
          </div>
          <div className="min-w-0">
            <h2
              id="destructive-title"
              className="font-heading text-[20px] leading-tight font-semibold"
            >
              {title}
            </h2>
            <p className="mt-1 text-sm break-words text-muted-foreground">
              {summary}
            </p>
          </div>
        </div>

        <p className="rounded-lg bg-secondary/60 p-3 text-xs leading-relaxed text-muted-foreground">
          {consequence}
        </p>

        <div className="space-y-2">
          <label htmlFor="destructive-reason" className="text-sm font-medium">
            Reason <span className="text-destructive">*</span>
          </label>
          <Textarea
            id="destructive-reason"
            ref={ref}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={placeholder}
            disabled={saving}
          />
          <p className="text-xs text-muted-foreground">
            Recorded in the audit log against your name. Required.
          </p>
        </div>

        <div className="flex gap-3">
          <Button
            type="submit"
            disabled={saving}
            className={cn(
              'h-12 flex-1 text-base',
              'bg-destructive text-white hover:bg-destructive/90',
            )}
          >
            {saving ? 'Working…' : verb}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={saving}
            className="h-12"
          >
            Go back
          </Button>
        </div>
      </form>
    </div>
  )
}

/** Void a financial or stock row — it stays on record, stops counting. */
export function VoidDialog({
  table,
  id,
  summary,
  consequence,
  onDone,
  onCancel,
}: {
  table: VoidableTable
  id: string
  /** what's being voided, e.g. "₹12,000 · Cement · 21 Jul" */
  summary: string
  /** what voiding will do, in plain words */
  consequence: string
  onDone: () => void | Promise<void>
  onCancel: () => void
}) {
  const label = VOIDABLE_LABEL[table]
  return (
    <DestructiveDialog
      title={`Void this ${label}?`}
      verb={`Void ${label}`}
      summary={summary}
      consequence={consequence}
      placeholder="e.g. Duplicate entry — same challan recorded twice"
      successTitle={`Voided the ${label}`}
      successBody="It stays on record, marked VOID, and no longer counts."
      failTitle={`Could not void the ${label}`}
      run={(reason) => voidRecord(table, id, reason)}
      onDone={onDone}
      onCancel={onCancel}
    />
  )
}

/** Cancel a workflow document — PO or VO. Keeps its number, leaves the numbers. */
export function CancelDialog({
  table,
  id,
  summary,
  consequence,
  onDone,
  onCancel,
}: {
  table: CancellableTable
  id: string
  summary: string
  consequence: string
  onDone: () => void | Promise<void>
  onCancel: () => void
}) {
  const label = CANCELLABLE_LABEL[table]
  return (
    <DestructiveDialog
      title={`Cancel this ${label}?`}
      verb={`Cancel ${label}`}
      summary={summary}
      consequence={consequence}
      placeholder="e.g. Client dropped the scope — no longer required"
      successTitle={`Cancelled the ${label}`}
      successBody="It keeps its number and stays on record, but drops out of active lists and every total."
      failTitle={`Could not cancel the ${label}`}
      run={(reason) => cancelDocument(table, id, reason)}
      onDone={onDone}
      onCancel={onCancel}
    />
  )
}

/** Reject a still-submitted variation, with the reason recorded. */
export function RejectVoDialog({
  id,
  summary,
  onDone,
  onCancel,
}: {
  id: string
  summary: string
  onDone: () => void | Promise<void>
  onCancel: () => void
}) {
  return (
    <DestructiveDialog
      title="Reject this variation?"
      verb="Reject variation"
      summary={summary}
      consequence="It stays on record as rejected and never reaches the contract value. The reason is shown on the variation."
      placeholder="e.g. Cost impact not agreed with the client"
      successTitle="Variation rejected"
      successBody="The reason is recorded against it."
      failTitle="Could not reject the variation"
      run={(reason) => rejectVariation(id, reason)}
      onDone={onDone}
      onCancel={onCancel}
    />
  )
}

/** The CANCELLED marker on a workflow document. */
export function CancelledBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block shrink-0 rounded-full bg-destructive/10 px-2 py-0.5',
        'text-[10px] font-semibold tracking-[0.12em] text-destructive uppercase',
        className,
      )}
    >
      Cancelled
    </span>
  )
}

/** The "why" line under a cancelled or rejected document. */
export function CancelNote({
  reason,
  by,
  at,
  verb = 'Cancelled',
}: {
  reason: string | null
  by?: string | null
  at?: string | null
  verb?: string
}) {
  if (!reason) return null
  return (
    <p className="mt-1.5 text-xs text-destructive/90">
      {verb}
      {by ? ` by ${by}` : ''}
      {at ? ` on ${new Date(at).toLocaleDateString('en-IN')}` : ''} — {reason}
    </p>
  )
}

/** The VOID marker shown on a reversed row. */
export function VoidBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block shrink-0 rounded-full bg-destructive/10 px-2 py-0.5',
        'text-[10px] font-semibold tracking-[0.12em] text-destructive uppercase',
        className,
      )}
    >
      Void
    </span>
  )
}

/**
 * Wraps a voided row: dimmed, struck through, and not interactive. Kept in one
 * place so every list marks voids identically.
 */
export function voidRowClass(voided: boolean): string {
  return voided ? 'opacity-55 line-through decoration-destructive/50' : ''
}

/** The "why" line under a voided row. */
export function VoidNote({
  reason,
  by,
  at,
}: {
  reason: string | null
  by?: string | null
  at?: string | null
}) {
  if (!reason) return null
  return (
    <p className="mt-1.5 text-xs text-destructive/90">
      Voided{by ? ` by ${by}` : ''}
      {at ? ` on ${new Date(at).toLocaleDateString('en-IN')}` : ''} — {reason}
    </p>
  )
}
