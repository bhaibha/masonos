import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { DocumentList } from '@/components/DocumentList'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchDocuments, fetchFolderCounts } from '@/lib/queries/documents'
import { DOC_FOLDERS, type DocumentRow } from '@/lib/types'
import { useProjects } from '@/store/project'

export default function Folders() {
  const projectId = useProjects((s) => s.selectedId)
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''

  const [term, setTerm] = useState(query)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [results, setResults] = useState<DocumentRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    setError(null)

    fetchDocuments(projectId, { search: query })
      .then((d) => {
        if (!cancelled) setResults(d)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Search failed.')
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

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

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
          {results && results.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nothing matched that title.
            </p>
          )}
        </>
      ) : (
        <ul className="grid grid-cols-2 gap-3">
          {DOC_FOLDERS.map((f) => (
            <li key={f.value}>
              <Link
                to={`/docs/${f.value}`}
                className="flex h-24 flex-col justify-between rounded-xl border border-border p-4 transition-colors hover:bg-muted/50"
              >
                <span className="text-sm font-medium">{f.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {counts[f.value] ?? 0}{' '}
                  {(counts[f.value] ?? 0) === 1 ? 'file' : 'files'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
