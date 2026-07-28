import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link, Navigate, useParams } from 'react-router-dom'
import { DocumentList } from '@/components/DocumentList'
import { ListSkeleton } from '@/components/Skeleton'
import { errText } from '@/lib/errText'
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

  const valid = folder && VALID.has(folder as DocFolder)

  const reload = useCallback(async () => {
    if (!projectId || !valid) return
    try {
      setDocs(await fetchDocuments(projectId, { folder: folder as DocFolder }))
    } catch (err) {
      toast.error('Could not load documents.', { description: errText(err) })
    }
  }, [projectId, folder, valid])

  useEffect(() => {
    setDocs(null)
    void reload()
  }, [reload])

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

      {docs === null && <ListSkeleton rows={4} />}

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

      {docs && docs.length > 0 && <DocumentList docs={docs} onChanged={reload} />}
    </div>
  )
}
