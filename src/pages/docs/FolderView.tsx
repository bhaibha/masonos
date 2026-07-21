import { useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { DocumentList } from '@/components/DocumentList'
import { fetchDocuments } from '@/lib/queries/documents'
import {
  canUploadDocs,
  DOC_FOLDER_LABEL,
  DOC_FOLDERS,
  type DocFolder,
  type DocumentRow,
} from '@/lib/types'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const VALID = new Set(DOC_FOLDERS.map((f) => f.value))

export default function FolderView() {
  const { folder } = useParams<{ folder: string }>()
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  const [docs, setDocs] = useState<DocumentRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const valid = folder && VALID.has(folder as DocFolder)

  useEffect(() => {
    if (!projectId || !valid) return
    let cancelled = false
    setDocs(null)
    setError(null)

    fetchDocuments(projectId, { folder: folder as DocFolder })
      .then((d) => {
        if (!cancelled) setDocs(d)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load documents.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectId, folder, valid])

  if (!valid) return <Navigate to="/docs" replace />

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-semibold">
          {DOC_FOLDER_LABEL[folder as DocFolder]}
        </h2>
        <Link
          to="/docs"
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          All folders
        </Link>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {docs === null && !error && (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      )}

      {docs?.length === 0 && (
        <div className="py-10 text-center">
          <p className="text-sm text-muted-foreground">Nothing filed here yet.</p>
          {canUploadDocs(role) && (
            <Link
              to="/docs/upload"
              className="mt-2 inline-block text-sm font-medium underline underline-offset-4"
            >
              Upload a document
            </Link>
          )}
        </div>
      )}

      {docs && docs.length > 0 && <DocumentList docs={docs} />}
    </div>
  )
}
