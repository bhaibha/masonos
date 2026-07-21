import { type FormEvent, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldRow, Select } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createDocument } from '@/lib/queries/documents'
import { uploadDocument } from '@/lib/storage'
import {
  canSeeConfidentialDocs,
  canUploadDocs,
  DOC_FOLDERS,
  type DocFolder,
} from '@/lib/types'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function UploadForm() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const navigate = useNavigate()

  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState<DocFolder>('other')
  const [confidential, setConfidential] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!canUploadDocs(role)) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Your role can read the vault but not upload to it.
      </p>
    )
  }

  function pickFile(f: File | null) {
    setError(null)
    setFile(f)
    if (f && title.trim() === '') {
      // Sensible default: filename without extension.
      setTitle(f.name.replace(/\.[^.]+$/, ''))
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!projectId) {
      setError('No project selected.')
      return
    }
    if (!file) {
      setError('Choose a file to upload.')
      return
    }
    if (title.trim() === '') {
      setError('Give the document a title.')
      return
    }

    setBusy(true)
    try {
      setStatus('Uploading file…')
      const { path, fileType } = await uploadDocument(projectId, file)

      setStatus('Saving details…')
      await createDocument({
        project_id: projectId,
        folder,
        title: title.trim(),
        file_path: path,
        file_type: fileType,
        is_confidential: confidential,
      })

      navigate(`/docs/${folder}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload the document.')
      setBusy(false)
      setStatus(null)
    }
  }

  const sizeKb = file ? Math.round(file.size / 1024) : null
  const isImage = file?.type.startsWith('image/') ?? false

  return (
    <form onSubmit={onSubmit} className="space-y-5 pb-6" noValidate>
      <FieldRow
        label="File"
        htmlFor="file"
        hint={
          file
            ? isImage
              ? `${sizeKb} KB image — will be compressed to under 300 KB.`
              : `${sizeKb} KB — uploaded as-is, no compression.`
            : 'PDF, image, Word, drawing — any file type.'
        }
      >
        <input
          ref={fileRef}
          id="file"
          type="file"
          className="sr-only"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1 text-base"
            onClick={() => fileRef.current?.click()}
          >
            {file ? 'Choose another file' : 'Choose file'}
          </Button>
          {file && (
            <Button
              type="button"
              variant="ghost"
              className="h-12"
              onClick={() => pickFile(null)}
            >
              Remove
            </Button>
          )}
        </div>
        {file && (
          <p className="mt-2 truncate rounded-lg bg-secondary px-3 py-2 text-sm">
            {file.name}
          </p>
        )}
      </FieldRow>

      <FieldRow label="Title" htmlFor="title">
        <Input
          id="title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-12 text-base"
          placeholder="Main contract — signed"
        />
      </FieldRow>

      <FieldRow label="Folder" htmlFor="folder">
        <Select
          id="folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value as DocFolder)}
        >
          {DOC_FOLDERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      {canSeeConfidentialDocs(role) && (
        <label
          htmlFor="confidential"
          className="flex items-start gap-3 rounded-xl border border-border p-4"
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

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        {busy ? (status ?? 'Uploading…') : 'Upload document'}
      </Button>
    </form>
  )
}
