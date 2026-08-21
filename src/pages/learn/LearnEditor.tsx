import { ArrowLeft, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { Markdown } from '@/components/Markdown'
import { PageHeader } from '@/components/PageHeader'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  createLearnArticle,
  draftLearnSkeleton,
  fetchLearnArticle,
  fetchLearnCategories,
  markAiDrafted,
  saveLearnSteps,
  updateLearnArticle,
} from '@/lib/queries/learn'
import {
  canWriteLearn,
  type LearnCategory,
  type LearnKind,
  type NewLearnStep,
  TRADES,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

interface StepDraft extends NewLearnStep {
  key: number
}

let keySeq = 1
const blankStep = (): StepDraft => ({
  key: keySeq++,
  step_no: 0,
  instruction: '',
  safety_note: '',
  qa_checkpoint: '',
  is_refs: [],
})

/** "IS 456, IS 1200" → ['IS 456','IS 1200'] */
const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * Write or edit a library entry.
 *
 * A method statement gets the extra header fields (activity, scope, PPE) and
 * the step list; an ordinary article does not. One editor rather than two,
 * because they share every other field and two forms would drift.
 */
export default function LearnEditor() {
  const { id } = useParams<{ id: string }>()
  const editing = Boolean(id)
  const navigate = useNavigate()
  const role = useAuth((s) => s.role)

  const [categories, setCategories] = useState<LearnCategory[]>([])
  const [loading, setLoading] = useState(editing)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(false)

  const [categoryCode, setCategoryCode] = useState('')
  const [kind, setKind] = useState<LearnKind>('article')
  const [title, setTitle] = useState('')
  const [refNo, setRefNo] = useState('')
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [isRefs, setIsRefs] = useState('')
  const [tags, setTags] = useState('')
  const [trades, setTrades] = useState<string[]>([])
  const [activity, setActivity] = useState('')
  const [scope, setScope] = useState('')
  const [ppe, setPpe] = useState('')
  const [steps, setSteps] = useState<StepDraft[]>([blankStep()])
  const [drafting, setDrafting] = useState(false)
  // Set when a skeleton has been generated in this session, so the reminder to
  // check every step is shown next to the steps it applies to.
  const [aiModel, setAiModel] = useState<string | null>(null)

  useEffect(() => {
    void fetchLearnCategories()
      .then((c) => {
        setCategories(c)
        setCategoryCode((prev) => prev || c[0]?.code || '')
      })
      .catch(() => setCategories([]))
  }, [])

  const load = useCallback(async () => {
    if (!id) return
    try {
      const r = await fetchLearnArticle(id)
      if (!r) {
        toast.error('That entry no longer exists')
        navigate('/learn')
        return
      }
      const { article: a, steps: s } = r
      setCategoryCode(a.category_code)
      setKind(a.kind)
      setTitle(a.title)
      setRefNo(a.ref_no ?? '')
      setSummary(a.summary ?? '')
      setBody(a.body ?? '')
      setIsRefs(a.is_refs.join(', '))
      setTags(a.tags.join(', '))
      setTrades(a.trades)
      setActivity(a.activity ?? '')
      setScope(a.scope ?? '')
      setPpe(a.ppe ?? '')
      setSteps(
        s.length > 0
          ? s.map((x) => ({
              key: keySeq++,
              step_no: x.step_no,
              instruction: x.instruction,
              safety_note: x.safety_note ?? '',
              qa_checkpoint: x.qa_checkpoint ?? '',
              is_refs: x.is_refs,
            }))
          : [blankStep()],
      )
    } catch (err) {
      toast.error('Could not open that entry', { description: errText(err) })
      navigate('/learn')
    }
    setLoading(false)
  }, [id, navigate])

  useEffect(() => {
    void load()
  }, [load])

  if (!canWriteLearn(role)) {
    return (
      <>
        <PageHeader title="Learn" />
        <p className="mx-auto max-w-lg px-4 py-10 text-center text-sm text-muted-foreground">
          Only a founder or PM writes library content. You can read everything
          that has been published.
        </p>
      </>
    )
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Learn" />
        <div className="mx-auto max-w-lg px-4 py-4">
          <ListSkeleton rows={5} />
        </div>
      </>
    )
  }

  const isMs = kind === 'method_statement'

  async function save() {
    if (!title.trim()) {
      toast.error('Give it a title')
      return
    }
    if (isMs && !activity.trim()) {
      toast.error('A method statement needs an activity', {
        description: 'What work does this procedure cover?',
      })
      return
    }

    setBusy(true)
    try {
      const payload = {
        category_code: categoryCode,
        kind,
        title,
        ref_no: refNo,
        summary,
        body,
        is_refs: splitList(isRefs),
        trades,
        tags: splitList(tags),
        activity,
        scope,
        ppe,
      }

      const articleId = editing
        ? (await updateLearnArticle(id as string, payload), id as string)
        : await createLearnArticle(payload)

      if (isMs) await saveLearnSteps(articleId, steps)
      // Provenance, recorded once the article exists. Not a warning to clear —
      // it stays on the row so "which of these started as a machine skeleton"
      // stays answerable.
      if (aiModel) await markAiDrafted(articleId, aiModel)

      toast.success(editing ? 'Saved' : 'Created', {
        description: 'It stays a draft until you publish it.',
      })
      navigate(`/learn/${articleId}`)
    } catch (err) {
      const msg = errText(err) ?? ''
      toast.error('Could not save', {
        description: msg.includes('learn_article_ref_uk')
          ? 'That reference number is already used by another entry.'
          : msg,
      })
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Learn" />

      <div className="mx-auto max-w-lg space-y-4 px-4 py-4 pb-6">
        <Link
          to={editing ? `/learn/${id}` : '/learn'}
          className="flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {editing ? 'Back to the entry' : 'Library'}
        </Link>

        <section className="paper space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2">
            <FieldRow label="Shelf" htmlFor="l_cat">
              <Select
                id="l_cat"
                value={categoryCode}
                onChange={(e) => setCategoryCode(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FieldRow>
            <FieldRow label="Type" htmlFor="l_kind">
              <Select
                id="l_kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as LearnKind)}
              >
                <option value="article">Article</option>
                <option value="method_statement">Method statement</option>
              </Select>
            </FieldRow>
          </div>

          <FieldRow label="Title" htmlFor="l_title">
            <Input
              id="l_title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="RCC slab pour — 150 thick"
              className="h-12 text-base"
            />
          </FieldRow>

          <FieldRow
            label="Reference number"
            htmlFor="l_ref"
            hint="Optional. MS-014, QA-03. Must be unique."
          >
            <Input
              id="l_ref"
              value={refNo}
              onChange={(e) => setRefNo(e.target.value)}
              className="h-12 text-base"
            />
          </FieldRow>

          <FieldRow label="Summary" htmlFor="l_sum" hint="One or two lines. Shown in search results.">
            <Textarea
              id="l_sum"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </FieldRow>

          <FieldRow
            label="IS standards cited"
            htmlFor="l_is"
            hint="Comma separated: IS 456, IS 1200. THIS is what links the entry to an NCR that cites the same code — so write them the way they appear on a drawing."
          >
            <Input
              id="l_is"
              value={isRefs}
              onChange={(e) => setIsRefs(e.target.value)}
              placeholder="IS 456, IS 1199"
              className="h-12 text-base"
            />
          </FieldRow>

          <FieldRow label="Tags" htmlFor="l_tags" hint="Comma separated. Searchable.">
            <Input
              id="l_tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="concrete, curing"
              className="h-12 text-base"
            />
          </FieldRow>

          <div>
            <p className="mb-2 text-sm font-medium">Trades</p>
            <div className="flex flex-wrap gap-1.5">
              {TRADES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() =>
                    setTrades((p) =>
                      p.includes(t) ? p.filter((x) => x !== t) : [...p, t],
                    )
                  }
                  className={cn(
                    'min-h-9 rounded-full border px-3 text-xs transition-colors',
                    trades.includes(t)
                      ? 'border-transparent bg-secondary text-secondary-foreground'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </section>

        {isMs && (
          <section className="paper space-y-4 p-5">
            <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Method statement header
            </p>
            <FieldRow label="Activity" htmlFor="l_act" hint="What work this covers. Required.">
              <Input
                id="l_act"
                value={activity}
                onChange={(e) => setActivity(e.target.value)}
                placeholder="RCC slab casting"
                className="h-12 text-base"
              />
            </FieldRow>
            <FieldRow label="Scope" htmlFor="l_scope">
              <Textarea
                id="l_scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="Where it applies, and where it does not."
              />
            </FieldRow>
            <FieldRow label="PPE required" htmlFor="l_ppe">
              <Input
                id="l_ppe"
                value={ppe}
                onChange={(e) => setPpe(e.target.value)}
                placeholder="Helmet, safety shoes, gloves, harness at the edge"
                className="h-12 text-base"
              />
            </FieldRow>
          </section>
        )}

        <section className="paper space-y-3 p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Body
            </p>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setPreview((v) => !v)}
            >
              {preview ? 'Edit' : 'Preview'}
            </Button>
          </div>

          {preview ? (
            <div className="min-h-32 rounded-lg border border-border p-3">
              <Markdown source={body} />
              {body.trim() === '' && (
                <p className="text-xs text-muted-foreground">Nothing to preview.</p>
              )}
            </div>
          ) : (
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={'## Heading\n\nText, **bold**, `code`.\n\n- a point\n- another'}
              className="min-h-48 font-mono text-sm"
            />
          )}

          {/* The 044 rule, said where it applies. */}
          <p className="text-[11px] text-muted-foreground">
            Markdown: # headings, **bold**, *italic*, `code`, - lists, &gt;
            quotes. <strong>Do not paste clause text from an IS standard</strong> —
            they are copyrighted and sold by BIS. Cite the number and title and
            write what we do about it.
          </p>
        </section>

        {isMs && (
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2 px-1">
              <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                Procedure
              </p>
              <Button
                variant="outline"
                size="xs"
                disabled={drafting || (!title.trim() && !activity.trim())}
                onClick={async () => {
                  // Replacing typed steps without asking would throw away
                  // somebody's work; the skeleton is for starting, not redoing.
                  const typed = steps.some((x) => x.instruction.trim() !== '')
                  if (
                    typed &&
                    !window.confirm(
                      'Replace the steps you have written with a fresh skeleton?',
                    )
                  )
                    return

                  setDrafting(true)
                  try {
                    const d = await draftLearnSkeleton({
                      title,
                      activity,
                      trades,
                    })
                    setSteps(
                      d.steps.map((x) => ({
                        key: keySeq++,
                        step_no: 0,
                        instruction: x.instruction,
                        safety_note: x.safety_note,
                        qa_checkpoint: x.qa_checkpoint,
                        is_refs: [],
                      })),
                    )
                    // Only fill fields that are still empty — a suggestion must
                    // never overwrite something the engineer already wrote.
                    if (!summary.trim() && d.summary_prompt) setSummary(d.summary_prompt)
                    if (!scope.trim() && d.scope_prompt) setScope(d.scope_prompt)
                    if (!ppe.trim() && d.ppe_prompt) setPpe(d.ppe_prompt)
                    if (!isRefs.trim() && d.suggested_is_refs.length)
                      setIsRefs(d.suggested_is_refs.join(', '))
                    if (!tags.trim() && d.suggested_tags.length)
                      setTags(d.suggested_tags.join(', '))
                    setAiModel(d.model)
                    toast.success(`${d.steps.length} steps drafted`, {
                      description:
                        'A skeleton, not a document — write the values and check every step.',
                    })
                  } catch (err) {
                    toast.error('Could not draft the skeleton', {
                      description: errText(err),
                    })
                  }
                  setDrafting(false)
                }}
              >
                <Sparkles className="size-3.5" />
                {drafting ? 'Drafting…' : 'Draft the structure'}
              </Button>
            </div>

            {/* Said plainly and kept on screen, because a skeleton READS like a
                document and six weeks later nobody can tell by looking. */}
            {aiModel && (
              <p className="rounded-lg bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] px-3 py-2.5 text-xs text-[var(--warning)]">
                These steps were drafted by {aiModel} as a SKELETON. Every "___"
                is a value you must supply, and every step needs checking against
                how the firm actually works before this is published. No figure
                here came from a standard.
              </p>
            )}

            {steps.map((s, i) => (
              <article key={s.key} className="paper space-y-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="figure text-sm font-semibold text-[var(--accent)]">
                    Step {i + 1}
                  </span>
                  {steps.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon-lg"
                      aria-label={`Remove step ${i + 1}`}
                      onClick={() =>
                        setSteps((p) => p.filter((x) => x.key !== s.key))
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>

                <Textarea
                  value={s.instruction}
                  onChange={(e) =>
                    setSteps((p) =>
                      p.map((x) =>
                        x.key === s.key ? { ...x, instruction: e.target.value } : x,
                      ),
                    )
                  }
                  placeholder="What to do."
                  aria-label={`Step ${i + 1} instruction`}
                />

                <Input
                  value={s.safety_note}
                  onChange={(e) =>
                    setSteps((p) =>
                      p.map((x) =>
                        x.key === s.key ? { ...x, safety_note: e.target.value } : x,
                      ),
                    )
                  }
                  placeholder="Safety note for this step (optional)"
                  aria-label={`Step ${i + 1} safety note`}
                  className="h-11 text-base"
                />

                <Input
                  value={s.qa_checkpoint}
                  onChange={(e) =>
                    setSteps((p) =>
                      p.map((x) =>
                        x.key === s.key
                          ? { ...x, qa_checkpoint: e.target.value }
                          : x,
                      ),
                    )
                  }
                  placeholder="QA checkpoint for this step (optional)"
                  aria-label={`Step ${i + 1} QA checkpoint`}
                  className="h-11 text-base"
                />

                <Input
                  value={s.is_refs.join(', ')}
                  onChange={(e) =>
                    setSteps((p) =>
                      p.map((x) =>
                        x.key === s.key
                          ? { ...x, is_refs: splitList(e.target.value) }
                          : x,
                      ),
                    )
                  }
                  placeholder="IS refs for this step (optional)"
                  aria-label={`Step ${i + 1} IS references`}
                  className="h-11 text-base"
                />
              </article>
            ))}

            <Button
              variant="outline"
              className="h-11 w-full"
              onClick={() => setSteps((p) => [...p, blankStep()])}
            >
              <Plus className="size-4" /> Add a step
            </Button>

            <p className="px-1 text-[11px] text-muted-foreground">
              Safety notes and QA checkpoints belong to the step they apply to —
              a note at the top of a document is read once; beside step 4 it is
              read when it matters. Steps are renumbered on save.
            </p>
          </section>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            className="h-12"
            disabled={busy}
            onClick={() => navigate(editing ? `/learn/${id}` : '/learn')}
          >
            Cancel
          </Button>
          <Button className="h-12" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Create as draft'}
          </Button>
        </div>
      </div>
    </>
  )
}
