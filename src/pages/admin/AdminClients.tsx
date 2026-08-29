import {
  CircleSlash,
  FileText,
  Image,
  KeyRound,
  MessageSquare,
  Pause,
  Play,
  Receipt,
  Stamp,
  UserRoundPlus,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  createClient,
  fetchClientRoster,
  fetchClientRosterSummary,
  fetchProjectsWithoutClient,
  type ProjectOption,
  setClientActive,
  unlinkClient,
} from '@/lib/queries/clients'
import type {
  ClientRosterRow,
  ClientRosterSummary,
  NewClientInput,
} from '@/lib/types'
import { cn } from '@/lib/utils'

const EMPTY: NewClientInput = {
  email: '',
  password: '',
  full_name: '',
  phone: '',
  project_id: '',
}

/**
 * PORTAL ACCESS ADMINISTRATION — not a CRM, and not a permission grid.
 *
 * What a client can see is a property of the SCHEMA: ten curated v_client_*
 * views, each scoped by fn_client_project(). There is deliberately no toggle
 * grid here, because toggles would advertise granularity the data layer does
 * not have and would become lies the first time somebody edits a view.
 *
 * What this screen shows instead is EXPOSURE — the count of what has actually
 * been shared with each client. That answers the question a founder is really
 * asking ("what have I shown this person?") without building an impersonation
 * path into the one part of the app whose entire story is that the database
 * refuses.
 */
export default function AdminClients() {
  const [roster, setRoster] = useState<ClientRosterRow[] | null>(null)
  const [summary, setSummary] = useState<ClientRosterSummary | null>(null)
  const [free, setFree] = useState<ProjectOption[]>([])
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async () => {
    // allSettled, not all: one failing panel must not blank the screen and
    // report "no clients", which is a different and more alarming claim than
    // "one panel could not load" (the 056 lesson).
    const [r, s, f] = await Promise.allSettled([
      fetchClientRoster(),
      fetchClientRosterSummary(),
      fetchProjectsWithoutClient(),
    ])

    if (r.status === 'fulfilled') setRoster(r.value)
    else {
      setRoster([])
      toast.error('Could not load the clients', { description: errText(r.reason) })
    }
    if (s.status === 'fulfilled') setSummary(s.value)
    if (f.status === 'fulfilled') setFree(f.value)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Client portal access
        </p>
        {!adding && (
          <Button onClick={() => setAdding(true)} className="h-11">
            <UserRoundPlus className="size-4" />
            Give access
          </Button>
        )}
      </div>

      {summary && summary.client_count > 0 && (
        <div className="paper flex flex-wrap gap-x-8 gap-y-3 p-5">
          <Stat label="Clients" value={summary.client_count} />
          <Stat label="Active" value={summary.active_count} />
          {summary.suspended_count > 0 && (
            <Stat label="Suspended" value={summary.suspended_count} />
          )}
          {summary.pending_approvals > 0 && (
            <Stat label="Awaiting them" value={summary.pending_approvals} tone="warning" />
          )}
          {summary.unread_from_clients > 0 && (
            <Stat label="Unread" value={summary.unread_from_clients} tone="warning" />
          )}
        </div>
      )}

      {adding && (
        <NewClientForm
          projects={free}
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await reload()
          }}
        />
      )}

      {roster === null && <ListSkeleton rows={3} />}

      {roster?.length === 0 && !adding && (
        <EmptyState
          icon={Users}
          title="No client has portal access yet"
          body={
            free.length > 0
              ? 'Give a client a login and they see progress, photos, shared documents and their bills — nothing else.'
              : 'Every project already has a client account.'
          }
          actionLabel={free.length > 0 ? 'Give access' : undefined}
          onAction={free.length > 0 ? () => setAdding(true) : undefined}
        />
      )}

      {roster && roster.length > 0 && (
        <Stagger className="card-grid">
          {roster.map((c) => (
            <RevealItem key={c.user_id}>
              <ClientCard client={c} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}

      {roster && roster.length > 0 && free.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          {free.length === 1
            ? '1 project has no client account.'
            : `${free.length} projects have no client account.`}
        </p>
      )}

      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        A client signs in to their own portal and never reaches an internal
        screen. They cannot see your fee, margin, overheads, vendor rates, other
        clients, or any project but their own — that is enforced in the database,
        not here.
      </p>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'warning'
}) {
  return (
    <div>
      <p className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          'figure text-2xl leading-tight',
          tone === 'warning' && 'text-[var(--warning)]',
        )}
      >
        {value}
      </p>
    </div>
  )
}

/* ---------------- One client ---------------- */

