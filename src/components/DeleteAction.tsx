import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import { deleteRecord } from '@/lib/queries/voids'
import {
  canDelete,
  DELETABLE_LABEL,
  type DeletableTable,
  type UserRole,
} from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Delete for records with no downstream effect.
 *
 * No reason field here, unlike void and cancel: there's nothing to reconcile
 * afterwards and no figure that moved. What matters is that it's deliberate,
 * so the confirm names the record.
 *
 * The reference checks live in fn_delete_record, not here. If something points
 * at the record the RPC refuses and says what — "used by 4 records",
 * "rolled over to a later day", "cancel it instead" — and that message is
 * surfaced verbatim, because it tells the user what to do next.
 */
export function DeleteButton({
  table,
  id,
  name,
  role,
  onDeleted,
  className,
  label,
}: {
  table: DeletableTable
  id: string
  /** what's being deleted, shown in the confirm — e.g. "OPC 53 Cement" */
  name: string
  role: UserRole | null
  onDeleted: () => void | Promise<void>
  className?: string
  /** override the button text; defaults to just the trash icon + "Delete" */
  label?: string
}) {
  const [confirming, setConfirming] = useState(false)

  if (!canDelete(role, table)) return null

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        className={cn(
          'h-9 text-destructive hover:bg-destructive/10 hover:text-destructive',
          className,
        )}
      >
        <Trash2 className="size-4" aria-hidden="true" />
        {label ?? 'Delete'}
      </Button>

      {confirming && (
        <ConfirmDelete
          table={table}
          id={id}
          name={name}
          onDone={async () => {
            setConfirming(false)
            await onDeleted()
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  )
}

function ConfirmDelete({
  table,
  id,
  name,
  onDone,
  onCancel,
}: {
  table: DeletableTable
  id: string
  name: string
  onDone: () => void | Promise<void>
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const label = DELETABLE_LABEL[table]

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, busy])

  async function run() {
    setBusy(true)
    try {
      await deleteRecord(table, id)
      toast.success(`Deleted the ${label}`)
      await onDone()
    } catch (err) {
      toast.error(`Could not delete the ${label}`, { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/25 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div className="paper w-full max-w-sm space-y-5 rounded-b-none p-6 sm:rounded-2xl">
        <div className="flex gap-3">
          <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="size-5 text-destructive" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2
              id="delete-title"
              className="font-heading text-[20px] leading-tight font-semibold"
            >
              Delete this {label}?
            </h2>
            <p className="mt-1 text-sm break-words text-muted-foreground">
              {name}
            </p>
          </div>
        </div>

        <p className="rounded-lg bg-secondary/60 p-3 text-xs leading-relaxed text-muted-foreground">
          This removes it for good — there's no undo. If anything else refers to
          it, the delete will be refused and you'll be told what's using it.
        </p>

        <div className="flex gap-3">
          <Button
            onClick={() => void run()}
            disabled={busy}
            className="h-12 flex-1 bg-destructive text-base text-white hover:bg-destructive/90"
          >
            {busy ? 'Deleting…' : `Delete ${label}`}
          </Button>
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={busy}
            className="h-12"
          >
            Go back
          </Button>
        </div>
      </div>
    </div>
  )
}
