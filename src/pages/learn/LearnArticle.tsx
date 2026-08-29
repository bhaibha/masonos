import {
  ArrowLeft,
  FileUp,
  HardHat,
  ListPlus,
  Paperclip,
  Pencil,
  ShieldCheck,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { LearnDocCard } from '@/components/LearnDocCard'
import { LearnUpload } from '@/components/LearnUpload'
import { Markdown } from '@/components/Markdown'
import { PageHeader } from '@/components/PageHeader'
import { ListSkeleton } from '@/components/Skeleton'
import { Button, buttonVariants } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import {
  deleteLearnArticle,
  fetchArticleDocuments,
  fetchLearnArticle,
  setLearnStatus,
} from '@/lib/queries/learn'
import {
  canWriteLearn,
  LEARN_STATUS_LABEL,
  type LearnArticle as Article,
  type LearnDocumentRow,
  type LearnStep,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

/**
 * One library entry, read-only.
 *
 * A method statement is laid out step by step with its safety note and QA
 * checkpoint attached to the step they belong to — a safety note at the top of
 * a document is read once and forgotten; beside "strike the side shutters" it
 * is read at the moment it matters.
 */
export default function LearnArticle() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const role = useAuth((s) => s.role)
  const mayWrite = canWriteLearn(role)

  const [data, setData] = useState<{
    article: Article
    steps: LearnStep[]
  } | null>(null)
  const [docs, setDocs] = useState<LearnDocumentRow[]>([])
  const [attaching, setAttaching] = useState(false)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const loadDocs = useCallback(async () => {
    if (!id) return
    // Attachments failing to load must not take the article down with them —
    // the procedure is the thing somebody came here to read.
    try {
      setDocs(await fetchArticleDocuments(id))
    } catch {
      setDocs([])
    }
  }, [id])

  const reload = useCallback(async () => {
    if (!id) return
    try {
      const r = await fetchLearnArticle(id)
      if (!r) setMissing(true)
      else setData(r)
    } catch (err) {
      toast.error('Could not open that entry', { description: errText(err) })
      setMissing(true)
    }
    await loadDocs()
  }, [id, loadDocs])

  useEffect(() => {
    void reload()
  }, [reload])

  if (missing) {
    return (
      <>
        <PageHeader title="Learn" />
        <div className="page-w px-4 py-10">
          <p className="text-center text-sm text-muted-foreground">
            That entry is not available. It may be a draft, which only the
            people who write the library can see.
          </p>
          <Button
            variant="ghost"
            className="mt-4 h-11 w-full"
            onClick={() => navigate('/learn')}
          >
            Back to the library
          </Button>
        </div>
      </>
    )
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Learn" />
        <div className="page-w px-4 py-4">
          <ListSkeleton rows={5} />
        </div>
      </>
    )
  }

  const { article: a, steps } = data
  const isMs = a.kind === 'method_statement'

  return (
    <>
      <PageHeader title="Learn" />

      <div className="page-w space-y-4 px-4 py-4 pb-6">
        <Link
          to="/learn"
          className="flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Library
        </Link>

        <article className="paper p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                {a.category_name}
              </p>
              <h1 className="font-heading mt-1 text-xl leading-snug font-semibold">
                {a.title}
              </h1>
              <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                {a.ref_no && `${a.ref_no} · `}v{a.version} · updated{' '}
                {a.updated_at.slice(0, 10)}
              </p>
            </div>
            {a.status !== 'published' && (
              <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--warning)]">
                {LEARN_STATUS_LABEL[a.status]}
              </span>
            )}
          </div>

          {a.summary && (
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              {a.summary}
            </p>
          )}

          {(a.is_refs.length > 0 || a.tags.length > 0 || a.trades.length > 0) && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {a.is_refs.map((r) => (
                <span
                  key={r}
                  className="rounded-full border border-[var(--accent)] px-2 py-0.5 text-[10px] text-[var(--accent)]"
                >
                  {r}
                </span>
              ))}
              {a.trades.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground"
                >
                  {t}
                </span>
              ))}
              {a.tags.map((t) => (
                <span key={t} className="text-[10px] text-muted-foreground">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </article>

        {/* Method statement header — activity, scope, PPE. */}
        {isMs && (a.activity || a.scope || a.ppe) && (
          <section className="paper space-y-3 p-5">
            {a.activity && (
              <Field label="Activity" value={a.activity} />
            )}
            {a.scope && <Field label="Scope" value={a.scope} />}
            {a.ppe && (
              <div>
                <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                  PPE required
                </p>
                <p className="mt-1 flex items-start gap-1.5 text-sm">
                  <HardHat className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
                  {a.ppe}
                </p>
              </div>
            )}
          </section>
        )}

        {a.body && (
          <section className="paper p-5">
            <Markdown source={a.body} />
          </section>
        )}

        {/* The procedure. */}
        {isMs && steps.length > 0 && (
          <section className="space-y-3">
            <p className="px-1 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Procedure · {steps.length} steps
            </p>
            {steps.map((s) => (
              <article key={s.id} className="paper p-5">
                <div className="flex gap-3">
                  <span className="figure shrink-0 text-lg leading-none font-semibold text-[var(--accent)]">
                    {String(s.step_no).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed">{s.instruction}</p>

                    {s.safety_note && (
                      <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] px-3 py-2 text-xs text-[var(--warning)]">
                        <HardHat className="mt-0.5 size-3.5 shrink-0" />
                        {s.safety_note}
                      </p>
                    )}

                    {s.qa_checkpoint && (
                      <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-[color-mix(in_oklab,var(--positive)_10%,transparent)] px-3 py-2 text-xs text-[var(--positive)]">
                        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                        {s.qa_checkpoint}
                      </p>
                    )}

                    {s.is_refs.length > 0 && (
                      <p className="mt-2 text-[10px] text-muted-foreground">
                        {s.is_refs.join(' · ')}
                      </p>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </section>
        )}

        {/* A message that states a problem and offers no way to fix it is a dead
            end. This is where somebody lands after creating a method statement,
            so the way forward belongs HERE, not two screens away. */}
        {isMs && steps.length === 0 && (
          <section className="paper space-y-3 p-5">
            <p className="text-sm">
              No procedure yet. A method statement cannot be published until it
              has steps.
            </p>
            {mayWrite ? (
              <>
                <Link
                  to={`/learn/${a.id}/edit`}
                  className={cn(buttonVariants(), 'h-12 w-full gap-2 text-base')}
                >
                  <ListPlus className="size-4" /> Add the procedure
                </Link>
                <p className="text-[11px] text-muted-foreground">
                  Write the steps yourself, or use{' '}
                  <strong>Draft the structure</strong> at the top of the
                  Procedure section to have a skeleton generated — then fill in
                  the values.
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                The office is still writing it.
              </p>
            )}
          </section>
        )}

        {/* Attachments: the evidence behind what the article says. Same table
            as a standalone library document (059), so a drawing filed here is
            searchable through the same box, and the future assistant reads one
            place rather than two. */}
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="flex items-center gap-1.5 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              <Paperclip className="size-3" />
              Attached {docs.length > 0 && `· ${docs.length}`}
            </p>
            {mayWrite && !attaching && (
              <Button
                variant="ghost"
                size="xs"
                className="gap-1.5"
                onClick={() => setAttaching(true)}
              >
                <FileUp className="size-3.5" /> Attach
              </Button>
            )}
          </div>

          {attaching && (
            <LearnUpload
              articleId={a.id}
              onCancel={() => setAttaching(false)}
              onDone={() => {
                setAttaching(false)
                void loadDocs()
              }}
            />
          )}

          {docs.length === 0 && !attaching && (
            <p className="px-1 text-[11px] text-muted-foreground">
              {mayWrite
                ? 'Nothing attached. Drawings, spec sheets and data sheets ' +
                  'filed here become searchable across the whole library.'
                : 'No supporting documents.'}
            </p>
          )}

          {docs.map((d) => (
            <LearnDocCard
              key={d.id}
              doc={d}
              mayWrite={mayWrite}
              onDeleted={() => void loadDocs()}
            />
          ))}
        </section>

        {mayWrite && (
          <section className="space-y-2">
            {/* Base UI's Button has no asChild — style the Link directly. */}
            <Link
              to={`/learn/${a.id}/edit`}
              className={cn(
                buttonVariants({ variant: 'outline' }),
                'h-11 w-full gap-2',
              )}
            >
              <Pencil className="size-4" /> Edit
            </Link>

            <div className="grid grid-cols-2 gap-2">
              {a.status !== 'published' ? (
                <Button
                  className="h-11"
                  // The RPC refuses a step-less method statement anyway; a
                  // button that always fails is just a worse error message.
                  disabled={busy || (isMs && steps.length === 0)}
                  title={
                    isMs && steps.length === 0
                      ? 'Add the procedure first'
                      : undefined
                  }
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await setLearnStatus(a.id, 'published')
                      toast.success('Published', {
                        description: 'Everyone on the team can read it now.',
                      })
                      await reload()
                    } catch (err) {
                      toast.error('Could not publish', {
                        description: errText(err),
                      })
                    }
                    setBusy(false)
                  }}
                >
                  Publish
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await setLearnStatus(a.id, 'archived')
                      toast.success('Archived', {
                        description: 'It stays on record but drops out of the shelves.',
                      })
                      await reload()
                    } catch (err) {
                      toast.error('Could not archive', {
                        description: errText(err),
                      })
                    }
                    setBusy(false)
                  }}
                >
                  Archive
                </Button>
              )}

              <Button
                variant="ghost"
                className={cn(
                  'h-11 text-destructive hover:bg-destructive/10 hover:text-destructive',
                )}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            </div>

            {confirmDelete && (
              <div className="paper space-y-3 p-4">
                <p className="text-sm">
                  Delete "{a.title}"? Its steps go with it. Archiving keeps it on
                  record instead.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="ghost"
                    className="h-11"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-11"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await deleteLearnArticle(a.id)
                        toast.success('Deleted')
                        navigate('/learn')
                      } catch (err) {
                        toast.error('Could not delete', {
                          description: errText(err),
                        })
                        setBusy(false)
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className="mt-1 text-sm">{value}</p>
    </div>
  )
}
