import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Grid3x3,
  Plus,
  Ruler,
  Trash2,
  Wand2,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { generateBbsPdf } from '@/lib/bbsPdf'
import { errText } from '@/lib/errText'
import {
  addBar,
  applyCallouts,
  createMember,
  deleteBar,
  deleteMember,
  fetchBars,
  fetchConstants,
  fetchGeometry,
  fetchMarkAudit,
  fetchMembers,
  fetchProjectBars,
  fetchShapes,
  fetchSteelByDia,
  previewCallouts,
  previewCuttingLength,
  runSelfTest,
  saveGeometry,
  setConstant,
} from '@/lib/queries/bbs'
import { fetchProject } from '@/lib/queries/projects'
import {
  BAR_DIAMETERS,
  BBS_MEMBER_LABEL,
  BBS_MEMBER_TYPES,
  type BbsBar,
  type BbsCalloutLine,
  type BbsConstant,
  type BbsGeometry,
  type BbsMember,
  type BbsMemberType,
  type BbsShape,
  type BbsSteelByDia,
  type BbsTestCase,
  canEditBbs,
  canEditBbsConstants,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

type Tab = 'schedule' | 'steel' | 'rules'

const kg = (v: number) =>
  new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v)

/**
 * Bar Bending Schedule — IS 2502.
 *
 * The module computes cutting lengths and weights from what the structural
 * drawing says. It does not decide how many bars a member needs or where the
 * cranks go: that is design, and software guessing at it would be doing
 * engineering it is not qualified to do. What it does is the arithmetic, which
 * is where the errors actually happen.
 *
 * Nothing here calculates. Every length, weight and total on this screen is a
 * figure Postgres produced, including the working shown under each bar — that
 * string comes out of the same call as the number it explains, so the two
 * cannot drift apart.
 */
