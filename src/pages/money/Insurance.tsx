import { Paperclip, ShieldCheck } from 'lucide-react'
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
import { formatInr } from '@/lib/format'
import {
  createPolicy,
  fetchPolicies,
  setPolicyStatus,
} from '@/lib/queries/insurance'
import { signedComplianceUrl, uploadComplianceProof } from '@/lib/storage'
import {
  canManageInsurance,
  INSURANCE_DISPLAY_LABEL,
  INSURANCE_TYPE_LABEL,
  INSURANCE_TYPES,
  type InsuranceDisplayStatus,
  type InsuranceType,
  type NewPolicyInput,
  type PolicyRow,
  type UserRole,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const TONE: Record<InsuranceDisplayStatus, string> = {
  active:
    'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  expiring:
    'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  expired: 'bg-destructive/10 text-destructive',
  renewed: 'bg-secondary text-muted-foreground',
  cancelled: 'bg-secondary text-muted-foreground',
}

type Scope = 'live' | 'all'

export default function Insurance() {
  const role = useAuth((s) => s.role)
  const selectedProject = useProjects((s) => s.selectedId)
  const mayManage = canManageInsurance(role)

  const [rows, setRows] = useState<PolicyRow[] | null>(null)
  const [scope, setScope] = useState<Scope>('live')
  const [where, setWhere] = useState<'all' | 'company' | 'this'>('all')
  const [adding, setAdding] = useState(false)
  const [renewing, setRenewing] = useState<PolicyRow | null>(null)

  const reload = useCallback(async () => {
    try {
      setRows(await fetchPolicies())
    } catch (err) {
      toast.error('Could not load the policy register', {
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
    return rows.filter((p) => {
      if (
        scope === 'live' &&
        (p.display_status === 'renewed' || p.display_status === 'cancelled')
      )
        return false
      if (where === 'company' && p.project_id !== null) return false
      if (where === 'this' && p.project_id !== selectedProject) return false
      return true
    })
  }, [rows, scope, where, selectedProject])

  if (adding || renewing) {
    return (
      <PolicyForm
        renewalOf={renewing}
        onCancel={() => {
          setAdding(false)
          setRenewing(null)
        }}
        onSaved={async () => {
          setAdding(false)
          setRenewing(null)
          await reload()
        }}
      />
    )
  }

  const expiring = rows?.filter((p) => p.display_status === 'expiring').length ?? 0
  const expired = rows?.filter((p) => p.display_status === 'expired').length ?? 0

  return (
    <div className="space-y-4 pb-6">
      {mayManage && (
        <Button className="h-12 w-full text-base" onClick={() => setAdding(true)}>
          Add policy
        </Button>
      )}

      {(expiring > 0 || expired > 0) && (
        <p
          className={cn(
            'rounded-lg px-3 py-2 text-sm',
            expired > 0
              ? 'bg-destructive/10 text-destructive'
              : 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
          )}
        >
          {expired > 0 && `${expired} policy${expired === 1 ? '' : ' policies'} expired`}
          {expired > 0 && expiring > 0 && ' · '}
          {expiring > 0 && `${expiring} expiring within 30 days`}
          {' — renew before the cover gap opens.'}
        </p>
      )}

      <div className="space-y-2">
        <div className="flex gap-1">
          {(['live', 'all'] as Scope[]).map((s) => (
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
              {s === 'live' ? 'Current' : 'All including history'}
            </button>
          ))}
        </div>

        <Select
          value={where}
          onChange={(e) => setWhere(e.target.value as 'all' | 'company' | 'this')}
          aria-label="Filter by cover scope"
        >
          <option value="all">Company + projects</option>
          <option value="company">Company-wide only</option>
          <option value="this">This project only</option>
        </Select>
      </div>

      {rows === null && <ListSkeleton rows={3} />}

      {shown?.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title={scope === 'live' ? 'No cover on the register' : 'Nothing here'}
          body="CAR, workmen's compensation, professional indemnity and third-party liability — with expiry dates the app will chase for you."
          actionLabel={mayManage ? 'Add policy' : undefined}
          onAction={mayManage ? () => setAdding(true) : undefined}
        />
      )}

      {shown && shown.length > 0 && (
        <Stagger className="space-y-3">
          {shown.map((p) => (
            <RevealItem key={p.id}>
              <PolicyCard
                policy={p}
                role={role}
                onChanged={reload}
                onRenew={() => setRenewing(p)}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ---------------- One policy ---------------- */

function PolicyCard({
  policy: p,
  role,
  onChanged,
  onRenew,
}: {
  policy: PolicyRow
  role: UserRole | null
  onChanged: () => Promise<void>
  onRenew: () => void
}) {
  const [busy, setBusy] = useState(false)
  const mayManage = canManageInsurance(role)
  const closed =
    p.display_status === 'renewed' || p.display_status === 'cancelled'

  async function move(next: 'active' | 'renewed' | 'cancelled') {
    setBusy(true)
    try {
      await setPolicyStatus(p.id, next)
      toast.success(next === 'active' ? 'Marked active' : `Marked ${next}`)
      await onChanged()
    } catch (err) {
      toast.error('Could not update the policy', { description: errText(err) })
    }
    setBusy(false)
  }

  async function openDoc() {
    if (!p.file_path) return
    const url = await signedComplianceUrl(p.file_path)
    if (url) window.open(url, '_blank', 'noopener')
    else toast.error('Could not open the policy document')
  }

  return (
    <article className={cn('paper p-5', closed && 'opacity-75')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[17px] leading-tight font-semibold">
            {INSURANCE_TYPE_LABEL[p.policy_type]}
          </p>
          <p className="mt-0.5 truncate text-sm">
            {p.policy_number} · {p.insurer}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {p.project_name ?? 'Company-wide'}
            {p.broker && ` · via ${p.broker}`}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            TONE[p.display_status],
          )}
        >
          {INSURANCE_DISPLAY_LABEL[p.display_status]}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t border-border pt-3">
        {p.sum_insured !== null && (
          <div>
            <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
              Sum insured
            </p>
            <p className="figure text-[19px] font-semibold">
              {formatInr(p.sum_insured)}
            </p>
          </div>
        )}
        {p.premium !== null && (
          <div>
            <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
              Premium
            </p>
            <p className="text-sm font-medium tabular-nums">
              {formatInr(p.premium)}
            </p>
          </div>
        )}
        <div>
          <p className="text-[11px] tracking-[0.1em] text-muted-foreground uppercase">
            Expires
          </p>
          <p
            className={cn(
              'text-sm font-medium tabular-nums',
              p.display_status === 'expired' && 'text-destructive',
              p.display_status === 'expiring' && 'text-[var(--warning)]',
            )}
          >
            {p.expiry_date}
            {!closed &&
              ` · ${
                p.days_to_expiry < 0
                  ? `${Math.abs(p.days_to_expiry)} days ago`
                  : `${p.days_to_expiry} days`
              }`}
          </p>
        </div>
      </div>

      {p.notes && <p className="mt-3 text-sm">{p.notes}</p>}

      {p.has_successor && (
        <p className="mt-2 text-xs text-muted-foreground">
          A later policy renews this one — it stays as the record of what was
          covered.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {p.file_path && (
          <Button variant="outline" size="sm" className="h-9" onClick={() => void openDoc()}>
            <Paperclip className="size-4" aria-hidden="true" />
            Policy
          </Button>
        )}
        {mayManage && !closed && (
          <Button size="sm" className="h-9" onClick={onRenew}>
            Renew
          </Button>
        )}
        {mayManage && !closed && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            disabled={busy}
            onClick={() => void move('cancelled')}
          >
            Mark cancelled
          </Button>
        )}
        {mayManage && closed && !p.has_successor && (
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
        {/* fn_delete_record refuses a policy another one renews. */}
        {!p.has_successor && (
          <DeleteButton
            table="insurance_policies"
            id={p.id}
            name={`${p.policy_number} · ${p.insurer}`}
            role={role}
            onDeleted={onChanged}
          />
        )}
      </div>
    </article>
  )
}

/* ---------------- Add / renew ---------------- */

/**
 * Renewing prefills from the old policy and links back to it through
 * `renewed_from`, then marks the old one renewed. Editing the dates in place
 * would erase what was covered last year — the one thing you need when a claim
 * arrives late.
 */
function PolicyForm({
  renewalOf,
  onCancel,
  onSaved,
}: {
  renewalOf: PolicyRow | null
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const selectedProject = useProjects((s) => s.selectedId)
  const projects = useProjects((s) => s.projects)

  const [form, setForm] = useState<NewPolicyInput>({
    project_id: renewalOf ? renewalOf.project_id : null,
    policy_type: renewalOf?.policy_type ?? 'car',
    policy_number: '',
    insurer: renewalOf?.insurer ?? '',
    broker: renewalOf?.broker ?? '',
    sum_insured: renewalOf?.sum_insured ?? null,
    premium: null,
    start_date: renewalOf?.expiry_date ?? null,
    expiry_date: '',
    file_path: null,
    notes: '',
    renewed_from: renewalOf?.id ?? null,
  })
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const set = <K extends keyof NewPolicyInput>(k: K, v: NewPolicyInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (form.policy_number.trim() === '') {
      toast.error('Enter the policy number')
      return
    }
    if (form.insurer.trim() === '') {
      toast.error('Enter the insurer')
      return
    }
    if (form.expiry_date === '') {
      toast.error('A policy without an expiry date cannot be tracked')
      return
    }

    setBusy(true)
    try {
      let path: string | null = null
      if (file) {
        setStatus('Uploading the policy…')
        path = await uploadComplianceProof(form.project_id, file)
      }

      setStatus('Saving…')
      await createPolicy({ ...form, file_path: path })

      // Only after the replacement exists — otherwise a failure here would
      // leave the old policy marked renewed with nothing renewing it.
      if (renewalOf) {
        await setPolicyStatus(renewalOf.id, 'renewed')
      }

      toast.success(
        renewalOf ? 'Policy renewed' : `${form.policy_number.trim()} added`,
        {
          description: renewalOf
            ? 'The previous policy stays on the register as history.'
            : 'You will be warned 30 days before it expires.',
        },
      )
      await onSaved()
    } catch (err) {
      // The unique index on (insurer, policy number) catches a duplicate.
      toast.error('Could not save the policy', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={submit} className="paper mb-6 space-y-5 p-5" noValidate>
      <div>
        <p className="font-heading text-[18px] font-semibold">
          {renewalOf ? 'Renew policy' : 'New policy'}
        </p>
        {renewalOf && (
          <p className="mt-1 text-sm text-muted-foreground">
            Replacing {renewalOf.policy_number} · expires{' '}
            {renewalOf.expiry_date}
          </p>
        )}
      </div>

      <FieldRow label="Cover" htmlFor="ip-type">
        <Select
          id="ip-type"
          value={form.policy_type}
          onChange={(e) => set('policy_type', e.target.value as InsuranceType)}
        >
          {INSURANCE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow
        label="Applies to"
        htmlFor="ip-proj"
        hint="A CAR policy covers one site; professional indemnity covers the practice."
      >
        <Select
          id="ip-proj"
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

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Policy number" htmlFor="ip-no">
          <Input
            id="ip-no"
            value={form.policy_number}
            onChange={(e) => set('policy_number', e.target.value)}
            className="h-12 text-base"
            autoFocus
          />
        </FieldRow>

        <FieldRow label="Insurer" htmlFor="ip-insurer">
          <Input
            id="ip-insurer"
            value={form.insurer}
            onChange={(e) => set('insurer', e.target.value)}
            placeholder="e.g. New India Assurance"
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      <FieldRow label="Broker" htmlFor="ip-broker" hint="Optional.">
        <Input
          id="ip-broker"
          value={form.broker}
          onChange={(e) => set('broker', e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Sum insured (₹)" htmlFor="ip-sum">
          <Input
            id="ip-sum"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={form.sum_insured ?? ''}
            onChange={(e) =>
              set('sum_insured', e.target.value === '' ? null : Number(e.target.value))
            }
            className="h-12 tabular-nums"
          />
        </FieldRow>

        <FieldRow label="Premium (₹)" htmlFor="ip-prem">
          <Input
            id="ip-prem"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={form.premium ?? ''}
            onChange={(e) =>
              set('premium', e.target.value === '' ? null : Number(e.target.value))
            }
            className="h-12 tabular-nums"
          />
        </FieldRow>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Starts" htmlFor="ip-start">
          <Input
            id="ip-start"
            type="date"
            value={form.start_date ?? ''}
            onChange={(e) => set('start_date', e.target.value || null)}
            className="h-12"
          />
        </FieldRow>

        <FieldRow label="Expires" htmlFor="ip-exp">
          <Input
            id="ip-exp"
            type="date"
            value={form.expiry_date}
            onChange={(e) => set('expiry_date', e.target.value)}
            className="h-12"
          />
        </FieldRow>
      </div>

      <FieldRow
        label="Policy document"
        htmlFor="ip-file"
        hint="PDF or photo. Stored in the same private bucket as compliance proofs."
      >
        <Input
          id="ip-file"
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Notes" htmlFor="ip-notes">
        <Textarea
          id="ip-notes"
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder="Exclusions, deductibles, anything worth knowing at renewal."
        />
      </FieldRow>

      {status && <p className="text-xs text-muted-foreground">{status}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Saving…' : renewalOf ? 'Save renewal' : 'Add policy'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}
