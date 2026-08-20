import { AlertTriangle, HardHat, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import { fetchCategories } from '@/lib/queries/expenses'
import {
  createContractor,
  createRate,
  deleteRate,
  fetchContractors,
  fetchLabourTrades,
  fetchLicenceAlerts,
  fetchOvertimeRegister,
  fetchRates,
  fetchReconcile,
  fetchWageRegister,
  postLabourExpense,
  setContractorActive,
} from '@/lib/queries/labour'
import { todayIst } from '@/lib/useSelectedDate'
import {
  canPostLabour,
  canSeeLabourCost,
  type LabourContractor,
  type LabourRate,
  type LabourReconcile,
  type LicenceAlert,
  type OvertimeRow,
  type WageRegisterRow,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

type Tab = 'register' | 'rates' | 'contractors'

/** First and last day of the month containing `date`, in Asia/Kolkata. */
function monthRange(date: string): [string, string] {
  const [y, m] = date.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return [
    `${y}-${String(m).padStart(2, '0')}-01`,
    `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
  ]
}

/**
 * Contract labour — the money half.
 *
 * The wage register, the rates behind it, and the one deliberate act that turns
 * a period's attendance into ledger cost. Attendance itself lives under Tasks,
 * where the supervisor logs it and sees no figures at all.
 */
export default function Labour() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  const [tab, setTab] = useState<Tab>('register')
  const [from, setFrom] = useState(() => monthRange(todayIst())[0])
  const [to, setTo] = useState(() => monthRange(todayIst())[1])

  const [register, setRegister] = useState<WageRegisterRow[] | null>(null)
  const [ot, setOt] = useState<OvertimeRow[]>([])
  const [recon, setRecon] = useState<LabourReconcile | null>(null)
  const [alerts, setAlerts] = useState<LicenceAlert[]>([])

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const [w, o, r] = await Promise.all([
        fetchWageRegister(projectId, from, to),
        fetchOvertimeRegister(projectId, from, to).catch(() => [] as OvertimeRow[]),
        fetchReconcile(projectId, from, to),
      ])
      setRegister(w)
      setOt(o)
      setRecon(r)
    } catch (err) {
      toast.error('Could not load the wage register', {
        description: errText(err),
      })
      setRegister([])
    }
  }, [projectId, from, to])

  useEffect(() => {
    setRegister(null)
    void reload()
    void fetchLicenceAlerts()
      .then(setAlerts)
      .catch(() => setAlerts([]))
  }, [reload])

  if (!canSeeLabourCost(role)) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Wage rates are restricted for your role. Attendance is under Tasks →
        Labour.
      </p>
    )
  }

  if (!projectId) return <ListSkeleton rows={4} />

  const payable = (register ?? []).reduce((a, r) => a + r.total_payable, 0)
  const missing = (register ?? []).reduce((a, r) => a + r.missing_rates, 0)

  return (
    <div className="space-y-4 pb-6">
      {alerts.length > 0 && (
        <section className="paper p-4">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Contractor licences
          </p>
          <ul className="mt-2 space-y-1">
            {alerts.map((a) => (
              <li
                key={a.contractor_id}
                className={cn(
                  'text-xs',
                  a.display_status === 'expired'
                    ? 'font-medium text-destructive'
                    : 'text-[var(--warning)]',
                )}
              >
                {a.name} — licence{' '}
                {a.display_status === 'expired'
                  ? `expired ${-a.days_left} days ago`
                  : `expires in ${a.days_left} days`}{' '}
                ({a.licence_valid_to})
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="paper p-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Labour for the period
          </h2>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="From"
            className="h-11 text-base"
          />
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label="To"
            className="h-11 text-base"
          />
        </div>

        <p className="figure mt-4 text-[28px] leading-none font-semibold">
          {formatInr(payable)}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          What the attendance for this period is worth
        </p>

        {missing > 0 && (
          <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {missing} {missing === 1 ? 'entry has' : 'entries have'} no wage rate
            in force. They are counted as zero — set the rate before posting.
          </p>
        )}

        {recon && <Reconciliation recon={recon} />}

        {canPostLabour(role) && (
          <PostBlock
            projectId={projectId}
            from={from}
            to={to}
            onPosted={reload}
          />
        )}
      </section>

      <div className="flex gap-1">
        {(
          [
            ['register', 'Wage register'],
            ['rates', 'Rates'],
            ['contractors', 'Contractors'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'min-h-11 flex-1 rounded-lg px-3 text-sm font-medium transition-colors',
              tab === t
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'register' && (
        <RegisterTab register={register} ot={ot} payable={payable} />
      )}
      {tab === 'rates' && <RatesTab projectId={projectId} />}
      {tab === 'contractors' && <ContractorsTab />}
    </div>
  )
}

/* ---------------- reconciliation ---------------- */

/**
 * The figure that stops the accrual and the P&L drifting apart.
 *
 * Attendance × rate never reaches the P&L on its own — if it did, labour paid
 * through an expense would be counted twice and every margin would be wrong by
 * the biggest line on the job. So this shows both numbers and their difference,
 * and posting is a deliberate act.
 */
function Reconciliation({ recon }: { recon: LabourReconcile }) {
  const clean = Math.abs(recon.variance) < 1

  return (
    <div className="mt-4 space-y-2 border-t border-border pt-4">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">Attendance is worth</span>
        <span className="tabular-nums">{formatInr(recon.accrued)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">Booked to the ledger</span>
        <span className="tabular-nums">{formatInr(recon.booked_ledger)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3 text-sm font-medium">
        <span>Difference</span>
        <span
          className={cn(
            'tabular-nums',
            clean ? 'text-[var(--positive)]' : 'text-[var(--warning)]',
          )}
        >
          {formatInr(recon.variance)}
        </span>
      </div>
      <p className="pt-1 text-[10px] text-muted-foreground">
        Only what is booked to the ledger reaches the P&amp;L. Attendance is
        never added to cost on its own, or labour paid by expense would be
        counted twice.
      </p>
    </div>
  )
}

function PostBlock({
  projectId,
  from,
  to,
  onPosted,
}: {
  projectId: string
  from: string
  to: string
  onPosted: () => Promise<void>
}) {
  const [cats, setCats] = useState<{ id: number; name: string }[]>([])
  const [cat, setCat] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void fetchCategories()
      .then((c) => {
        setCats(c)
        const labour = c.find((x) => x.name.toLowerCase().startsWith('labour'))
        if (labour) setCat(String(labour.id))
      })
      .catch(() => setCats([]))
  }, [])

  if (!open) {
    return (
      <Button
        variant="outline"
        className="mt-4 h-11 w-full"
        onClick={() => setOpen(true)}
      >
        Post this period to the ledger
      </Button>
    )
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">
        Creates one expense per schedule activity in the period, so earned value
        keeps its tagging. Overlapping periods are refused — that refusal is what
        keeps labour out of the P&amp;L twice.
      </p>

      <FieldRow label="Book against" htmlFor="lab_cat">
        <Select id="lab_cat" value={cat} onChange={(e) => setCat(e.target.value)}>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" className="h-11" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          className="h-11"
          disabled={busy || !cat}
          onClick={async () => {
            setBusy(true)
            try {
              const n = await postLabourExpense(
                projectId,
                from,
                to,
                Number(cat),
                null,
              )
              toast.success(
                `${n} expense${n === 1 ? '' : 's'} posted to the ledger`,
                { description: 'The P&L will pick this up the ordinary way.' },
              )
              setOpen(false)
              await onPosted()
            } catch (err) {
              toast.error('Could not post', { description: errText(err) })
            }
            setBusy(false)
          }}
        >
          {busy ? 'Posting…' : 'Post'}
        </Button>
      </div>
    </div>
  )
}

/* ---------------- registers ---------------- */

function RegisterTab({
  register,
  ot,
  payable,
}: {
  register: WageRegisterRow[] | null
  ot: OvertimeRow[]
  payable: number
}) {
  if (register === null) return <ListSkeleton rows={3} />

  if (register.length === 0) {
    return (
      <EmptyState
        icon={HardHat}
        title="No labour recorded for this period"
        body="Gangs are logged on site under Tasks → Labour. The wage register builds itself from them."
      />
    )
  }

  return (
    <div className="space-y-4">
      <section className="paper overflow-x-auto p-0">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              {['Contractor', 'Trade', 'Days', 'Mandays', 'Rate', 'Wages', 'OT', 'Payable'].map(
                (h, i) => (
                  <th
                    key={h}
                    className={cn(
                      'px-3 py-3 text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase',
                      i < 2 ? 'text-left' : 'text-right',
                    )}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {register.map((r) => (
              <tr
                key={`${r.contractor_id}-${r.trade}`}
                className="border-b border-border/60"
              >
                <td className="px-3 py-3">{r.contractor_name}</td>
                <td className="px-3 py-3 text-muted-foreground">{r.trade}</td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {r.days_worked}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {r.mandays}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {r.daily_rate === null ? (
                    <span className="text-destructive">no rate</span>
                  ) : (
                    formatInr(r.daily_rate)
                  )}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatInr(r.wages)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {r.ot_amount > 0 ? formatInr(r.ot_amount) : '—'}
                </td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums">
                  {formatInr(r.total_payable)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border">
              <td
                colSpan={7}
                className="px-3 py-3 text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase"
              >
                Total payable
              </td>
              <td className="figure px-3 py-3 text-right text-base font-semibold">
                {formatInr(payable)}
              </td>
            </tr>
          </tfoot>
        </table>
      </section>

      <p className="px-1 text-[11px] text-muted-foreground">
        A Form XVII equivalent, at GANG level. It is the firm's own record, built
        from gang counts — it is not the named statutory wage register your
        contractor must keep. Where a contractor supplies a roster, add it under
        Contractors and the registers can name people.
      </p>

      {ot.length > 0 && (
        <section className="paper p-5">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Overtime register
          </p>
          <ul className="mt-3 space-y-2">
            {ot.map((o, i) => (
              <li
                key={`${o.work_date}-${o.contractor_name}-${o.trade}-${i}`}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <span className="min-w-0 truncate">
                  {o.work_date} · {o.contractor_name} · {o.trade}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {o.ot_hours} h × {formatInr(o.ot_rate_per_hr)} ={' '}
                  {formatInr(o.ot_amount)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[10px] text-muted-foreground">
            Overtime is paid at {ot[0]?.ot_multiplier ?? 2}× the ordinary hourly
            rate — the daily rate over a {ot[0]?.normal_hours ?? 8}-hour day.
            Both figures are on the rate, so they can be seen and changed.
          </p>
        </section>
      )}
    </div>
  )
}

/* ---------------- rates ---------------- */

function RatesTab({ projectId }: { projectId: string }) {
  const [rates, setRates] = useState<LabourRate[] | null>(null)
  const [contractors, setContractors] = useState<LabourContractor[]>([])
  const [trades, setTrades] = useState<string[]>([])
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async () => {
    try {
      setRates(await fetchRates())
    } catch {
      setRates([])
    }
  }, [])

  useEffect(() => {
    void reload()
    void fetchContractors().then(setContractors).catch(() => setContractors([]))
    void fetchLabourTrades().then(setTrades).catch(() => setTrades([]))
  }, [reload])

  if (rates === null) return <ListSkeleton rows={3} />

  const nameOf = (id: string | null) =>
    id ? (contractors.find((c) => c.id === id)?.name ?? '—') : null

  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        className="h-11 w-full"
        onClick={() => setAdding((v) => !v)}
      >
        <Plus className="size-4" /> Add a rate
      </Button>

      {adding && (
        <RateForm
          projectId={projectId}
          contractors={contractors}
          trades={trades}
          onDone={async () => {
            setAdding(false)
            await reload()
          }}
        />
      )}

      {rates.length === 0 && !adding && (
        <EmptyState
          icon={HardHat}
          title="No wage rates set"
          body="Attendance without a rate is counted as zero, and posting is refused until every entry has one."
        />
      )}

      <Stagger className="space-y-2">
        {rates.map((r) => (
          <RevealItem key={r.id}>
            <article className="paper flex items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {r.trade} · {formatInr(r.daily_rate)}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    / day
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {/* Which scope this rate applies at — the same four levels
                      fn_labour_rate resolves against. */}
                  {[
                    r.project_id ? 'this project' : 'all projects',
                    nameOf(r.contractor_id) ?? 'all contractors',
                    `from ${r.effective_from}`,
                    r.effective_to ? `to ${r.effective_to}` : null,
                    `OT ×${r.ot_multiplier} on ${r.normal_hours} h`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <Button
                variant="ghost"
                size="xs"
                aria-label="Delete rate"
                onClick={async () => {
                  try {
                    await deleteRate(r.id)
                    toast.success('Rate removed')
                    await reload()
                  } catch (err) {
                    toast.error('Could not remove the rate', {
                      description: errText(err),
                    })
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </article>
          </RevealItem>
        ))}
      </Stagger>
    </div>
  )
}

function RateForm({
  projectId,
  contractors,
  trades,
  onDone,
}: {
  projectId: string
  contractors: LabourContractor[]
  trades: string[]
  onDone: () => Promise<void>
}) {
  const [trade, setTrade] = useState(trades[0] ?? '')
  const [rate, setRate] = useState('')
  const [scopeProject, setScopeProject] = useState(true)
  const [contractorId, setContractorId] = useState('')
  const [from, setFrom] = useState(todayIst())
  const [otMult, setOtMult] = useState('2')
  const [hours, setHours] = useState('8')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (trades.length > 0 && !trade) setTrade(trades[0])
  }, [trades, trade])

  return (
    <section className="paper space-y-4 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        New wage rate
      </p>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Trade" htmlFor="rate_trade">
          <Select
            id="rate_trade"
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
          >
            {trades.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="Per day" htmlFor="rate_amt">
          <Input
            id="rate_amt"
            type="number"
            inputMode="decimal"
            step="1"
            min="0"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="850"
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
      </div>

      <FieldRow
        label="Applies to"
        htmlFor="rate_contractor"
        hint="The most specific rate in force on the day wins: this project + this contractor, then this project, then this contractor, then the firm standard."
      >
        <Select
          id="rate_contractor"
          value={contractorId}
          onChange={(e) => setContractorId(e.target.value)}
        >
          <option value="">All contractors</option>
          {contractors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </FieldRow>

      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={scopeProject}
          onChange={(e) => setScopeProject(e.target.checked)}
          className="size-4"
        />
        Only on the selected project
      </label>

      <div className="grid grid-cols-3 gap-2">
        <FieldRow label="From" htmlFor="rate_from">
          <Input
            id="rate_from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="OT ×" htmlFor="rate_ot">
          <Input
            id="rate_ot"
            type="number"
            step="0.25"
            min="1"
            value={otMult}
            onChange={(e) => setOtMult(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
        <FieldRow label="Day (h)" htmlFor="rate_hours">
          <Input
            id="rate_hours"
            type="number"
            step="0.5"
            min="1"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
      </div>

      <Button
        className="h-12 w-full"
        disabled={busy || !trade || Number(rate) < 0 || rate === ''}
        onClick={async () => {
          setBusy(true)
          try {
            await createRate({
              project_id: scopeProject ? projectId : null,
              contractor_id: contractorId || null,
              trade,
              daily_rate: Number(rate),
              ot_multiplier: Number(otMult) || 2,
              normal_hours: Number(hours) || 8,
              effective_from: from,
              effective_to: null,
              notes: '',
            })
            toast.success('Rate saved')
            await onDone()
          } catch (err) {
            toast.error('Could not save the rate', { description: errText(err) })
            setBusy(false)
          }
        }}
      >
        {busy ? 'Saving…' : 'Save rate'}
      </Button>
    </section>
  )
}

/* ---------------- contractors ---------------- */

function ContractorsTab() {
  const [list, setList] = useState<LabourContractor[] | null>(null)
  const [trades, setTrades] = useState<string[]>([])
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async () => {
    try {
      setList(await fetchContractors(false))
    } catch {
      setList([])
    }
  }, [])

  useEffect(() => {
    void reload()
    void fetchLabourTrades().then(setTrades).catch(() => setTrades([]))
  }, [reload])

  if (list === null) return <ListSkeleton rows={3} />

  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        className="h-11 w-full"
        onClick={() => setAdding((v) => !v)}
      >
        <Plus className="size-4" /> Add a contractor
      </Button>

      {adding && (
        <ContractorForm
          trades={trades}
          onDone={async () => {
            setAdding(false)
            await reload()
          }}
        />
      )}

      {list.length === 0 && !adding && (
        <EmptyState
          icon={HardHat}
          title="No labour contractors yet"
          body="Add each contractor with their CLRA licence number and expiry — attendance is logged against them."
        />
      )}

      <Stagger className="space-y-2">
        {list.map((c) => (
          <RevealItem key={c.id}>
            <article
              className={cn('paper p-4', !c.is_active && 'opacity-60')}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{c.name}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {[
                      c.licence_no ? `Licence ${c.licence_no}` : 'No licence on file',
                      c.licence_valid_to ? `valid to ${c.licence_valid_to}` : null,
                      c.licensed_strength ? `${c.licensed_strength} workers` : null,
                      c.phone,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {c.trades.length > 0 && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {c.trades.join(', ')}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={async () => {
                    try {
                      await setContractorActive(c.id, !c.is_active)
                      await reload()
                    } catch (err) {
                      toast.error('Could not update', {
                        description: errText(err),
                      })
                    }
                  }}
                >
                  {c.is_active ? 'Deactivate' : 'Reactivate'}
                </Button>
              </div>
            </article>
          </RevealItem>
        ))}
      </Stagger>
    </div>
  )
}

function ContractorForm({
  trades,
  onDone,
}: {
  trades: string[]
  onDone: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [contact, setContact] = useState('')
  const [licence, setLicence] = useState('')
  const [validTo, setValidTo] = useState('')
  const [strength, setStrength] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <section className="paper space-y-4 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        New labour contractor
      </p>

      <FieldRow label="Name" htmlFor="c_name">
        <Input
          id="c_name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ramesh & Co"
          className="h-12 text-base"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Contact person" htmlFor="c_contact">
          <Input
            id="c_contact"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Phone" htmlFor="c_phone">
          <Input
            id="c_phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      <FieldRow
        label="CLRA licence no"
        htmlFor="c_lic"
        hint="An expired licence on site is a stop-work risk, so the expiry is tracked and warned about 30 days ahead."
      >
        <Input
          id="c_lic"
          value={licence}
          onChange={(e) => setLicence(e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Valid to" htmlFor="c_valid">
          <Input
            id="c_valid"
            type="date"
            value={validTo}
            onChange={(e) => setValidTo(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow
          label="Licensed workers"
          htmlFor="c_strength"
          hint="Attendance above it is flagged"
        >
          <Input
            id="c_strength"
            type="number"
            inputMode="numeric"
            min="1"
            value={strength}
            onChange={(e) => setStrength(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Trades supplied</p>
        <div className="flex flex-wrap gap-1.5">
          {trades.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() =>
                setPicked((p) =>
                  p.includes(t) ? p.filter((x) => x !== t) : [...p, t],
                )
              }
              className={cn(
                'min-h-9 rounded-full border px-3 text-xs transition-colors',
                picked.includes(t)
                  ? 'border-transparent bg-secondary text-secondary-foreground'
                  : 'border-border text-muted-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <FieldRow label="Notes" htmlFor="c_notes">
        <Textarea
          id="c_notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </FieldRow>

      <Button
        className="h-12 w-full"
        disabled={busy || !name.trim()}
        onClick={async () => {
          setBusy(true)
          try {
            await createContractor({
              name,
              contact_person: contact,
              phone,
              licence_no: licence,
              licence_authority: '',
              licence_valid_to: validTo || null,
              licensed_strength: strength ? Number(strength) : null,
              pf_code: '',
              esi_code: '',
              gstin: '',
              trades: picked,
              notes,
            })
            toast.success('Contractor added')
            await onDone()
          } catch (err) {
            toast.error('Could not add the contractor', {
              description: errText(err),
            })
            setBusy(false)
          }
        }}
      >
        {busy ? 'Saving…' : 'Add contractor'}
      </Button>
    </section>
  )
}
