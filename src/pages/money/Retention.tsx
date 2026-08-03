import { Landmark, Paperclip, PiggyBank } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { DeleteButton } from '@/components/DeleteAction'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import {
  EMPTY_VENDOR,
  VendorField,
  type VendorValue,
} from '@/components/VendorField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import {
  createBg,
  fetchBgs,
  fetchRetentionLedger,
  fetchTranches,
  planTranche,
  releaseRetention,
  setBgStatus,
} from '@/lib/queries/retention'
import { signedComplianceUrl, uploadComplianceProof } from '@/lib/storage'
import {
  BG_DISPLAY_LABEL,
  BG_TYPE_LABEL,
  BG_TYPES,
  canManageRetention,
  canReleaseRetention,
  RETENTION_MILESTONE_LABEL,
  RETENTION_MILESTONES,
  type BgDisplayStatus,
  type BgRow,
  type BgType,
  type NewBgInput,
  type RetentionLedgerRow,
  type RetentionMilestone,
  type RetentionTranche,
  type UserRole,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const BG_TONE: Record<BgDisplayStatus, string> = {
  active:
    'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  expiring:
    'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  expired: 'bg-destructive/10 text-destructive',
  released: 'bg-secondary text-muted-foreground',
  returned: 'bg-secondary text-muted-foreground',
}

type Tab = 'retention' | 'guarantees'

export default function Retention() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  const [tab, setTab] = useState<Tab>('retention')
  const [ledger, setLedger] = useState<RetentionLedgerRow[] | null>(null)
  const [tranches, setTranches] = useState<RetentionTranche[]>([])
  const [bgs, setBgs] = useState<BgRow[] | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const [l, t, g] = await Promise.all([
        fetchRetentionLedger(projectId),
        fetchTranches(projectId),
        fetchBgs(projectId),
      ])
      setLedger(l)
      setTranches(t)
      setBgs(g)
    } catch (err) {
      toast.error('Could not load retention', { description: errText(err) })
      setLedger([])
      setBgs([])
    }
  }, [projectId])

  useEffect(() => {
    setLedger(null)
    setBgs(null)
    void reload()
  }, [reload])

  return (
    <div className="space-y-4 pb-6">
      <div className="flex gap-1">
        {(['retention', 'guarantees'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'min-h-11 rounded-lg px-3.5 text-sm font-medium transition-colors',
              tab === t
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t === 'retention' ? 'Retention' : 'Guarantees'}
          </button>
        ))}
      </div>

      {tab === 'retention' ? (
        <RetentionTab
          ledger={ledger}
          tranches={tranches}
          role={role}
          onChanged={reload}
        />
      ) : (
        <BgTab rows={bgs} role={role} onChanged={reload} />
      )}
    </div>
  )
}

/* ---------------- Retention ---------------- */

