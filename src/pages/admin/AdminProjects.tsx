import { Building2, Plus } from 'lucide-react'
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
import { createProject, updateProject } from '@/lib/queries/admin'
import {
  fetchProjectCommercials,
  fetchProjects,
} from '@/lib/queries/projects'
import { fetchSnagSummary, setProjectDlp } from '@/lib/queries/snags'
import {
  PROJECT_STATUS_LABEL,
  type NewProjectInput,
  type Project,
  type ProjectStatus,
} from '@/lib/types'
import { useProjects } from '@/store/project'

const EMPTY: NewProjectInput = {
  name: '',
  client_name: '',
  site_address: '',
  status: 'active',
  contract_value: null,
  management_fee_pct: null,
}

export default function AdminProjects() {
  const reloadStore = useProjects((s) => s.load)

  const [rows, setRows] = useState<Project[] | null>(null)
  const [fees, setFees] = useState<Map<string, number | null>>(new Map())
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)

  const reload = useCallback(async () => {
    try {
      const list = await fetchProjects()
      setRows(list)

      // Commercials live behind the role-gated view (010) — fetch per project.
      const pairs = await Promise.all(
        list.map(async (p) => {
          const c = await fetchProjectCommercials(p.id)
          return [p.id, c?.contract_value ?? null] as const
        }),
      )
      setFees(new Map(pairs))
    } catch (err) {
      toast.error('Could not load projects', { description: errText(err) })
      setRows([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function afterWrite() {
    setAdding(false)
    setEditing(null)
    await reload()
    // The project picker in every other tab reads from this store.
    await reloadStore()
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Projects
        </p>
        {!adding && !editing && (
          <Button onClick={() => setAdding(true)} className="h-11">
            <Plus className="size-4" />
            New project
          </Button>
        )}
      </div>

      {(adding || editing) && (
        <ProjectForm
          project={editing}
          onCancel={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={afterWrite}
        />
      )}

      {rows === null && <ListSkeleton rows={3} />}

      {rows?.length === 0 && !adding && (
        <EmptyState
          icon={Building2}
          title="No projects yet"
          body="Create the first project — everything else in the app hangs off it."
          actionLabel="New project"
          onAction={() => setAdding(true)}
        />
      )}

      {rows && rows.length > 0 && (
        <Stagger className="space-y-3">
          {rows.map((p) => (
            <RevealItem key={p.id}>
              <button
                type="button"
                onClick={() => {
                  setAdding(false)
                  setEditing(p)
                }}
                className="paper w-full p-5 text-left transition-shadow hover:paper-lift"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-heading text-[18px] leading-tight font-semibold">
                      {p.name}
                    </p>
                    {p.client_name && (
                      <p className="mt-1 truncate text-sm text-muted-foreground">
                        {p.client_name}
                      </p>
                    )}
                  </div>
                  <StatusTag status={p.status} />
                </div>

                {fees.get(p.id) != null && (
                  <p className="figure mt-3 text-[15px] font-semibold">
                    {formatInr(fees.get(p.id) as number)}
                    <span className="ml-1.5 font-sans text-[11px] font-normal tracking-[0.1em] text-muted-foreground uppercase">
                      contract
                    </span>
                  </p>
                )}
              </button>
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function StatusTag({ status }: { status: ProjectStatus }) {
  const tone =
    status === 'active'
      ? 'bg-[color-mix(in_oklab,var(--positive)_12%,transparent)] text-[var(--positive)]'
      : status === 'on_hold'
        ? 'bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-[var(--warning)]'
        : 'bg-secondary text-muted-foreground'

  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium tracking-wide ${tone}`}
    >
      {PROJECT_STATUS_LABEL[status]}
    </span>
  )
}

/* ---------------- Form ---------------- */

function ProjectForm({
  project,
  onCancel,
  onSaved,
}: {
  project: Project | null
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const [form, setForm] = useState<NewProjectInput>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [loadingCommercials, setLoadingCommercials] = useState(false)
  // DLP lives on the project row (027) but is read through
  // fn_project_snag_summary, which already returns the window.
  const [dlpStart, setDlpStart] = useState('')
  const [dlpEnd, setDlpEnd] = useState('')

  useEffect(() => {
    if (!project) {
      setForm(EMPTY)
      setDlpStart('')
      setDlpEnd('')
      return
    }

    void fetchSnagSummary(project.id).then((s) => {
      setDlpStart(s?.dlp_start ?? '')
      setDlpEnd(s?.dlp_end ?? '')
    })

    setForm({
      name: project.name,
      client_name: project.client_name ?? '',
      site_address: project.site_address ?? '',
      status: project.status,
      contract_value: null,
      management_fee_pct: null,
    })

    // 010 revoked SELECT on the commercial columns — read them through the view.
    setLoadingCommercials(true)
    void fetchProjectCommercials(project.id)
      .then((c) => {
        if (!c) return
        setForm((f) => ({
          ...f,
          contract_value: c.contract_value,
          management_fee_pct: c.management_fee_pct,
        }))
      })
      .finally(() => setLoadingCommercials(false))
  }, [project])

  const set = <K extends keyof NewProjectInput>(
    k: K,
    v: NewProjectInput[K],
  ) => setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (form.name.trim() === '') {
      toast.error('Give the project a name')
      return
    }

    if (dlpStart !== '' && dlpEnd !== '' && dlpEnd < dlpStart) {
      toast.error('The DLP cannot end before it starts')
      return
    }

    setSaving(true)
    try {
      if (project) {
        await updateProject(project.id, form)
        await setProjectDlp(project.id, dlpStart || null, dlpEnd || null)
        toast.success(`${form.name.trim()} updated`)
      } else {
        const created = await createProject(form)
        if (dlpStart || dlpEnd) {
          await setProjectDlp(created.id, dlpStart || null, dlpEnd || null)
        }
        toast.success(`${form.name.trim()} created`, {
          description: 'Assign the team on the Team tab.',
        })
      }
      await onSaved()
    } catch (err) {
      toast.error(
        project ? 'Could not save the project' : 'Could not create the project',
        { description: errText(err) },
      )
    }
    setSaving(false)
  }

  return (
    <form onSubmit={submit} className="paper space-y-5 p-5">
      <p className="font-heading text-[18px] font-semibold">
        {project ? 'Edit project' : 'New project'}
      </p>

      <FieldRow label="Project name" htmlFor="p-name">
        <Input
          id="p-name"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Bluejay Ardley Villa"
          className="h-12"
          autoFocus
        />
      </FieldRow>

      <FieldRow label="Client" htmlFor="p-client">
        <Input
          id="p-client"
          value={form.client_name}
          onChange={(e) => set('client_name', e.target.value)}
          placeholder="Client name"
          className="h-12"
        />
      </FieldRow>

      <FieldRow label="Site address" htmlFor="p-addr">
        <Textarea
          id="p-addr"
          value={form.site_address}
          onChange={(e) => set('site_address', e.target.value)}
          placeholder="Plot, street, locality, Bengaluru"
        />
      </FieldRow>

      <FieldRow label="Status" htmlFor="p-status">
        <Select
          id="p-status"
          value={form.status}
          onChange={(e) => set('status', e.target.value as ProjectStatus)}
        >
          {(Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[]).map((s) => (
            <option key={s} value={s}>
              {PROJECT_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </FieldRow>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Contract value (₹)" htmlFor="p-cv">
          <Input
            id="p-cv"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={form.contract_value ?? ''}
            onChange={(e) =>
              set(
                'contract_value',
                e.target.value === '' ? null : Number(e.target.value),
              )
            }
            placeholder={loadingCommercials ? 'Loading…' : '0.00'}
            className="h-12 tabular-nums"
          />
        </FieldRow>

        <FieldRow label="Management fee %" htmlFor="p-fee">
          <Input
            id="p-fee"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={form.management_fee_pct ?? ''}
            onChange={(e) =>
              set(
                'management_fee_pct',
                e.target.value === '' ? null : Number(e.target.value),
              )
            }
            placeholder={loadingCommercials ? 'Loading…' : 'e.g. 12'}
            className="h-12 tabular-nums"
          />
        </FieldRow>
      </div>

      <p className="text-xs text-muted-foreground">
        The fee amount is computed in Postgres from these two figures. Both are
        hidden from supervisors by the database, not by this screen.
      </p>

      <div className="border-t border-border pt-5">
        <div className="grid grid-cols-2 gap-4">
          <FieldRow label="DLP starts" htmlFor="p-dlp-s">
            <Input
              id="p-dlp-s"
              type="date"
              value={dlpStart}
              onChange={(e) => setDlpStart(e.target.value)}
              className="h-12"
            />
          </FieldRow>
          <FieldRow label="DLP ends" htmlFor="p-dlp-e">
            <Input
              id="p-dlp-e"
              type="date"
              value={dlpEnd}
              onChange={(e) => setDlpEnd(e.target.value)}
              className="h-12"
            />
          </FieldRow>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Defect liability period — usually handover date plus 12 months. Snags
          raised inside this window are flagged, and the app warns as the end
          date approaches.
        </p>
      </div>

      <div className="flex gap-3 pt-1">
        <Button type="submit" disabled={saving} className="h-12 flex-1 text-base">
          {saving ? 'Saving…' : project ? 'Save changes' : 'Create project'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          className="h-12"
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
