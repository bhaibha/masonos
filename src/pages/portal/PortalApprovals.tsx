import { Check, Stamp, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import {
  type ClientApproval,
  decideApproval,
  fetchApprovals,
} from '@/lib/queries/portal'
import { cn } from '@/lib/utils'

const SUBJECT_LABEL: Record<string, string> = {
  variation: 'Change to the works',
  material: 'Material selection',
  drawing: 'Drawing',
  design: 'Design',
  other: 'Approval',
}

export default function PortalApprovals() {
  const [items, setItems] = useState<ClientApproval[] | null>(null)

  const reload = useCallback(async () => {
    try {
      setItems(await fetchApprovals())
    } catch {
      setItems([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const pending = (items ?? []).filter((a) => a.status === 'pending')
  const decided = (items ?? []).filter((a) => a.status !== 'pending')

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Approvals
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Decisions your project team needs from you.
        </p>
      </div>

      {items === null && <ListSkeleton rows={3} />}

      {items?.length === 0 && (
        <EmptyState
          icon={Stamp}
          title="Nothing needs your decision"
          body="When your team needs you to approve a change or a selection, it will appear here."
        />
      )}

      {pending.length > 0 && (
        <Stagger className="space-y-3">
          {pending.map((a) => (
            <RevealItem key={a.id}>
              <PendingCard approval={a} onDone={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}

      {decided.length > 0 && (
        <div className="space-y-3">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Already decided
          </p>
          {decided.map((a) => (
            <div key={a.id} className="paper p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                    {a.approval_no} · {SUBJECT_LABEL[a.subject] ?? a.subject}
                  </p>
                  <p className="mt-0.5 text-sm font-medium">{a.title}</p>
                  {a.reject_reason && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Your note: {a.reject_reason}
                    </p>
                  )}
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium',
                    a.status === 'approved'
                      ? 'bg-[var(--positive)]/10 text-[var(--positive)]'
                      : 'bg-[var(--danger)]/10 text-[var(--danger)]',
                  )}
                >
                  {a.status === 'approved' ? 'Approved' : 'Not approved'}
                </span>
              </div>
              {a.decided_on && (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  {fmtDate(a.decided_on)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PendingCard({
  approval,
  onDone,
}: {
  approval: ClientApproval
  onDone: () => Promise<void>
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function decide(decision: 'approved' | 'rejected') {
    // fn_client_decide requires a reason on a rejection and raises without one.
    // Asking here is the courtesy; the database is what enforces it.
    if (decision === 'rejected' && !note.trim()) {
      toast.error('Please say briefly why', {
        description: 'It tells the team what to change.',
      })
      return
    }
    setBusy(true)
    try {
      await decideApproval(approval.id, decision, note)
      toast.success(decision === 'approved' ? 'Approved' : 'Sent back to the team')
      await onDone()
    } catch (err) {
      toast.error('Could not record your decision', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <div className="paper p-5">
      <p className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
        {approval.approval_no} · {SUBJECT_LABEL[approval.subject] ?? approval.subject}
      </p>
      <p className="font-heading mt-1 text-[18px] leading-tight font-semibold">
        {approval.title}
      </p>
      {approval.details && (
        <p className="mt-2.5 text-sm leading-relaxed whitespace-pre-wrap">
          {approval.details}
        </p>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Asked {fmtDate(approval.created_at)}
      </p>

      {rejecting && (
        <div className="mt-4">
          <label htmlFor={`note-${approval.id}`} className="text-sm font-medium">
            What would you like changed?
          </label>
          <Textarea
            id={`note-${approval.id}`}
            className="mt-2"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="A sentence is enough."
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {!rejecting ? (
          <>
            <Button className="h-11" disabled={busy} onClick={() => void decide('approved')}>
              <Check className="size-4" />
              Approve
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              <X className="size-4" />
              Ask for a change
            </Button>
          </>
        ) : (
          <>
            <Button className="h-11" disabled={busy} onClick={() => void decide('rejected')}>
              Send to the team
            </Button>
            <Button
              variant="ghost"
              className="h-11"
              disabled={busy}
              onClick={() => {
                setRejecting(false)
                setNote('')
              }}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
