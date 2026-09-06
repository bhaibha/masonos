import { ChevronDown, ChevronRight, ShieldCheck, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { CreateModePicker } from '@/components/CreateModePicker'
import { FieldRow, Select } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  createUser,
  fetchTeam,
  setProjectAssignments,
  updateTeamMember,
} from '@/lib/queries/admin'
import { fetchProjects } from '@/lib/queries/projects'
import {
  DESIGNATIONS,
  ROLE_ACCESS_NOTE,
  ROLE_LABEL,
  designationRole,
  type NewUserInput,
  type Project,
  type TeamMember,
  type UserRole,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

const EMPTY: NewUserInput = {
  email: '',
  password: '',
  full_name: '',
  phone: '',
  designation: 'Site Engineer',
  role: 'supervisor',
  project_ids: [],
  mode: 'direct',
}

export default function AdminTeam() {
  const myId = useAuth((s) => s.profile?.id ?? null)

  const [team, setTeam] = useState<TeamMember[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)

  /**
   * Past staff are SEPARATED, not hidden. Since 078 a deactivated account is
   * genuinely closed — my_role() returns NULL and every policy refuses — so
   * these rows are nobody who can reach anything, and mixing them into the
   * working list makes the founder read a name and think about it before
   * noticing the badge.
   *
   * They still have to be REACHABLE, because Reactivate lives on the card and
   * users are not deletable (022): hiding them outright would mean somebody
   * coming back from leave could only be restored with SQL. Hence a collapsed
   * section rather than a filter — the same reason 041 retires an overhead
   * category instead of deleting it.
   */
  const [active, inactive] = useMemo(() => {
    const list = team ?? []
    return [
      list.filter((m) => m.is_active),
      list.filter((m) => !m.is_active),
    ]
  }, [team])

  const reload = useCallback(async () => {
    try {
      const [people, projs] = await Promise.all([fetchTeam(), fetchProjects()])
      setTeam(people)
      setProjects(projs)
    } catch (err) {
      toast.error('Could not load the team', { description: errText(err) })
      setTeam([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Team
        </p>
        {!adding && (
          <Button onClick={() => setAdding(true)} className="h-11">
            <UserPlus className="size-4" />
            Add person
          </Button>
        )}
      </div>

      {adding && (
        <NewUserForm
          projects={projects}
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await reload()
          }}
        />
      )}

      {team === null && <ListSkeleton rows={4} />}

      {team?.length === 0 && !adding && (
        <EmptyState
          icon={Users}
          title="No one on the team yet"
          body="Add your project managers, engineers and supervisors here."
          actionLabel="Add person"
          onAction={() => setAdding(true)}
        />
      )}

      {active.length > 0 && (
        <Stagger className="card-grid">
          {active.map((m) => (
            <RevealItem key={m.id}>
              <MemberCard
                member={m}
                projects={projects}
                isMe={m.id === myId}
                expanded={editingId === m.id}
                onToggle={() =>
                  setEditingId((cur) => (cur === m.id ? null : m.id))
                }
                onSaved={reload}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}

      {/* Everyone is deactivated — a real state, and one the big empty state
          would describe wrongly ("No one on the team yet" is not true). */}
      {team !== null && active.length === 0 && inactive.length > 0 && (
        <p className="paper p-5 text-sm text-muted-foreground">
          Nobody on the team is active. {inactive.length} deactivated{' '}
          {inactive.length === 1 ? 'account is' : 'accounts are'} below.
        </p>
      )}

      {inactive.length > 0 && (
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setShowInactive((v) => !v)}
            aria-expanded={showInactive}
            className="flex w-full items-center gap-2 border-t border-border pt-5 text-left"
          >
            {showInactive ? (
              <ChevronDown
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            ) : (
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Deactivated
            </span>
            <span className="figure text-sm text-muted-foreground tabular-nums">
              {inactive.length}
            </span>
          </button>

          {showInactive && (
            <>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                These accounts can still sign in but the app refuses every
                screen. They are kept because their names are on work they
                recorded — reactivate to restore exactly the access they had.
              </p>

              <Stagger className="card-grid mt-4">
                {inactive.map((m) => (
                  <RevealItem key={m.id}>
                    <div className="opacity-70 transition-opacity hover:opacity-100">
                      <MemberCard
                        member={m}
                        projects={projects}
                        isMe={m.id === myId}
                        expanded={editingId === m.id}
                        onToggle={() =>
                          setEditingId((cur) => (cur === m.id ? null : m.id))
                        }
                        onSaved={reload}
                      />
                    </div>
                  </RevealItem>
                ))}
              </Stagger>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------------- Existing member ---------------- */

function MemberCard({
  member,
  projects,
  isMe,
  expanded,
  onToggle,
  onSaved,
}: {
  member: TeamMember
  projects: Project[]
  isMe: boolean
  expanded: boolean
  onToggle: () => void
  onSaved: () => Promise<void>
}) {
  const [designation, setDesignation] = useState(member.designation ?? '')
  const [role, setRole] = useState<UserRole>(member.role)
  const [phone, setPhone] = useState(member.phone ?? '')
  const [assigned, setAssigned] = useState<string[]>(member.project_ids)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDesignation(member.designation ?? '')
    setRole(member.role)
    setPhone(member.phone ?? '')
    setAssigned(member.project_ids)
  }, [member])

  function pickDesignation(title: string) {
    setDesignation(title)
    // Keep the access role in step with the title, but leave it editable —
    // a Site Engineer who also handles billing may need a different role.
    const mapped = designationRole(title)
    if (mapped) setRole(mapped)
  }

  async function save() {
    setSaving(true)
    try {
      await updateTeamMember(member.id, { designation, role, phone })
      await setProjectAssignments(member.id, assigned)
      toast.success(`${member.full_name} updated`)
      await onSaved()
      onToggle()
    } catch (err) {
      toast.error('Could not save the changes', { description: errText(err) })
    }
    setSaving(false)
  }

  async function toggleActive() {
    const next = !member.is_active
    if (
      !next &&
      !window.confirm(
        `Deactivate ${member.full_name}? They can still sign in, but every ` +
          `screen is refused by the database and they see a closed-account ` +
          `notice instead. Their project assignments are kept, so ` +
          `reactivating restores exactly what they had. If they are leaving ` +
          `on bad terms, reset their password in Supabase as well.`,
      )
    )
      return

    try {
      await updateTeamMember(member.id, { is_active: next })
      // Say WHERE the card went. Deactivating moves it out of the working list
      // into the collapsed Deactivated section, and a row that simply vanishes
      // reads as a delete — which is the one thing this is not.
      toast.success(next ? 'Reactivated' : 'Deactivated', {
        description: next
          ? `${member.full_name} is back on the team with the access they had.`
          : `${member.full_name} has moved to Deactivated, at the bottom of this page.`,
      })
      await onSaved()
    } catch (err) {
      toast.error('Could not change the status', { description: errText(err) })
    }
  }

  return (
    <div className="paper p-5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="font-heading text-[18px] leading-tight font-semibold">
            {member.full_name || 'Unnamed'}
            {isMe && (
              <span className="ml-2 font-sans text-[11px] font-normal text-muted-foreground">
                you
              </span>
            )}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {member.designation ?? '—'}
            <span className="text-muted-foreground/70">
              {' '}
              · {ROLE_LABEL[member.role]}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            {member.project_ids.length} project
            {member.project_ids.length === 1 ? '' : 's'}
            {member.phone ? ` · ${member.phone}` : ''}
          </p>
        </div>

        {!member.is_active && (
          <span className="shrink-0 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            Inactive
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-5 space-y-5 border-t border-border pt-5">
          <FieldRow label="Job title" htmlFor={`d-${member.id}`}>
            <Select
              id={`d-${member.id}`}
              value={designation}
              onChange={(e) => pickDesignation(e.target.value)}
            >
              <option value="">— none —</option>
              {DESIGNATIONS.map((d) => (
                <option key={d.title} value={d.title}>
                  {d.title}
                </option>
              ))}
            </Select>
          </FieldRow>

          <RolePicker
            id={`r-${member.id}`}
            value={role}
            onChange={setRole}
            lockWarning={isMe && role !== 'founder'}
          />

          <FieldRow label="Phone" htmlFor={`ph-${member.id}`}>
            <Input
              id={`ph-${member.id}`}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              placeholder="+91"
              className="h-12"
            />
          </FieldRow>

          <ProjectAssignments
            projects={projects}
            value={assigned}
            onChange={setAssigned}
          />

          <div className="flex gap-3">
            <Button
              onClick={() => void save()}
              disabled={saving}
              className="h-12 flex-1 text-base"
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void toggleActive()}
              className="h-12"
              disabled={isMe}
            >
              {member.is_active ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- New user ---------------- */

function NewUserForm({
  projects,
  onCancel,
  onSaved,
}: {
  projects: Project[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<NewUserInput>(EMPTY)
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof NewUserInput>(k: K, v: NewUserInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  function pickDesignation(title: string) {
    const mapped = designationRole(title)
    setForm((f) => ({ ...f, designation: title, role: mapped ?? f.role }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()

    if (form.full_name.trim() === '') return toast.error('Enter their name')
    if (!form.email.includes('@')) return toast.error('Enter a valid email')
    if (form.password.length < 8)
      return toast.error('Password must be at least 8 characters')

    setSaving(true)
    try {
      await createUser(form)
      toast.success(`${form.full_name.trim()} can now sign in`, {
        description: 'Share the email and password with them directly.',
      })
      setForm(EMPTY)
      await onSaved()
    } catch (err) {
      toast.error('Could not create the account', { description: errText(err) })
    }
    setSaving(false)
  }

  return (
    <form onSubmit={submit} className="paper space-y-5 p-5">
      <p className="font-heading text-[18px] font-semibold">Add person</p>

      <FieldRow label="Full name" htmlFor="u-name">
        <Input
          id="u-name"
          value={form.full_name}
          onChange={(e) => set('full_name', e.target.value)}
          className="h-12"
          autoFocus
        />
      </FieldRow>

      <FieldRow label="Job title" htmlFor="u-desig">
        <Select
          id="u-desig"
          value={form.designation}
          onChange={(e) => pickDesignation(e.target.value)}
        >
          {DESIGNATIONS.map((d) => (
            <option key={d.title} value={d.title}>
              {d.title}
            </option>
          ))}
        </Select>
      </FieldRow>

      <RolePicker
        id="u-role"
        value={form.role}
        onChange={(r) => set('role', r)}
      />

      <FieldRow label="Email (their login)" htmlFor="u-email">
        <Input
          id="u-email"
          type="email"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          inputMode="email"
          autoComplete="off"
          className="h-12"
        />
      </FieldRow>

      <CreateModePicker
        value={form.mode}
        onChange={(m) => set('mode', m)}
        who="them"
      />

      {/* Only the direct path needs a password. Showing the field in invite
          mode would ask for a secret that is never used. */}
      {form.mode === 'direct' && (
        <FieldRow
          label="Temporary password"
          htmlFor="u-pass"
          hint="At least 8 characters. Give it to them directly — the app will make them change it the first time they sign in."
        >
          <Input
            id="u-pass"
            type="text"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            autoComplete="off"
            className="h-12"
          />
        </FieldRow>
      )}

      <FieldRow label="Phone" htmlFor="u-phone">
        <Input
          id="u-phone"
          value={form.phone}
          onChange={(e) => set('phone', e.target.value)}
          inputMode="tel"
          placeholder="+91"
          className="h-12"
        />
      </FieldRow>

      <ProjectAssignments
        projects={projects}
        value={form.project_ids}
        onChange={(ids) => set('project_ids', ids)}
      />

      <div className="flex gap-3 pt-1">
        <Button type="submit" disabled={saving} className="h-12 flex-1 text-base">
          {saving ? 'Creating…' : 'Create account'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}

/* ---------------- Shared bits ---------------- */

function RolePicker({
  id,
  value,
  onChange,
  lockWarning,
}: {
  id: string
  value: UserRole
  onChange: (r: UserRole) => void
  lockWarning?: boolean
}) {
  return (
    <div className="space-y-2">
      <FieldRow label="Access level" htmlFor={id}>
        <Select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value as UserRole)}
        >
          {(Object.keys(ROLE_LABEL) as UserRole[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
      </FieldRow>

      <div className="flex gap-2.5 rounded-lg bg-secondary/60 p-3">
        <ShieldCheck
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {ROLE_ACCESS_NOTE[value]}
        </p>
      </div>

      {lockWarning && (
        <p className="text-xs font-medium text-destructive">
          This is your own account — lowering your access will lock you out of
          this screen.
        </p>
      )}
    </div>
  )
}

function ProjectAssignments({
  projects,
  value,
  onChange,
}: {
  projects: Project[]
  value: string[]
  onChange: (ids: string[]) => void
}) {
  function toggle(id: string) {
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-sm leading-none font-medium">Projects</p>

      {projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No projects yet — create one on the Projects tab first.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {projects.map((p) => {
            const on = value.includes(p.id)
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                aria-pressed={on}
                className={cn(
                  'min-h-11 rounded-lg border px-3.5 text-sm font-medium transition-colors',
                  on
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {p.name}
              </button>
            )
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Project membership is what every RLS policy checks. Someone with no
        projects sees nothing, whatever their access level.
      </p>
    </div>
  )
}