function ClientCard({
  client,
  onChanged,
}: {
  client: ClientRosterRow
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  async function toggleActive() {
    const next = !client.is_active
    if (
      !next &&
      !window.confirm(
        `Suspend ${client.full_name}? They can no longer sign in. Everything ` +
          `they approved stays on record, and you can restore access later.`,
      )
    )
      return

    setBusy(true)
    try {
      await setClientActive(client.user_id, next)
      toast.success(next ? 'Access restored' : 'Access suspended')
      await onChanged()
    } catch (err) {
      toast.error('Could not change access', { description: errText(err) })
    }
    setBusy(false)
  }

  async function remove() {
    if (
      !window.confirm(
        `Remove ${client.full_name} from ${client.project_name}?\n\n` +
          `Their login is deactivated and the link to the project is deleted. ` +
          `Their name stays on anything they approved. Suspend instead if this ` +
          `is just a handover.`,
      )
    )
      return

    setBusy(true)
    try {
      await unlinkClient(client.user_id)
      toast.success('Portal access removed')
      await onChanged()
    } catch (err) {
      toast.error('Could not remove access', { description: errText(err) })
    }
    setBusy(false)
  }

  const nothingShared =
    client.shared_documents === 0 &&
    client.published_photos === 0 &&
    client.visible_invoices === 0

  return (
    <div className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading truncate text-[17px] leading-tight font-semibold">
            {client.full_name}
          </p>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {client.project_name}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium',
            client.is_active
              ? 'bg-[var(--positive)]/10 text-[var(--positive)]'
              : 'bg-secondary text-muted-foreground',
          )}
        >
          {client.is_active ? 'Active' : 'Suspended'}
        </span>
      </div>

      {/* EXPOSURE — what this person can actually reach today. */}
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-4">
        <Exposure icon={FileText} n={client.shared_documents} noun="document" />
        <Exposure icon={Image} n={client.published_photos} noun="photo" />
        <Exposure icon={Receipt} n={client.visible_invoices} noun="bill" />
        <Exposure
          icon={Stamp}
          n={client.pending_approvals}
          noun="approval waiting"
          plural="approvals waiting"
          tone={client.pending_approvals > 0 ? 'warning' : undefined}
        />
        {client.unread_from_client > 0 && (
          <Exposure
            icon={MessageSquare}
            n={client.unread_from_client}
            noun="unread message"
            plural="unread messages"
            tone="warning"
          />
        )}
      </div>

      {nothingShared && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Nothing has been shared yet. Publish photos from the site log and mark
          documents client-visible in the vault — this screen only reports what
          is shared, it does not share it.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="h-11"
          disabled={busy}
          onClick={toggleActive}
        >
          {client.is_active ? (
            <>
              <Pause className="size-4" />
              Suspend
            </>
          ) : (
            <>
              <Play className="size-4" />
              Restore
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          className="h-11 text-[var(--danger)] hover:text-[var(--danger)]"
          disabled={busy}
          onClick={remove}
        >
          <CircleSlash className="size-4" />
          Remove access
        </Button>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        Access given {new Date(client.granted_at).toLocaleDateString('en-IN')}
        {client.granted_by_name ? ` by ${client.granted_by_name}` : ''}
      </p>
    </div>
  )
}

function Exposure({
  icon: Icon,
  n,
  noun,
  plural,
  tone,
}: {
  icon: typeof FileText
  n: number
  noun: string
  plural?: string
  tone?: 'warning'
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon
        className={cn(
          'size-4 shrink-0',
          tone === 'warning' ? 'text-[var(--warning)]' : 'text-muted-foreground',
        )}
        aria-hidden="true"
      />
      <span className={cn(tone === 'warning' && 'text-[var(--warning)]')}>
        <span className="figure tabular-nums">{n}</span>{' '}
        {n === 1 ? noun : (plural ?? `${noun}s`)}
      </span>
    </div>
  )
}

/* ---------------- Give access ---------------- */

function NewClientForm({
  projects,
  onCancel,
  onSaved,
}: {
  projects: ProjectOption[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<NewClientInput>(EMPTY)
  const [saving, setSaving] = useState(false)

  function set<K extends keyof NewClientInput>(k: K, v: NewClientInput[K]) {
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.project_id) {
      toast.error('Pick a project')
      return
    }
    setSaving(true)
    try {
      await createClient(form)
      toast.success(`${form.full_name.trim()} can now sign in`, {
        description: 'Send them the email and password you just set.',
      })
      setForm(EMPTY)
      await onSaved()
    } catch (err) {
      toast.error('Could not create the client account', {
        description: errText(err),
      })
    }
    setSaving(false)
  }

  // A project with no client is the only valid target: client_projects.user_id
  // is UNIQUE, so one account belongs to exactly one job, and a job already
  // having a client means a second one would need moving rather than creating.
  if (projects.length === 0) {
    return (
      <div className="paper space-y-3 p-5">
        <p className="text-sm">Every project already has a client account.</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          To move a client to a different project, remove their access here and
          give it again on the new one.
        </p>
        <Button variant="outline" className="h-11" onClick={onCancel}>
          Close
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="paper space-y-4 p-5">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Give a client access
      </p>

      <FieldRow
        label="Project"
        htmlFor="cl-project"
        hint="A client account belongs to exactly one project."
      >
        <Select
          id="cl-project"
          value={form.project_id}
          onChange={(e) => set('project_id', e.target.value)}
          required
        >
          <option value="">Choose…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow label="Full name" htmlFor="cl-name">
        <Input
          id="cl-name"
          className="h-12"
          value={form.full_name}
          onChange={(e) => set('full_name', e.target.value)}
          required
        />
      </FieldRow>

      <FieldRow label="Email" htmlFor="cl-email" hint="This is their username.">
        <Input
          id="cl-email"
          type="email"
          className="h-12"
          autoComplete="off"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          required
        />
      </FieldRow>

      <FieldRow label="Phone" htmlFor="cl-phone">
        <Input
          id="cl-phone"
          type="tel"
          className="h-12"
          value={form.phone}
          onChange={(e) => set('phone', e.target.value)}
        />
      </FieldRow>

      <FieldRow
        label="Password"
        htmlFor="cl-pass"
        hint="At least 8 characters. There is no invite email — tell them yourself, and they can change it later."
      >
        <Input
          id="cl-pass"
          type="password"
          className="h-12"
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
          required
          minLength={8}
        />
      </FieldRow>

      <div className="flex items-start gap-2.5 rounded-lg bg-secondary/60 p-3.5">
        <KeyRound
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          They will see progress, published photos, documents you have shared,
          their progress bills and anything awaiting their approval. They will
          not see your fee, margin, overheads, vendor rates, staff, or any other
          project.
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={saving}>
          {saving ? 'Creating…' : 'Create account'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
