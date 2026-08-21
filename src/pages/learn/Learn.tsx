import {
  BookOpen,
  ChevronRight,
  FileUp,
  ListOrdered,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { LearnDocCard } from '@/components/LearnDocCard'
import { LearnUpload } from '@/components/LearnUpload'
import { Select } from '@/components/Field'
import { PageHeader } from '@/components/PageHeader'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  fetchLearnCategories,
  searchLearn,
  searchLearnDocuments,
} from '@/lib/queries/learn'
import {
  canWriteLearn,
  LEARN_KIND_LABEL,
  type LearnCategory,
  type LearnDocumentHit,
  type LearnKind,
  type LearnSearchHit,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

/**
 * Mason Learn — the firm's reference library.
 *
 * Not project-scoped: an IS code and a method statement are the same on every
 * job, so there is no project picker here. That is also why it sits on its own
 * route rather than inside Docs, which is the per-project vault.
 *
 * Every role reads it. Drafts are hidden from anyone who cannot write them, at
 * RLS — so a half-finished method statement is never followed on site.
 */
export default function Learn() {
  const role = useAuth((s) => s.role)
  const mayWrite = canWriteLearn(role)

  const [categories, setCategories] = useState<LearnCategory[] | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [kind, setKind] = useState<LearnKind | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<LearnSearchHit[] | null>(null)
  const [docs, setDocs] = useState<LearnDocumentHit[] | null>(null)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    void fetchLearnCategories()
      .then(setCategories)
      .catch((err) => {
        toast.error('Could not load the library', { description: errText(err) })
        setCategories([])
      })
  }, [])

  const run = useCallback(async () => {
    setHits(null)
    setDocs(null)

    // allSettled, never all: a failure searching documents must not blank the
    // articles list as well. One dead panel is a much smaller lie than an
    // empty library (the 056 lesson).
    const [a, d] = await Promise.allSettled([
      searchLearn(q, category, kind),
      // Documents have no kind, so the Articles/Method-statements filter simply
      // excludes them rather than being applied meaninglessly.
      kind === null ? searchLearnDocuments(q, category) : Promise.resolve([]),
    ])

    if (a.status === 'fulfilled') setHits(a.value)
    else {
      toast.error('Search failed', { description: errText(a.reason) })
      setHits([])
    }

    if (d.status === 'fulfilled') setDocs(d.value)
    else {
      toast.error('Could not search documents', {
        description: errText(d.reason),
      })
      setDocs([])
    }
  }, [q, category, kind])

  // Debounced: the search is a server round trip, and firing one per keystroke
  // on a site connection is worse than waiting 300 ms.
  useEffect(() => {
    const t = setTimeout(() => void run(), 300)
    return () => clearTimeout(t)
  }, [run])

  const searching = q.trim() !== '' || category !== null || kind !== null

  return (
    <>
      <PageHeader title="Learn" />

      <div className="mx-auto max-w-lg space-y-4 px-4 py-4 pb-6">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the library…"
            aria-label="Search the library"
            className="h-12 pr-10 pl-10 text-base"
          />
          {q !== '' && (
            <button
              type="button"
              onClick={() => setQ('')}
              aria-label="Clear search"
              className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {/* Quoted phrases and a leading minus both work, because the server
            uses websearch_to_tsquery. Saying so costs one line and saves
            somebody discovering it by accident. */}
        <p className="px-1 text-[11px] text-muted-foreground">
          Searches titles, bodies and the steps inside method statements. Use
          "quotes" for an exact phrase, or -word to exclude one.
        </p>

        <div className="grid grid-cols-2 gap-2">
          <Select
            value={category ?? ''}
            onChange={(e) => setCategory(e.target.value || null)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {(categories ?? []).map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.article_count})
              </option>
            ))}
          </Select>
          <Select
            value={kind ?? ''}
            onChange={(e) => setKind((e.target.value || null) as LearnKind | null)}
            aria-label="Filter by type"
          >
            <option value="">Everything</option>
            <option value="method_statement">Method statements</option>
            <option value="article">Articles</option>
          </Select>
        </div>

        {/* Base UI's Button has no asChild — style the Link directly, the same
            way EmptyState does. */}
        {mayWrite && !uploading && (
          <div className="grid grid-cols-2 gap-2">
            <Link
              to="/learn/new"
              className={cn(buttonVariants(), 'h-12 gap-2 text-base')}
            >
              <Plus className="size-4" /> Write
            </Link>
            <Button
              variant="outline"
              className="h-12 gap-2 text-base"
              onClick={() => setUploading(true)}
            >
              <FileUp className="size-4" /> Upload
            </Button>
          </div>
        )}

        {uploading && (
          <LearnUpload
            categories={categories ?? []}
            defaultCategory={category}
            onCancel={() => setUploading(false)}
            onDone={() => {
              setUploading(false)
              void run()
              void fetchLearnCategories().then(setCategories).catch(() => {})
            }}
          />
        )}

        {/* The shelves. Shown when nothing is being searched, because a library
            you can only reach through a search box is a library you have to
            already know the contents of. */}
        {!searching && categories && categories.length > 0 && (
          <section className="space-y-2">
            <p className="px-1 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Browse
            </p>
            {categories.map((c) => (
              <button
                key={c.code}
                type="button"
                onClick={() => setCategory(c.code)}
                className="paper flex w-full items-center gap-3 p-4 text-left transition-shadow hover:shadow-[var(--shadow-card-lift)]"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-heading text-[15px] font-semibold">
                    {c.name}
                  </p>
                  {c.description && (
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      {c.description}
                    </p>
                  )}
                </div>
                {/* Both counts, because a shelf holding only uploaded PDFs was
                    reading as empty and nobody would open it. */}
                <span className="figure shrink-0 text-right text-sm tabular-nums">
                  {c.article_count + c.document_count}
                  {c.document_count > 0 && (
                    <span className="block text-[10px] font-normal text-muted-foreground">
                      {c.document_count} file
                      {c.document_count === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </section>
        )}

        {searching && (
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="text-[11px] text-muted-foreground">
              {hits === null
                ? 'Searching…'
                : `${hits.length} entr${hits.length === 1 ? 'y' : 'ies'}` +
                  (docs && docs.length > 0
                    ? ` · ${docs.length} document${docs.length === 1 ? '' : 's'}`
                    : '')}
            </p>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setQ('')
                setCategory(null)
                setKind(null)
              }}
            >
              Clear filters
            </Button>
          </div>
        )}

        {hits === null && searching && <ListSkeleton rows={4} />}

        {hits !== null && hits.length === 0 && (docs ?? []).length === 0 && (
          <EmptyState
            icon={BookOpen}
            title={
              q.trim() ? `Nothing matches "${q.trim()}"` : 'Nothing here yet'
            }
            body={
              q.trim()
                ? 'Try a different word, or clear the category filter.'
                : mayWrite
                  ? 'Write the first method statement or reference note.'
                  : 'The office has not added anything to this shelf yet.'
            }
            actionLabel={mayWrite && !q.trim() ? 'Write something' : undefined}
            actionTo={mayWrite && !q.trim() ? '/learn/new' : undefined}
          />
        )}

        {hits !== null && hits.length > 0 && (
          <Stagger className="space-y-3">
            {hits.map((h) => (
              <RevealItem key={h.id}>
                <HitCard hit={h} />
              </RevealItem>
            ))}
          </Stagger>
        )}

        {/* Documents, in their own labelled block. Interleaving them with
            articles would mean ranking a supplier's brochure against a method
            statement the firm wrote, which are not comparable things. */}
        {docs !== null && docs.length > 0 && (
          <section className="space-y-2 pt-2">
            <p className="px-1 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Documents
            </p>
            <Stagger className="space-y-3">
              {docs.map((d) => (
                <RevealItem key={d.id}>
                  <LearnDocCard
                    doc={d}
                    snippet={d.snippet}
                    mayWrite={mayWrite}
                    onDeleted={() => void run()}
                  />
                </RevealItem>
              ))}
            </Stagger>
          </section>
        )}
      </div>
    </>
  )
}

function HitCard({ hit }: { hit: LearnSearchHit }) {
  return (
    <Link
      to={`/learn/${hit.id}`}
      className="paper block p-5 transition-shadow hover:shadow-[var(--shadow-card-lift)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[16px] font-semibold">{hit.title}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {hit.category_name}
            {hit.ref_no && ` · ${hit.ref_no}`}
            {hit.kind === 'method_statement' &&
              ` · ${hit.step_count} step${hit.step_count === 1 ? '' : 's'}`}
          </p>
        </div>
        {hit.status !== 'published' && (
          <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[var(--warning)]">
            {hit.status === 'draft' ? 'Draft' : 'Archived'}
          </span>
        )}
      </div>

      {/* The server's highlighted extract. `matched_in = step` is worth saying:
          it tells the reader the phrase is inside the procedure, not the
          heading, which is usually exactly what they wanted. */}
      {hit.snippet && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          <Highlighted text={hit.snippet} />
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {hit.matched_in === 'step' && (
          <span className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground">
            <ListOrdered className="size-3" /> found in a step
          </span>
        )}
        {hit.kind === 'method_statement' && hit.matched_in !== 'step' && (
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground">
            {LEARN_KIND_LABEL[hit.kind]}
          </span>
        )}
        {hit.is_refs.slice(0, 3).map((r) => (
          <span
            key={r}
            className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {r}
          </span>
        ))}
        {hit.tags.slice(0, 2).map((t) => (
          <span key={t} className="text-[10px] text-muted-foreground">
            #{t}
          </span>
        ))}
      </div>
    </Link>
  )
}

/**
 * ts_headline wraps matches in <b>…</b>. Rendered by SPLITTING ON THE MARKER
 * and emitting real elements — never dangerouslySetInnerHTML, so a title
 * containing markup cannot inject anything.
 */
function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(<b>.*?<\/b>)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('<b>') ? (
          <mark
            key={i}
            className={cn('rounded bg-[color-mix(in_oklab,var(--accent)_22%,transparent)] px-0.5 text-foreground')}
          >
            {p.slice(3, -4)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}
