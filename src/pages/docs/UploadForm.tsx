import { type FormEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { FieldRow, Select } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { createDocument, fetchSubfolders } from '@/lib/queries/documents'
import { uploadDocument } from '@/lib/storage'
import {
  canSeeConfidentialDocs,
  canUploadDocs,
  DOC_FOLDERS,
  type DocFolder,
  type DocSubfolder,
} from '@/lib/types'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function UploadForm() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const navigate = useNavigate()

  // Arriving from a folder ("Upload here") prefills that folder, so the file
  // lands where the person was already looking.
  const [params] = useSearchParams()
  const fromFolder = params.get('folder') as DocFolder | null
  const initialFolder: DocFolder =
    fromFolder && DOC_FOLDERS.some((f) => f.value === fromFolder)
      ? fromFolder
      : 'other'

  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState<DocFolder>(initialFolder)
  const [subfolder, setSubfolder] = useState(params.get('sub') ?? '')
  const [subs, setSubs] = useState<DocSubfolder[]>([])
  const [confidential, setConfidential] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  // Sub-folders of whichever folder is selected. Changing folder clears the
  // sub-folder, since it belongs to the old one.
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    fetchSubfolders(projectId, folder)
      .then((s) => {
        if (!cancelled) setSubs(s)
      })
      .catch(() => {
        if (!cancelled) setSubs([])
      })
    return () => {
      cancelled = true
    }
  }, [projectId, folder])

  if (!canUploadDocs(role)) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Your role can read the vault but not upload to it.
      </p>
    )
  }

  /** Filename without its extension — the default title for each file. */
  function nameOf(f: File): string {
    return f.name.replace(/\.[^.]+$/, '')
  }

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return
    const picked = Array.from(list)

    setFiles((prev) => {
      // Re-picking the same file twice is a slip, not an intention.
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`))
      return [...prev, ...picked.filter((f) => !seen.has(`${f.name}:${f.size}`))]
    })

    // Only auto-fill the title for a lone file. With several, each keeps its
    // own filename and the title box becomes an optional prefix.
    if (picked.length === 1 && files.length === 0 && title.trim() === '') {
      const first = picked[0]
      if (first) setTitle(nameOf(first))
    }
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, n) => n !== i))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()

    if (!projectId) {
      toast.error('No project selected.')
      return
    }
    if (files.length === 0) {
      toast.error('Choose at least one file to upload.')
      return
    }
    if (files.length === 1 && title.trim() === '') {
      toast.error('Give the document a title.')
      return
    }

    setBusy(true)

    // Each file is uploaded and recorded independently, so one failure doesn't
    // discard the ones that already landed — the toast reports exactly which
    // failed rather than pretending the whole batch did.
    const failed: string[] = []
    let done = 0

    for (const [i, f] of files.entries()) {
      setStatus(`Uploading ${i + 1} of ${files.length} — ${f.name}`)
      try {
        const { path, fileType } = await uploadDocument(projectId, f)

        const docTitle =
          files.length === 1
            ? title.trim()
            : title.trim() === ''
              ? nameOf(f)
              : `${title.trim()} — ${nameOf(f)}`

        await createDocument({
          project_id: projectId,
          folder,
          title: docTitle,
          file_path: path,
          file_type: fileType,
          is_confidential: confidential,
          subfolder_id: subfolder || null,
        })
        done += 1
      } catch (err) {
        failed.push(`${f.name}: ${errText(err)}`)
      }
    }

    if (failed.length > 0) {
      toast.error(
        done > 0
          ? `${done} uploaded, ${failed.length} failed`
          : 'Could not upload',
        { description: failed.join(' · ') },
      )
      setBusy(false)
      setStatus(null)
      if (done === 0) return
    } else {
      toast.success(
        done === 1 ? 'Document uploaded' : `${done} documents uploaded`,
      )
    }

    navigate(subfolder ? `/docs/${folder}?sub=${subfolder}` : `/docs/${folder}`)
  }

  const totalKb = files.reduce((n, f) => n + f.size, 0) / 1024
  const images = files.filter((f) => f.type.startsWith('image/')).length

  return (
    <form onSubmit={onSubmit} className="paper mb-6 space-y-5 p-5" noValidate>
      <FieldRow
        label={files.length > 1 ? `Files (${files.length})` : 'File'}
        htmlFor="file"
        hint={
          files.length === 0
            ? 'PDF, image, Word, drawing — any file type. Pick several at once if you like.'
            : `${Math.round(totalKb)} KB total${
                images > 0
                  ? ` · ${images} image${images === 1 ? '' : 's'} compressed to under 300 KB each`
                  : ' · uploaded as-is, no compression'
              }`
        }
      >
        <input
          ref={fileRef}
          id="file"
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            addFiles(e.target.files)
            // Clear the input so picking the same file again still fires
            // onChange after it has been removed from the list.
            e.target.value = ''
          }}
        />
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1 text-base"
            onClick={() => fileRef.current?.click()}
          >
            {files.length === 0 ? 'Choose files' : 'Add more files'}
          </Button>
          {files.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              className="h-12"
              onClick={() => setFiles([])}
            >
              Clear
            </Button>
          )}
        </div>

        {files.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${f.size}-${i}`}
                className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {Math.round(f.size / 1024)} KB
                </span>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  className="min-h-9 shrink-0 px-1 text-xs text-destructive"
                  aria-label={`Remove ${f.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </FieldRow>

      <FieldRow
        label={files.length > 1 ? 'Title prefix' : 'Title'}
        htmlFor="title"
        hint={
          files.length > 1
            ? 'Optional. Each file is titled by its own filename; a prefix is added in front.'
            : undefined
        }
      >
        <Input
          id="title"
          required={files.length <= 1}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-12 text-base"
          placeholder={
            files.length > 1 ? 'e.g. BBMP submission' : 'Main contract — signed'
          }
        />
      </FieldRow>

      <FieldRow label="Folder" htmlFor="folder">
        <Select
          id="folder"
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value as DocFolder)
            // The old sub-folder belongs to the old folder.
            setSubfolder('')
          }}
        >
          {DOC_FOLDERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      {subs.length > 0 && (
        <FieldRow label="Sub-folder" htmlFor="subfolder">
          <Select
            id="subfolder"
            value={subfolder}
            onChange={(e) => setSubfolder(e.target.value)}
          >
            <option value="">None — file at the folder root</option>
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </FieldRow>
      )}

      {canSeeConfidentialDocs(role) && (
        <label
          htmlFor="confidential"
          className="flex items-start gap-3 rounded-lg bg-secondary/50 p-4"
        >
          <input
            id="confidential"
            type="checkbox"
            checked={confidential}
            onChange={(e) => setConfidential(e.target.checked)}
            className="mt-0.5 size-5"
          />
          <span>
            <span className="block text-sm font-medium">Confidential</span>
            <span className="block text-xs text-muted-foreground">
              Hidden from supervisors. Enforced by RLS on the documents table.
            </span>
          </span>
        </label>
      )}

      {busy && status && (
        <p className="truncate text-xs text-muted-foreground">{status}</p>
      )}

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        {busy
          ? 'Uploading…'
          : files.length > 1
            ? `Upload ${files.length} documents`
            : 'Upload document'}
      </Button>
    </form>
  )
}
