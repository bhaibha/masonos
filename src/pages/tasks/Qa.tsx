import { ClipboardList, Download, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { generateNcrFile, generateNcrPdf } from '@/lib/ncrPdf'
import { createDocument } from '@/lib/queries/documents'
import { fetchProject } from '@/lib/queries/projects'
import {
  applyItpTemplate,
  createItpCheck,
  createItpItem,
  createNcr,
  deleteItpCheck,
  deleteItpItem,
  fetchInspections,
  fetchItpItems,
  fetchItpTemplates,
  fetchNcrs,
  fetchInspectionChecks,
  fetchItpChecks,
  fetchQaSummary,
  fetchTemplateChecks,
  fetchTemplateItems,
  recordInspection,
  requestInspection,
  saveItpTemplate,
  setNcrStatus,
} from '@/lib/queries/qa'
import { fetchActivities } from '@/lib/queries/schedule'
import {
  compressImage,
  signedSitePhotoUrl,
  uploadDocument,
  uploadSitePhoto,
} from '@/lib/storage'
import {
  canEditItp,
  canRaiseNcr,
  canSignOffInspection,
  type CheckAnswer,
  CHECK_LABEL,
  type CheckResult,
  type InspectionCheckRow,
  type InspectionResult,
  type InspectionRow,
  type ItpCheck,
  type ItpTemplateCheck,
  ITP_STATUS_LABEL,
  ITP_TYPE_LABEL,
  ITP_TYPES,
  type ItpItem,
  type ItpTemplate,
  type ItpTemplateItem,
  type ItpType,
  NCR_SEVERITIES,
  NCR_SEVERITY_LABEL,
  NCR_STATUS_LABEL,
  type NcrRow,
  type NcrSeverity,
  type NewItpItemInput,
  type NewNcrInput,
  type QaSummary,
  type ScheduleActivity,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

type Tab = 'plan' | 'ncrs' | 'templates'

/**
 * QA/QC — inspection plan, hold points, inspection records and NCRs.
 *
 * The one thing to preserve here: a supervisor REQUESTS an inspection and
 * never records one. An inspection record is the approval — the row somebody
 * points at in two years when a slab cracks — and the whole reason a hold point
 * exists is that the person who did the work does not sign it off. The screen
 * hides the sign-off controls, and `fn_record_inspection` refuses them anyway.
 */
export default function Qa() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  const maySignOff = canSignOffInspection(role)
  const mayEditPlan = canEditItp(role)
  const mayRaise = canRaiseNcr(role)

  const [tab, setTab] = useState<Tab>('plan')
  const [items, setItems] = useState<ItpItem[] | null>(null)
  const [ncrs, setNcrs] = useState<NcrRow[]>([])
  const [summary, setSummary] = useState<QaSummary | null>(null)
  const [templates, setTemplates] = useState<ItpTemplate[]>([])
  const [activities, setActivities] = useState<ScheduleActivity[]>([])

  const [addingItem, setAddingItem] = useState(false)
  const [raisingNcr, setRaisingNcr] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const [i, n, s] = await Promise.all([
        fetchItpItems(projectId),
        fetchNcrs(projectId).catch(() => [] as NcrRow[]),
        fetchQaSummary(projectId),
      ])
      setItems(i)
      setNcrs(n)
      setSummary(s)
    } catch (err) {
      toast.error('Could not load QA records', { description: errText(err) })
      setItems([])
    }
  }, [projectId])

  useEffect(() => {
    setItems(null)
    void reload()
  }, [reload])

  useEffect(() => {
    fetchItpTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])

  useEffect(() => {
    if (!projectId) return
    fetchActivities(projectId).then(setActivities).catch(() => setActivities([]))
  }, [projectId])

  if (!projectId || items === null) return <ListSkeleton rows={5} />

  return (
    <div className="space-y-4 pb-6">
      {summary && <QaCard summary={summary} />}

      <div className="flex gap-1">
        {(
          [
            ['plan', 'Inspection plan'],
            ['ncrs', `NCRs${summary && summary.open_ncrs > 0 ? ` (${summary.open_ncrs})` : ''}`],
            ['templates', 'Templates'],
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

      {tab === 'plan' && (
        <PlanTab
          projectId={projectId}
          items={items}
          activities={activities}
          templates={templates}
          maySignOff={maySignOff}
          mayEditPlan={mayEditPlan}
          adding={addingItem}
          setAdding={setAddingItem}
          onChanged={reload}
        />
      )}

      {tab === 'ncrs' && (
        <NcrTab
          projectId={projectId}
          ncrs={ncrs}
          items={items}
          maySignOff={maySignOff}
          mayRaise={mayRaise}
          raising={raisingNcr}
          setRaising={setRaisingNcr}
          onChanged={reload}
        />
      )}

      {tab === 'templates' && (
        <TemplatesTab
          projectId={projectId}
          templates={templates}
          mayEditPlan={mayEditPlan}
          hasItems={items.length > 0}
          onChanged={async () => {
            setTemplates(await fetchItpTemplates().catch(() => []))
            await reload()
          }}
        />
      )}
    </div>
  )
}

/* ---------------- summary card ---------------- */

function QaCard({ summary: s }: { summary: QaSummary }) {
  const blocked = s.holds_blocking > 0

  return (
    <section className="paper p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Quality
        </h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {s.itp_passed} of {s.itp_total} points passed
        </span>
      </div>

      {/* The one thing on this screen that stops work. Loud, or it is just
          another number. */}
      {blocked && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive">
          {s.holds_blocking} hold point{s.holds_blocking === 1 ? '' : 's'}{' '}
          blocking work. Progress cannot be recorded past{' '}
          {s.holds_blocking === 1 ? 'it' : 'them'} until an inspection passes.
        </p>
      )}

      <div className="mt-4 grid grid-cols-3 gap-5">
        <Stat
          label="Open NCRs"
          value={String(s.open_ncrs)}
          tone={s.ncr_critical > 0 ? 'danger' : s.open_ncrs > 0 ? 'warning' : undefined}
          hint={
            s.open_ncrs > 0
              ? [
                  s.ncr_critical > 0 && `${s.ncr_critical} critical`,
                  s.ncr_major > 0 && `${s.ncr_major} major`,
                  s.ncr_minor > 0 && `${s.ncr_minor} minor`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'none outstanding'
          }
        />
        <Stat
          label="Holds pending"
          value={String(s.holds_pending)}
          tone={blocked ? 'danger' : undefined}
          hint={blocked ? `${s.holds_blocking} blocking` : 'nothing blocked'}
        />
        <Stat
          label="Pass rate"
          value={s.pass_rate === null ? 'n/a' : `${s.pass_rate}%`}
          hint={
            s.inspections_done === 0
              ? 'no inspections yet'
              : `${s.inspections_done} inspection${s.inspections_done === 1 ? '' : 's'}`
          }
        />
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'danger' | 'warning'
}) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'figure mt-1.5 text-[24px] leading-none font-semibold',
          tone === 'danger' && 'text-destructive',
          tone === 'warning' && 'text-[var(--warning)]',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/* ---------------- inspection plan ---------------- */

const TYPE_TONE: Record<ItpType, string> = {
  hold: 'bg-destructive/10 text-destructive',
  witness: 'bg-secondary text-secondary-foreground',
  review: 'bg-secondary text-muted-foreground',
}

function PlanTab({
  projectId,
  items,
  activities,
  templates,
  maySignOff,
  mayEditPlan,
  adding,
  setAdding,
  onChanged,
}: {
  projectId: string
  items: ItpItem[]
  activities: ScheduleActivity[]
  templates: ItpTemplate[]
  maySignOff: boolean
  mayEditPlan: boolean
  adding: boolean
  setAdding: (v: boolean) => void
  onChanged: () => Promise<void>
}) {
  const [applying, setApplying] = useState('')

  async function apply(templateId: string) {
    if (!templateId) return
    setApplying(templateId)
    try {
      const n = await applyItpTemplate(projectId, templateId)
      toast.success(`${n} inspection point${n === 1 ? '' : 's'} added`, {
        description: 'Copied onto this project — edit them freely from here.',
      })
      await onChanged()
    } catch (err) {
      toast.error('Could not apply that template', { description: errText(err) })
    } finally {
      setApplying('')
    }
  }

  if (items.length === 0) {
    return (
      <>
        <EmptyState
          icon={ClipboardList}
          title="No inspection plan yet"
          body={
            mayEditPlan
              ? 'Apply one of the firm’s standard plans, or add inspection points one at a time.'
              : 'Nobody has set out the inspection plan for this project yet.'
          }
        />
        {mayEditPlan && (
          <div className="space-y-3">
            {templates.length > 0 && (
              <FieldRow label="Apply a template" htmlFor="apply_tpl">
                <Select
                  id="apply_tpl"
                  value=""
                  disabled={applying !== ''}
                  onChange={(e) => void apply(e.target.value)}
                >
                  <option value="">Select a standard plan…</option>
                  {templates
                    .filter((t) => t.is_active)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.item_count})
                      </option>
                    ))}
                </Select>
              </FieldRow>
            )}
            <Button className="h-11 w-full" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add an inspection point
            </Button>
            {adding && (
              <ItpForm
                projectId={projectId}
                activities={activities}
                onDone={async () => {
                  setAdding(false)
                  await onChanged()
                }}
                onCancel={() => setAdding(false)}
              />
            )}
          </div>
        )}
      </>
    )
  }

  return (
    <div className="space-y-3">
      {mayEditPlan && (
        <div className="flex gap-3">
          <Button className="h-11 flex-1" onClick={() => setAdding(!adding)}>
            <Plus className="size-4" aria-hidden="true" />
            {adding ? 'Close' : 'Add point'}
          </Button>
          {templates.length > 0 && (
            <Select
              value=""
              disabled={applying !== ''}
              onChange={(e) => void apply(e.target.value)}
              className="h-11 flex-1 text-sm"
              aria-label="Apply a template"
            >
              <option value="">Apply a template…</option>
              {templates
                .filter((t) => t.is_active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.item_count})
                  </option>
                ))}
            </Select>
          )}
        </div>
      )}

      {adding && (
        <ItpForm
          projectId={projectId}
          activities={activities}
          onDone={async () => {
            setAdding(false)
            await onChanged()
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      <Stagger className="space-y-2.5">
        {items.map((it) => (
          <RevealItem key={it.id}>
            <ItpCard
              item={it}
              maySignOff={maySignOff}
              mayEditPlan={mayEditPlan}
              onChanged={onChanged}
            />
          </RevealItem>
        ))}
      </Stagger>
    </div>
  )
}

function ItpCard({
  item: it,
  maySignOff,
  mayEditPlan,
  onChanged,
}: {
  item: ItpItem
  maySignOff: boolean
  mayEditPlan: boolean
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [showChecks, setShowChecks] = useState(false)
  const [history, setHistory] = useState<InspectionRow[] | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [busy, setBusy] = useState(false)

  const isHold = it.inspection_type === 'hold'
  const blocked = isHold && it.status !== 'passed'

  useEffect(() => {
    if (!open || history !== null) return
    fetchInspections(it.id).then(setHistory).catch(() => setHistory([]))
  }, [open, history, it.id])

  async function request() {
    setBusy(true)
    try {
      await requestInspection(it.id)
      toast.success('Inspection requested', {
        description: 'Recorded against your name. The PM can see it now.',
      })
      await onChanged()
    } catch (err) {
      toast.error('Could not request that inspection', {
        description: errText(err),
      })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!confirm(`Remove "${it.description}" from the plan?`)) return
    try {
      await deleteItpItem(it.id)
      toast.success('Inspection point removed')
      await onChanged()
    } catch (err) {
      toast.error('Could not remove that point', { description: errText(err) })
    }
  }

  return (
    <article
      className={cn(
        'paper p-4',
        // A hold point that hasn't passed is the only thing on this screen
        // that stops work. It gets a red edge; nothing else does.
        blocked && 'border-l-[3px] border-l-destructive',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
                TYPE_TONE[it.inspection_type],
              )}
            >
              {ITP_TYPE_LABEL[it.inspection_type]}
            </span>
            <span className="text-xs text-muted-foreground">{it.stage}</span>
          </div>
          <p className="mt-1.5 font-medium">{it.description}</p>
          {it.acceptance_criteria && (
            <p className="mt-1 text-xs text-muted-foreground">
              Accept: {it.acceptance_criteria}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {it.reference_standard && `${it.reference_standard} · `}
            {it.activity_label ?? 'Not tied to an activity'}
          </p>
        </div>

        <span
          className={cn(
            'shrink-0 text-right text-xs font-medium',
            it.status === 'passed' && 'text-[var(--positive)]',
            it.status === 'failed' && 'text-destructive',
            it.status === 'requested' && 'text-[var(--warning)]',
            it.status === 'pending' && 'text-muted-foreground',
          )}
        >
          {ITP_STATUS_LABEL[it.status]}
        </span>
      </div>

      {blocked && (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {it.status === 'failed'
            ? 'Failed. Work depending on this activity stays blocked until a re-inspection passes.'
            : 'Hold point — progress on anything depending on this activity is blocked until it passes.'}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {/* A supervisor sees only this. The sign-off buttons are not hidden
            from them as a courtesy — fn_record_inspection refuses them. */}
        {it.status !== 'passed' && (
          <Button
            variant="outline"
            className="h-10"
            disabled={busy || it.status === 'requested'}
            onClick={() => void request()}
          >
            {it.status === 'requested' ? 'Inspection requested' : 'Request inspection'}
          </Button>
        )}

        {maySignOff && (
          <Button className="h-10" onClick={() => setInspecting((v) => !v)}>
            {inspecting ? 'Close' : 'Record inspection'}
          </Button>
        )}

        <Button
          variant="ghost"
          className="h-10"
          onClick={() => setShowChecks((c) => !c)}
        >
          {showChecks ? 'Hide checks' : 'Checklist'}
        </Button>

        <Button
          variant="ghost"
          className="h-10"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide history' : 'History'}
        </Button>

        {mayEditPlan && (
          <Button
            variant="ghost"
            className="ml-auto h-10 text-destructive"
            onClick={() => void remove()}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      {showChecks && <ChecklistEditor item={it} mayEdit={mayEditPlan} />}

      {inspecting && maySignOff && (
        <InspectionForm
          item={it}
          onDone={async () => {
            setInspecting(false)
            setHistory(null)
            await onChanged()
          }}
        />
      )}

      {open && (
        <div className="mt-3 border-t border-border pt-3">
          {history === null ? (
            <ListSkeleton rows={2} />
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing inspected yet.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {history.map((h) => (
                <li key={h.id} className="text-sm">
                  <span
                    className={cn(
                      'font-medium',
                      h.result === 'pass' && 'text-[var(--positive)]',
                      h.result === 'fail' && 'text-destructive',
                      h.result === 'conditional' && 'text-[var(--warning)]',
                    )}
                  >
                    {h.result === 'pass'
                      ? 'Passed'
                      : h.result === 'fail'
                        ? 'Failed'
                        : 'Conditional'}
                  </span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {h.inspected_on}
                    {h.location && ` · ${h.location}`}
                    {h.inspector_name && ` · ${h.inspector_name}`}
                  </span>
                  {h.remarks && (
                    <p className="text-xs text-muted-foreground">{h.remarks}</p>
                  )}
                  {h.photos.length > 0 && <PhotoStrip paths={h.photos} />}
                  {/* The auditable part: exactly what was asked and answered. */}
                  <AnswerList inspectionId={h.id} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  )
}

/* ---------------- record an inspection ---------------- */

/**
 * The checklist runner. This is the screen a PM stands in front of the work
 * with, so it is built for one thumb: each question is a full-width row with
 * three 48px targets, and the whole thing scrolls in one column.
 *
 * The headline result is DERIVED and shown live — the inspector never chooses
 * it while questions are outstanding. `fn_record_inspection` recomputes the
 * same thing server-side and overrules a contradictory claim, so this banner
 * is a preview of the verdict rather than the verdict itself.
 */
function InspectionForm({
  item,
  onDone,
}: {
  item: ItpItem
  onDone: () => Promise<void>
}) {
  const [checks, setChecks] = useState<ItpCheck[] | null>(null)
  const [answers, setAnswers] = useState<Record<string, CheckAnswer>>({})
  const [openRemark, setOpenRemark] = useState<string | null>(null)
  const [date, setDate] = useState(todayIst())
  const [location, setLocation] = useState('')
  const [remarks, setRemarks] = useState('')
  const [conditional, setConditional] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    fetchItpChecks(item.id)
      .then((c) => {
        setChecks(c)
        setAnswers(
          Object.fromEntries(
            c.map((q) => [
              q.id,
              {
                check_id: q.id,
                question: q.question,
                section: q.section,
                result: null,
                remark: '',
                photos: [],
              },
            ]),
          ),
        )
      })
      .catch(() => setChecks([]))
  }, [item.id])

  const list = checks ?? []
  const answered = list.filter((q) => answers[q.id]?.result != null).length
  const fails = list.filter((q) => answers[q.id]?.result === 'fail').length
  const complete = list.length === 0 || answered === list.length

  // Same rule as the server, so the banner never disagrees with the outcome.
  const derived: InspectionResult =
    list.length === 0
      ? conditional
        ? 'conditional'
        : fails > 0
          ? 'fail'
          : 'pass'
      : fails > 0
        ? conditional
          ? 'conditional'
          : 'fail'
        : 'pass'

  function answer(id: string, result: CheckResult) {
    setAnswers((a) => ({ ...a, [id]: { ...a[id], result } }))
    // Failing a check is the moment somebody has something to say about it.
    if (result === 'fail') setOpenRemark(id)
  }

  async function addPhoto(id: string, files: FileList | null) {
    if (!files?.length) return
    try {
      const out: File[] = []
      for (const f of Array.from(files)) out.push(await compressImage(f))
      const paths: string[] = []
      for (const f of out) paths.push(await uploadSitePhoto(item.project_id, f))
      setAnswers((a) => ({
        ...a,
        [id]: { ...a[id], photos: [...a[id].photos, ...paths] },
      }))
      toast.success(`${paths.length} photo${paths.length === 1 ? '' : 's'} attached`)
    } catch (err) {
      toast.error('Could not attach that photo', { description: errText(err) })
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!complete) {
      toast.error(`${list.length - answered} question(s) still unanswered`, {
        description: 'A checklist with blanks records an interruption, not an inspection.',
      })
      return
    }

    setBusy(true)
    setStatus('Recording…')
    try {
      await recordInspection(
        item.id,
        derived,
        date,
        remarks,
        [],
        list.map((q) => answers[q.id]),
        location,
      )

      toast.success(
        derived === 'pass'
          ? 'Passed and signed off'
          : derived === 'conditional'
            ? `Conditional pass — ${fails} NCR${fails === 1 ? '' : 's'} raised`
            : `Failed — ${fails} NCR${fails === 1 ? '' : 's'} raised`,
        {
          description:
            derived === 'pass'
              ? item.inspection_type === 'hold'
                ? 'The hold is lifted; dependent work can now be recorded.'
                : undefined
              : 'One NCR per failed check, each naming the question. See the NCRs tab.',
        },
      )
      await onDone()
    } catch (err) {
      toast.error('Could not record that inspection', { description: errText(err) })
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  if (checks === null) {
    return (
      <div className="mt-3 border-t border-border pt-4">
        <ListSkeleton rows={4} />
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-4 border-t border-border pt-4">
      {list.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Checklist
            </p>
            <span className="text-xs text-muted-foreground tabular-nums">
              {answered} of {list.length}
            </span>
          </div>

          {/* Progress along the checklist, not a percentage of anything. */}
          <div className="h-[4px] w-full overflow-hidden rounded-full bg-border">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                fails > 0 ? 'bg-destructive' : 'bg-primary',
              )}
              style={{ width: `${(answered / list.length) * 100}%` }}
            />
          </div>

          <ul className="space-y-3">
            {list.map((q, i) => {
              const a = answers[q.id]
              // The paper form's PRE / DURING / POST bands. Printed once, when
              // the heading changes — the same place the sheet prints them.
              const heading =
                q.section && q.section !== (list[i - 1]?.section ?? null)
                  ? q.section
                  : null
              return (
                <li
                  key={q.id}
                  className={cn(
                    'rounded-xl border p-3',
                    a?.result === 'fail'
                      ? 'border-destructive/40 bg-destructive/5'
                      : a?.result === 'pass'
                        ? 'border-[var(--positive)]/30'
                        : 'border-border',
                  )}
                >
                  {heading && (
                    <p className="-mx-3 -mt-3 mb-2.5 rounded-t-[11px] bg-secondary px-3 py-1.5 text-[11px] font-semibold tracking-[0.1em] text-secondary-foreground uppercase">
                      {heading}
                    </p>
                  )}
                  <p className="text-sm">
                    <span className="text-muted-foreground tabular-nums">
                      {i + 1}.
                    </span>{' '}
                    {q.question}
                  </p>
                  {q.guidance && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {q.guidance}
                    </p>
                  )}

                  {/* Three targets, 48px tall, thumb-width. */}
                  <div className="mt-2.5 grid grid-cols-3 gap-2">
                    {(['pass', 'fail', 'na'] as CheckResult[]).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => answer(q.id, r)}
                        aria-pressed={a?.result === r}
                        className={cn(
                          'h-12 rounded-lg text-sm font-medium transition-colors',
                          a?.result === r
                            ? r === 'pass'
                              ? 'bg-[var(--positive)] text-white'
                              : r === 'fail'
                                ? 'bg-destructive text-white'
                                : 'bg-secondary text-secondary-foreground'
                            : 'bg-secondary/50 text-muted-foreground',
                        )}
                      >
                        {CHECK_LABEL[r]}
                      </button>
                    ))}
                  </div>

                  {(openRemark === q.id || a?.remark || a?.photos.length) && (
                    <div className="mt-2.5 space-y-2">
                      <Textarea
                        value={a?.remark ?? ''}
                        onChange={(e) =>
                          setAnswers((prev) => ({
                            ...prev,
                            [q.id]: { ...prev[q.id], remark: e.target.value },
                          }))
                        }
                        placeholder={
                          a?.result === 'fail'
                            ? 'What is wrong, and where? This becomes the NCR.'
                            : 'Note (optional)'
                        }
                        className="min-h-16"
                      />
                      <div className="flex items-center gap-2">
                        <input
                          id={`cp-${q.id}`}
                          type="file"
                          accept="image/*"
                          capture="environment"
                          multiple
                          className="sr-only"
                          onChange={(e) => void addPhoto(q.id, e.target.files)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="h-10"
                          onClick={() => document.getElementById(`cp-${q.id}`)?.click()}
                        >
                          Photo
                        </Button>
                        {a?.photos.length ? (
                          <span className="text-xs text-muted-foreground">
                            {a.photos.length} attached
                          </span>
                        ) : null}
                      </div>
                    </div>
                  )}

                  {a?.result !== 'fail' && openRemark !== q.id && !a?.remark && (
                    <button
                      type="button"
                      onClick={() => setOpenRemark(q.id)}
                      className="mt-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      + note or photo
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      {/* The verdict, computed from the answers above. */}
      <div
        className={cn(
          'rounded-lg px-3 py-2.5 text-sm font-medium',
          derived === 'pass'
            ? 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]'
            : derived === 'conditional'
              ? 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]'
              : 'bg-destructive/10 text-destructive',
        )}
      >
        {!complete
          ? `${list.length - answered} question${list.length - answered === 1 ? '' : 's'} left`
          : derived === 'pass'
            ? 'All checks pass — this point will be signed off'
            : derived === 'conditional'
              ? `Conditional pass — ${fails} NCR${fails === 1 ? '' : 's'} will be raised`
              : `${fails} check${fails === 1 ? '' : 's'} failed — ${fails} NCR${fails === 1 ? '' : 's'} will be raised, and the point stays open`}
      </div>

      {fails > 0 && (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={conditional}
            onChange={(e) => setConditional(e.target.checked)}
            className="mt-1 size-5 shrink-0"
          />
          <span>
            Conditional pass — the next stage may proceed while these are put
            right.
            <span className="block text-xs text-muted-foreground">
              The NCRs are still raised. Leave unticked and the point stays
              open, and anything depending on it stays blocked.
            </span>
          </span>
        </label>
      )}

      {/* The header of the paper sheet: PROJECT and DATE are already known,
          LOCATION is the one that changes between two inspections of the same
          activity. */}
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Date" htmlFor={`dt-${item.id}`}>
          <Input
            id={`dt-${item.id}`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Location" htmlFor={`loc-${item.id}`}>
          <Input
            id={`loc-${item.id}`}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="h-12 text-base"
            placeholder="Block A, first floor"
          />
        </FieldRow>
      </div>

      <FieldRow label="Overall remarks" htmlFor={`rm-${item.id}`}>
        <Textarea
          id={`rm-${item.id}`}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="Anything about the inspection as a whole"
        />
      </FieldRow>

      <Button
        type="submit"
        disabled={busy || !complete}
        className="h-12 w-full text-base"
      >
        {busy ? (status ?? 'Saving…') : 'Record inspection'}
      </Button>
    </form>
  )
}

/**
 * What was actually asked and answered on one completed inspection.
 *
 * Collapsed by default: the history is usually scanned for the result, and
 * expanded when somebody wants the evidence. The wording shown is the
 * SNAPSHOT taken at the time, so editing the plan afterwards never rewrites
 * what an inspector was asked.
 */
function AnswerList({ inspectionId }: { inspectionId: string }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<InspectionCheckRow[] | null>(null)

  useEffect(() => {
    if (!open || rows !== null) return
    fetchInspectionChecks(inspectionId)
      .then(setRows)
      .catch(() => setRows([]))
  }, [open, rows, inspectionId])

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? 'Hide checklist' : 'Show checklist'}
      </button>

      {open && (
        <div className="mt-2 border-l-2 border-border pl-3">
          {rows === null ? (
            <ListSkeleton rows={2} />
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No checklist was recorded for this inspection.
            </p>
          ) : (
            <ol className="space-y-2">
              {rows.map((r) => (
                <li key={r.id} className="text-xs">
                  <span
                    className={cn(
                      'font-medium',
                      r.result === 'pass' && 'text-[var(--positive)]',
                      r.result === 'fail' && 'text-destructive',
                      r.result === 'na' && 'text-muted-foreground',
                    )}
                  >
                    {CHECK_LABEL[r.result]}
                  </span>
                  <span className="text-muted-foreground"> · </span>
                  {r.question}
                  {r.ncr_no && (
                    <span className="ml-1 font-medium text-destructive">
                      → {r.ncr_no}
                    </span>
                  )}
                  {r.remark && (
                    <p className="text-muted-foreground">{r.remark}</p>
                  )}
                  {r.photos.length > 0 && <PhotoStrip paths={r.photos} />}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The checklist under one live ITP point: visible to everyone, editable by
 * founder/PM.
 *
 * A supervisor reads it BEFORE requesting the inspection — knowing what will
 * be checked is how the work gets done right the first time, which is worth
 * more than catching it afterwards.
 */
function ChecklistEditor({
  item,
  mayEdit,
}: {
  item: ItpItem
  mayEdit: boolean
}) {
  const [checks, setChecks] = useState<ItpCheck[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setChecks(await fetchItpChecks(item.id))
    } catch {
      setChecks([])
    }
  }, [item.id])

  useEffect(() => {
    void load()
  }, [load])

  async function add() {
    if (question.trim().length < 5) {
      toast.error('Write the check as a question somebody can answer on site.')
      return
    }
    setBusy(true)
    try {
      await createItpCheck(
        item.id,
        question,
        '',
        ((checks?.length ?? 0) + 1) * 10,
      )
      setQuestion('')
      setAdding(false)
      toast.success('Check added')
      await load()
    } catch (err) {
      toast.error('Could not add that check', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    try {
      await deleteItpCheck(id)
      toast.success('Check removed', {
        description: 'Answers already given to it stay on their inspections.',
      })
      await load()
    } catch (err) {
      toast.error('Could not remove that check', { description: errText(err) })
    }
  }

  if (checks === null) return <ListSkeleton rows={2} />

  return (
    <div className="mt-3 border-t border-border pt-3">
      {checks.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No checklist on this point — the inspection will be a single
          pass/fail.
        </p>
      ) : (
        <ol className="space-y-1.5">
          {checks.map((c, i) => (
            <li key={c.id} className="flex items-start gap-2 text-sm">
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {i + 1}.
              </span>
              <span className="min-w-0 flex-1">{c.question}</span>
              {mayEdit && (
                <button
                  type="button"
                  onClick={() => void remove(c.id)}
                  aria-label="Remove check"
                  className="shrink-0 text-destructive"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {mayEdit && (
        <div className="mt-3">
          {adding ? (
            <div className="space-y-2">
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Cover blocks fixed at the required spacing"
                className="h-12 text-base"
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  className="h-11 flex-1"
                  disabled={busy}
                  onClick={() => void add()}
                >
                  Add check
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="text-sm font-medium text-primary hover:underline"
            >
              + Add a check
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------------- NCRs ---------------- */

const NCR_TONE: Record<string, string> = {
  open: 'bg-destructive/10 text-destructive',
  corrected: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  closed: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  rejected: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-secondary text-muted-foreground',
}

function NcrTab({
  projectId,
  ncrs,
  items,
  maySignOff,
  mayRaise,
  raising,
  setRaising,
  onChanged,
}: {
  projectId: string
  ncrs: NcrRow[]
  items: ItpItem[]
  maySignOff: boolean
  mayRaise: boolean
  raising: boolean
  setRaising: (v: boolean) => void
  onChanged: () => Promise<void>
}) {
  return (
    <div className="space-y-3">
      {mayRaise && (
        <Button className="h-11 w-full" onClick={() => setRaising(!raising)}>
          <ShieldAlert className="size-4" aria-hidden="true" />
          {raising ? 'Close' : 'Raise an NCR'}
        </Button>
      )}

      {raising && (
        <NcrForm
          projectId={projectId}
          items={items}
          onDone={async () => {
            setRaising(false)
            await onChanged()
          }}
          onCancel={() => setRaising(false)}
        />
      )}

      {ncrs.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No non-conformances"
          body="Nothing has been raised on this project. A failed or conditional inspection also raises one automatically."
        />
      ) : (
        <Stagger className="space-y-2.5">
          {ncrs.map((n) => (
            <RevealItem key={n.id}>
              <NcrCard
                ncr={n}
                item={items.find((i) => i.id === n.itp_item_id) ?? null}
                projectId={projectId}
                maySignOff={maySignOff}
                onChanged={onChanged}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function NcrCard({
  ncr: n,
  item,
  projectId,
  maySignOff,
  onChanged,
}: {
  ncr: NcrRow
  item: ItpItem | null
  projectId: string
  maySignOff: boolean
  onChanged: () => Promise<void>
}) {
  const [correcting, setCorrecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function move(status: 'corrected' | 'closed' | 'rejected' | 'cancelled') {
    if (status !== 'closed' && note.trim() === '') {
      toast.error(
        status === 'corrected'
          ? 'Say what was actually done'
          : status === 'rejected'
            ? 'Say why the correction was rejected'
            : 'A reason is required to cancel',
      )
      return
    }
    setBusy(true)
    try {
      await setNcrStatus(n.id, status, note.trim() || undefined)
      toast.success(
        status === 'corrected'
          ? 'Corrective action recorded'
          : status === 'closed'
            ? `${n.ncr_no} closed`
            : status === 'rejected'
              ? 'Correction rejected'
              : `${n.ncr_no} cancelled`,
      )
      setNote('')
      setCorrecting(false)
      await onChanged()
    } catch (err) {
      toast.error('Could not update that NCR', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Download, or file into the project's document vault.
   *
   * `qc_certificates` is where it lands — the folder already exists and this is
   * exactly what it is for. Filed NOT confidential: an NCR carries no rupee
   * figure by design, and the people who most need to read one are the
   * supervisors and the trades doing the correction. Same call as the Site
   * Instruction.
   */
  async function pdf(file: boolean) {
    setBusy(true)
    try {
      const p = await fetchProject(projectId)
      const opts = {
        ncr: n,
        projectName: p?.name ?? 'Project',
        siteAddress: p?.site_address ?? null,
        clientName: p?.client_name ?? null,
        item,
      }

      if (!file) {
        generateNcrPdf(opts)
        toast.success('NCR downloaded')
        return
      }

      const f = generateNcrFile(opts)
      const { path, fileType } = await uploadDocument(projectId, f)
      await createDocument({
        project_id: projectId,
        folder: 'qc_certificates',
        title: `${n.ncr_no} · ${n.area}`,
        file_path: path,
        file_type: fileType,
        is_confidential: false,
      })
      toast.success('Filed to Docs → QC Certificates', {
        description: `${n.ncr_no} — a snapshot as it reads today.`,
      })
    } catch (err) {
      toast.error('Could not build the PDF', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={cn('paper p-4', n.status === 'cancelled' && 'opacity-70')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {n.ncr_no}
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
                n.severity === 'critical'
                  ? 'bg-destructive/15 text-destructive'
                  : n.severity === 'major'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-secondary text-muted-foreground',
              )}
            >
              {NCR_SEVERITY_LABEL[n.severity]}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {n.area}
            {n.standard_ref && ` · ${n.standard_ref}`} · {n.created_at.slice(0, 10)}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded px-2 py-1 text-[11px] font-medium',
            NCR_TONE[n.status],
          )}
        >
          {NCR_STATUS_LABEL[n.status]}
        </span>
      </div>

      <p className="mt-2 text-sm break-words">{n.description}</p>

      {n.photos.length > 0 && <PhotoStrip paths={n.photos} />}

      {n.corrective_action && (
        <p className="mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs">
          <span className="font-medium">Corrective action:</span>{' '}
          {n.corrective_action}
        </p>
      )}
      {n.reject_reason && (
        <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Rejected: {n.reject_reason}
        </p>
      )}
      {n.cancel_reason && (
        <p className="mt-2 text-xs text-muted-foreground">
          Cancelled — {n.cancel_reason}
        </p>
      )}

      {n.status !== 'cancelled' && n.status !== 'closed' && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {correcting && (
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                n.status === 'corrected'
                  ? 'Why is this being rejected, or why is it being cancelled?'
                  : 'What was actually done to correct it?'
              }
            />
          )}

          <div className="flex flex-wrap gap-2">
            {/* Anyone on the project records what they did. Only a founder or
                PM decides whether it is good enough. */}
            {n.status !== 'corrected' && (
              <Button
                variant="outline"
                className="h-10"
                disabled={busy}
                onClick={() =>
                  correcting ? void move('corrected') : setCorrecting(true)
                }
              >
                {correcting ? 'Save corrective action' : 'Record correction'}
              </Button>
            )}

            {maySignOff && n.status === 'corrected' && (
              <>
                <Button
                  className="h-10"
                  disabled={busy}
                  onClick={() => void move('closed')}
                >
                  Re-inspected — close
                </Button>
                <Button
                  variant="outline"
                  className="h-10"
                  disabled={busy}
                  onClick={() =>
                    correcting ? void move('rejected') : setCorrecting(true)
                  }
                >
                  Reject correction
                </Button>
              </>
            )}

            {maySignOff && (
              <Button
                variant="ghost"
                className="h-10 text-destructive"
                disabled={busy}
                onClick={() =>
                  correcting ? void move('cancelled') : setCorrecting(true)
                }
              >
                Cancel NCR
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <Button
          variant="ghost"
          className="h-10"
          disabled={busy}
          onClick={() => void pdf(false)}
        >
          <Download className="size-4" aria-hidden="true" />
          PDF
        </Button>
        <Button
          variant="ghost"
          className="h-10"
          disabled={busy}
          onClick={() => void pdf(true)}
        >
          File to Docs
        </Button>
      </div>
    </article>
  )
}

function NcrForm({
  projectId,
  items,
  onDone,
  onCancel,
}: {
  projectId: string
  items: ItpItem[]
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [area, setArea] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<NcrSeverity>('minor')
  const [standard, setStandard] = useState('')
  const [itemId, setItemId] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)

  // Picking the inspection point fills the standard in, because retyping
  // "IS 456" is how two NCRs end up citing different things for one defect.
  const chosen = useMemo(
    () => items.find((i) => i.id === itemId) ?? null,
    [items, itemId],
  )
  useEffect(() => {
    if (chosen?.reference_standard) setStandard(chosen.reference_standard)
  }, [chosen])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!area.trim() || !description.trim()) {
      toast.error('Say where it is and what is wrong.')
      return
    }
    setBusy(true)
    try {
      const paths: string[] = []
      for (const f of files) paths.push(await uploadSitePhoto(projectId, f))

      const input: NewNcrInput = {
        area,
        description,
        severity,
        standard_ref: standard,
        photos: paths,
        itp_item_id: itemId || null,
        assigned_to: null,
      }
      await createNcr(projectId, input)
      toast.success('NCR raised')
      await onDone()
    } catch (err) {
      toast.error('Could not raise that NCR', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="paper space-y-4 p-5" noValidate>
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Area" htmlFor="ncr_area">
          <Input
            id="ncr_area"
            required
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="h-12 text-base"
            placeholder="First floor, grid C3"
          />
        </FieldRow>
        <FieldRow label="Severity" htmlFor="ncr_sev">
          <Select
            id="ncr_sev"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as NcrSeverity)}
          >
            {NCR_SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </FieldRow>
      </div>

      {items.length > 0 && (
        <FieldRow label="Against inspection point" htmlFor="ncr_item">
          <Select
            id="ncr_item"
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
          >
            <option value="">Not tied to a point</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.stage} — {i.description}
              </option>
            ))}
          </Select>
        </FieldRow>
      )}

      <FieldRow label="Standard" htmlFor="ncr_std">
        <Input
          id="ncr_std"
          value={standard}
          onChange={(e) => setStandard(e.target.value)}
          className="h-12 text-base"
          placeholder="IS 456"
        />
      </FieldRow>

      <FieldRow label="What does not conform" htmlFor="ncr_desc">
        <Textarea
          id="ncr_desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What was found, and against what requirement"
        />
      </FieldRow>

      <PhotoPicker files={files} onChange={setFiles} id="ncr_photos" />

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Saving…' : 'Raise NCR'}
        </Button>
        <Button type="button" variant="ghost" className="h-12" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/* ---------------- templates ---------------- */

/** The checklist under one template point, loaded on demand. */
function TemplateChecks({ templateItemId }: { templateItemId: string }) {
  const [open, setOpen] = useState(false)
  const [checks, setChecks] = useState<ItpTemplateCheck[] | null>(null)

  useEffect(() => {
    if (!open || checks !== null) return
    fetchTemplateChecks(templateItemId)
      .then(setChecks)
      .catch(() => setChecks([]))
  }, [open, checks, templateItemId])

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs font-medium text-primary hover:underline"
      >
        {open ? 'Hide checks' : 'Checks'}
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-3">
          {checks === null ? (
            <ListSkeleton rows={2} />
          ) : checks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No checklist on this point.
            </p>
          ) : (
            <ol className="space-y-1">
              {checks.map((c, n) => (
                <li key={c.id} className="text-xs text-muted-foreground">
                  <span className="tabular-nums">{n + 1}.</span> {c.question}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One template, expandable to its points.
 *
 * Loaded lazily on first open: five seeded plans hold 52 points between them,
 * and fetching all of them to render five collapsed rows would be work nobody
 * asked for. Read-only by design — a template is edited by applying it to a
 * project, changing the points there, and saving it back as a new standard.
 * Editing in place would restate plans already applied to live jobs.
 */
function TemplateCard({ template: t }: { template: ItpTemplate }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ItpTemplateItem[] | null>(null)

  useEffect(() => {
    if (!open || items !== null) return
    fetchTemplateItems(t.id)
      .then(setItems)
      .catch((err) => {
        toast.error('Could not open that template', { description: errText(err) })
        setItems([])
      })
  }, [open, items, t.id])

  const holds = items?.filter((i) => i.inspection_type === 'hold').length ?? 0

  return (
    <section className="paper overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <span
          aria-hidden="true"
          className={cn(
            'shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        >
          ›
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">
            {t.name}
            {!t.is_active && (
              <span className="ml-2 text-xs text-muted-foreground">
                (retired)
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t.item_count} inspection point{t.item_count === 1 ? '' : 's'}
            {open && holds > 0 && ` · ${holds} hold`}
            {t.description && ` · ${t.description}`}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-4 pt-3 pb-4">
          {items === null ? (
            <ListSkeleton rows={3} />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This template has no points.
            </p>
          ) : (
            <ol className="space-y-3">
              {items.map((i) => (
                <li key={i.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
                        TYPE_TONE[i.inspection_type],
                      )}
                    >
                      {ITP_TYPE_LABEL[i.inspection_type]}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {i.stage}
                    </span>
                  </div>
                  <p className="mt-1 font-medium">{i.description}</p>
                  {i.acceptance_criteria && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Accept: {i.acceptance_criteria}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {/* Blank on purpose where no standard was verified — say so
                        rather than leaving a silent gap. */}
                    {i.reference_standard ?? 'No standard reference — add your own'}
                    {i.required_by_stage && ` · required ${i.required_by_stage.toLowerCase()}`}
                  </p>
                  <TemplateChecks templateItemId={i.id} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}


function TemplatesTab({
  projectId,
  templates,
  mayEditPlan,
  hasItems,
  onChanged,
}: {
  projectId: string
  templates: ItpTemplate[]
  mayEditPlan: boolean
  hasItems: boolean
  onChanged: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (name.trim().length < 3) {
      toast.error('Give the template a name.')
      return
    }
    setBusy(true)
    try {
      await saveItpTemplate(projectId, name, desc)
      toast.success(`"${name.trim()}" saved`, {
        description: 'Available on every project from now on.',
      })
      setName('')
      setDesc('')
      await onChanged()
    } catch (err) {
      const msg = errText(err) ?? ''
      toast.error('Could not save that template', {
        description: /duplicate|unique/i.test(msg)
          ? 'A template with that name already exists.'
          : msg,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Standard inspection plans, shared across every project. Applying one
        copies its points onto the project — editing a template afterwards never
        restates an inspection that has already been signed off.
      </p>

      {templates.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No standard plans yet"
          body="If the seeded IS plans are missing, migration 044 has not been run. Otherwise: build the plan on one project, then save it here as the firm's standard."
        />
      ) : (
        <div className="space-y-2.5">
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} />
          ))}
        </div>
      )}

      {mayEditPlan && hasItems && (
        <section className="paper space-y-4 p-5">
          <div>
            <h3 className="font-heading text-[17px] font-semibold">
              Save this project’s plan as a template
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              A plan worked out once on site becomes the standard, instead of
              being retyped slightly differently next time.
            </p>
          </div>

          <FieldRow label="Name" htmlFor="tpl_name">
            <Input
              id="tpl_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-12 text-base"
              placeholder="Standard villa — RCC and finishes"
            />
          </FieldRow>

          <FieldRow label="Note" htmlFor="tpl_desc">
            <Input
              id="tpl_desc"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="h-12 text-base"
              placeholder="Optional"
            />
          </FieldRow>

          <Button
            className="h-11 w-full"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save as template'}
          </Button>
        </section>
      )}
    </div>
  )
}

/* ---------------- ITP point form ---------------- */

function ItpForm({
  projectId,
  activities,
  onDone,
  onCancel,
}: {
  projectId: string
  activities: ScheduleActivity[]
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [form, setForm] = useState<NewItpItemInput>({
    activity_id: null,
    stage: '',
    description: '',
    acceptance_criteria: '',
    inspection_type: 'witness',
    reference_standard: '',
    required_by_stage: '',
    notes: '',
  })
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof NewItpItemInput>(
    k: K,
    v: NewItpItemInput[K],
  ) => setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.stage.trim() || !form.description.trim()) {
      toast.error('A stage and a description, please.')
      return
    }
    setBusy(true)
    try {
      await createItpItem(projectId, form)
      toast.success('Inspection point added')
      await onDone()
    } catch (err) {
      toast.error('Could not add that point', { description: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="paper space-y-4 p-5" noValidate>
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Stage" htmlFor="itp_stage">
          <Input
            id="itp_stage"
            required
            value={form.stage}
            onChange={(e) => set('stage', e.target.value)}
            className="h-12 text-base"
            placeholder="Ground floor slab"
          />
        </FieldRow>
        <FieldRow label="Type" htmlFor="itp_type">
          <Select
            id="itp_type"
            value={form.inspection_type}
            onChange={(e) => set('inspection_type', e.target.value as ItpType)}
          >
            {ITP_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </FieldRow>
      </div>

      <p className="text-xs text-muted-foreground">
        {ITP_TYPES.find((t) => t.value === form.inspection_type)?.hint}
      </p>

      <FieldRow label="Inspection point" htmlFor="itp_desc">
        <Input
          id="itp_desc"
          required
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          className="h-12 text-base"
          placeholder="Reinforcement before concreting"
        />
      </FieldRow>

      <FieldRow label="Acceptance criteria" htmlFor="itp_accept">
        <Textarea
          id="itp_accept"
          value={form.acceptance_criteria}
          onChange={(e) => set('acceptance_criteria', e.target.value)}
          placeholder="Cover, spacing, laps and cleanliness as per drawing"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Standard" htmlFor="itp_std">
          <Input
            id="itp_std"
            value={form.reference_standard}
            onChange={(e) => set('reference_standard', e.target.value)}
            className="h-12 text-base"
            placeholder="IS 456"
          />
        </FieldRow>
        <FieldRow label="Required by" htmlFor="itp_by">
          <Input
            id="itp_by"
            value={form.required_by_stage}
            onChange={(e) => set('required_by_stage', e.target.value)}
            className="h-12 text-base"
            placeholder="Before pour"
          />
        </FieldRow>
      </div>

      {activities.length > 0 && (
        <FieldRow
          label="Guards which activity"
          htmlFor="itp_act"
          hint="A hold point blocks progress on everything that depends on this activity."
        >
          <Select
            id="itp_act"
            value={form.activity_id ?? ''}
            onChange={(e) => set('activity_id', e.target.value || null)}
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

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Saving…' : 'Add point'}
        </Button>
        <Button type="button" variant="ghost" className="h-12" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/* ---------------- photos ---------------- */

function PhotoPicker({
  files,
  onChange,
  id,
}: {
  files: File[]
  onChange: (f: File[]) => void
  id: string
}) {
  async function pick(list: FileList | null) {
    if (!list?.length) return
    try {
      const out: File[] = []
      for (const f of Array.from(list)) out.push(await compressImage(f))
      onChange([...files, ...out])
    } catch {
      toast.error('Could not process that photo.')
    }
  }

  return (
    <FieldRow
      label="Photos"
      htmlFor={id}
      hint={
        files.length > 0
          ? `${files.length} attached — compressed to under 300 KB each.`
          : 'Optional. Camera opens directly.'
      }
    >
      <input
        id={id}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="sr-only"
        onChange={(e) => void pick(e.target.files)}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-12 flex-1 text-base"
          onClick={() => document.getElementById(id)?.click()}
        >
          {files.length > 0 ? 'Add another' : 'Take photo'}
        </Button>
        {files.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="h-12"
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        )}
      </div>
    </FieldRow>
  )
}

function PhotoStrip({ paths }: { paths: string[] }) {
  const [urls, setUrls] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all(paths.map((p) => signedSitePhotoUrl(p))).then((r) => {
      if (!cancelled) setUrls(r.filter((u): u is string => u !== null))
    })
    return () => {
      cancelled = true
    }
  }, [paths])

  if (urls.length === 0) return null

  return (
    <div className="mt-2 flex gap-2 overflow-x-auto">
      {urls.map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer" className="shrink-0">
          <img
            src={u}
            alt="Inspection photo"
            className="h-24 rounded-lg object-cover ring-1 ring-foreground/10"
          />
        </a>
      ))}
    </div>
  )
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}
