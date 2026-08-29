import { CalendarClock, Paperclip } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { DeleteButton } from '@/components/DeleteAction'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  createComplianceItem,
  fetchActivePeople,
  fetchCompliance,
  fileCompliance,
  unfileCompliance,
  updateComplianceItem,
} from '@/lib/queries/compliance'
import { signedComplianceUrl, uploadComplianceProof } from '@/lib/storage'
import {
  canManageCompliance,
  canUnfileCompliance,
  COMPLIANCE_CATEGORIES,
  COMPLIANCE_CATEGORY_LABEL,
  COMPLIANCE_DISPLAY_LABEL,
  COMPLIANCE_RECURRENCE_LABEL,
  COMPLIANCE_RECURRENCES,
  type ComplianceCategory,
  type ComplianceDisplayStatus,
  type ComplianceRecurrence,
  type ComplianceRow,
  type NewComplianceInput,
  type UserRole,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/* Colour is the whole point of this screen: green upcoming, amber inside a
   week, red past due. Filed drops to a neutral tone — it's done. */
const TONE: Record<ComplianceDisplayStatus, string> = {
  overdue: 'bg-destructive/10 text-destructive',
  due_soon:
    'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  upcoming:
    'bg-[color-mix(in_oklab,var(--positive)_12%,transparent)] text-[var(--positive)]',
  filed: 'bg-secondary text-muted-foreground',
}

const RAIL: Record<ComplianceDisplayStatus, string> = {
  overdue: 'bg-destructive',
  due_soon: 'bg-[var(--warning)]',
  upcoming: 'bg-[var(--positive)]',
  filed: 'bg-border',
}

type Scope = 'open' | 'filed' | 'all'

export default function Compliance() {
  const role = useAuth((s) => s.role)
  const selectedProject = useProjects((s) => s.selectedId)
  const mayManage = canManageCompliance(role)

  const [rows, setRows] = useState<ComplianceRow[] | null>(null)
  const [scope, setScope] = useState<Scope>('open')
  const [category, setCategory] = useState<ComplianceCategory | ''>('')
  const [projectScope, setProjectScope] = useState<'all' | 'company' | 'this'>(
    'all',
  )
  const [editing, setEditing] = useState<ComplianceRow | null>(null)
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async () => {
    try {
      setRows(await fetchCompliance())
    } catch (err) {
      toast.error('Could not load the compliance calendar', {
        description: errText(err),
      })
      setRows([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const shown = useMemo(() => {
    if (!rows) return null
    return rows.filter((r) => {
      if (scope === 'open' && r.display_status === 'filed') return false
      if (scope === 'filed' && r.display_status !== 'filed') return false
      if (category !== '' && r.category !== category) return false
      if (projectScope === 'company' && r.project_id !== null) return false
      if (projectScope === 'this' && r.project_id !== selectedProject)
        return false
      return true
    })
  }, [rows, scope, category, projectScope, selectedProject])

  // Grouped by month so the list reads as a calendar rather than a queue.
  const months = useMemo(() => {
    if (!shown) return []
    const map = new Map<string, ComplianceRow[]>()
    for (const r of shown) {
      const key = r.due_date.slice(0, 7)
      const list = map.get(key)
      if (list) list.push(r)
      else map.set(key, [r])
    }
    return [...map.entries()]
  }, [shown])

  const overdue = rows?.filter((r) => r.display_status === 'overdue').length ?? 0
  const soon = rows?.filter((r) => r.display_status === 'due_soon').length ?? 0

  if (adding || editing) {
    return (
      <ItemForm
        item={editing}
        onCancel={() => {
          setAdding(false)
          setEditing(null)
        }}
        onSaved={async () => {
          setAdding(false)
          setEditing(null)
          await reload()
        }}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      {mayManage && (
        <Button className="h-12 w-full text-base" onClick={() => setAdding(true)}>
          Add deadline
        </Button>
      )}

      {rows !== null && (overdue > 0 || soon > 0) && (
        <div className="paper flex flex-wrap items-baseline gap-x-5 gap-y-1 p-4">
          {overdue > 0 && (
            <span className="text-sm font-medium text-destructive tabular-nums">
              {overdue} overdue
            </span>
          )}
          {soon > 0 && (
            <span className="text-sm font-medium text-[var(--warning)] tabular-nums">
              {soon} due within 7 days
            </span>
          )}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex gap-1">
          {(['open', 'filed', 'all'] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={cn(
                'min-h-11 rounded-lg px-3.5 text-sm font-medium transition-colors',
                scope === s
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s === 'open' ? 'Outstanding' : s === 'filed' ? 'Filed' : 'All'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Select
            value={category}
            onChange={(e) =>
              setCategory(e.target.value as ComplianceCategory | '')
            }
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {COMPLIANCE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>

          <Select
            value={projectScope}
            onChange={(e) =>
              setProjectScope(e.target.value as 'all' | 'company' | 'this')
            }
            aria-label="Filter by project"
          >
            <option value="all">Company + projects</option>
            <option value="company">Company-wide only</option>
            <option value="this">This project only</option>
          </Select>
        </div>
      </div>

      {rows === null && <ListSkeleton rows={4} />}

      {shown?.length === 0 && (
        <EmptyState
          icon={CalendarClock}
          title={
            scope === 'open'
              ? 'Nothing outstanding'
              : scope === 'filed'
                ? 'Nothing filed yet'
                : 'No deadlines tracked'
          }
          body={
            scope === 'open'
              ? 'Every tracked deadline has been filed.'
              : 'Add GST, TDS, PF, licence renewals and permits once — recurring ones create their next occurrence automatically when you file them.'
          }
          actionLabel={mayManage && scope !== 'open' ? 'Add deadline' : undefined}
          onAction={mayManage && scope !== 'open' ? () => setAdding(true) : undefined}
        />
      )}

      {months.map(([month, items]) => (
        <section key={month} className="space-y-3">
          <p className="pt-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            {monthLabel(month)}
          </p>
          <Stagger className="card-grid">
            {items.map((item) => (
              <RevealItem key={item.id}>
                <ItemCard
                  item={item}
                  role={role}
                  onChanged={reload}
                  onEdit={() => setEditing(item)}
                />
              </RevealItem>
            ))}
          </Stagger>
        </section>
      ))}
    </div>
  )
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  })
}

function dueLabel(item: ComplianceRow): string {
  if (item.display_status === 'filed') {
    return item.filed_date ? `Filed ${item.filed_date}` : 'Filed'
  }
  const d = item.days_until
  if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue`
  if (d === 0) return 'Due today'
  if (d === 1) return 'Due tomorrow'
  return `Due in ${d} days`
}

/* ---------------- One item ---------------- */

function ItemCard({
  item,
  role,
  onChanged,
  onEdit,
}: {
  item: ComplianceRow
  role: UserRole | null
  onChanged: () => Promise<void>
  onEdit: () => void
}) {
  const [filing, setFiling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [filedDate, setFiledDate] = useState(todayIst())
  const [proof, setProof] = useState<File | null>(null)
  const [note, setNote] = useState('')

  const mayManage = canManageCompliance(role)
  const mayUnfile = canUnfileCompliance(role)

  async function save() {
    setBusy(true)
    try {
      let path: string | null = null
      if (proof) path = await uploadComplianceProof(item.project_id, proof)

      const nextId = await fileCompliance(item.id, filedDate, path, note)

      toast.success(`${item.title} marked filed`, {
        description:
          nextId && item.recurrence !== 'one_time'
            ? 'The next occurrence has been added to the calendar.'
            : undefined,
      })
      setFiling(false)
      setProof(null)
      setNote('')
      await onChanged()
    } catch (err) {
      toast.error('Could not record the filing', { description: errText(err) })
    }
    setBusy(false)
  }

  async function reopen() {
    setBusy(true)
    try {
      await unfileCompliance(item.id)
      toast.success('Filing reopened', {
        description: 'The proof was cleared — attach the correct one when you refile.',
      })
      await onChanged()
    } catch (err) {
      toast.error('Could not reopen the filing', { description: errText(err) })
    }
    setBusy(false)
  }

  async function openProof() {
    if (!item.proof_path) return
    const url = await signedComplianceUrl(item.proof_path)
    if (url) window.open(url, '_blank', 'noopener')
    else toast.error('Could not open that file')
  }

  return (
    <article className="paper relative overflow-hidden p-5 pl-6">
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-1',
          RAIL[item.display_status],
        )}
        aria-hidden="true"
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[17px] leading-tight font-semibold">
            {item.title}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-2 text-sm text-muted-foreground">
            <span>{COMPLIANCE_CATEGORY_LABEL[item.category]}</span>
            <span aria-hidden="true">·</span>
            <span>{item.project_name ?? 'Company-wide'}</span>
            {item.recurrence !== 'one_time' && (
              <>
                <span aria-hidden="true">·</span>
                <span>{COMPLIANCE_RECURRENCE_LABEL[item.recurrence]}</span>
              </>
            )}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            TONE[item.display_status],
          )}
        >
          {COMPLIANCE_DISPLAY_LABEL[item.display_status]}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="figure text-[15px] font-semibold tabular-nums">
          {item.due_date}
        </p>
        <p
          className={cn(
            'text-[13px]',
            item.display_status === 'overdue'
              ? 'text-destructive'
              : item.display_status === 'due_soon'
                ? 'text-[var(--warning)]'
                : 'text-muted-foreground',
          )}
        >
          {dueLabel(item)}
        </p>
        {item.responsible_name && (
          <p className="text-[13px] text-muted-foreground">
            {item.responsible_name}
          </p>
        )}
      </div>

      {item.notes && <p className="mt-2 text-sm">{item.notes}</p>}

      {item.proof_path && (
        <button
          type="button"
          onClick={() => void openProof()}
          className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-primary"
        >
          <Paperclip className="size-4" aria-hidden="true" />
          Proof of filing
        </button>
      )}

      {filing && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <FieldRow label="Filed on" htmlFor={`fd-${item.id}`}>
            <Input
              id={`fd-${item.id}`}
              type="date"
              value={filedDate}
              onChange={(e) => e.target.value && setFiledDate(e.target.value)}
              className="h-12"
            />
          </FieldRow>

          <FieldRow
            label="Proof of filing"
            htmlFor={`pf-${item.id}`}
            hint="Acknowledgement PDF or a photo of the challan. PDFs are stored byte-for-byte."
          >
            <Input
              id={`pf-${item.id}`}
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setProof(e.target.files?.[0] ?? null)}
              className="h-12 text-base"
            />
          </FieldRow>

          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reference number, portal, anything worth keeping."
            aria-label="Notes"
          />

          <div className="flex gap-2">
            <Button className="h-11 flex-1" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Confirm filed'}
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => setFiling(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!filing && (
        <div className="mt-4 flex flex-wrap gap-2">
          {mayManage && item.display_status !== 'filed' && (
            <Button disabled={busy} onClick={() => setFiling(true)}>
              Mark filed
            </Button>
          )}
          {mayManage && item.display_status !== 'filed' && (
            <Button variant="outline" disabled={busy} onClick={onEdit}>
              Edit
            </Button>
          )}
          {mayUnfile && item.display_status === 'filed' && (
            <Button variant="ghost" disabled={busy} onClick={() => void reopen()}>
              Reopen
            </Button>
          )}
          {/* fn_delete_record refuses a filed item — it holds the proof. */}
          {item.display_status !== 'filed' && (
            <DeleteButton
              table="compliance_items"
              id={item.id}
              name={`${item.title} · due ${item.due_date}`}
              role={role}
              onDeleted={onChanged}
            />
          )}
        </div>
      )}
    </article>
  )
}

/* ---------------- Add / edit ---------------- */

function ItemForm({
  item,
  onCancel,
  onSaved,
}: {
  item: ComplianceRow | null
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const selectedProject = useProjects((s) => s.selectedId)
  const projects = useProjects((s) => s.projects)

  const [people, setPeople] = useState<{ id: string; full_name: string }[]>([])
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<NewComplianceInput>({
    title: item?.title ?? '',
    category: item?.category ?? 'gst',
    project_id: item ? item.project_id : null,
    due_date: item?.due_date ?? todayIst(),
    recurrence: item?.recurrence ?? 'monthly',
    responsible: item?.responsible ?? null,
    notes: item?.notes ?? '',
  })

  useEffect(() => {
    fetchActivePeople()
      .then(setPeople)
      .catch(() => {})
  }, [])

  const set = <K extends keyof NewComplianceInput>(
    k: K,
    v: NewComplianceInput[K],
  ) => setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (form.title.trim() === '') {
      toast.error('Give the deadline a name')
      return
    }

    setSaving(true)
    try {
      if (item) {
        await updateComplianceItem(item.id, form)
        toast.success('Deadline updated')
      } else {
        await createComplianceItem(form)
        toast.success('Deadline added')
      }
      await onSaved()
    } catch (err) {
      toast.error('Could not save the deadline', { description: errText(err) })
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="paper mb-6 space-y-5 p-5" noValidate>
      <p className="font-heading text-[18px] font-semibold">
        {item ? 'Edit deadline' : 'New deadline'}
      </p>

      <FieldRow label="What is due" htmlFor="c-title">
        <Input
          id="c-title"
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="e.g. GSTR-3B for July"
          className="h-12 text-base"
          autoFocus
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Category" htmlFor="c-cat">
          <Select
            id="c-cat"
            value={form.category}
            onChange={(e) =>
              set('category', e.target.value as ComplianceCategory)
            }
          >
            {COMPLIANCE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </FieldRow>

        <FieldRow label="Due date" htmlFor="c-due">
          <Input
            id="c-due"
            type="date"
            value={form.due_date}
            onChange={(e) => e.target.value && set('due_date', e.target.value)}
            className="h-12"
          />
        </FieldRow>
      </div>

      <FieldRow
        label="Applies to"
        htmlFor="c-proj"
        hint="A GST return belongs to the company; a building permit belongs to one site."
      >
        <Select
          id="c-proj"
          value={form.project_id ?? ''}
          onChange={(e) => set('project_id', e.target.value || null)}
        >
          <option value="">Company-wide</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.id === selectedProject ? ' (current)' : ''}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow
        label="Repeats"
        htmlFor="c-rec"
        hint="Filing a recurring deadline creates the next one automatically, counted from the due date."
      >
        <Select
          id="c-rec"
          value={form.recurrence}
          onChange={(e) =>
            set('recurrence', e.target.value as ComplianceRecurrence)
          }
        >
          {COMPLIANCE_RECURRENCES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow label="Responsible" htmlFor="c-resp">
        <Select
          id="c-resp"
          value={form.responsible ?? ''}
          onChange={(e) => set('responsible', e.target.value || null)}
        >
          <option value="">Nobody assigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow label="Notes" htmlFor="c-notes">
        <Textarea
          id="c-notes"
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder="Portal, login, who files it, anything the next person needs."
        />
      </FieldRow>

      <div className="flex gap-3">
        <Button type="submit" disabled={saving} className="h-12 flex-1 text-base">
          {saving ? 'Saving…' : item ? 'Save changes' : 'Add deadline'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}