export default function Bbs() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayEdit = canEditBbs(role)

  const [tab, setTab] = useState<Tab>('schedule')
  const [members, setMembers] = useState<BbsMember[] | null>(null)
  const [steel, setSteel] = useState<BbsSteelByDia[]>([])
  const [shapes, setShapes] = useState<BbsShape[]>([])
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const [m, s] = await Promise.all([
        fetchMembers(projectId),
        fetchSteelByDia(projectId).catch(() => [] as BbsSteelByDia[]),
      ])
      setMembers(m)
      setSteel(s)
    } catch (err) {
      toast.error('Could not load the bar schedule', {
        description: errText(err),
      })
      setMembers([])
    }
  }, [projectId])

  useEffect(() => {
    setMembers(null)
    void reload()
    void fetchShapes()
      .then(setShapes)
      .catch(() => setShapes([]))
  }, [reload])

  if (!projectId || members === null) return <ListSkeleton rows={5} />

  const grandTotal = steel.reduce((a, s) => a + s.total_weight_kg, 0)
  const warnings = members.reduce((a, m) => a + m.warnings, 0)

  return (
    <div className="space-y-4 pb-6">
      <SummaryCard
        members={members.length}
        grandTotal={grandTotal}
        warnings={warnings}
      />

      <div className="flex gap-1">
        {(
          [
            ['schedule', 'Schedule'],
            ['steel', 'Steel'],
            ['rules', 'IS rules'],
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

      {tab === 'schedule' && (
        <>
          {mayEdit && !adding && (
            <Button
              className="h-12 w-full text-base"
              onClick={() => setAdding(true)}
            >
              <Plus className="size-4" /> Add member
            </Button>
          )}

          {adding && projectId && (
            <MemberForm
              projectId={projectId}
              onDone={async () => {
                setAdding(false)
                await reload()
              }}
            />
          )}

          {members.length === 0 && !adding && (
            <>
              <EmptyState
                icon={Ruler}
                title="No bar schedule yet"
                body="Add a member — a footing, column, beam or slab — then list its bar marks off the drawing."
                actionLabel={mayEdit ? 'Add the first member' : undefined}
                onAction={mayEdit ? () => setAdding(true) : undefined}
              />
              <OtherProjectsHint />
            </>
          )}

          {members.length > 0 && (
            <Stagger className="space-y-3">
              {members.map((m) => (
                <RevealItem key={m.member_id}>
                  <MemberCard
                    member={m}
                    shapes={shapes}
                    mayEdit={mayEdit}
                    onChanged={reload}
                  />
                </RevealItem>
              ))}
            </Stagger>
          )}

          {members.length > 0 && (
            <PrintButton projectId={projectId} members={members} steel={steel} />
          )}
        </>
      )}

      {tab === 'steel' && <SteelTab steel={steel} grandTotal={grandTotal} />}

      {tab === 'rules' && <RulesTab mayEdit={canEditBbsConstants(role)} />}
    </div>
  )
}

/* ---------------- summary ---------------- */

function SummaryCard({
  members,
  grandTotal,
  warnings,
}: {
  members: number
  grandTotal: number
  warnings: number
}) {
  return (
    <section className="paper p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Bar bending schedule
        </h2>
        <span className="text-[11px] text-muted-foreground">IS 2502</span>
      </div>

      {warnings > 0 && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
          {warnings} bar {warnings === 1 ? 'mark has' : 'marks have'} an
          impossible cutting length. Check the dimensions before anyone cuts.
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-5">
        <div>
          <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
            Total steel
          </p>
          <p className="figure mt-1 text-[26px] leading-none font-semibold">
            {kg(grandTotal)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              kg
            </span>
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {(grandTotal / 1000).toFixed(3)} t · excludes wastage and laps
          </p>
        </div>
        <div>
          <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
            Members
          </p>
          <p className="figure mt-1 text-[26px] leading-none font-semibold">
            {members}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            scheduled off the drawings
          </p>
        </div>
      </div>
    </section>
  )
}

/* ---------------- member ---------------- */

function MemberCard({
  member,
  shapes,
  mayEdit,
  onChanged,
}: {
  member: BbsMember
  shapes: BbsShape[]
  mayEdit: boolean
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [bars, setBars] = useState<BbsBar[] | null>(null)
  const [addingBar, setAddingBar] = useState(false)

  const loadBars = useCallback(async () => {
    try {
      setBars(await fetchBars(member.member_id))
    } catch {
      setBars([])
    }
  }, [member.member_id])

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && bars === null) await loadBars()
  }

  return (
    <article className="paper p-5">
      <button
        type="button"
        onClick={() => void toggle()}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="font-heading text-[17px] font-semibold">
            {member.mark}
            {member.warnings > 0 && (
              <AlertTriangle className="ml-1.5 inline size-4 text-destructive" />
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {BBS_MEMBER_LABEL[member.member_type]}
            {member.description && ` · ${member.description}`}
            {' · '}
            {member.member_count} no{member.member_count === 1 ? '' : 's'} ·{' '}
            {member.bar_marks} bar {member.bar_marks === 1 ? 'mark' : 'marks'}
          </p>
        </div>
        <span className="figure shrink-0 text-sm font-semibold">
          {kg(member.total_weight_kg)} kg
        </span>
      </button>

      {open && (
        <div className="mt-4 border-t border-border pt-4">
          {bars === null ? (
            <p className="text-sm text-muted-foreground">Loading bars…</p>
          ) : bars.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No bar marks yet on this member.
            </p>
          ) : (
            <ul className="space-y-3">
              {bars.map((b) => (
                <BarRow
                  key={b.bar_id}
                  bar={b}
                  mayEdit={mayEdit}
                  onChanged={async () => {
                    await loadBars()
                    await onChanged()
                  }}
                />
              ))}
            </ul>
          )}

          {mayEdit && (
            <div className="mt-4 space-y-2">
              <CalloutPanel
                memberId={member.member_id}
                mark={member.mark}
                onApplied={async () => {
                  await loadBars()
                  await onChanged()
                }}
              />

              {addingBar ? (
                <BarForm
                  memberId={member.member_id}
                  shapes={shapes}
                  nextOrder={((bars?.length ?? 0) + 1) * 10}
                  onDone={async () => {
                    setAddingBar(false)
                    await loadBars()
                    await onChanged()
                  }}
                  onCancel={() => setAddingBar(false)}
                />
              ) : (
                <Button
                  variant="outline"
                  className="h-11 w-full"
                  onClick={() => setAddingBar(true)}
                >
                  <Plus className="size-4" /> Add bar mark
                </Button>
              )}

              <Button
                variant="ghost"
                className="h-11 w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={async () => {
                  try {
                    await deleteMember(member.member_id)
                    toast.success(`${member.mark} removed`)
                    await onChanged()
                  } catch (err) {
                    toast.error('Could not remove the member', {
                      description: errText(err),
                    })
                  }
                }}
              >
                Delete {member.mark}
              </Button>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function BarRow({
  bar,
  mayEdit,
  onChanged,
}: {
  bar: BbsBar
  mayEdit: boolean
  onChanged: () => Promise<void>
}) {
  const [showWorking, setShowWorking] = useState(false)

  const dims = [bar.a_mm, bar.b_mm, bar.c_mm, bar.d_mm]
    .filter((v) => v > 0)
    .join(' / ')

  return (
    <li
      className={cn(
        'rounded-lg border border-border p-3',
        bar.warning && 'border-destructive/40 bg-destructive/5',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {bar.bar_mark}
            <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
              Ø{bar.dia_mm}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {bar.shape_name} · {dims} mm
            {bar.n_cranks > 0 && ` · ${bar.n_cranks} crank`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold tabular-nums">
            {bar.cutting_length_mm.toFixed(0)}{' '}
            <span className="text-xs font-normal text-muted-foreground">mm</span>
          </p>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            × {bar.total_qty} = {kg(bar.total_weight_kg)} kg
          </p>
        </div>
      </div>

      {bar.warning && (
        <p className="mt-2 text-xs font-medium text-destructive">
          {bar.warning}
        </p>
      )}

      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setShowWorking((v) => !v)}
          className="min-h-8 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          {showWorking ? 'Hide working' : 'Show working'}
        </button>
        {mayEdit && (
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Remove ${bar.bar_mark}`}
            onClick={async () => {
              try {
                await deleteBar(bar.bar_id)
                toast.success('Bar mark removed')
                await onChanged()
              } catch (err) {
                toast.error('Could not remove the bar', {
                  description: errText(err),
                })
              }
            }}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      {/* The working comes out of the same server call as the number above it,
          so it cannot describe a different calculation. */}
      {showWorking && bar.working && (
        <p className="mt-2 rounded bg-secondary/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {bar.working}
          <br />= {bar.cutting_length_mm.toFixed(2)} mm ·{' '}
          {bar.unit_weight_kg_m.toFixed(4)} kg/m ({bar.dia_mm}² ÷ 162)
        </p>
      )}
    </li>
  )
}

/* ---------------- callout expansion ---------------- */

const CALLOUT_PLACEHOLDER = `4-Y16 BOTTOM
2-Y12 TOP
2-Y16 CRANK
Y8 @150 STIRRUP`

/**
 * Type what the drawing says; the machine does the counting and the geometry.
 *
 * This is deliberately NOT "upload the drawing and let it read it". Extracting
 * reinforcement from a drawing image needs a vision model, which would be
 * confidently wrong some of the time — and a plausible bar schedule nobody
 * checks is the worst thing this module could produce, because the error stops
 * being visible the moment the concrete is poured. Here nothing is inferred
 * that the engineer did not write down.
 *
 * The preview runs the SAME parser as the apply, so it cannot promise bars the
 * apply would not create.
 */
function CalloutPanel({
  memberId,
  mark,
  onApplied,
}: {
  memberId: string
  mark: string
  onApplied: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [geom, setGeom] = useState<BbsGeometry | null>(null)
  const [text, setText] = useState('')
  const [lines, setLines] = useState<BbsCalloutLine[]>([])
  const [busy, setBusy] = useState(false)
  const [savingGeom, setSavingGeom] = useState(false)

  useEffect(() => {
    if (!open) return
    void fetchGeometry(memberId)
      .then((g) => {
        setGeom(g)
        if (g?.callout_text) setText(g.callout_text)
      })
      .catch(() => setGeom(null))
  }, [open, memberId])

  useEffect(() => {
    if (!open || !text.trim()) {
      setLines([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void previewCallouts(memberId, text)
        .then((r) => {
          if (!cancelled) setLines(r)
        })
        .catch(() => {
          if (!cancelled) setLines([])
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, memberId, text])

  const bad = lines.filter((l) => !l.ok)
  const good = lines.filter((l) => l.ok)

  if (!open) {
    return (
      <Button
        variant="outline"
        className="h-11 w-full"
        onClick={() => setOpen(true)}
      >
        <Wand2 className="size-4" /> Expand from callouts
      </Button>
    )
  }

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Expand from callouts
        </p>
        <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      {geom && (
        <GeometryFields
          geom={geom}
          onChange={setGeom}
          busy={savingGeom}
          onSave={async () => {
            setSavingGeom(true)
            try {
              await saveGeometry(memberId, geom)
              toast.success('Dimensions saved')
              // Re-preview: the callouts measure from these.
              if (text.trim()) setLines(await previewCallouts(memberId, text))
            } catch (err) {
              toast.error('Could not save the dimensions', {
                description: errText(err),
              })
            }
            setSavingGeom(false)
          }}
        />
      )}

      <FieldRow
        label="Callouts"
        htmlFor="callouts"
        hint="One per line, as written on the section. 4-Y16 BOTTOM · Y8 @150 STIRRUP · 2-Y16 CRANK. Lines starting with -- are ignored."
      >
        <Textarea
          id="callouts"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={CALLOUT_PLACEHOLDER}
          className="min-h-32 font-mono text-sm"
        />
      </FieldRow>

      {bad.length > 0 && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2.5">
          <p className="text-xs font-medium text-destructive">
            {bad.length} line{bad.length === 1 ? '' : 's'} cannot be read. The
            whole expansion is refused until they are fixed — a schedule missing
            a callout is short of steel with nothing to show which.
          </p>
          <ul className="mt-2 space-y-1">
            {bad.map((l) => (
              <li key={l.line_no} className="text-[11px] text-destructive">
                <span className="font-mono">{l.source_line}</span> — {l.problem}
              </li>
            ))}
          </ul>
        </div>
      )}

      {good.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Preview — {good.length} bar {good.length === 1 ? 'mark' : 'marks'}
          </p>
          <ul className="space-y-1.5">
            {good.map((l) => (
              <li
                key={l.line_no}
                className="rounded bg-secondary/50 px-2.5 py-2 text-xs"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {l.bar_mark} · {l.qty} × Ø{l.dia_mm}
                  </span>
                  <span className="tabular-nums">
                    {l.cutting_length_mm?.toFixed(0)} mm
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {l.shape_code}
                  {l.a_mm > 0 && ` · A ${l.a_mm}`}
                  {l.b_mm > 0 && ` · B ${l.b_mm}`}
                  {l.remarks && ` · ${l.remarks}`}
                </p>
                {l.warning && (
                  <p className="mt-0.5 text-[11px] font-medium text-destructive">
                    {l.warning}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button
        className="h-12 w-full"
        disabled={busy || good.length === 0 || bad.length > 0}
        onClick={async () => {
          setBusy(true)
          try {
            const count = await applyCallouts(memberId, text)
            toast.success(`${count} bar marks written to ${mark}`, {
              description:
                'Bars added by hand are untouched — only a previous expansion is replaced.',
            })
            await onApplied()
          } catch (err) {
            toast.error('Could not expand the callouts', {
              description: errText(err),
            })
          }
          setBusy(false)
        }}
      >
        {busy
          ? 'Expanding…'
          : `Create ${good.length} bar mark${good.length === 1 ? '' : 's'}`}
      </Button>
    </section>
  )
}

function GeometryFields({
  geom,
  onChange,
  onSave,
  busy,
}: {
  geom: BbsGeometry
  onChange: (g: BbsGeometry) => void
  onSave: () => Promise<void>
  busy: boolean
}) {
  const set = (k: keyof BbsGeometry, v: string) =>
    onChange({ ...geom, [k]: v === '' ? null : Number(v) })

  const field = (
    label: string,
    key: keyof BbsGeometry,
    id: string,
    hint?: string,
  ) => (
    <FieldRow label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        value={(geom[key] as number | null) ?? ''}
        onChange={(e) => set(key, e.target.value)}
        placeholder="mm"
        className="h-11 text-base tabular-nums"
      />
    </FieldRow>
  )

  return (
    <div className="space-y-3 rounded-lg bg-secondary/40 p-3">
      <p className="text-[11px] text-muted-foreground">
        The callouts measure from these. Everything in millimetres.
      </p>

      <div className="grid grid-cols-3 gap-2">
        {field('Length', 'length_mm', 'g_len')}
        {geom.is_circular
          ? field('Diameter', 'diameter_mm', 'g_dia')
          : field('Width', 'width_mm', 'g_w')}
        {!geom.is_circular && field('Depth', 'depth_mm', 'g_d')}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {field('Clear cover', 'cover_mm', 'g_cov')}
        {/* Defaults to zero on purpose: development length depends on steel and
            concrete grade, bond condition and the designer's detail, and it is
            on the drawing. A "sensible" default would be the app quietly
            designing the joint. */}
        {field(
          'Anchorage / end',
          'anchorage_mm',
          'g_anch',
          'From the drawing. Leave 0 if the bar stops at the cover line.',
        )}
      </div>

      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={geom.is_circular}
          onChange={(e) =>
            onChange({ ...geom, is_circular: e.target.checked })
          }
          className="size-4"
        />
        Circular column (ties become circular)
      </label>

      <Button
        variant="outline"
        size="sm"
        className="h-10 w-full"
        disabled={busy}
        onClick={() => void onSave()}
      >
        {busy ? 'Saving…' : 'Save dimensions'}
      </Button>
    </div>
  )
}

/* ---------------- forms ---------------- */

function MemberForm({
  projectId,
  onDone,
}: {
  projectId: string
  onDone: () => Promise<void>
}) {
  const [type, setType] = useState<BbsMemberType>('beam')
  const [mark, setMark] = useState('')
  const [description, setDescription] = useState('')
  const [level, setLevel] = useState('')
  const [drawing, setDrawing] = useState('')
  const [count, setCount] = useState('1')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!mark.trim()) {
      toast.error('Give the member its mark from the drawing (B1, C2, F3…)')
      return
    }
    setBusy(true)
    try {
      await createMember({
        project_id: projectId,
        member_type: type,
        mark,
        description,
        level,
        drawing_ref: drawing,
        member_count: Math.max(1, Number(count) || 1),
        notes: '',
        // Geometry is filled in on the member's own card, next to the callouts
        // that measure from it — asking for six dimensions before the member
        // exists is how a form gets abandoned half-filled.
        length_mm: null,
        width_mm: null,
        depth_mm: null,
        cover_mm: 25,
        anchorage_mm: 0,
        is_circular: false,
        diameter_mm: null,
      })
      toast.success(`${mark.trim()} added`)
      await onDone()
    } catch (err) {
      toast.error('Could not add the member', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <section className="paper space-y-4 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        New member
      </p>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Type" htmlFor="bbs_type">
          <Select
            id="bbs_type"
            value={type}
            onChange={(e) => setType(e.target.value as BbsMemberType)}
          >
            {BBS_MEMBER_TYPES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="Mark" htmlFor="bbs_mark">
          <Input
            id="bbs_mark"
            value={mark}
            onChange={(e) => setMark(e.target.value)}
            placeholder="B1"
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      <FieldRow label="Description" htmlFor="bbs_desc">
        <Input
          id="bbs_desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="300 × 450 plinth beam"
          className="h-12 text-base"
        />
      </FieldRow>

      <div className="grid grid-cols-3 gap-2">
        <FieldRow label="Level" htmlFor="bbs_level">
          <Input
            id="bbs_level"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            placeholder="GF"
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Drawing" htmlFor="bbs_dwg">
          <Input
            id="bbs_dwg"
            value={drawing}
            onChange={(e) => setDrawing(e.target.value)}
            placeholder="S-04"
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow
          label="Nos"
          htmlFor="bbs_count"
          hint="Identical members"
        >
          <Input
            id="bbs_count"
            type="number"
            inputMode="numeric"
            min="1"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
      </div>

      <Button className="h-12 w-full" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Adding…' : 'Add member'}
      </Button>
    </section>
  )
}

function BarForm({
  memberId,
  shapes,
  nextOrder,
  onDone,
  onCancel,
}: {
  memberId: string
  shapes: BbsShape[]
  nextOrder: number
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [barMark, setBarMark] = useState('')
  const [dia, setDia] = useState('12')
  const [shapeCode, setShapeCode] = useState(shapes[0]?.code ?? 'STR')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [c, setC] = useState('')
  const [d, setD] = useState('')
  const [cranks, setCranks] = useState('0')
  const [qty, setQty] = useState('1')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{
    cutting_length_mm: number
    working: string
    warning: string | null
    error: string | null
  } | null>(null)

  const shape = useMemo(
    () => shapes.find((s) => s.code === shapeCode) ?? null,
    [shapes, shapeCode],
  )

  useEffect(() => {
    if (shapes.length > 0 && !shapes.some((s) => s.code === shapeCode)) {
      setShapeCode(shapes[0].code)
    }
  }, [shapes, shapeCode])

  // Live preview, computed by the SAME server function the saved schedule uses.
  // Deliberately not reimplemented in TypeScript: two copies of a safety-
  // critical formula is one more than can be kept in step, and the browser copy
  // is the one nobody re-checks after a constant changes.
  useEffect(() => {
    const dNum = Number(dia)
    if (!shapeCode || !dNum) {
      setPreview(null)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void previewCuttingLength({
        shape: shapeCode,
        dia: dNum,
        a: Number(a) || 0,
        b: Number(b) || 0,
        c: Number(c) || 0,
        d: Number(d) || 0,
        cranks: Number(cranks) || 0,
      })
        .then((r) => {
          if (!cancelled) setPreview(r)
        })
        .catch(() => {
          if (!cancelled) setPreview(null)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [shapeCode, dia, a, b, c, d, cranks])

  async function submit() {
    if (!barMark.trim()) {
      toast.error('Give the bar its mark')
      return
    }
    setBusy(true)
    try {
      await addBar({
        member_id: memberId,
        bar_mark: barMark,
        dia_mm: Number(dia),
        shape_code: shapeCode,
        a_mm: Number(a) || 0,
        b_mm: Number(b) || 0,
        c_mm: Number(c) || 0,
        d_mm: Number(d) || 0,
        n_cranks: Number(cranks) || 0,
        qty_per_member: Math.max(1, Number(qty) || 1),
        remarks,
        sort_order: nextOrder,
      })
      toast.success('Bar mark added')
      await onDone()
    } catch (err) {
      toast.error('Could not add the bar', { description: errText(err) })
      setBusy(false)
    }
  }

  const legField = (
    label: string | null,
    value: string,
    set: (v: string) => void,
    id: string,
  ) =>
    label ? (
      <FieldRow key={id} label={label} htmlFor={id}>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => set(e.target.value)}
          placeholder="mm"
          className="h-12 text-base tabular-nums"
        />
      </FieldRow>
    ) : null

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        New bar mark
      </p>

      <div className="grid grid-cols-3 gap-2">
        <FieldRow label="Mark" htmlFor="bar_mark">
          <Input
            id="bar_mark"
            value={barMark}
            onChange={(e) => setBarMark(e.target.value)}
            placeholder="B1-1"
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Dia (mm)" htmlFor="bar_dia">
          <Select
            id="bar_dia"
            value={dia}
            onChange={(e) => setDia(e.target.value)}
          >
            {BAR_DIAMETERS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </FieldRow>
        <FieldRow label="Nos" htmlFor="bar_qty" hint="per member">
          <Input
            id="bar_qty"
            type="number"
            inputMode="numeric"
            min="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
      </div>

      <FieldRow label="Shape" htmlFor="bar_shape" hint={shape?.formula}>
        <Select
          id="bar_shape"
          value={shapeCode}
          onChange={(e) => setShapeCode(e.target.value)}
        >
          {shapes.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </Select>
      </FieldRow>

      {/* Field labels come from the shape row, so nobody has to guess whether
          B is the second leg or the crank rise. */}
      <div className="grid grid-cols-2 gap-2">
        {legField(shape?.label_a ?? 'A', a, setA, 'bar_a')}
        {legField(shape?.label_b ?? null, b, setB, 'bar_b')}
        {legField(shape?.label_c ?? null, c, setC, 'bar_c')}
        {legField(shape?.label_d ?? null, d, setD, 'bar_d')}
        {shape?.formula_kind === 'crank' && (
          <FieldRow label="Number of cranks" htmlFor="bar_cranks">
            <Input
              id="bar_cranks"
              type="number"
              inputMode="numeric"
              min="0"
              value={cranks}
              onChange={(e) => setCranks(e.target.value)}
              className="h-12 text-base tabular-nums"
            />
          </FieldRow>
        )}
      </div>

      {preview && (
        <div
          className={cn(
            'rounded-lg px-3 py-2.5',
            preview.warning || preview.error
              ? 'bg-destructive/10'
              : 'bg-secondary/60',
          )}
        >
          {preview.error ? (
            <p className="text-sm font-medium text-destructive">
              {preview.error}
            </p>
          ) : (
            <>
              <p className="text-sm">
                Cutting length{' '}
                <span
                  className={cn(
                    'figure font-semibold',
                    preview.warning && 'text-destructive',
                  )}
                >
                  {preview.cutting_length_mm.toFixed(2)} mm
                </span>
              </p>
              <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {preview.working}
              </p>
              {preview.warning && (
                <p className="mt-1 text-xs font-medium text-destructive">
                  {preview.warning}
                </p>
              )}
            </>
          )}
        </div>
      )}

      <FieldRow label="Remarks" htmlFor="bar_rem">
        <Textarea
          id="bar_rem"
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="Top steel, extra at support…"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" className="h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          className="h-11"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? 'Adding…' : 'Add bar'}
        </Button>
      </div>
    </section>
  )
}

/* ---------------- steel summary ---------------- */

function SteelTab({
  steel,
  grandTotal,
}: {
  steel: BbsSteelByDia[]
  grandTotal: number
}) {
  if (steel.length === 0) {
    return (
      <EmptyState
        icon={Grid3x3}
        title="No steel scheduled yet"
        body="Add bar marks to a member and the totals by diameter appear here."
      />
    )
  }

  return (
    <section className="paper overflow-x-auto p-0">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            {['Dia', 'Nos', 'Length (m)', 'kg/m', 'Weight (kg)', '12m pcs'].map((h, i) => (
              <th
                key={h}
                className={cn(
                  'px-4 py-3 text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase',
                  i === 0 ? 'text-left' : 'text-right',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {steel.map((s) => (
            <tr key={s.dia_mm} className="border-b border-border/60">
              <td className="px-4 py-3 font-medium">Ø{s.dia_mm}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {s.total_bars}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {s.total_length_m.toFixed(3)}
              </td>
              <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">
                {s.unit_weight_kg_m.toFixed(4)}
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums">
                {kg(s.total_weight_kg)}
              </td>
              {/* What actually gets ordered. A straight ceiling of the total
                  length — NOT a cutting optimisation, so offcuts are still on
                  top of it. */}
              <td className="px-4 py-3 text-right tabular-nums">
                {s.pieces_required}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border">
            <td className="px-4 py-3 text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
              Total
            </td>
            <td colSpan={3} />
            <td className="figure px-4 py-3 text-right text-base font-semibold">
              {kg(grandTotal)}
            </td>
            <td className="px-4 py-3 text-right tabular-nums">
              {steel.reduce((a, s) => a + s.pieces_required, 0)}
            </td>
          </tr>
        </tfoot>
      </table>
      <p className="px-4 pt-1 pb-4 text-[11px] text-muted-foreground">
        {(grandTotal / 1000).toFixed(3)} tonnes. The piece count is a straight
        ceiling of the total length, not a cutting optimisation — offcuts and
        laps are still on top of it.
      </p>
    </section>
  )
}

/* ---------------- IS rules + self-test ---------------- */

function RulesTab({ mayEdit }: { mayEdit: boolean }) {
  const [constants, setConstants] = useState<BbsConstant[] | null>(null)
  const [tests, setTests] = useState<BbsTestCase[] | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    try {
      setConstants(await fetchConstants())
    } catch {
      setConstants([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function selfTest() {
    setRunning(true)
    try {
      const r = await runSelfTest()
      setTests(r)
      const failed = r.filter((t) => !t.passed).length
      if (failed === 0) {
        toast.success(`All ${r.length} test cases match IS 2502`)
      } else {
        toast.error(`${failed} of ${r.length} test cases FAILED`, {
          description: 'A constant has been changed away from the IS value.',
        })
      }
    } catch (err) {
      toast.error('Could not run the self-test', { description: errText(err) })
    }
    setRunning(false)
  }

  if (constants === null) return <ListSkeleton rows={4} />

  return (
    <div className="space-y-4">
      <section className="paper p-5">
        <h3 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          IS 2502 constants
        </h3>
        <p className="mt-2 text-xs text-muted-foreground">
          Every cutting length in this project is computed from these figures.
          Change one and every schedule in the database is restated — which is
          why only the founder may, why each edit is written to the audit log,
          and why the self-test below exists.
        </p>

        <ul className="mt-4 space-y-3">
          {constants.map((c) => (
            <ConstantRow
              key={c.code}
              c={c}
              mayEdit={mayEdit}
              onChanged={load}
            />
          ))}
        </ul>
      </section>

      <section className="paper p-5">
        <h3 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Self-test
        </h3>
        <p className="mt-2 text-xs text-muted-foreground">
          Eight worked examples with known IS-2502 answers, run inside Postgres
          by the same function the schedule uses. Run it after changing anything
          above.
        </p>

        <Button
          variant="outline"
          className="mt-4 h-11 w-full"
          disabled={running}
          onClick={() => void selfTest()}
        >
          {running ? 'Running…' : 'Run the test cases'}
        </Button>

        {tests && (
          <ul className="mt-4 space-y-2">
            {tests.map((t) => (
              <li
                key={t.case_no}
                className={cn(
                  'rounded-lg border p-3',
                  t.passed
                    ? 'border-border'
                    : 'border-destructive/40 bg-destructive/5',
                )}
              >
                <div className="flex items-start gap-2">
                  {t.passed ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--positive)]" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t.case_name}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {t.hand_working}
                    </p>
                    <p
                      className={cn(
                        'mt-1 text-xs tabular-nums',
                        t.passed
                          ? 'text-muted-foreground'
                          : 'font-medium text-destructive',
                      )}
                    >
                      expected {t.expected_mm} · computed {t.computed_mm} · diff{' '}
                      {t.diff_mm}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ConstantRow({
  c,
  mayEdit,
  onChanged,
}: {
  c: BbsConstant
  mayEdit: boolean
  onChanged: () => Promise<void>
}) {
  const [value, setValue] = useState(String(c.value))
  const [busy, setBusy] = useState(false)
  const dirty = Number(value) !== c.value

  return (
    <li className="border-b border-border/60 pb-3 last:border-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{c.label}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {c.is_ref && `${c.is_ref} · `}
            {c.note}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {mayEdit ? (
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label={c.label}
              className="h-10 w-24 text-right text-sm tabular-nums"
            />
          ) : (
            <span className="text-sm font-semibold tabular-nums">{c.value}</span>
          )}
          <span className="w-16 text-[10px] text-muted-foreground">
            {c.unit}
          </span>
        </div>
      </div>

      {mayEdit && dirty && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setValue(String(c.value))}
          >
            Reset
          </Button>
          <Button
            size="xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await setConstant(c.code, Number(value))
                toast.success(`${c.label} updated`, {
                  description:
                    'Every schedule has been restated. Run the self-test.',
                })
                await onChanged()
              } catch (err) {
                toast.error('Could not update the constant', {
                  description: errText(err),
                })
              }
              setBusy(false)
            }}
          >
            Save
          </Button>
        </div>
      )}
    </li>
  )
}

/* ---------------- print ---------------- */

function PrintButton({
  projectId,
  members,
  steel,
}: {
  projectId: string
  members: BbsMember[]
  steel: BbsSteelByDia[]
}) {
  const [busy, setBusy] = useState(false)

  async function print() {
    setBusy(true)
    try {
      const [bars, project, constants, marks] = await Promise.all([
        fetchProjectBars(projectId),
        fetchProject(projectId),
        fetchConstants(),
        fetchMarkAudit(projectId),
      ])

      // The schedule states which constants it was cut to. A BBS that does not
      // say its hook allowance cannot be checked a year later.
      const note =
        'Constants in force: ' +
        constants
          .map((c) => `${c.code}=${c.value}`)
          .join(', ')

      generateBbsPdf({
        members,
        bars,
        steel,
        projectName: project?.name ?? '',
        siteAddress: project?.site_address ?? null,
        constantsNote: note,
        lastMark: marks?.last_mark ?? null,
        omittedMarks: marks?.omitted ?? null,
      })
    } catch (err) {
      toast.error('Could not build the schedule', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <Button
      variant="outline"
      className="h-12 w-full"
      disabled={busy}
      onClick={() => void print()}
    >
      <Download className="size-4" />
      {busy ? 'Building…' : 'Printable BBS'}
    </Button>
  )
}
