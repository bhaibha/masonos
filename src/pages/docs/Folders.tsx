import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link, useSearchParams } from 'react-router-dom'
import { DocumentList } from '@/components/DocumentList'
import { RevealItem, Stagger } from '@/components/Reveal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { fetchDocuments, fetchFolderCounts } from '@/lib/queries/documents'
import { DOC_FOLDERS, type DocumentRow } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useProjects } from '@/store/project'

export default function Folders() {
  const projectId = useProjects((s) => s.selectedId)
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''

  const [term, setTerm] = useState(query)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [results, setResults] = useState<DocumentRow[] | null>(null)

  useEffect(() => {
    setTerm(query)
  }, [query])

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    fetchFolderCounts(projectId)
      .then((c) => {
        if (!cancelled) setCounts(c)
      })
      .catch(() => setCounts({}))
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId || query.trim() === '') {
      setResults(null)
      return
    }

    let cancelled = false
    setResults(null)

    fetchDocuments(projectId, { search: query })
      .then((d) => {
        if (!cancelled) setResults(d)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          toast.error('Search failed.', { description: errText(err) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectId, query])

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    setParams(term.trim() === '' ? {} : { q: term.trim() }, { replace: true })
  }

  return (
    <div className="space-y-4 pb-6">
      <form onSubmit={submitSearch} className="flex gap-2">
        <Input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search documents by title"
          aria-label="Search documents"
          className="h-12 flex-1 text-base"
        />
        <Button type="submit" className="h-12 px-5">
          Search
        </Button>
      </form>

      {query.trim() !== '' ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {results === null
                ? 'Searching…'
                : `${results.length} result${results.length === 1 ? '' : 's'} for “${query}”`}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setParams({}, { replace: true })}
            >
              Clear
            </Button>
          </div>

          {results && results.length > 0 && <DocumentList docs={results} />}
          {/* A search returning nothing is a non-match, not an empty state —
              plain text, no icon, no call to action. */}
          {results && results.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nothing matched that title.
            </p>
          )}
        </>
      ) : (
        <Stagger className="grid grid-cols-2 gap-3">
          {DOC_FOLDERS.map((f) => {
            const n = counts[f.value] ?? 0
            return (
              <RevealItem key={f.value} className="h-full">
                <Link
                  to={`/docs/${f.value}`}
                  className="paper flex h-24 flex-col justify-between p-4 transition-shadow hover:paper-lift focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  <span className="text-sm font-medium">{f.label}</span>
                  <span
                    className={cn(
                      'text-xs tabular-nums',
                      n > 0 ? 'text-muted-foreground' : 'text-muted-foreground/60',
                    )}
                  >
                    {n} {n === 1 ? 'file' : 'files'}
                  </span>
                </Link>
              </RevealItem>
            )
          })}
        </Stagger>
      )}
    </div>
  )
}