function RetentionTab({
  ledger,
  tranches,
  role,
  onChanged,
}: {
  ledger: RetentionLedgerRow[] | null
  tranches: RetentionTranche[]
  role: UserRole | null
  onChanged: () => Promise<void>
}) {
  const [planning, setPlanning] = useState<RetentionLedgerRow | null>(null)
  const mayManage = canManageRetention(role)

  if (ledger === null) return <ListSkeleton rows={3} />

  if (ledger.length === 0) {
    return (
      <EmptyState
        icon={PiggyBank}
        title="Nothing held back yet"
        body="Retention appears here automatically once an RA bill is certified — it's summed from the certified bills, never typed in."
      />
    )
  }

  if (planning) {
    return (
      <PlanForm
        party={planning}
        onCancel={() => setPlanning(null)}
        onSaved={async () => {
          setPlanning(null)
          await onChanged()
        }}
      />
    )
  }

  const totalHeld = ledger.reduce((n, r) => n + r.balance_held, 0)

  return (
    <div className="space-y-4">
      <div className="paper p-5">
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Currently held
        </p>
        <p className="figure mt-1 text-[30px] leading-none font-semibold">
          {formatInr(totalHeld)}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Summed from certified RA bills, less what has been released.
        </p>
      </div>

      <Stagger className="space-y-3">
        {ledger.map((r) => {
          const mine = tranches.filter(
            (t) =>
              (t.vendor_id ?? (t.contractor_name ?? '').toLowerCase()) ===
              (r.vendor_id ?? r.party_key),
          )

          return (
            <RevealItem key={r.party_key}>
              <article className="paper p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-heading text-[17px] leading-tight font-semibold">
                      {r.contractor}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                      {r.certified_bills} certified bill
                      {r.certified_bills === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
                      Balance held
                    </p>
                    <p className="figure text-[19px] font-semibold">
                      {formatInr(r.balance_held)}
                    </p>
                  </div>
                </div>

                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3 text-sm">
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Held to date</dt>
                    <dd className="tabular-nums">{formatInr(r.retention_held)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Released</dt>
                    <dd className="tabular-nums">{formatInr(r.released)}</dd>
                  </div>
                  {r.planned > 0 && (
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">Planned</dt>
                      <dd className="tabular-nums text-[var(--warning)]">
                        {formatInr(r.planned)}
                      </dd>
                    </div>
                  )}
                </dl>

                {mine.length > 0 && (
                  <ul className="mt-3 space-y-2 border-t border-border pt-3">
                    {mine.map((t) => (
                      <TrancheRow
                        key={t.id}
                        tranche={t}
                        role={role}
                        onChanged={onChanged}
                      />
                    ))}
                  </ul>
                )}

                {mayManage && (
                  <Button
                    variant="outline"
                    className="mt-4 h-11"
                    onClick={() => setPlanning(r)}
                  >
                    Plan a release
                  </Button>
                )}
              </article>
            </RevealItem>
          )
        })}
      </Stagger>
    </div>
  )
}

function TrancheRow({
  tranche: t,
  role,
  onChanged,
}: {
  tranche: RetentionTranche
  role: UserRole | null
  onChanged: () => Promise<void>
}) {
  const [releasing, setReleasing] = useState(false)
  const [amount, setAmount] = useState(String(t.amount))
  const [date, setDate] = useState(todayIst())
  const [busy, setBusy] = useState(false)
  const mayRelease = canReleaseRetention(role)

  async function release() {
    setBusy(true)
    try {
      await releaseRetention(t.id, Number(amount) || 0, date)
      toast.success('Retention released', {
        description: 'The balance held drops by that amount.',
      })
      setReleasing(false)
      await onChanged()
    } catch (err) {
      // The RPC refuses more than is held, and refuses roles that can't release.
      toast.error('Could not release', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <li className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">
            {RETENTION_MILESTONE_LABEL[t.milestone]}
            {t.due_date && (
              <span className="ml-2 text-xs text-muted-foreground">
                due {t.due_date}
              </span>
            )}
          </p>
          {t.notes && (
            <p className="truncate text-xs text-muted-foreground">{t.notes}</p>
          )}
        </div>
        <div className="flex shrink-0 items-baseline gap-2">
          <span
            className={cn(
              'text-sm font-medium tabular-nums',
              t.status === 'released' && 'text-[var(--positive)]',
            )}
          >
            {formatInr(t.amount)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t.status === 'released' ? `released ${t.released_date}` : 'planned'}
          </span>
        </div>
      </div>

      {releasing ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-secondary/50 p-3">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-11 w-32 tabular-nums"
            aria-label="Amount released"
          />
          <Input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="h-11 w-40"
            aria-label="Release date"
          />
          <Button className="h-11" disabled={busy} onClick={() => void release()}>
            {busy ? 'Saving…' : 'Confirm release'}
          </Button>
          <Button variant="ghost" className="h-11" onClick={() => setReleasing(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {mayRelease && t.status === 'planned' && (
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setReleasing(true)}
            >
              Release
            </Button>
          )}
          {t.status === 'planned' && (
            <DeleteButton
              table="retention_releases"
              id={t.id}
              name={`${RETENTION_MILESTONE_LABEL[t.milestone]} · ${formatInr(t.amount)}`}
              role={role}
              onDeleted={onChanged}
            />
          )}
        </div>
      )}
    </li>
  )
}

function PlanForm({
  party,
  onCancel,
  onSaved,
}: {
  party: RetentionLedgerRow
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const projectId = useProjects((s) => s.selectedId)
  const [milestone, setMilestone] = useState<RetentionMilestone>('on_completion')
  // Half the balance is the common case ("half on completion, half after DLP").
  const [amount, setAmount] = useState(String(party.balance_held / 2))
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!projectId) return
    if (Number(amount) <= 0) {
      toast.error('Give the tranche an amount')
      return
    }

    setBusy(true)
    try {
      await planTranche({
        project_id: projectId,
        vendor_id: party.vendor_id,
        contractor_name: party.contractor,
        milestone,
        amount: Number(amount),
        due_date: dueDate || null,
        notes,
      })
      toast.success('Release planned', {
        description: 'It stays planned until someone confirms the payment.',
      })
      await onSaved()
    } catch (err) {
      toast.error('Could not plan the release', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="paper space-y-5 p-5" noValidate>
      <div>
        <p className="font-heading text-[18px] font-semibold">Plan a release</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {party.contractor} · {formatInr(party.balance_held)} held
        </p>
      </div>

      <FieldRow label="Milestone" htmlFor="rt-ms">
        <Select
          id="rt-ms"
          value={milestone}
          onChange={(e) => setMilestone(e.target.value as RetentionMilestone)}
        >
          {RETENTION_MILESTONES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Amount (₹)" htmlFor="rt-amt">
          <Input
            id="rt-amt"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-12 tabular-nums"
          />
        </FieldRow>

        <FieldRow label="Due" htmlFor="rt-due" hint="Optional.">
          <Input
            id="rt-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="h-12"
          />
        </FieldRow>
      </div>

      <FieldRow label="Notes" htmlFor="rt-notes">
        <Textarea
          id="rt-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Release on handover certificate."
        />
      </FieldRow>

      <p className="text-xs text-muted-foreground">
        Releasing is a separate, deliberate step — and the database refuses to
        release more than is actually held.
      </p>

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Saving…' : 'Plan release'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}

/* ---------------- Bank guarantees ---------------- */

function BgTab({
  rows,
  role,
  onChanged,
}: {
  rows: BgRow[] | null
  role: UserRole | null
  onChanged: () => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const mayManage = canManageRetention(role)

  if (adding) {
    return (
      <BgForm
        onCancel={() => setAdding(false)}
        onSaved={async () => {
          setAdding(false)
          await onChanged()
        }}
      />
    )
  }

  const live = rows?.filter(
    (b) => b.display_status === 'expiring' || b.display_status === 'expired',
  )

  return (
    <div className="space-y-4">
      {mayManage && (
        <Button className="h-12 w-full text-base" onClick={() => setAdding(true)}>
          Add guarantee
        </Button>
      )}

      {live && live.length > 0 && (
        <p
          className={cn(
            'rounded-lg px-3 py-2 text-sm',
            live.some((b) => b.display_status === 'expired')
              ? 'bg-destructive/10 text-destructive'
              : 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
          )}
        >
          {live.filter((b) => b.display_status === 'expired').length > 0 &&
            `${live.filter((b) => b.display_status === 'expired').length} expired`}
          {live.filter((b) => b.display_status === 'expired').length > 0 &&
            live.filter((b) => b.display_status === 'expiring').length > 0 &&
            ' · '}
          {live.filter((b) => b.display_status === 'expiring').length > 0 &&
            `${live.filter((b) => b.display_status === 'expiring').length} expiring within 30 days`}
          {' — extend or get them returned.'}
        </p>
      )}

      {rows === null && <ListSkeleton rows={3} />}

      {rows?.length === 0 && (
        <EmptyState
          icon={Landmark}
          title="No guarantees on the register"
          body="Advance, performance and retention guarantees — with expiry dates the app will chase for you."
          actionLabel={mayManage ? 'Add guarantee' : undefined}
          onAction={mayManage ? () => setAdding(true) : undefined}
        />
      )}

      {rows && rows.length > 0 && (
        <Stagger className="space-y-3">
          {rows.map((b) => (
            <RevealItem key={b.id}>
              <BgCard bg={b} role={role} onChanged={onChanged} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function BgCard({
  bg: b,
  role,
  onChanged,
}: {
  bg: BgRow
  role: UserRole | null
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const mayManage = canManageRetention(role)
  const closed = b.display_status === 'released' || b.display_status === 'returned'

  async function move(next: 'active' | 'released' | 'returned') {
    setBusy(true)
    try {
      await setBgStatus(b.id, next)
      toast.success(
        next === 'active' ? 'Marked active' : `Marked ${next}`,
      )
      await onChanged()
    } catch (err) {
      toast.error('Could not update the guarantee', { description: errText(err) })
    }
    setBusy(false)
  }

  async function openScan() {
    if (!b.file_path) return
    const url = await signedComplianceUrl(b.file_path)
    if (url) window.open(url, '_blank', 'noopener')
    else toast.error('Could not open the scan')
  }

  return (
    <article className={cn('paper p-5', closed && 'opacity-75')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[17px] leading-tight font-semibold">
            {b.bg_number}
          </p>
          <p className="mt-0.5 truncate text-sm">
            {BG_TYPE_LABEL[b.bg_type]} · {b.counterparty_name}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {b.issuing_bank}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            BG_TONE[b.display_status],
          )}
        >
          {BG_DISPLAY_LABEL[b.display_status]}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-border pt-3">
        <div>
          <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
            Value
          </p>
          <p className="figure text-[19px] font-semibold">{formatInr(b.amount)}</p>
        </div>
        <div>
          <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
            Expires
          </p>
          <p
            className={cn(
              'text-sm font-medium tabular-nums',
              b.display_status === 'expired' && 'text-destructive',
              b.display_status === 'expiring' && 'text-[var(--warning)]',
            )}
          >
            {b.expiry_date}
            {!closed &&
              ` · ${
                b.days_to_expiry < 0
                  ? `${Math.abs(b.days_to_expiry)} days ago`
                  : `${b.days_to_expiry} days`
              }`}
          </p>
        </div>
        {b.claim_expiry_date && (
          <div>
            <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
              Claim until
            </p>
            <p className="text-sm tabular-nums">{b.claim_expiry_date}</p>
          </div>
        )}
      </div>

      {b.notes && <p className="mt-3 text-sm">{b.notes}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {b.file_path && (
          <Button variant="outline" size="sm" className="h-9" onClick={() => void openScan()}>
            <Paperclip className="size-4" aria-hidden="true" />
            Scan
          </Button>
        )}
        {mayManage && !closed && (
          <Button size="sm" className="h-9" disabled={busy} onClick={() => void move('returned')}>
            Mark returned
          </Button>
        )}
        {mayManage && !closed && (
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            disabled={busy}
            onClick={() => void move('released')}
          >
            Mark released
          </Button>
        )}
        {mayManage && closed && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            disabled={busy}
            onClick={() => void move('active')}
          >
            Reactivate
          </Button>
        )}
        {!closed && (
          <DeleteButton
            table="bank_guarantees"
            id={b.id}
            name={`${b.bg_number} · ${b.issuing_bank}`}
            role={role}
            onDeleted={onChanged}
          />
        )}
      </div>
    </article>
  )
}

function BgForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const projectId = useProjects((s) => s.selectedId)

  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
  const [bgType, setBgType] = useState<BgType>('performance')
  const [bgNumber, setBgNumber] = useState('')
  const [bank, setBank] = useState('')
  const [amount, setAmount] = useState('')
  const [issue, setIssue] = useState('')
  const [expiry, setExpiry] = useState('')
  const [claim, setClaim] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!projectId) return
    if (bgNumber.trim() === '') {
      toast.error('Enter the guarantee number')
      return
    }
    if (bank.trim() === '') {
      toast.error('Enter the issuing bank')
      return
    }
    if (expiry === '') {
      toast.error('A guarantee without an expiry date cannot be tracked')
      return
    }

    setBusy(true)
    try {
      let path: string | null = null
      if (file) {
        setStatus('Uploading the scan…')
        path = await uploadComplianceProof(projectId, file)
      }

      setStatus('Saving…')
      const payload: NewBgInput = {
        project_id: projectId,
        vendor_id: vendor.vendorId,
        counterparty: vendor.vendorName,
        bg_type: bgType,
        bg_number: bgNumber,
        issuing_bank: bank,
        amount: Number(amount) || 0,
        issue_date: issue || null,
        expiry_date: expiry,
        claim_expiry_date: claim || null,
        file_path: path,
        notes,
      }
      await createBg(payload)
      toast.success(`${bgNumber.trim()} added`, {
        description: 'You will be warned 30 days before it expires.',
      })
      await onSaved()
    } catch (err) {
      // The unique index on (project, bg_number) catches a duplicate.
      toast.error('Could not add the guarantee', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="paper space-y-5 p-5" noValidate>
      <p className="font-heading text-[18px] font-semibold">New guarantee</p>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Type" htmlFor="bg-type">
          <Select
            id="bg-type"
            value={bgType}
            onChange={(e) => setBgType(e.target.value as BgType)}
          >
            {BG_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </FieldRow>

        <FieldRow label="BG number" htmlFor="bg-no">
          <Input
            id="bg-no"
            value={bgNumber}
            onChange={(e) => setBgNumber(e.target.value)}
            placeholder="e.g. 0123BG000456"
            className="h-12 text-base"
            autoFocus
          />
        </FieldRow>
      </div>

      <FieldRow
        label="Counterparty"
        htmlFor="bg-vendor"
        hint="Whose guarantee this is — a registered vendor or free text."
      >
        <VendorField id="bg-vendor" value={vendor} onChange={setVendor} />
      </FieldRow>

      <FieldRow label="Issuing bank" htmlFor="bg-bank">
        <Input
          id="bg-bank"
          value={bank}
          onChange={(e) => setBank(e.target.value)}
          placeholder="e.g. Canara Bank, Jayanagar"
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Value (₹)" htmlFor="bg-amt">
        <Input
          id="bg-amt"
          type="number"
          inputMode="decimal"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="h-12 tabular-nums"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Issued" htmlFor="bg-issue">
          <Input
            id="bg-issue"
            type="date"
            value={issue}
            onChange={(e) => setIssue(e.target.value)}
            className="h-12"
          />
        </FieldRow>

        <FieldRow label="Expires" htmlFor="bg-exp">
          <Input
            id="bg-exp"
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="h-12"
          />
        </FieldRow>
      </div>

      <FieldRow
        label="Claim period ends"
        htmlFor="bg-claim"
        hint="Usually later than expiry — this is the last day it can actually be invoked."
      >
        <Input
          id="bg-claim"
          type="date"
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          className="h-12"
        />
      </FieldRow>

      <FieldRow
        label="Scanned copy"
        htmlFor="bg-file"
        hint="PDF or photo. Stored in the same private bucket as compliance proofs."
      >
        <Input
          id="bg-file"
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Notes" htmlFor="bg-notes">
        <Textarea
          id="bg-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth remembering when it comes up for renewal."
        />
      </FieldRow>

      {status && <p className="text-xs text-muted-foreground">{status}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Saving…' : 'Add guarantee'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}
