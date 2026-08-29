import { Download, ReceiptText } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CancelDialog, CancelledBadge, CancelNote } from '@/components/VoidDialog'
import { DeleteButton } from '@/components/DeleteAction'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { OtherProjectsHint } from '@/components/ProjectPicker'
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
import { fetchProject } from '@/lib/queries/projects'
import { fetchActivities, retagRaBill } from '@/lib/queries/schedule'
import {
  addRaLine,
  certifyRaBill,
  createRaBill,
  deleteRaLine,
  fetchRaBills,
  fetchRaLines,
  fetchRaPayables,
  rejectRaBill,
  setRaStatus,
} from '@/lib/queries/raBills'
import { generateRaBillPdf } from '@/lib/raBillPdf'
import {
  canCertifyRaBill,
  canManageRaBills,
  RA_STATUS_LABEL,
  type NewRaBillInput,
  type RaBillLine,
  type RaBillRow,
  type RaPayable,
  type RaStatus,
  type ScheduleActivity,
  type UserRole,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const STATUS_TONE: Record<RaStatus, string> = {
  submitted: 'bg-secondary text-secondary-foreground',
  under_review:
    'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  certified:
    'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  rejected: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-secondary text-muted-foreground',
}

type Filter = 'open' | 'certified' | 'all'

export default function RaBills() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayManage = canManageRaBills(role)

  const [rows, setRows] = useState<RaBillRow[] | null>(null)
  const [payables, setPayables] = useState<RaPayable[]>([])
  const [filter, setFilter] = useState<Filter>('open')
  const [raising, setRaising] = useState(false)
  // The programme, for re-tagging which activity a bill is measured against.
  // A project without one shows no control rather than an empty select.
  const [activities, setActivities] = useState<ScheduleActivity[]>([])

  useEffect(() => {
    if (!projectId) return
    fetchActivities(projectId).then(setActivities).catch(() => setActivities([]))
  }, [projectId])

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const [bills, pay] = await Promise.all([
        fetchRaBills(projectId),
        fetchRaPayables(projectId).catch(() => []),
      ])
      setRows(bills)
      setPayables(pay)
    } catch (err) {
      toast.error('Could not load bills', { description: errText(err) })
      setRows([])
    }
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (raising) {
    return (
      <NewBillForm
        onCancel={() => setRaising(false)}
        onSaved={async () => {
          setRaising(false)
          await reload()
        }}
      />
    )
  }

  const shown = rows?.filter((b) => {
    if (filter === 'all') return true
    if (filter === 'certified') return b.status === 'certified'
    return b.status === 'submitted' || b.status === 'under_review'
  })

  return (
    <div className="space-y-4 pb-6">
      {mayManage && (
        <Button className="h-12 w-full text-base" onClick={() => setRaising(true)}>
          Record a bill
        </Button>
      )}

      {payables.length > 0 && <PayablesStrip rows={payables} />}

      <div className="flex gap-1">
        {(['open', 'certified', 'all'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'min-h-11 rounded-lg px-3.5 text-sm font-medium transition-colors',
              filter === f
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f === 'open' ? 'In review' : f === 'certified' ? 'Certified' : 'All'}
          </button>
        ))}
      </div>

      {rows === null && <ListSkeleton rows={3} />}

      {shown?.length === 0 && (
        <>
          <EmptyState
            icon={ReceiptText}
            title={
              filter === 'open'
                ? 'Nothing waiting for certification'
                : filter === 'certified'
                  ? 'Nothing certified yet'
                  : 'No bills recorded'
            }
            body="Record a contractor's running-account bill, measure the work to date against it, then certify what's actually payable."
            actionLabel={mayManage && filter !== 'open' ? 'Record a bill' : undefined}
            onAction={mayManage && filter !== 'open' ? () => setRaising(true) : undefined}
          />
          {filter === 'all' && <OtherProjectsHint />}
        </>
      )}

      {shown && shown.length > 0 && (
        <Stagger className="card-grid">
          {shown.map((b) => (
            <RevealItem key={b.id}>
              <BillCard
                bill={b}
                role={role}
                activities={activities}
                onChanged={reload}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ---------------- Payables ---------------- */

function PayablesStrip({ rows }: { rows: RaPayable[] }) {
  const held = rows.reduce((n, r) => n + r.retention_held, 0)
  const net = rows.reduce((n, r) => n + r.net_certified, 0)

  return (
    <div className="paper space-y-3 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Certified to date
      </p>

      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <div>
          <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
            Net certified
          </p>
          <p className="figure mt-1 text-[22px] leading-none font-semibold">
            {formatInr(net)}
          </p>
        </div>
        <div>
          <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
            Retention held
          </p>
          <p className="figure mt-1 text-[22px] leading-none font-semibold text-[var(--warning)]">
            {formatInr(held)}
          </p>
        </div>
      </div>

      <ul className="divide-y divide-border border-t border-border pt-1">
        {rows.map((r) => (
          <li
            key={`${r.vendor_id ?? r.contractor}`}
            className="flex items-baseline justify-between gap-3 py-2"
          >
            <span className="min-w-0 truncate text-sm">{r.contractor}</span>
            <span className="shrink-0 text-sm font-medium tabular-nums">
              {formatInr(r.net_certified)}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {formatInr(r.retention_held)} held
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------------- One bill ---------------- */

function BillCard({
  bill: b,
  role,
  activities,
  onChanged,
}: {
  bill: RaBillRow
  role: UserRole | null
  activities: ScheduleActivity[]
  onChanged: () => Promise<void>
}) {
  const [retagging, setRetagging] = useState(false)
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<RaBillLine[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [cancelling, setCancelling] = useState(false)

  const mayCertify = canCertifyRaBill(role)
  const editable = b.status === 'submitted' || b.status === 'under_review'

  /**
   * Which activity this bill's certified value counts against.
   *
   * Allowed even after certification: 032 freezes the bill's VALUE, and the
   * activity tag is not a value — a certified bill measured against the wrong
   * line is precisely the thing that needs correcting.
   */
  async function retag(activityId: string) {
    setRetagging(true)
    try {
      await retagRaBill(b.id, activityId || null)
      toast.success('Activity updated', {
        description: 'Earned value recalculates; the certified figures do not move.',
      })
      await onChanged()
    } catch (err) {
      toast.error('Could not change the activity', { description: errText(err) })
    } finally {
      setRetagging(false)
    }
  }

  const loadLines = useCallback(async () => {
    try {
      setLines(await fetchRaLines(b.id))
    } catch (err) {
      toast.error('Could not load measurements', { description: errText(err) })
      setLines([])
    }
  }, [b.id])

  useEffect(() => {
    if (open && lines === null) void loadLines()
  }, [open, lines, loadLines])

  async function certify() {
    setBusy(true)
    try {
      await certifyRaBill(b.id, null)
      toast.success(`${b.bill_no} certified`, {
        description: 'The figures are now frozen on the bill.',
      })
      await onChanged()
    } catch (err) {
      // The RPC refuses an empty bill, a backwards running account, or a
      // role that cannot certify — the message says which.
      toast.error('Could not certify the bill', { description: errText(err) })
    }
    setBusy(false)
  }

  async function reject() {
    if (reason.trim() === '') {
      toast.error('Say what needs fixing')
      return
    }
    setBusy(true)
    try {
      await rejectRaBill(b.id, reason)
      toast.success(`${b.bill_no} rejected`, {
        description: 'The contractor can correct it and resubmit.',
      })
      setRejecting(false)
      setReason('')
      await onChanged()
    } catch (err) {
      toast.error('Could not reject the bill', { description: errText(err) })
    }
    setBusy(false)
  }

  async function move(next: 'submitted' | 'under_review') {
    setBusy(true)
    try {
      await setRaStatus(b.id, next)
      toast.success(
        next === 'under_review' ? 'Moved to review' : 'Back to submitted',
      )
      await onChanged()
    } catch (err) {
      toast.error('Could not update the bill', { description: errText(err) })
    }
    setBusy(false)
  }

  async function download() {
    setBusy(true)
    try {
      const [project, ls] = await Promise.all([
        fetchProject(b.project_id),
        lines ? Promise.resolve(lines) : fetchRaLines(b.id),
      ])
      generateRaBillPdf({
        bill: b,
        lines: ls,
        projectName: project?.name ?? '—',
        siteAddress: project?.site_address ?? null,
      })
      toast.success('Certificate downloaded')
    } catch (err) {
      toast.error('Could not build the certificate', {
        description: errText(err),
      })
    }
    setBusy(false)
  }

  return (
    <article
      className={cn(
        'paper p-5',
        (b.status === 'cancelled' || b.status === 'rejected') && 'opacity-75',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="font-heading text-[17px] font-semibold tabular-nums">
              {b.bill_no}
            </span>
            {b.contractor_bill_no && (
              <span className="text-xs text-muted-foreground">
                their {b.contractor_bill_no}
              </span>
            )}
            {b.status === 'cancelled' && <CancelledBadge />}
          </p>
          <p className="mt-0.5 truncate text-sm">
            {b.vendor_name ?? b.contractor_name ?? '—'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {b.period_from ? `${b.period_from} → ` : 'Up to '}
            {b.period_to}
            {` · ${b.line_count} item${b.line_count === 1 ? '' : 's'}`}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            STATUS_TONE[b.status],
          )}
        >
          {RA_STATUS_LABEL[b.status]}
        </span>
      </div>

      {/* The running account, in the order it reads on paper. */}
      <dl className="mt-4 space-y-1.5 border-t border-border pt-4 text-sm">
        <Row label="Work to date" value={formatInr(b.gross_work_value)} />
        <Row
          label="Less previously certified"
          value={`− ${formatInr(b.less_previously_certified)}`}
        />
        <Row label="Value this bill" value={formatInr(b.value_this_bill)} strong />
        <Row
          label={`Less retention @ ${b.retention_pct}%`}
          value={`− ${formatInr(b.retention_amount)}`}
        />
        <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-border pt-2">
          <dt className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            {b.is_frozen ? 'Net certified' : 'Would certify'}
          </dt>
          <dd className="figure text-[19px] font-semibold">
            {formatInr(b.net_certified)}
          </dd>
        </div>
      </dl>

      {!b.is_frozen && b.line_count > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Preview from the measurements — nothing is committed until it's
          certified.
        </p>
      )}

      {b.claimed_amount !== null && (
        <p className="mt-2 text-xs text-muted-foreground">
          Claimed {formatInr(b.claimed_amount)}
          {b.is_frozen &&
            ` · ${formatInr(Math.abs(b.claimed_amount - b.net_certified))} ${
              b.claimed_amount > b.net_certified ? 'less' : 'more'
            } certified`}
        </p>
      )}

      {b.status !== 'cancelled' && activities.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <label
            htmlFor={`bill-act-${b.id}`}
            className="shrink-0 text-xs text-muted-foreground"
          >
            Activity
          </label>
          <Select
            id={`bill-act-${b.id}`}
            value={b.activity_id ?? ''}
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

      {b.status === 'rejected' && b.reject_reason && (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Rejected: {b.reject_reason}
        </p>
      )}
      {b.status === 'cancelled' && (
        <CancelNote at={b.cancelled_at} reason={b.cancel_reason} />
      )}

      {rejecting && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <FieldRow
            label="What needs fixing"
            htmlFor={`rj-${b.id}`}
            hint="The contractor has to know what to correct before resubmitting."
          >
            <Textarea
              id={`rj-${b.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Quantities for block work exceed the measured area."
            />
          </FieldRow>
          <div className="flex gap-2">
            <Button
              className="h-11 flex-1 bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={() => void reject()}
            >
              {busy ? 'Saving…' : 'Reject bill'}
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!rejecting && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide measurements' : `Measurements (${b.line_count})`}
          </Button>

          {mayCertify && editable && (
            <Button disabled={busy} onClick={() => void certify()}>
              Certify
            </Button>
          )}
          {mayCertify && editable && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              Reject
            </Button>
          )}
          {b.status === 'submitted' && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void move('under_review')}
            >
              Start review
            </Button>
          )}
          {b.status === 'rejected' && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void move('under_review')}
            >
              Reopen
            </Button>
          )}

          {b.status === 'certified' && (
            <Button variant="outline" disabled={busy} onClick={() => void download()}>
              <Download className="size-4" aria-hidden="true" />
              Certificate
            </Button>
          )}

          {b.status === 'certified' && (
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setCancelling(true)}
            >
              Cancel bill
            </Button>
          )}

          {b.status !== 'certified' && b.status !== 'cancelled' && (
            <DeleteButton
              table="ra_bills"
              id={b.id}
              name={`${b.bill_no} · ${b.vendor_name ?? b.contractor_name ?? ''}`}
              role={role}
              onDeleted={onChanged}
            />
          )}
        </div>
      )}

      {cancelling && (
        <CancelDialog
          table="ra_bills"
          id={b.id}
          summary={`${b.bill_no} · ${b.vendor_name ?? b.contractor_name ?? ''} · ${formatInr(b.net_certified)} certified`}
          consequence="The certified figure is withdrawn. The next bill's “less previously certified” drops accordingly, so the running account corrects itself."
          onDone={async () => {
            setCancelling(false)
            await onChanged()
          }}
          onCancel={() => setCancelling(false)}
        />
      )}

      {open && (
        <Measurements
          billId={b.id}
          lines={lines}
          editable={editable}
          onChanged={async () => {
            setLines(null)
            await onChanged()
          }}
        />
      )}
    </article>
  )
}

function Row({
  label,
  value,
  strong,
}: {
  label: string
  value: string
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn('text-muted-foreground', strong && 'text-foreground')}>
        {label}
      </dt>
      <dd className={cn('tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  )
}

/* ---------------- Measurements ---------------- */

function Measurements({
  billId,
  lines,
  editable,
  onChanged,
}: {
  billId: string
  lines: RaBillLine[] | null
  editable: boolean
  onChanged: () => Promise<void>
}) {
  const [description, setDescription] = useState('')
  const [unit, setUnit] = useState('sqft')
  const [qty, setQty] = useState('')
  const [rate, setRate] = useState('')
  const [busy, setBusy] = useState(false)

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (description.trim() === '') {
      toast.error('Describe the work')
      return
    }
    setBusy(true)
    try {
      await addRaLine({
        bill_id: billId,
        description,
        unit,
        qty_to_date: Number(qty) || 0,
        rate: Number(rate) || 0,
        sort: (lines?.length ?? 0) * 10 + 10,
      })
      setDescription('')
      setQty('')
      setRate('')
      await onChanged()
    } catch (err) {
      toast.error('Could not add the measurement', { description: errText(err) })
    }
    setBusy(false)
  }

  async function remove(id: string) {
    try {
      await deleteRaLine(id)
      await onChanged()
    } catch (err) {
      toast.error('Could not remove the line', { description: errText(err) })
    }
  }

  return (
    <div className="mt-4 border-t border-border pt-4">
      {lines === null ? (
        <ListSkeleton rows={2} />
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No measurements yet. A bill with no lines cannot be certified.
        </p>
      ) : (
        <ul className="space-y-2">
          {lines.map((l) => (
            <li key={l.id} className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{l.description}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {l.qty_to_date} {l.unit ?? ''} × {formatInr(l.rate)}
                </p>
              </div>
              <div className="flex shrink-0 items-baseline gap-2">
                <span className="text-sm font-medium tabular-nums">
                  {formatInr(l.amount)}
                </span>
                {editable && (
                  <button
                    type="button"
                    onClick={() => void remove(l.id)}
                    className="min-h-9 px-1 text-xs text-destructive"
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <form onSubmit={add} className="mt-4 space-y-3" noValidate>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Block work, ground floor"
            className="h-11 text-base"
            aria-label="Description"
          />
          <div className="grid grid-cols-3 gap-2">
            <Select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              aria-label="Unit"
            >
              {['sqft', 'rmt', 'nos', 'cum', 'kg', 'days', 'lump sum'].map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="Qty to date"
              className="h-11 tabular-nums"
              aria-label="Quantity to date"
            />
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="Rate"
              className="h-11 tabular-nums"
              aria-label="Rate"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Quantity is cumulative to date, not this period — that's what makes
            the running account correct itself.
          </p>
          <Button type="submit" variant="outline" disabled={busy} className="h-11">
            {busy ? 'Adding…' : 'Add measurement'}
          </Button>
        </form>
      )}
    </div>
  )
}

/* ---------------- New bill ---------------- */

function NewBillForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const projectId = useProjects((s) => s.selectedId)

  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
  const [theirNo, setTheirNo] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayIst())
  const [claimed, setClaimed] = useState('')
  const [retention, setRetention] = useState('5')
  const [notes, setNotes] = useState('')
  const [activityId, setActivityId] = useState('')
  const [activities, setActivities] = useState<ScheduleActivity[]>([])
  const [busy, setBusy] = useState(false)

  // Optional, and hidden entirely on a project with no programme.
  useEffect(() => {
    if (!projectId) return
    fetchActivities(projectId).then(setActivities).catch(() => setActivities([]))
  }, [projectId])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!projectId) return
    if (!vendor.vendorId && vendor.vendorName.trim() === '') {
      toast.error('Say whose bill this is')
      return
    }

    setBusy(true)
    try {
      const payload: NewRaBillInput = {
        project_id: projectId,
        vendor_id: vendor.vendorId,
        contractor_name: vendor.vendorName,
        contractor_bill_no: theirNo,
        period_from: from || null,
        period_to: to,
        claimed_amount: claimed === '' ? null : Number(claimed),
        retention_pct: Number(retention) || 0,
        notes,
        activity_id: activityId || null,
      }
      await createRaBill(payload)
      toast.success('Bill recorded', {
        description: 'Add the measurements, then certify it.',
      })
      await onSaved()
    } catch (err) {
      toast.error('Could not record the bill', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="paper mb-6 space-y-5 p-5" noValidate>
      <p className="font-heading text-[18px] font-semibold">New RA bill</p>

      <FieldRow
        label="Contractor"
        htmlFor="ra-vendor"
        hint="A registered vendor, or free text for a labour contractor who isn't one."
      >
        <VendorField id="ra-vendor" value={vendor} onChange={setVendor} />
      </FieldRow>

      {activities.length > 0 && (
        <FieldRow
          label="Schedule activity"
          htmlFor="ra-activity"
          hint="Optional. Once certified, this bill's value counts as actual cost against that activity's earned value."
        >
          <Select
            id="ra-activity"
            value={activityId}
            onChange={(e) => setActivityId(e.target.value)}
          >
            <option value="">Not tied to an activity</option>
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </FieldRow>
      )}

      <FieldRow
        label="Their bill number"
        htmlFor="ra-their-no"
        hint="Optional — how the contractor numbered it."
      >
        <Input
          id="ra-their-no"
          value={theirNo}
          onChange={(e) => setTheirNo(e.target.value)}
          placeholder="e.g. RA-3"
          className="h-12 text-base"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Period from" htmlFor="ra-from">
          <Input
            id="ra-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-12"
          />
        </FieldRow>
        <FieldRow label="Measured up to" htmlFor="ra-to">
          <Input
            id="ra-to"
            type="date"
            value={to}
            onChange={(e) => e.target.value && setTo(e.target.value)}
            className="h-12"
          />
        </FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow
          label="Claimed (₹)"
          htmlFor="ra-claimed"
          hint="What they asked for."
        >
          <Input
            id="ra-claimed"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={claimed}
            onChange={(e) => setClaimed(e.target.value)}
            placeholder="0.00"
            className="h-12 tabular-nums"
          />
        </FieldRow>

        <FieldRow label="Retention %" htmlFor="ra-ret">
          <Input
            id="ra-ret"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            className="h-12 tabular-nums"
          />
        </FieldRow>
      </div>

      <FieldRow label="Notes" htmlFor="ra-notes">
        <Textarea
          id="ra-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything the certificate should record."
        />
      </FieldRow>

      <p className="text-xs text-muted-foreground">
        Every figure on the certificate is computed in Postgres when you certify
        — retention is taken on this bill's value only, so the same work is
        never held back twice.
      </p>

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Saving…' : 'Record bill'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}
