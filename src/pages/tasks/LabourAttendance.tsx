import { HardHat, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  createContractor,
  fetchAttendance,
  fetchContractors,
  fetchHeadcountCheck,
  fetchLabourTrades,
  logAttendanceBatch,
  voidAttendance,
} from '@/lib/queries/labour'
import { useSelectedDate } from '@/lib/useSelectedDate'
import {
  type AttendanceRow,
  canLogAttendance,
  canSeeLabourCost,
  type LabourContractor,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/**
 * Daily gang attendance — the supervisor's screen.
 *
 * Deliberately counts gangs, not names: "Ramesh & Co, 14 masons, second floor"
 * is what somebody can enter one-handed at a gate. A module that demanded
 * fourteen names on a phone would go unused, which is the 048 lesson learned by
 * deleting a 627-question inspection plan.
 *
 * There is no money anywhere on this screen. Wage rates live in a separate
 * table that a supervisor matches no policy on, so they see headcount and work
 * areas and nothing else — not blanked figures, no rows at all.
 */
export default function LabourAttendance() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayLog = canLogAttendance(role)

  const [date] = useSelectedDate()
  const [gangs, setGangs] = useState<AttendanceRow[] | null>(null)
  const [contractors, setContractors] = useState<LabourContractor[]>([])
  const [trades, setTrades] = useState<string[]>([])
  const [check, setCheck] = useState<{
    site_log: number
    attendance: number
    variance: number
  } | null>(null)
  const [adding, setAdding] = useState(false)
  // Deliberately NOT swallowed. An empty list and a missing table look identical
  // on screen, and "0 items usually means a migration that never ran" is a
  // standing lesson in this project — so the reason is kept and shown.
  const [refError, setRefError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const [a, c] = await Promise.all([
        fetchAttendance(projectId, date),
        fetchHeadcountCheck(projectId, date),
      ])
      setGangs(a)
      setCheck(c)
    } catch (err) {
      toast.error('Could not load attendance', { description: errText(err) })
      setGangs([])
    }
  }, [projectId, date])

  const reloadContractors = useCallback(async () => {
    try {
      setContractors(await fetchContractors())
      setRefError(null)
    } catch (err) {
      setContractors([])
      setRefError(errText(err) ?? 'Could not load contractors')
    }
  }, [])

  useEffect(() => {
    setGangs(null)
    void reload()
    void reloadContractors()
    void fetchLabourTrades()
      .then(setTrades)
      .catch((err) => setRefError(errText(err) ?? 'Could not load trades'))
  }, [reload, reloadContractors])

  if (!projectId || gangs === null) return <ListSkeleton rows={4} />

  const live = gangs.filter((g) => g.voided_at === null)
  const onSite = live.reduce((a, g) => a + g.workers_present, 0)
  const otHours = live.reduce((a, g) => a + g.overtime_hours, 0)

  return (
    <div className="space-y-4 pb-6">
      <section className="paper p-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Labour on site
          </h2>
          <span className="text-[11px] text-muted-foreground">{date}</span>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-5">
          <div>
            <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
              Workers
            </p>
            <p className="figure mt-1 text-[26px] leading-none font-semibold">
              {onSite}
            </p>
          </div>
          <div>
            <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
              Gangs
            </p>
            <p className="figure mt-1 text-[26px] leading-none font-semibold">
              {live.length}
            </p>
          </div>
          <div>
            <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
              Overtime
            </p>
            <p className="figure mt-1 text-[26px] leading-none font-semibold">
              {otHours}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                h
              </span>
            </p>
          </div>
        </div>

        {/* The site log has held a headcount since day one. Two records of one
            fact will disagree; this makes the disagreement visible instead of
            letting whichever was typed last quietly win. */}
        {check && check.site_log > 0 && check.variance !== 0 && (
          <p className="mt-4 rounded-lg bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] px-3 py-2.5 text-xs text-[var(--warning)]">
            The site log for {date} says {check.site_log} on site; attendance
            adds up to {check.attendance}. One of them needs correcting — the
            wage register uses attendance.
          </p>
        )}
      </section>

      {mayLog && !adding && (
        <Button className="h-12 w-full text-base" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Log a gang
        </Button>
      )}

      {refError && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          Could not read the labour reference tables — {refError}. If migration
          054 has not been run yet, that is why.
        </p>
      )}

      {adding && (
        <GangForm
          projectId={projectId}
          date={date}
          contractors={contractors}
          trades={trades}
          mayAddContractor={canSeeLabourCost(role)}
          onContractorAdded={reloadContractors}
          onDone={async () => {
            setAdding(false)
            await reload()
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {gangs.length === 0 && !adding && (
        <EmptyState
          icon={HardHat}
          title="No gangs logged for this day"
          body="Record each contractor's gang — trade, how many were present, and where they worked."
          actionLabel={mayLog ? 'Log the first gang' : undefined}
          onAction={mayLog ? () => setAdding(true) : undefined}
        />
      )}

      {gangs.length > 0 && (
        <Stagger className="space-y-3">
          {gangs.map((g) => (
            <RevealItem key={g.attendance_id}>
              <GangCard gang={g} role={role} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function GangCard({
  gang,
  role,
  onChanged,
}: {
  gang: AttendanceRow
  role: string | null
  onChanged: () => Promise<void>
}) {
  const me = useAuth((s) => s.user?.id ?? null)
  const [voiding, setVoiding] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const voided = gang.voided_at !== null

  // A supervisor voids what they logged themselves — they enter it, so they
  // make the typos. The RPC enforces this; the button only mirrors it.
  const mayVoid =
    !voided &&
    (role === 'founder' ||
      role === 'pm' ||
      (role === 'supervisor' && gang.created_by === me))

  return (
    <article className={cn('paper p-5', voided && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[17px] font-semibold">
            {gang.contractor_name}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {gang.trade}
            {gang.work_area && ` · ${gang.work_area}`}
            {gang.overtime_hours > 0 && ` · ${gang.overtime_hours} h OT`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="figure text-xl font-semibold">{gang.workers_present}</p>
          <p className="text-[10px] text-muted-foreground">present</p>
        </div>
      </div>

      {/* Flagged, never blocked — the app cannot send anyone home, but it can
          say the licence does not cover this many. */}
      {gang.over_licence && !voided && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          More workers than {gang.contractor_name}'s licence permits.
        </p>
      )}

      {gang.remarks && (
        <p className="mt-3 text-xs text-muted-foreground">{gang.remarks}</p>
      )}

      {voided && (
        <p className="mt-3 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
          Voided — {gang.void_reason}
        </p>
      )}

      {mayVoid && !voiding && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setVoiding(true)}
        >
          <Trash2 className="size-3.5" /> Void entry
        </Button>
      )}

      {voiding && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            Attendance drives wages, so the entry stays on record marked void
            rather than disappearing. Why is it wrong?
          </p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Logged against the wrong contractor"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setVoiding(false)}
            >
              Keep
            </Button>
            <Button
              variant="destructive"
              className="h-11"
              disabled={busy || reason.trim().length < 3}
              onClick={async () => {
                setBusy(true)
                try {
                  await voidAttendance(gang.attendance_id, reason)
                  toast.success('Entry voided')
                  await onChanged()
                } catch (err) {
                  toast.error('Could not void the entry', {
                    description: errText(err),
                  })
                }
                setBusy(false)
              }}
            >
              Void
            </Button>
          </div>
        </div>
      )}
    </article>
  )
}

interface TradeLine {
  key: number
  trade: string
  workers: string
  ot: string
}

let lineSeq = 1

const blankLine = (trade = ''): TradeLine => ({
  key: lineSeq++,
  trade,
  workers: '',
  ot: '0',
})

function GangForm({
  projectId,
  date,
  contractors,
  trades,
  mayAddContractor,
  onContractorAdded,
  onDone,
  onCancel,
}: {
  projectId: string
  date: string
  contractors: LabourContractor[]
  trades: string[]
  mayAddContractor: boolean
  onContractorAdded: () => Promise<void>
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [newContractor, setNewContractor] = useState(false)
  const [contractorId, setContractorId] = useState('')
  const [lines, setLines] = useState<TradeLine[]>([blankLine()])
  const [area, setArea] = useState('')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (contractors.length === 1) setContractorId(contractors[0].id)
  }, [contractors])

  const chosen = contractors.find((c) => c.id === contractorId) ?? null

  /**
   * Picking a contractor seeds one row per trade THEY are recorded as supplying,
   * so the common case is "type three numbers" rather than "pick a trade, type a
   * number, tap add, pick a trade…".
   *
   * Only while nothing has been typed yet — re-seeding over entered counts would
   * throw away work, and the supervisor may deliberately be logging a trade the
   * contractor's record does not list.
   */
  function pickContractor(id: string) {
    setContractorId(id)
    const c = contractors.find((x) => x.id === id)
    const untouched = lines.every((l) => l.workers.trim() === '')
    if (untouched && c && c.trades.length > 0) {
      setLines(c.trades.filter((t) => trades.includes(t)).map((t) => blankLine(t)))
    } else if (untouched && lines.length === 1 && !lines[0].trade && trades.length) {
      setLines([blankLine(trades[0])])
    }
  }

  function patch(key: number, change: Partial<TradeLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)))
  }

  // Only rows somebody actually filled in. A trade left at zero is a trade that
  // did not turn up, and writing it would put an empty gang on the muster roll.
  const filled = lines.filter((l) => l.trade && Number(l.workers) > 0)
  const totalWorkers = filled.reduce((a, l) => a + Number(l.workers), 0)
  const dupes = filled
    .map((l) => l.trade)
    .filter((t, i, arr) => arr.indexOf(t) !== i)

  async function submit() {
    if (!contractorId) {
      toast.error('Pick a contractor')
      return
    }
    if (filled.length === 0) {
      toast.error('Enter how many were present for at least one trade')
      return
    }
    if (dupes.length > 0) {
      toast.error(`${dupes[0]} is listed twice`, {
        description: 'Put the whole gang for a trade on one line.',
      })
      return
    }

    setBusy(true)
    try {
      const n = await logAttendanceBatch(
        filled.map((l) => ({
          project_id: projectId,
          work_date: date,
          contractor_id: contractorId,
          trade: l.trade,
          workers_present: Number(l.workers),
          overtime_hours: Number(l.ot) || 0,
          work_area: area,
          activity_id: null,
          remarks,
        })),
      )
      toast.success(
        n === 1 ? 'Gang logged' : `${n} trades logged`,
        { description: `${totalWorkers} workers on site for ${chosen?.name ?? 'the contractor'}.` },
      )
      await onDone()
    } catch (err) {
      // The unique index catches a double tap on a slow connection, which would
      // otherwise double that day's wage bill silently. The batch is one
      // statement, so nothing was written — say so, or they will not know
      // whether to re-enter.
      const msg = errText(err) ?? ''
      const duplicate = msg.includes('labour_att_uk')
      toast.error(
        duplicate
          ? 'One of those trades is already logged for this day and area'
          : 'Could not log the gang',
        {
          description: duplicate
            ? 'Nothing was saved. Check what is already on the day and adjust.'
            : msg,
        },
      )
      setBusy(false)
    }
  }

  // No contractors yet. Anybody who may write the contractor register gets to
  // add one HERE rather than being sent to another screen and back — the same
  // inline-create pattern the expense form already uses for vendors. A dead end
  // that tells you to go somewhere else is the wrong answer even when it is
  // accurate.
  const empty = contractors.length === 0

  if (empty && !newContractor) {
    return (
      <section className="paper space-y-3 p-5">
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Log a gang · {date}
        </p>
        <p className="text-sm text-muted-foreground">
          {mayAddContractor
            ? 'No labour contractors on file yet — attendance is logged against one, so add the first.'
            : 'No labour contractors on file yet. Ask the office to add the contractor, then log the gang against them.'}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="ghost" className="h-11" onClick={onCancel}>
            Back
          </Button>
          {mayAddContractor && (
            <Button className="h-11" onClick={() => setNewContractor(true)}>
              <Plus className="size-4" /> Add contractor
            </Button>
          )}
        </div>
      </section>
    )
  }

  if (newContractor) {
    return (
      <QuickContractorForm
        onDone={async (id) => {
          await onContractorAdded()
          setContractorId(id ?? '')
          setNewContractor(false)
        }}
        onCancel={() => setNewContractor(false)}
      />
    )
  }

  return (
    <section className="paper space-y-4 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Log a gang · {date}
      </p>

      <FieldRow label="Contractor" htmlFor="att_contractor">
        <Select
          id="att_contractor"
          value={contractorId}
          onChange={(e) => {
            if (e.target.value === '__new') {
              setNewContractor(true)
              return
            }
            pickContractor(e.target.value)
          }}
        >
          <option value="">Choose…</option>
          {contractors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {mayAddContractor && (
            <option value="__new">+ Add a new contractor…</option>
          )}
        </Select>
      </FieldRow>

      {/* One contractor, several trades. Each line becomes its own attendance
          row, because wage rates are per trade — a lumped row could not be
          priced. */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Trades present</p>

        {lines.map((l) => (
          <div
            key={l.key}
            className="space-y-2 rounded-lg border border-border p-3"
          >
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <Select
                  aria-label="Trade"
                  value={l.trade}
                  onChange={(e) => patch(l.key, { trade: e.target.value })}
                >
                  <option value="">Select a trade…</option>
                  {trades.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </div>
              {lines.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  aria-label="Remove trade"
                  onClick={() =>
                    setLines((ls) => ls.filter((x) => x.key !== l.key))
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min="1"
                value={l.workers}
                onChange={(e) => patch(l.key, { workers: e.target.value })}
                placeholder="Present"
                aria-label={`Workers present${l.trade ? ` — ${l.trade}` : ''}`}
                className="h-12 text-base tabular-nums"
              />
              <Input
                type="number"
                inputMode="decimal"
                step="0.5"
                min="0"
                value={l.ot}
                onChange={(e) => patch(l.key, { ot: e.target.value })}
                placeholder="OT hours"
                aria-label={`Overtime hours${l.trade ? ` — ${l.trade}` : ''}`}
                className="h-12 text-base tabular-nums"
              />
            </div>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          className="h-11 w-full"
          onClick={() => setLines((ls) => [...ls, blankLine()])}
        >
          <Plus className="size-4" /> Add another trade
        </Button>

        {filled.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {totalWorkers} worker{totalWorkers === 1 ? '' : 's'} across{' '}
            {filled.length} trade{filled.length === 1 ? '' : 's'}
            {chosen?.licensed_strength &&
              totalWorkers > chosen.licensed_strength && (
                <span className="ml-1 font-medium text-destructive">
                  · more than {chosen.name}'s licence permits
                </span>
              )}
          </p>
        )}
      </div>

      {/* Area and remarks apply to the whole gang — a contractor's masons and
          helpers are working the same place. Anything genuinely different gets
          its own entry. */}
      <FieldRow label="Work area" htmlFor="att_area">
        <Input
          id="att_area"
          value={area}
          onChange={(e) => setArea(e.target.value)}
          placeholder="Second floor slab"
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Remarks" htmlFor="att_rem">
        <Textarea
          id="att_rem"
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="Optional"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" className="h-12" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button className="h-12" onClick={() => void submit()} disabled={busy}>
          {busy
            ? 'Saving…'
            : filled.length > 1
              ? `Log ${filled.length} trades`
              : 'Log gang'}
        </Button>
      </div>
    </section>
  )
}

/**
 * The minimum needed to log attendance against somebody: a name.
 *
 * Licence number and licensed strength are offered because they are what the
 * register is for and they are usually on the paperwork in front of you — but
 * they are optional, so a missing licence never stops a gang being recorded.
 * The full record (PF/ESI codes, trades, contact) is filled in later under
 * Money → Labour; this form exists so nobody has to leave the screen they are
 * on to get past an empty list.
 */
function QuickContractorForm({
  onDone,
  onCancel,
}: {
  onDone: (id: string | null) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [licence, setLicence] = useState('')
  const [strength, setStrength] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!name.trim()) {
      toast.error("What is the contractor's name?")
      return
    }
    setBusy(true)
    try {
      const id = await createContractor({
        name,
        contact_person: '',
        phone: '',
        licence_no: licence,
        licence_authority: '',
        licence_valid_to: null,
        licensed_strength: strength ? Number(strength) : null,
        pf_code: '',
        esi_code: '',
        gstin: '',
        trades: [],
        notes: '',
      })
      toast.success(`${name.trim()} added`, {
        description: 'Licence expiry and trades can be filled in under Money → Labour.',
      })
      await onDone(id)
    } catch (err) {
      const msg = errText(err) ?? ''
      toast.error(
        msg.includes('labour_contractor_name_uk')
          ? 'A contractor with that name already exists'
          : 'Could not add the contractor',
        { description: msg.includes('labour_contractor_name_uk') ? undefined : msg },
      )
      setBusy(false)
    }
  }

  return (
    <section className="paper space-y-4 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        New labour contractor
      </p>

      <FieldRow label="Name" htmlFor="qc_name">
        <Input
          id="qc_name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ramesh & Co"
          className="h-12 text-base"
          autoFocus
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Licence no" htmlFor="qc_lic" hint="Optional">
          <Input
            id="qc_lic"
            value={licence}
            onChange={(e) => setLicence(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Licensed workers" htmlFor="qc_str" hint="Optional">
          <Input
            id="qc_str"
            type="number"
            inputMode="numeric"
            min="1"
            value={strength}
            onChange={(e) => setStrength(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" className="h-12" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button className="h-12" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving…' : 'Add contractor'}
        </Button>
      </div>
    </section>
  )
}
