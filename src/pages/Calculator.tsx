import { AlertTriangle, Calculator as CalcIcon, ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select } from '@/components/Field'
import { PageHeader } from '@/components/PageHeader'
import { ProjectPicker } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  calcConcrete,
  calcExcavation,
  calcMasonry,
  calcPaint,
  calcPlaster,
  calcSteel,
  calcTiling,
  calcWaterproofing,
  deleteEstimate,
  fetchBbsSteel,
  fetchCalcConstants,
  fetchEstimates,
  fetchEstimateVsActual,
  fetchMasonryUnits,
  fetchMaterialOptions,
  fetchMixes,
  runSelftest,
  saveEstimate,
  setConstant,
  type BbsSteelRow,
  type SelftestRow,
} from '@/lib/queries/calculator'
import {
  AREA_UNIT_LABEL,
  canEditCalcConstants,
  canUseCalculator,
  ESTIMATE_KINDS,
  ESTIMATE_KIND_LABEL,
  LENGTH_UNIT_LABEL,
  toMetres,
  toSqMetres,
  type CalcConstant,
  type CalcMix,
  type CalcResult,
  type EstimateKind,
  type EstimateVsActual,
  type LengthUnit,
  type MasonryUnit,
  type SavedEstimate,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/**
 * M13-A MATERIAL QUANTITY CALCULATOR — a field tool.
 *
 * NOT ONE MULTIPLICATION HAPPENS IN THIS FILE. Every figure is a round trip to
 * an `fn_calc_*` in migration 086 on a 300 ms debounce, which also returns the
 * WORKING printed under the result. That is the 051 decision: a TypeScript copy
 * would be faster and would be the copy nobody re-checks after somebody edits
 * the dry-volume factor.
 *
 * THE UNIT TOGGLE IS A DISPLAY CONCERN AND STOPS AT `toMetres`. Everything
 * crossing to Postgres is metric. A unit switch that reached the database would
 * eventually store a 30 ft wall as 30 m.
 *
 * THERE IS NO MONEY ON THIS SCREEN — no rates, no totals, nothing to hide — so
 * every internal role uses it, supervisors included. The supervisor is the one
 * standing in front of the wall who has to know how many blocks to order.
 */

type Tab = EstimateKind | 'saved' | 'reference'

const DEBOUNCE_MS = 300

export default function Calculator() {
  const role = useAuth((s) => s.role)
  const projectId = useProjects((s) => s.selectedId)
  const [tab, setTab] = useState<Tab>('concrete')
  const [unit, setUnit] = useState<LengthUnit>('m')

  const [mixes, setMixes] = useState<CalcMix[] | null>(null)
  const [units, setUnits] = useState<MasonryUnit[] | null>(null)

  useEffect(() => {
    Promise.allSettled([fetchMixes(), fetchMasonryUnits()]).then(([m, u]) => {
      setMixes(m.status === 'fulfilled' ? m.value : [])
      setUnits(u.status === 'fulfilled' ? u.value : [])
      if (m.status === 'rejected')
        toast.error('Could not load the mix ratios', { description: errText(m.reason) })
    })
  }, [])

  if (!canUseCalculator(role)) {
    return (
      <div className="page-w px-6 py-20 text-center">
        <p className="text-sm text-muted-foreground">
          The calculator isn't available for your role.
        </p>
      </div>
    )
  }

  const tabs: { to: Tab; label: string }[] = [
    ...ESTIMATE_KINDS.map((k) => ({ to: k.value as Tab, label: k.label })),
    { to: 'saved', label: 'Saved' },
    { to: 'reference', label: 'Reference' },
  ]

  return (
    <>
      <PageHeader title="Calculator" />

      <div className="sticky top-[61px] z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="page-w space-y-2 px-4 py-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <ProjectPicker />
            </div>
            <UnitToggle unit={unit} onChange={setUnit} />
          </div>
          <nav className="-mx-1 flex gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <button
                key={t.to}
                type="button"
                onClick={() => setTab(t.to)}
                className={cn(
                  'shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  tab === t.to
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div className="page-w space-y-4 px-4 py-4 pb-8">
        {mixes === null || units === null ? (
          <ListSkeleton rows={4} />
        ) : (
          <>
            {tab === 'concrete' && <ConcreteCalc unit={unit} mixes={mixes} projectId={projectId} />}
            {tab === 'masonry' && <MasonryCalc unit={unit} mixes={mixes} units={units} projectId={projectId} />}
            {tab === 'plaster' && <PlasterCalc unit={unit} mixes={mixes} projectId={projectId} />}
            {tab === 'tiling' && <TilingCalc unit={unit} projectId={projectId} />}
            {tab === 'steel' && <SteelCalc unit={unit} projectId={projectId} />}
            {tab === 'paint' && <PaintCalc unit={unit} projectId={projectId} />}
            {tab === 'waterproofing' && <WaterproofCalc unit={unit} projectId={projectId} />}
            {tab === 'excavation' && <ExcavationCalc unit={unit} projectId={projectId} />}
            {tab === 'saved' && <SavedTab projectId={projectId} />}
            {tab === 'reference' && <ReferenceTab mixes={mixes} units={units} />}
          </>
        )}
      </div>
    </>
  )
}

/* ================= shared bits ================= */

function UnitToggle({
  unit,
  onChange,
}: {
  unit: LengthUnit
  onChange: (u: LengthUnit) => void
}) {
  return (
    <div
      className="flex shrink-0 rounded-lg border border-border p-0.5"
      role="group"
      aria-label="Units"
    >
      {(['m', 'ft'] as LengthUnit[]).map((u) => (
        <button
          key={u}
          type="button"
          onClick={() => onChange(u)}
          aria-pressed={unit === u}
          className={cn(
            'min-w-11 rounded-md px-3 py-2 text-sm font-medium transition-colors',
            unit === u
              ? 'bg-[var(--accent)] text-white'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {u === 'm' ? 'Metres' : 'Feet'}
        </button>
      ))}
    </div>
  )
}

function Num({
  id,
  label,
  value,
  onChange,
  suffix,
  hint,
  step = '0.01',
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  suffix?: string
  hint?: string
  step?: string
}) {
  return (
    <FieldRow label={suffix ? `${label} (${suffix})` : label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-12 text-base tabular-nums"
      />
    </FieldRow>
  )
}

const n = (s: string): number => {
  const v = Number(s)
  return Number.isFinite(v) ? v : 0
}

/**
 * The result card. `working` is collapsed by default — a site phone wants the
 * answer, and the arithmetic is there for the person who disagrees with it.
 */
function ResultCard({
  result,
  busy,
  onSave,
}: {
  result: CalcResult | null
  busy: boolean
  onSave?: () => void
}) {
  const [showWorking, setShowWorking] = useState(false)

  if (busy && !result) return <ListSkeleton rows={2} />
  if (!result) return null

  if (!result.ok) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <span className="text-sm">{result.error}</span>
      </div>
    )
  }

  return (
    <div className={cn('paper p-5 transition-opacity', busy && 'opacity-60')}>
      <ul className="divide-y divide-border">
        {result.lines.map((l) => (
          <li key={l.item} className="flex items-baseline justify-between gap-3 py-2.5">
            <span className={cn('text-sm', !l.orderable && 'text-muted-foreground')}>
              {l.item}
              {!l.orderable && (
                <span className="ml-2 text-[10px] tracking-wider uppercase">working figure</span>
              )}
            </span>
            <span className="shrink-0 font-heading text-lg font-semibold tabular-nums">
              {l.qty.toLocaleString('en-IN', { maximumFractionDigits: 3 })}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">{l.unit}</span>
            </span>
          </li>
        ))}
      </ul>

      {result.warning && (
        <div className="mt-3 flex items-start gap-3 rounded-lg border border-[var(--warning)]/30 bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] px-4 py-3">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-[var(--warning)]"
            aria-hidden="true"
          />
          <span className="text-sm">{result.warning}</span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setShowWorking((s) => !s)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          <ChevronDown
            className={cn('size-4 transition-transform', showWorking && 'rotate-180')}
            aria-hidden="true"
          />
          {showWorking ? 'Hide working' : 'Show working'}
        </button>
        {onSave && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={onSave}>
            Save to project
          </Button>
        )}
      </div>

      {showWorking && (
        <pre className="mt-3 overflow-x-auto rounded-lg bg-secondary/50 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {result.working}
        </pre>
      )}
    </div>
  )
}

/**
 * One debounced round trip per change. Returns the last good result while a new
 * one is in flight, so the numbers do not blink away between keystrokes.
 */
function useCalc<T>(args: T, run: (a: T) => Promise<CalcResult>, ready: boolean) {
  const [result, setResult] = useState<CalcResult | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const key = JSON.stringify(args)

  useEffect(() => {
    if (!ready) {
      setResult(null)
      return
    }
    const mine = ++seq.current
    setBusy(true)
    const t = setTimeout(() => {
      run(JSON.parse(key) as T)
        .then((r) => {
          // Ignore a reply that has been overtaken — otherwise a slow early
          // request can land after a fast later one and show a stale answer.
          if (mine === seq.current) setResult(r)
        })
        .catch((err) => {
          if (mine === seq.current) {
            setResult(null)
            toast.error('Could not calculate', { description: errText(err) })
          }
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  return { result, busy }
}

/* ================= the eight ================= */

function ConcreteCalc({
  unit,
  mixes,
  projectId,
}: {
  unit: LengthUnit
  mixes: CalcMix[]
  projectId: string | null
}) {
  const [l, setL] = useState('4.5')
  const [b, setB] = useState('3.2')
  const [d, setD] = useState(unit === 'ft' ? '0.5' : '0.15')
  const [mix, setMix] = useState('M20')
  const [waste, setWaste] = useState('')
  const [saving, setSaving] = useState(false)

  const concrete = mixes.filter((m) => m.kind === 'concrete')
  const args = {
    length_m: toMetres(n(l), unit),
    width_m: toMetres(n(b), unit),
    depth_m: toMetres(n(d), unit),
    mix,
    wastage_pct: waste === '' ? null : n(waste),
  }
  const { result, busy } = useCalc(args, calcConcrete, n(l) > 0 && n(b) > 0 && n(d) > 0)

  return (
    <Stagger className="space-y-4">
      <RevealItem>
        <div className="paper space-y-4 p-5">
          <h2 className="font-heading text-lg font-semibold">Concrete</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Num id="c-l" label="Length" suffix={LENGTH_UNIT_LABEL[unit]} value={l} onChange={setL} />
            <Num id="c-b" label="Breadth" suffix={LENGTH_UNIT_LABEL[unit]} value={b} onChange={setB} />
            <Num id="c-d" label="Depth" suffix={LENGTH_UNIT_LABEL[unit]} value={d} onChange={setD} />
          </div>
          <FieldRow label="Mix" htmlFor="c-mix">
            <Select id="c-mix" value={mix} onChange={(e) => setMix(e.target.value)} className="h-12 text-base">
              {concrete.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.label}
                  {!m.is_nominal ? ' — not an IS 456 nominal mix' : ''}
                </option>
              ))}
            </Select>
          </FieldRow>
          <Num
            id="c-w"
            label="Wastage"
            suffix="%"
            value={waste}
            onChange={setWaste}
            hint="Leave blank for the firm's default, set on the Reference tab."
          />
        </div>
      </RevealItem>
      <RevealItem>
        <ResultCard
          result={result}
          busy={busy}
          onSave={
            projectId && result?.ok
              ? () => void saveFlow('concrete', result, args, projectId, setSaving)
              : undefined
          }
        />
      </RevealItem>
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
    </Stagger>
  )
}

function MasonryCalc({
  unit,
  mixes,
  units,
  projectId,
}: {
  unit: LengthUnit
  mixes: CalcMix[]
  units: MasonryUnit[]
  projectId: string | null
}) {
  const [area, setArea] = useState('37.5')
  const [thick, setThick] = useState('150')
  const [code, setCode] = useState(units[0]?.code ?? '')
  const [mix, setMix] = useState('CM1:5')
  const [joint, setJoint] = useState('')
  const [waste, setWaste] = useState('')
  const [saving, setSaving] = useState(false)

  const mortar = mixes.filter((m) => m.kind === 'mortar')
  const chosen = units.find((u) => u.code === code)

  // Wall thickness is in MILLIMETRES whatever the unit toggle says — nobody
  // measures a block wall in feet, and 0.492 ft is not a number anybody types.
  const args = {
    area_sqm: toSqMetres(n(area), unit),
    thickness_m: n(thick) / 1000,
    unit_code: code,
    mortar_mix: mix,
    joint_mm: joint === '' ? null : n(joint),
    wastage_pct: waste === '' ? null : n(waste),
  }
  const { result, busy } = useCalc(args, calcMasonry, n(area) > 0 && n(thick) > 0 && code !== '')

  return (
    <Stagger className="space-y-4">
      <RevealItem>
        <div className="paper space-y-4 p-5">
          <h2 className="font-heading text-lg font-semibold">Blockwork &amp; brickwork</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Num id="m-a" label="Wall area" suffix={AREA_UNIT_LABEL[unit]} value={area} onChange={setArea} />
            <Num
              id="m-t"
              label="Wall thickness"
              suffix="mm"
              value={thick}
              onChange={setThick}
              step="5"
              hint="Always millimetres — nobody measures a wall in feet."
            />
          </div>
          <FieldRow label="Unit" htmlFor="m-u">
            <Select id="m-u" value={code} onChange={(e) => setCode(e.target.value)} className="h-12 text-base">
              {units.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.label}
                </option>
              ))}
            </Select>
          </FieldRow>
          {chosen?.note && <p className="text-xs text-muted-foreground">{chosen.note}</p>}
          <div className="grid gap-4 sm:grid-cols-3">
            <FieldRow label="Mortar" htmlFor="m-mix">
              <Select id="m-mix" value={mix} onChange={(e) => setMix(e.target.value)} className="h-12 text-base">
                {mortar.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </FieldRow>
            <Num
              id="m-j"
              label="Joint"
              suffix="mm"
              value={joint}
              onChange={setJoint}
              step="1"
              hint={chosen ? `Default ${chosen.default_joint_mm ?? 10} mm` : undefined}
            />
            <Num id="m-w" label="Wastage" suffix="%" value={waste} onChange={setWaste} />
          </div>
        </div>
      </RevealItem>
      <RevealItem>
        <ResultCard
          result={result}
          busy={busy}
          onSave={
            projectId && result?.ok
              ? () => void saveFlow('masonry', result, args, projectId, setSaving)
              : undefined
          }
        />
      </RevealItem>
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
    </Stagger>
  )
}

function PlasterCalc({
  unit,
  mixes,
  projectId,
}: {
  unit: LengthUnit
  mixes: CalcMix[]
  projectId: string | null
}) {
  const [area, setArea] = useState('86')
  const [thick, setThick] = useState('12')
  const [mix, setMix] = useState('CM1:6')
  const [waste, setWaste] = useState('')
  const [saving, setSaving] = useState(false)
  const mortar = mixes.filter((m) => m.kind === 'mortar')

  const args = {
    area_sqm: toSqMetres(n(area), unit),
    thickness_mm: n(thick),
    mortar_mix: mix,
    wastage_pct: waste === '' ? null : n(waste),
  }
  const { result, busy } = useCalc(args, calcPlaster, n(area) > 0 && n(thick) > 0)

  return (
    <Stagger className="space-y-4">
      <RevealItem>
        <div className="paper space-y-4 p-5">
          <h2 className="font-heading text-lg font-semibold">Plaster</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Num id="p-a" label="Area" suffix={AREA_UNIT_LABEL[unit]} value={area} onChange={setArea} />
            <Num id="p-t" label="Thickness" suffix="mm" value={thick} onChange={setThick} step="1" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow label="Mortar" htmlFor="p-mix">
              <Select id="p-mix" value={mix} onChange={(e) => setMix(e.target.value)} className="h-12 text-base">
                {mortar.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </FieldRow>
            <Num id="p-w" label="Wastage" suffix="%" value={waste} onChange={setWaste} />
          </div>
        </div>
      </RevealItem>
      <RevealItem>
        <ResultCard
          result={result}
          busy={busy}
          onSave={
            projectId && result?.ok
              ? () => void saveFlow('plaster', result, args, projectId, setSaving)
              : undefined
          }
        />
      </RevealItem>
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
    </Stagger>
  )
}

function TilingCalc({ unit, projectId }: { unit: LengthUnit; projectId: string | null }) {
  const [area, setArea] = useState('42.5')
  const [tl, setTl] = useState('600')
  const [tw, setTw] = useState('600')
  const [bed, setBed] = useState('6')
  const [joint, setJoint] = useState('')
  const [waste, setWaste] = useState('')
  const [saving, setSaving] = useState(false)

  const args = {
    area_sqm: toSqMetres(n(area), unit),
    tile_l_mm: n(tl),
    tile_w_mm: n(tw),
    bed_mm: n(bed),
    joint_mm: joint === '' ? null : n(joint),
    wastage_pct: waste === '' ? null : n(waste),
  }
  const { result, busy } = useCalc(args, calcTiling, n(area) > 0 && n(tl) > 0 && n(tw) > 0)

  return (
    <Stagger className="space-y-4">
      <RevealItem>
        <div className="paper space-y-4 p-5">
          <h2 className="font-heading text-lg font-semibold">Tiling</h2>
          <Num id="t-a" label="Area" suffix={AREA_UNIT_LABEL[unit]} value={area} onChange={setArea} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Num id="t-l" label="Tile length" suffix="mm" value={tl} onChange={setTl} step="1" />
            <Num id="t-w" label="Tile width" suffix="mm" value={tw} onChange={setTw} step="1" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Num id="t-b" label="Adhesive bed" suffix="mm" value={bed} onChange={setBed} step="1" />
            <Num id="t-j" label="Joint" suffix="mm" value={joint} onChange={setJoint} step="1" />
            <Num id="t-ws" label="Wastage" suffix="%" value={waste} onChange={setWaste} />
          </div>
        </div>
      </RevealItem>
      <RevealItem>
        <ResultCard
          result={result}
          busy={busy}
          onSave={
            projectId && result?.ok
              ? () => void saveFlow('tiling', result, args, projectId, setSaving)
              : undefined
          }
        />
      </RevealItem>
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
    </Stagger>
  )
}

function SteelCalc({ unit, projectId }: { unit: LengthUnit; projectId: string | null }) {
  const [dia, setDia] = useState('16')
  const [len, setLen] = useState('11.8')
  const [qty, setQty] = useState('24')
  const [bbs, setBbs] = useState<BbsSteelRow[] | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!projectId) {
      setBbs([])
      return
    }
    fetchBbsSteel(projectId).then(setBbs).catch(() => setBbs([]))
  }, [projectId])

  const args = { dia_mm: n(dia), length_m: toMetres(n(len), unit), qty: Math.round(n(qty)) }
  const { result, busy } = useCalc(args, calcSteel, n(dia) > 0 && n(len) > 0 && n(qty) > 0)

  return (
    <Stagger className="space-y-4">
      {/* The BBS already knows the answer for a project that has one. Offering
          it beats asking somebody to re-type a schedule that exists. */}
      {bbs && bbs.length > 0 && (
        <RevealItem>
          <div className="paper p-5">
            <h2 className="font-heading text-lg font-semibold">From the bar bending schedule</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Already computed for this project — no need to re-enter it.
            </p>
            <ul className="mt-3 divide-y divide-border">
              {bbs.map((r) => (
                <li key={r.dia_mm} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="text-sm">
                    {r.dia_mm} mm · {r.total_bars} bars
                  </span>
                  <span className="font-heading text-base font-semibold tabular-nums">
                    {r.total_weight_kg.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">kg</span>
                  </span>
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-3 py-2">
                <span className="text-sm font-medium">Total</span>
                <span className="font-heading text-lg font-semibold tabular-nums">
                  {bbs
                    .reduce((s, r) => s + r.total_tonnes, 0)
                    .toLocaleString('en-IN', { maximumFractionDigits: 3 })}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">t</span>
                </span>
              </li>
            </ul>
          </div>
        </RevealItem>
      )}

      <RevealItem>
        <div className="paper space-y-4 p-5">
          <h2 className="font-heading text-lg font-semibold">Steel by hand</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Num id="s-d" label="Diameter" suffix="mm" value={dia} onChange={setDia} step="1" />
            <Num id="s-l" label="Length each" suffix={LENGTH_UNIT_LABEL[unit]} value={len} onChange={setLen} />
            <Num id="s-q" label="Number of bars" value={qty} onChange={setQty} step="1" />
          </div>
        </div>
      </RevealItem>
      <RevealItem>
        <ResultCard
          result={result}
          busy={busy}
          onSave={
            projectId && result?.ok
              ? () => void saveFlow('steel', result, args, projectId, setSaving)
              : undefined
          }
        />
      </RevealItem>
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
    </Stagger>
  )
}

function PaintCalc({ unit, projectId }: { unit: LengthUnit; projectId: string | null }) {
  const [area, setArea] = useState('210')
  const [coats, setCoats] = useState('2')
  const [cov, setCov] = useState('')
  const [pcov, setPcov] = useState('')
  const [primer, setPrimer] = useState(true)
  const [waste, setWaste] = useState('')
  const [saving, setSaving] = useState(false)

  const args = {
    area_sqm: toSqMetres(n(area), unit),
    coats: Math.round(n(coats)),
    coverage_sqm_l: cov === '' ? null : n(cov),
    primer_coverage_sqm_l: pcov === '' ? null : n(pcov),
    with_primer: primer,
    wastage_pct: waste === '' ? null : n(waste),
  }
  const { result, busy } = useCalc(args, calcPaint, n(area) > 0 && n(coats) > 0)

  return (
    <Stagger className="space-y-4">
      <RevealItem>
        <div className="paper space-y-4 p-5">
          <h2 className="font-heading text-lg font-semibold">Paint</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Num id="pa-a" label="Area" suffix={AREA_UNIT_LABEL[unit]} value={area} onChange={setArea} />
            <Num id="pa-c" label="Coats" value={coats} onChange={setCoats} step="1" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Num
              id="pa-cov"
              label="Coverage"
              suffix="sqm/litre"
              value={cov}
              onChange={setCov}
              hint="Blank uses the default. Read the tin — fresh plaster takes far more."
            />
            <Num id="pa-pc" label="Primer coverage" suffix="sqm/litre" value={pcov} onChange={setPcov} />
          </div>
          <label className="flex items-center gap-3 py-1">
            <input
              type="checkbox"
              checked={primer}
              onChange={(e) => setPrimer(e.target.checked)}
              className="size-5"
            />
            <span className="text-sm">Include one coat of primer</span>
          </label>
          <Num id="pa-w" label="Wastage" suffix="%" value={waste} onChange={setWaste} />
        </div>
      </RevealItem>
      <RevealItem>
        <ResultCard
          result={result}
          busy={busy}
          onSave={
            projectId && result?.ok
              ? () => void saveFlow('paint', result, args, projectId, setSaving)
              : undefined
          }
        />
      </RevealItem>
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
    </Stagger>
  )
}

function WaterproofCalc({ unit, projectId }: { unit: LengthUnit; projectId: string | null }) {
  const [area, setArea] = useState('64')
  const [coats, setCoats] = useState('2')
  const [rate, setRate] = useState('')
  const [waste, setWaste] = useState('')
  const [saving, setSaving] = useState(false)

  const args = {
    area_sqm: toSqMetres(n(area), unit),
    coats: Math.round(n(coats)),
    consumption_kg_sqm: rate === '' ? null : n(rate),
    wastage_pct: waste === '' ? null : n(waste),
  }
  const { result, busy } = useCalc(args, calcWaterproofing, n(area) > 0 && n(coats) > 0)

  return (
    <Stagger className="space-y-4">
      <RevealItem>
        <div className="paper space-y-4 p-5">
          <h2 className="font-heading text-lg font-semibold">Waterproofing</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Num id="w-a" label="Area" suffix={AREA_UNIT_LABEL[unit]} value={area} onChange={setArea} />
            <Num id="w-c" label="Coats" value={coats} onChange={setCoats} step="1" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Num
              id="w-r"
              label="Consumption"
              suffix="kg/sqm/coat"
              value={rate}
              onChange={setRate}
              hint="Blank uses the default for a cementitious slurry."
            />
            <Num id="w-w" label="Wastage" suffix="%" value={waste} onChange={setWaste} />
          </div>
        </div>
      </RevealItem>
      <RevealItem>
        <ResultCard
          result={result}
          busy={busy}
          onSave={
            projectId && result?.ok
              ? () => void saveFlow('waterproofing', result, args, projectId, setSaving)
              : undefined
          }
        />
      </RevealItem>
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
    </Stagger>
  )
}

function ExcavationCalc({ unit, projectId }: { unit: LengthUnit; projectId: string | null }) {
  const [l, setL] = useState('2')
  const [b, setB] = useState('1.5')
  const [d, setD] = useState('1.2')
  const [pits, setPits] = useState('4')
  const [bulk, setBulk] = useState('')
  const [saving, setSaving] = useState(false)

  const args = {
    length_m: toMetres(n(l), unit),
    width_m: toMetres(n(b), unit),
    depth_m: toMetres(n(d), unit),
    pits: Math.round(n(pits)),
    bulking_pct: bulk === '' ? null : n(bulk),
  }
  const { result, busy } = useCalc(
    args,
    calcExcavation,
    n(l) > 0 && n(b) > 0 && n(d) > 0 && n(pits) > 0,
  )

  return (
    <Stagger className="space-y-4">
      <RevealItem>
        <div className="paper space-y-4 p-5">
          <h2 className="font-heading text-lg font-semibold">Excavation</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Num id="e-l" label="Length" suffix={LENGTH_UNIT_LABEL[unit]} value={l} onChange={setL} />
            <Num id="e-b" label="Breadth" suffix={LENGTH_UNIT_LABEL[unit]} value={b} onChange={setB} />
            <Num id="e-d" label="Depth" suffix={LENGTH_UNIT_LABEL[unit]} value={d} onChange={setD} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Num id="e-p" label="Number of pits" value={pits} onChange={setPits} step="1" />
            <Num
              id="e-bk"
              label="Soil bulking"
              suffix="%"
              value={bulk}
              onChange={setBulk}
              hint="Affects the lorry, never the excavation measured for payment."
            />
          </div>
        </div>
      </RevealItem>
      <RevealItem>
        <ResultCard
          result={result}
          busy={busy}
          onSave={
            projectId && result?.ok
              ? () => void saveFlow('excavation', result, args, projectId, setSaving)
              : undefined
          }
        />
      </RevealItem>
      {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
    </Stagger>
  )
}

/* ================= saving ================= */

/**
 * A deliberately plain save. The title is asked for with `prompt` rather than a
 * modal because the estimate is the by-product here — the calculator is the
 * feature, and a three-step dialog between a number and a saved number is how
 * people stop saving.
 */
async function saveFlow(
  kind: EstimateKind,
  result: CalcResult,
  inputs: Record<string, unknown>,
  projectId: string,
  setSaving: (b: boolean) => void,
) {
  const title = window.prompt(
    `Save this ${ESTIMATE_KIND_LABEL[kind].toLowerCase()} estimate as:`,
    '',
  )
  if (title === null) return
  if (title.trim() === '') {
    toast.error('Give the estimate a name')
    return
  }

  setSaving(true)
  try {
    // Map orderable lines onto stock materials by name where one matches, so
    // "Cement" can be compared against what the store actually issued. An
    // unmatched line still saves — it simply cannot be compared.
    const materials = await fetchMaterialOptions()
    const byItem: Record<string, string | null> = {}
    for (const l of result.lines) {
      if (!l.orderable) {
        byItem[l.item] = null
        continue
      }
      const want = l.item.toLowerCase()
      const hit = materials.find(
        (m) =>
          m.name.toLowerCase().includes(want) || want.includes(m.name.toLowerCase()),
      )
      byItem[l.item] = hit?.id ?? null
    }

    await saveEstimate({
      project_id: projectId,
      kind,
      title: title.trim(),
      work_area: '',
      notes: '',
      inputs,
      working: result.working,
      lines: result.lines,
      materialByItem: byItem,
    })
    const mapped = Object.values(byItem).filter(Boolean).length
    toast.success('Estimate saved', {
      description:
        mapped > 0
          ? `${mapped} line${mapped === 1 ? '' : 's'} matched to a stock material and can be compared against what the site consumes.`
          : 'No lines matched a stock material, so this one cannot be compared against issues.',
    })
  } catch (err) {
    toast.error('Could not save the estimate', { description: errText(err) })
  }
  setSaving(false)
}

/* ================= saved + vs actual ================= */

function SavedTab({ projectId }: { projectId: string | null }) {
  const [rows, setRows] = useState<SavedEstimate[] | null>(null)
  const [actual, setActual] = useState<EstimateVsActual[]>([])

  const reload = useCallback(async () => {
    if (!projectId) return
    const [e, a] = await Promise.allSettled([
      fetchEstimates(projectId),
      fetchEstimateVsActual(projectId),
    ])
    if (e.status === 'fulfilled') setRows(e.value)
    else {
      setRows([])
      toast.error('Could not load estimates', { description: errText(e.reason) })
    }
    setActual(a.status === 'fulfilled' ? a.value : [])
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (rows === null) return <ListSkeleton rows={4} />

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CalcIcon}
        title="Nothing saved for this project"
        body="Work something out on any of the tabs and tap Save to project. Saved estimates can then be compared against what the store actually issued."
      />
    )
  }

  return (
    <Stagger className="space-y-4">
      {/* Zero rows when nothing has been estimated — the panel disappears rather
          than showing a table of noughts (073). */}
      {actual.length > 0 && (
        <RevealItem>
          <div className="paper p-5">
            <h2 className="font-heading text-lg font-semibold">Estimated against actual</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Received answers "did we over-order". Issued answers "did we over-use". They are
              different questions, so they are different columns.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                    <th className="pb-2 font-medium">Material</th>
                    <th className="pb-2 text-right font-medium">Estimated</th>
                    <th className="pb-2 text-right font-medium">Received</th>
                    <th className="pb-2 text-right font-medium">Issued</th>
                    <th className="pb-2 text-right font-medium">Variance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {actual.map((r) => (
                    <tr key={r.material_id}>
                      <td className="py-2.5">
                        {r.material_name}
                        <span className="ml-1.5 text-xs text-muted-foreground">{r.unit}</span>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{r.estimated}</td>
                      <td className="py-2.5 text-right tabular-nums">{r.received}</td>
                      <td className="py-2.5 text-right tabular-nums">{r.issued}</td>
                      <td
                        className={cn(
                          'py-2.5 text-right font-medium tabular-nums',
                          r.variance > 0
                            ? 'text-[var(--warning)]'
                            : r.variance < 0
                              ? 'text-muted-foreground'
                              : 'text-[var(--positive)]',
                        )}
                      >
                        {r.variance > 0 ? '+' : ''}
                        {r.variance}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              A positive variance means the site has issued more than was estimated. Only lines
              matched to a stock material appear here.
            </p>
          </div>
        </RevealItem>
      )}

      {rows.map((e) => (
        <RevealItem key={e.id}>
          <SavedCard estimate={e} onChanged={reload} />
        </RevealItem>
      ))}
    </Stagger>
  )
}

function SavedCard({
  estimate: e,
  onChanged,
}: {
  estimate: SavedEstimate
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-base font-semibold">{e.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {ESTIMATE_KIND_LABEL[e.kind]} · {e.created_at.slice(0, 10)}
            {e.created_by_name && ` · ${e.created_by_name}`}
          </p>
        </div>
        <button
          type="button"
          onClick={async () => {
            if (!window.confirm(`Delete "${e.title}"?`)) return
            try {
              await deleteEstimate(e.id)
              toast.success('Deleted')
              await onChanged()
            } catch (err) {
              toast.error('Could not delete it', { description: errText(err) })
            }
          }}
          className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-destructive"
        >
          Delete
        </button>
      </div>

      <ul className="mt-3 divide-y divide-border">
        {e.lines
          .filter((l) => l.is_orderable)
          .map((l) => (
            <li key={l.id} className="flex items-baseline justify-between gap-3 py-2">
              <span className="text-sm">
                {l.item}
                {!l.material_id && (
                  <span className="ml-2 text-[10px] tracking-wider text-muted-foreground uppercase">
                    not matched to stock
                  </span>
                )}
              </span>
              <span className="font-heading text-base font-semibold tabular-nums">
                {l.qty.toLocaleString('en-IN', { maximumFractionDigits: 3 })}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">{l.unit}</span>
              </span>
            </li>
          ))}
      </ul>

      {e.working && (
        <>
          <button
            type="button"
            onClick={() => setOpen((s) => !s)}
            className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            <ChevronDown
              className={cn('size-4 transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
            {open ? 'Hide working' : 'Show working as it was computed'}
          </button>
          {open && (
            <pre className="mt-3 overflow-x-auto rounded-lg bg-secondary/50 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {e.working}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

/* ================= reference ================= */

function ReferenceTab({ mixes, units }: { mixes: CalcMix[]; units: MasonryUnit[] }) {
  const role = useAuth((s) => s.role)
  const mayEdit = canEditCalcConstants(role)
  const [consts, setConsts] = useState<CalcConstant[] | null>(null)
  const [tests, setTests] = useState<SelftestRow[] | null>(null)

  const reload = useCallback(async () => {
    const [c, t] = await Promise.allSettled([fetchCalcConstants(), runSelftest()])
    setConsts(c.status === 'fulfilled' ? c.value : [])
    setTests(t.status === 'fulfilled' ? t.value : [])
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const failing = useMemo(() => (tests ?? []).filter((t) => !t.passed).length, [tests])

  if (consts === null) return <ListSkeleton rows={5} />

  return (
    <Stagger className="space-y-4">
      <RevealItem>
        <div className="paper p-5">
          <h2 className="font-heading text-lg font-semibold">Self-test</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Twelve worked examples re-derived through the same functions the calculator uses. Edit a
            constant below and watch these change — that is what makes editing one safe.
          </p>
          {tests && (
            <p
              className={cn(
                'mt-3 font-heading text-lg font-semibold',
                failing === 0 ? 'text-[var(--positive)]' : 'text-destructive',
              )}
            >
              {tests.length - failing} / {tests.length} passing
            </p>
          )}
          <div className="mt-3 space-y-1.5">
            {(tests ?? []).map((t) => (
              <div
                key={t.case_no}
                className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 text-sm last:border-0"
              >
                <span className={cn(!t.passed && 'text-destructive')}>
                  {t.scenario}
                  <span className="ml-2 text-xs text-muted-foreground">{t.measure}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className="text-muted-foreground">{t.expected}</span>
                  <span className="mx-1.5 text-muted-foreground">→</span>
                  <span className={cn('font-medium', !t.passed && 'text-destructive')}>
                    {t.computed}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </RevealItem>

      <RevealItem>
        <div className="paper p-5">
          <h2 className="font-heading text-lg font-semibold">Constants</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {mayEdit
              ? 'Founder-editable. Every change is audited, and changing one restates every calculator at once.'
              : 'Read-only — a founder edits these.'}
          </p>
          <div className="mt-4 space-y-3">
            {consts.map((c) => (
              <ConstantRow key={c.code} c={c} mayEdit={mayEdit} onSaved={reload} />
            ))}
          </div>
        </div>
      </RevealItem>

      <RevealItem>
        <div className="paper p-5">
          <h2 className="font-heading text-lg font-semibold">Mixes</h2>
          <ul className="mt-3 divide-y divide-border">
            {mixes.map((m) => (
              <li key={m.code} className="py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{m.label}</span>
                  {!m.is_nominal && (
                    <span className="shrink-0 text-[10px] font-semibold tracking-wider text-[var(--warning)] uppercase">
                      not IS 456 nominal
                    </span>
                  )}
                </div>
                {m.note && <p className="mt-0.5 text-xs text-muted-foreground">{m.note}</p>}
              </li>
            ))}
          </ul>
        </div>
      </RevealItem>

      <RevealItem>
        <div className="paper p-5">
          <h2 className="font-heading text-lg font-semibold">Masonry units</h2>
          <ul className="mt-3 divide-y divide-border">
            {units.map((u) => (
              <li key={u.code} className="py-2.5">
                <p className="text-sm font-medium">{u.label}</p>
                {u.note && <p className="mt-0.5 text-xs text-muted-foreground">{u.note}</p>}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Trade names are not consistent about which dimension is which — a block called
            400×200×150 is 200 high, a brick called 230×110×75 is 75 high. The labels above spell it
            out for that reason.
          </p>
        </div>
      </RevealItem>
    </Stagger>
  )
}

function ConstantRow({
  c,
  mayEdit,
  onSaved,
}: {
  c: CalcConstant
  mayEdit: boolean
  onSaved: () => Promise<void>
}) {
  const [v, setV] = useState(String(c.value))
  const [busy, setBusy] = useState(false)
  const dirty = Number(v) !== c.value && v.trim() !== ''

  return (
    <div className="border-b border-border pb-3 last:border-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{c.label}</p>
          {c.note && <p className="mt-0.5 text-xs text-muted-foreground">{c.note}</p>}
          {c.ref && (
            <p className="mt-0.5 text-[11px] tracking-wider text-muted-foreground uppercase">
              {c.ref}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            value={v}
            disabled={!mayEdit}
            onChange={(e) => setV(e.target.value)}
            className="h-11 w-24 text-right text-base tabular-nums"
            aria-label={c.label}
          />
          <span className="w-16 text-xs text-muted-foreground">{c.unit}</span>
        </div>
      </div>
      {mayEdit && dirty && (
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setV(String(c.value))}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await setConstant(c.code, Number(v))
                toast.success('Constant updated', {
                  description: 'Every calculator now uses the new figure. Check the self-test.',
                })
                await onSaved()
              } catch (err) {
                toast.error('Could not update it', { description: errText(err) })
              }
              setBusy(false)
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  )
}
