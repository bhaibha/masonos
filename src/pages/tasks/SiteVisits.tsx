import { CalendarCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { fetchTeam } from '@/lib/queries/admin'
import {
  completeVisitAction,
  createSiteVisit,
  createVisitAction,
  fetchSiteVisits,
} from '@/lib/queries/siteVisits'
import { compressImage, signedSitePhotoUrl, uploadSitePhoto } from '@/lib/storage'
import {
  canLogSiteVisit,
  TASK_STATUS_LABEL,
  VISIT_TYPE_LABEL,
  VISIT_TYPES,
  visitNeedsObservations,
  type SiteVisit,
  type TeamMember,
  type VisitType,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { todayIst } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/**
 * M18 SITE VISITS — who came, what they said, what we now have to do.
 *
 * THE ACTION ITEMS ARE TASKS. Adding one here writes an ordinary row in
 * `tasks` carrying `visit_id` (084), so it lands on the supervisor's daily
 * list, rolls over when missed and reaches the push digest. There is no second
 * to-do list to check, and no second definition of overdue.
 *
 * A CLIENT visit cannot be saved without observations — a CHECK constraint, not
 * a form rule, so it holds for anything talking to the API. After saving one,
 * the screen offers to record the conversation in the Client log (M36); that
 * stays a prompt rather than a requirement, because a visit should not be
 * unloggable until somebody also writes up the small talk.
 */
export default function SiteVisits() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayLog = canLogSiteVisit(role)
  const navigate = useNavigate()

  const [visits, setVisits] = useState<SiteVisit[] | null>(null)
  const [logging, setLogging] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setVisits(await fetchSiteVisits(projectId))
    } catch (err) {
      toast.error('Could not load site visits', { description: errText(err) })
      setVisits([])
    }
  }, [projectId])

  useEffect(() => {
    setVisits(null)
    void reload()
  }, [reload])

  if (logging) {
    return (
      <VisitForm
        projectId={projectId ?? ''}
        onDone={() => {
          setLogging(false)
          void reload()
        }}
        onCancel={() => setLogging(false)}
        onLogConversation={() => navigate('/tasks/client-log')}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      {mayLog && (
        <Button className="h-12 w-full text-base" onClick={() => setLogging(true)}>
          Log a visit
        </Button>
      )}

      {visits === null && <ListSkeleton rows={3} />}

      {visits?.length === 0 && (
        <EmptyState
          icon={CalendarCheck}
          title="No visits logged"
          body={
            mayLog
              ? 'Log every consultant, inspector and client who walks the site. The observations and the photographs are what settle an argument six months later.'
              : 'Nobody has logged a site visit on this project yet.'
          }
          actionLabel={mayLog ? 'Log a visit' : undefined}
          onAction={mayLog ? () => setLogging(true) : undefined}
        />
      )}

      {visits && visits.length > 0 && (
        <Stagger className="space-y-3">
          {visits.map((v) => (
            <RevealItem key={v.id}>
              <VisitCard visit={v} mayLog={mayLog} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ---------------- One visit ---------------- */

const TYPE_TONE: Record<VisitType, string> = {
  client: 'bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-[var(--accent)]',
  consultant: 'bg-secondary text-muted-foreground',
  pm: 'bg-secondary text-muted-foreground',
  inspection: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  authority: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  vendor: 'bg-secondary text-muted-foreground',
}

function VisitCard({
  visit: v,
  mayLog,
  onChanged,
}: {
  visit: SiteVisit
  mayLog: boolean
  onChanged: () => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [dueOn, setDueOn] = useState(todayIst())
  const [team, setTeam] = useState<TeamMember[]>([])
  const [assignee, setAssignee] = useState('')
  const [busy, setBusy] = useState(false)
  const today = todayIst()

  useEffect(() => {
    if (!adding || team.length > 0) return
    fetchTeam()
      .then((t) => setTeam(t.filter((p) => p.is_active)))
      .catch(() => setTeam([]))
  }, [adding, team.length])

  async function addAction() {
    if (title.trim() === '') {
      toast.error('Write what has to be done')
      return
    }
    setBusy(true)
    try {
      await createVisitAction({
        project_id: v.project_id,
        visit_id: v.id,
        title,
        due_on: dueOn,
        assigned_to: assignee || null,
      })
      toast.success('Action added', {
        description: 'It is an ordinary task — it will show on the daily list and roll over if missed.',
      })
      setTitle('')
      setAssignee('')
      setAdding(false)
      await onChanged()
    } catch (err) {
      toast.error('Could not add the action', { description: errText(err) })
    }
    setBusy(false)
  }

  const open = v.actions.filter((a) => a.status === 'pending')

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-heading text-[16px] font-semibold">
              {v.visitor_name}
            </span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase',
                TYPE_TONE[v.visit_type],
              )}
            >
              {VISIT_TYPE_LABEL[v.visit_type]}
            </span>
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {v.visitor_org && `${v.visitor_org} · `}
            {v.visit_date}
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {v.visit_no}
        </span>
      </div>

      {v.purpose && (
        <p className="mt-3 text-sm">
          <span className="text-muted-foreground">Purpose: </span>
          {v.purpose}
        </p>
      )}

      {v.observations && (
        <div className="mt-3 rounded-lg bg-secondary/50 p-3">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Observations
          </p>
          <p className="mt-1 text-sm whitespace-pre-wrap">{v.observations}</p>
        </div>
      )}

      {v.photos.length > 0 && <Photos paths={v.photos} />}

      {/* Actions — tasks, shown here as well as on the task list */}
      {v.actions.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Actions {open.length > 0 && `· ${open.length} open`}
          </p>
          <ul className="mt-2 divide-y divide-border">
            {v.actions.map((a) => {
              const overdue = a.status === 'pending' && a.planned_date < today
              return (
                <li key={a.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p
                      className={cn(
                        'text-sm',
                        a.status !== 'pending' && 'text-muted-foreground line-through',
                      )}
                    >
                      {a.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Due {a.planned_date}
                      {a.assigned_to_name && ` · ${a.assigned_to_name}`}
                      {overdue && ' · overdue'}
                    </p>
                  </div>
                  {a.status === 'pending' ? (
                    mayLog && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0"
                        onClick={async () => {
                          try {
                            await completeVisitAction(a.id)
                            toast.success('Marked done')
                            await onChanged()
                          } catch (err) {
                            toast.error('Could not update it', {
                              description: errText(err),
                            })
                          }
                        }}
                      >
                        Done
                      </Button>
                    )
                  ) : (
                    <span className="shrink-0 text-xs text-[var(--positive)]">
                      {TASK_STATUS_LABEL[a.status]}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {mayLog && !adding && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => setAdding(true)}
        >
          Add an action
        </Button>
      )}

      {adding && (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <FieldRow
            label="What has to be done"
            htmlFor={`ac-${v.id}`}
            hint="This becomes a task on the project — it will appear on the daily list."
          >
            <Input
              id={`ac-${v.id}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-12 text-base"
              placeholder="Re-check cover to the north beams"
            />
          </FieldRow>
          <FieldRow label="Due" htmlFor={`ad-${v.id}`}>
            <Input
              id={`ad-${v.id}`}
              type="date"
              value={dueOn}
              onChange={(e) => setDueOn(e.target.value)}
              className="h-12 text-base"
            />
          </FieldRow>
          <FieldRow label="Assign to" htmlFor={`aa-${v.id}`}>
            <Select
              id={`aa-${v.id}`}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="h-12 text-base"
            >
              <option value="">Nobody in particular</option>
              {team.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                </option>
              ))}
            </Select>
          </FieldRow>
          <div className="flex gap-2">
            <Button className="h-11 flex-1" disabled={busy} onClick={() => void addAction()}>
              {busy ? 'Adding…' : 'Add action'}
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Logged by {v.logged_by_name ?? 'someone'}
      </p>
    </article>
  )
}

function Photos({ paths }: { paths: string[] }) {
  const [urls, setUrls] = useState<(string | null)[]>([])

  useEffect(() => {
    let alive = true
    Promise.all(paths.map((p) => signedSitePhotoUrl(p)))
      .then((u) => {
        if (alive) setUrls(u)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [paths])

  return (
    <div className="mt-3 flex gap-2 overflow-x-auto">
      {urls.map((u, i) =>
        u ? (
          <img
            key={i}
            src={u}
            alt=""
            className="size-24 shrink-0 rounded-lg border border-border object-cover"
          />
        ) : null,
      )}
    </div>
  )
}

/* ---------------- Log a visit ---------------- */

function VisitForm({
  projectId,
  onDone,
  onCancel,
  onLogConversation,
}: {
  projectId: string
  onDone: () => void
  onCancel: () => void
  onLogConversation: () => void
}) {
  const [type, setType] = useState<VisitType>('consultant')
  const [date, setDate] = useState(todayIst())
  const [name, setName] = useState('')
  const [org, setOrg] = useState('')
  const [purpose, setPurpose] = useState('')
  const [observations, setObservations] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const needsObservations = visitNeedsObservations(type)
  const hint = VISIT_TYPES.find((v) => v.value === type)?.hint

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return
    try {
      const next: File[] = []
      for (const f of Array.from(files)) next.push(await compressImage(f))
      setPhotos((p) => [...p, ...next])
    } catch {
      toast.error('Could not process one of those images.')
    }
  }

  async function save() {
    if (name.trim() === '') {
      toast.error('Who came?')
      return
    }
    // Mirrors `svt_client_needs_observations`. The constraint is what enforces
    // it; this only means the person sees a sentence instead of a constraint
    // name.
    if (needsObservations && observations.trim() === '') {
      toast.error('Write what was observed', {
        description:
          'A client visit is the one somebody will ask about later. The database refuses it without observations.',
      })
      return
    }

    setBusy(true)
    try {
      const uploaded: string[] = []
      for (let i = 0; i < photos.length; i++) {
        setStatus(`Uploading photo ${i + 1} of ${photos.length}…`)
        const f = photos[i]
        if (f) uploaded.push(await uploadSitePhoto(projectId, f))
      }
      setStatus('Saving…')
      await createSiteVisit({
        project_id: projectId,
        visit_type: type,
        visit_date: date,
        visitor_name: name,
        visitor_org: org,
        purpose,
        observations,
        photos: uploaded,
      })

      if (type === 'client') {
        // A prompt, not a requirement — see the header. The visit is already
        // saved either way.
        toast.success('Client visit logged', {
          description: 'Was there a conversation worth recording too?',
          action: { label: 'Client log', onClick: onLogConversation },
          duration: 8000,
        })
      } else {
        toast.success('Visit logged')
      }
      onDone()
    } catch (err) {
      toast.error('Could not log the visit', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="paper space-y-4 p-5">
        <h2 className="font-heading text-lg font-semibold">Log a site visit</h2>

        <FieldRow label="Who came" htmlFor="sv-type" hint={hint}>
          <Select
            id="sv-type"
            value={type}
            onChange={(e) => setType(e.target.value as VisitType)}
            className="h-12 text-base"
          >
            {VISIT_TYPES.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </Select>
        </FieldRow>

        <FieldRow label="Name" htmlFor="sv-name">
          <Input
            id="sv-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-12 text-base"
            placeholder="Mr Rao"
          />
        </FieldRow>

        <FieldRow
          label="Organisation"
          htmlFor="sv-org"
          hint="A year later, 'Sharma' and 'Sharma, structural consultants' are different facts."
        >
          <Input
            id="sv-org"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            className="h-12 text-base"
            placeholder="Studio Aangan"
          />
        </FieldRow>

        <FieldRow label="Date of the visit" htmlFor="sv-date">
          <Input
            id="sv-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>

        <FieldRow label="Purpose" htmlFor="sv-purpose">
          <Input
            id="sv-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            className="h-12 text-base"
            placeholder="Slab reinforcement check before the pour"
          />
        </FieldRow>

        <FieldRow
          label={needsObservations ? 'Observations (required)' : 'Observations'}
          htmlFor="sv-obs"
          hint={
            needsObservations
              ? 'Required for a client visit — enforced by the database, not just this form.'
              : 'What was said, what was pointed at, what was disputed.'
          }
        >
          <Textarea
            id="sv-obs"
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            rows={5}
            placeholder="Wants the parapet raised by 150mm. Shown the drain falls; accepted them."
          />
        </FieldRow>

        <FieldRow
          label="Photos"
          htmlFor="sv-photos"
          hint={
            photos.length > 0
              ? `${photos.length} ready, each compressed before upload.`
              : 'Photograph anything that was pointed at.'
          }
        >
          <Input
            id="sv-photos"
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(e) => void addPhotos(e.target.files)}
            className="h-12 text-base"
          />
        </FieldRow>

        {status && <p className="text-xs text-muted-foreground">{status}</p>}

        <div className="flex gap-2">
          <Button
            className="h-12 flex-1 text-base"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Log the visit'}
          </Button>
          <Button variant="ghost" className="h-12" onClick={onCancel}>
            Cancel
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Add the action items after saving — each one becomes a task on this
          project, so it reaches the daily list rather than sitting in a second
          list nobody checks.
        </p>
      </div>
    </div>
  )
}
