import { ChevronRight, FolderOpen, FolderPlus, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { DeleteButton } from '@/components/DeleteAction'
import { DocumentList } from '@/components/DocumentList'
import { EmptyState } from '@/components/EmptyState'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  createSubfolder,
  fetchDocuments,
  fetchSubfolders,
} from '@/lib/queries/documents'
import {
  canManageSubfolders,
  canUploadDocs,
  DOC_FOLDER_LABEL,
  DOC_FOLDERS,
  type DocFolder,
  type DocSubfolder,
  type DocumentRow,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const VALID = new Set(DOC_FOLDERS.map((f) => f.value))

export default function FolderView() {
  const { folder } = useParams<{ folder: string }>()
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  // Which sub-folder is open, as a query param rather than a route segment —
  // /docs/:folder/:sub would be a third path shape competing with the drawing
  // register's routes, and static-vs-param ranking has bitten this file once.
  const [params, setParams] = useSearchParams()
  const openSub = params.get('sub')

  const [docs, setDocs] = useState<DocumentRow[] | null>(null)
  const [subs, setSubs] = useState<DocSubfolder[] | null>(null)
  const [creating, setCreating] = useState(false)

  const valid = folder && VALID.has(folder as DocFolder)
  const maySub = canManageSubfolders(role)

  const reload = useCallback(async () => {
    if (!projectId || !valid) return
    try {
      const [d, s] = await Promise.all([
        fetchDocuments(projectId, { folder: folder as DocFolder }),
        fetchSubfolders(projectId, folder as DocFolder),
      ])
      setDocs(d)
      setSubs(s)
    } catch (err) {
      toast.error('Could not load documents.', { description: errText(err) })
      setDocs([])
      setSubs([])
    }
  }, [projectId, folder, valid])

  useEffect(() => {
    setDocs(null)
    void reload()
  }, [reload])

  const current = useMemo(
    () => subs?.find((s) => s.id === openSub) ?? null,
    [subs, openSub],
  )

  // Files in the open sub-folder, or those sitting at the folder root.
  const shown = useMemo(
    () =>
      docs?.filter((d) =>
        openSub ? d.subfolder_id === openSub : d.subfolder_id === null,
      ) ?? null,
    [docs, openSub],
  )

  if (!valid) return <Navigate to="/docs" replace />

  const label = DOC_FOLDER_LABEL[folder as DocFolder]
  const uploadTo = openSub
    ? `/docs/upload?folder=${folder}&sub=${openSub}`
    : `/docs/upload?folder=${folder}`

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-semibold">
          {current ? `${label} · ${current.name}` : label}
        </h2>
        {current ? (
          <Link
            to={`/docs/${folder}`}
            className="text-sm text-muted-foreground underline underline-offset-4"
          >
            Back to {label}
          </Link>
        ) : (
          <Link
            to="/docs"
            className="text-sm text-muted-foreground underline underline-offset-4"
          >
            All folders
          </Link>
        )}
      </div>

      {/* Sub-folders, only at the folder root — one level, not a tree. */}
      {!openSub && (
        <>
          {maySub && !creating && (
            <Button
              variant="outline"
              className="h-11 w-full"
              onClick={() => setCreating(true)}
            >
              <FolderPlus className="size-4" aria-hidden="true" />
              New sub-folder
            </Button>
          )}

          {creating && (
            <NewSubfolderForm
              folder={folder as DocFolder}
              onCancel={() => setCreating(false)}
              onSaved={async () => {
                setCreating(false)
                await reload()
              }}
            />
          )}

          {subs && subs.length > 0 && (
            <Stagger className="space-y-2">
              {subs.map((s) => {
                const n =
                  docs?.filter((d) => d.subfolder_id === s.id).length ?? 0
                return (
                  <RevealItem key={s.id}>
                    <div className="paper flex items-center gap-2 p-4">
                      <button
                        type="button"
                        onClick={() => setParams({ sub: s.id })}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <FolderOpen
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-medium">
                            {s.name}
                          </span>
                          <span className="block text-xs text-muted-foreground tabular-nums">
                            {n === 0 ? 'Empty' : `${n} file${n === 1 ? '' : 's'}`}
                          </span>
                        </span>
                        <ChevronRight
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      </button>
                      {/* Deleting a sub-folder never takes files with it —
                          subfolder_id is ON DELETE SET NULL, so they come back
                          to the folder root. */}
                      <DeleteButton
                        table="doc_subfolders"
                        id={s.id}
                        name={`${label} · ${s.name}`}
                        role={role}
                        label=""
                        onDeleted={reload}
                      />
                    </div>
                  </RevealItem>
                )
              })}
            </Stagger>
          )}
        </>
      )}

      {/* Upload lives here rather than as a top-level tab: you file into the
          folder you're looking at, and it arrives prefilled. */}
      {canUploadDocs(role) && shown !== null && shown.length > 0 && (
        <Link
          to={uploadTo}
          className={cn(buttonVariants({ variant: 'outline' }), 'h-11 w-full')}
        >
          <Upload className="size-4" aria-hidden="true" />
          Upload to {current ? current.name : label}
        </Link>
      )}

      {docs === null && <ListSkeleton rows={4} />}

      {shown?.length === 0 && (
        <>
          <EmptyState
            icon={FolderOpen}
            title="Nothing filed here yet"
            body={
              openSub
                ? 'Upload a document into this sub-folder, or move one here from the folder root.'
                : subs && subs.length > 0
                  ? 'Files sitting directly in this folder appear here. Open a sub-folder above for the rest.'
                  : 'Drawings, permits, certificates and contracts filed to this folder appear here.'
            }
            actionLabel={canUploadDocs(role) ? 'Upload a document' : undefined}
            actionTo={canUploadDocs(role) ? uploadTo : undefined}
          />
          {!openSub && <OtherProjectsHint />}
        </>
      )}

      {shown && shown.length > 0 && (
        <DocumentList
          docs={shown}
          onChanged={reload}
          subfolders={subs ?? []}
          currentSubfolder={openSub}
        />
      )}
    </div>
  )
}

function NewSubfolderForm({
  folder,
  onCancel,
  onSaved,
}: {
  folder: DocFolder
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const projectId = useProjects((s) => s.selectedId)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!projectId) return
    if (name.trim() === '') {
      toast.error('Give the sub-folder a name')
      return
    }

    setBusy(true)
    try {
      await createSubfolder(projectId, folder, name)
      toast.success(`${name.trim()} created`)
      await onSaved()
    } catch (err) {
      // The case-insensitive unique index is what catches a duplicate.
      toast.error('Could not create the sub-folder', {
        description: errText(err),
      })
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="paper flex gap-2 p-4" noValidate>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={`New sub-folder in ${DOC_FOLDER_LABEL[folder]}`}
        className="h-11 flex-1 text-base"
        aria-label="Sub-folder name"
        autoFocus
      />
      <Button type="submit" disabled={busy} className="h-11">
        {busy ? 'Creating…' : 'Create'}
      </Button>
      <Button type="button" variant="ghost" className="h-11" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}
