import { Scale, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import { fetchMaterials } from '@/lib/queries/materials'
import {
  comparisonFromPr,
  createComparison,
  fetchComparisons,
  fetchOpenRequests,
} from '@/lib/queries/rateComparison'
import {
  canAwardComparison,
  canSeeComparisons,
  type ComparisonSummary,
  type Material,
  RC_STATUS_LABEL,
  type RcStatus,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'
import ComparisonDetail from './ComparisonDetail'

const STATUS_TONE: Record<RcStatus, string> = {
  draft:
    'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  decided:
    'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  ordered: 'bg-secondary text-secondary-foreground',
}

/**
 * Rate comparison — the step between a requisition and an order.
 *
 * The screen exists to answer one question in front of a client: did you get
 * more than one price, and if you did not take the cheapest, why not. Every
 * figure on it comes from Postgres; the browser formats and nothing else.
 *
 * A supervisor cannot reach this route (the /money guard) and would see zero
 * rows if they did (RLS on rate_comparisons), so the "restricted" line below is
 * the third layer, not the boundary.
 */
export default function Comparisons() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  const [rows, setRows] = useState<ComparisonSummary[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setRows(await fetchComparisons(projectId))
    } catch (err) {
      toast.error('Could not load rate comparisons', {
        description: errText(err),
      })
      setRows([])
    }
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (!canSeeComparisons(role)) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Rate comparisons carry vendor rates, so they are restricted for your
        role.
      </p>
    )
  }

  if (openId) {
    return (
      <ComparisonDetail
        comparisonId={openId}
        onBack={() => {
          setOpenId(null)
          void reload()
        }}
      />
    )
  }

  if (creating && projectId) {
    return (
      <NewComparisonForm
        projectId={projectId}
        onDone={(id) => {
          setCreating(false)
          void reload()
          if (id) setOpenId(id)
        }}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      <Button
        className="h-12 w-full text-base"
        onClick={() => setCreating(true)}
      >
        New comparison
      </Button>

      {rows === null && <ListSkeleton rows={3} />}

      {rows !== null && rows.length === 0 && (
        <>
          <EmptyState
            icon={Scale}
            title="No rate comparisons yet"
            body="Put two or more quotes side by side, pick the rate, and keep the reason on record."
            actionLabel="Start one"
            onAction={() => setCreating(true)}
          />
          <OtherProjectsHint />
        </>
      )}

      {rows && rows.length > 0 && (
        <Stagger className="space-y-3">
          {rows.map((c) => (
            <RevealItem key={c.comparison_id}>
              <ComparisonCard
                c={c}
                mayAward={canAwardComparison(role)}
                onOpen={() => setOpenId(c.comparison_id)}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function ComparisonCard({
  c,
  mayAward,
  onOpen,
}: {
  c: ComparisonSummary
  mayAward: boolean
  onOpen: () => void
}) {
  // The saving the comparison actually produced, against the dearest complete
  // quote. Null until at least two vendors have priced every line — a "saving"
  // computed off one quote is a number with nothing to compare it to.
  const spread =
    c.lowest_total !== null &&
    c.highest_total !== null &&
    c.highest_total > c.lowest_total
      ? c.highest_total - c.lowest_total
      : null

  return (
    <article className="paper p-5">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="font-heading text-[17px] font-semibold">{c.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {c.comparison_no} · {c.item_count}{' '}
            {c.item_count === 1 ? 'item' : 'items'} · {c.vendor_count}{' '}
            {c.vendor_count === 1 ? 'quote' : 'quotes'}
            {c.need_by && ` · need by ${c.need_by}`}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            STATUS_TONE[c.status],
          )}
        >
          {RC_STATUS_LABEL[c.status]}
        </span>
      </button>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <Figure
          label="Lowest quote"
          value={c.lowest_total === null ? '—' : formatInr(c.lowest_total)}
          hint={
            c.vendor_count < 2
              ? 'needs a second quote'
              : c.lowest_total === null
                ? 'no vendor priced every line'
                : spread !== null
                  ? `spread ${formatInr(spread)}`
                  : 'single complete quote'
          }
        />
        <Figure
          label="Awarded"
          value={
            c.items_awarded === 0 ? '—' : formatInr(c.awarded_subtotal)
          }
          hint={
            c.items_awarded === 0
              ? 'nothing chosen yet'
              : `${c.items_awarded} of ${c.item_count} lines`
          }
        />
        <Figure
          label="Off lowest"
          value={String(c.awarded_off_lowest)}
          tone={c.awarded_off_lowest > 0 ? 'warning' : undefined}
          hint={
            c.awarded_off_lowest > 0 ? 'reason recorded' : 'all at lowest rate'
          }
        />
      </div>

      {c.status === 'draft' && c.vendor_count < 2 && mayAward && (
        <p className="mt-4 rounded-lg bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] px-3 py-2 text-xs text-[var(--warning)]">
          One quote is not a comparison. Add a second vendor before awarding.
        </p>
      )}
    </article>
  )
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'warning'
}) {
  return (
    <div>
      <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'figure mt-1 text-[15px] font-semibold',
          tone === 'warning' && 'text-[var(--warning)]',
        )}
      >
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}

/* ---------------- new comparison ---------------- */

interface DraftItem {
  key: number
  material_id: string
  description: string
  unit: string
  qty: string
}

let keySeq = 1

function blank(): DraftItem {
  return { key: keySeq++, material_id: '', description: '', unit: '', qty: '' }
}

/**
 * Two ways in, because both happen in practice: a supervisor has raised a
 * requisition and the office is now sourcing it, or the founder is pricing
 * something before anybody has asked for it.
 */
function NewComparisonForm({
  projectId,
  onDone,
}: {
  projectId: string
  onDone: (id: string | null) => void
}) {
  const [materials, setMaterials] = useState<Material[]>([])
  const [prs, setPrs] = useState<
    { id: string; po_number: string; line_count: number }[]
  >([])

  const [title, setTitle] = useState('')
  const [needBy, setNeedBy] = useState('')
  const [notes, setNotes] = useState('')
  const [fromPr, setFromPr] = useState('')
  const [items, setItems] = useState<DraftItem[]>([blank()])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void fetchMaterials()
      .then(setMaterials)
      .catch(() => setMaterials([]))
    void fetchOpenRequests(projectId)
      .then(setPrs)
      .catch(() => setPrs([]))
  }, [projectId])

  function patch(key: number, change: Partial<DraftItem>) {
    setItems((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)))
  }

  // Picking a material fills the description and unit from the master. They
  // stay editable: the row stores what was ASKED FOR, and renaming a material
  // next month must not restate a statement somebody already signed.
  function pickMaterial(key: number, materialId: string) {
    const m = materials.find((x) => x.id === materialId)
    patch(key, {
      material_id: materialId,
      description: m?.name ?? '',
      unit: m?.unit ?? '',
    })
  }

  async function submit() {
    setBusy(true)
    try {
      if (fromPr) {
        const id = await comparisonFromPr(fromPr, title.trim() || 'Rate comparison')
        toast.success('Comparison built from the requisition', {
          description: 'Add the vendors and their rates next.',
        })
        onDone(id)
        return
      }

      const clean = items
        .filter((l) => l.description.trim() && Number(l.qty) > 0)
        .map((l) => ({
          material_id: l.material_id || null,
          description: l.description,
          unit: l.unit.trim() || 'nos',
          qty: Number(l.qty),
          spec: null,
        }))

      if (clean.length === 0) {
        toast.error('Add at least one item with a quantity')
        setBusy(false)
        return
      }

      const id = await createComparison({
        project_id: projectId,
        title: title.trim() || 'Rate comparison',
        need_by: needBy || null,
        notes,
        items: clean,
      })
      toast.success('Comparison created', {
        description: 'Add the vendors and their rates next.',
      })
      onDone(id)
    } catch (err) {
      toast.error('Could not create the comparison', {
        description: errText(err),
      })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5 pb-6">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        New rate comparison
      </p>

      <FieldRow label="What is being priced" htmlFor="rc_title">
        <Input
          id="rc_title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Bathroom tiles — first floor"
          className="h-12 text-base"
        />
      </FieldRow>

      {prs.length > 0 && (
        <FieldRow
          label="Build from a requisition"
          htmlFor="rc_pr"
          hint="Copies the requested items and quantities. Only requests still awaiting rates appear here — a comparison written after the rates were approved would be a rationale invented after the fact."
        >
          <Select
            id="rc_pr"
            value={fromPr}
            onChange={(e) => setFromPr(e.target.value)}
          >
            <option value="">Enter the items myself</option>
            {prs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.po_number} · {p.line_count}{' '}
                {p.line_count === 1 ? 'item' : 'items'}
              </option>
            ))}
          </Select>
        </FieldRow>
      )}

      {!fromPr && (
        <>
          <div className="space-y-3">
            {items.map((l) => (
              <div key={l.key} className="paper space-y-3 p-4">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <Select
                      aria-label="Material"
                      value={l.material_id}
                      onChange={(e) => pickMaterial(l.key, e.target.value)}
                    >
                      <option value="">Free text (not a stock item)…</option>
                      {materials.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.unit})
                        </option>
                      ))}
                    </Select>
                  </div>
                  {items.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      aria-label="Remove item"
                      onClick={() =>
                        setItems((ls) => ls.filter((x) => x.key !== l.key))
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>

                <Input
                  value={l.description}
                  onChange={(e) => patch(l.key, { description: e.target.value })}
                  placeholder="Description as quoted"
                  className="h-12 text-base"
                />

                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0.01"
                    value={l.qty}
                    onChange={(e) => patch(l.key, { qty: e.target.value })}
                    placeholder="Quantity"
                    className="h-12 text-base tabular-nums"
                  />
                  <Input
                    value={l.unit}
                    onChange={(e) => patch(l.key, { unit: e.target.value })}
                    placeholder="Unit"
                    className="h-12 text-base"
                  />
                </div>
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            onClick={() => setItems((ls) => [...ls, blank()])}
          >
            Add another item
          </Button>

          <p className="text-xs text-muted-foreground">
            An item linked to a material can become a purchase-order line later.
            Free-text items are for things you compare but never stock — a
            labour rate, a hire charge — and cannot be ordered through
            procurement.
          </p>
        </>
      )}

      <FieldRow label="Need by" htmlFor="rc_needby">
        <Input
          id="rc_needby"
          type="date"
          value={needBy}
          onChange={(e) => setNeedBy(e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Notes" htmlFor="rc_notes">
        <Textarea
          id="rc_notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Scope, specification, anything the vendors were told"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="ghost"
          className="h-12"
          onClick={() => onDone(null)}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="h-12"
          onClick={() => void submit()}
          disabled={busy}
        >
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
