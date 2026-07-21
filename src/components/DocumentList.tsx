import { useState } from 'react'
import { signedDocumentUrl } from '@/lib/storage'
import type { DocumentRow } from '@/lib/types'

function prettyType(mime: string | null): string {
  if (!mime) return 'File'
  if (mime === 'application/pdf') return 'PDF'
  if (mime.startsWith('image/')) return 'Image'
  if (mime.includes('word')) return 'Word'
  if (mime.includes('sheet') || mime.includes('excel')) return 'Excel'
  if (mime.startsWith('text/')) return 'Text'
  return 'File'
}

function prettyDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

export function DocumentList({ docs }: { docs: DocumentRow[] }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border">
      {docs.map((d) => (
        <DocumentItem key={d.id} doc={d} />
      ))}
    </ul>
  )
}

function DocumentItem({ doc }: { doc: DocumentRow }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function open() {
    setBusy(true)
    setError(null)
    const url = await signedDocumentUrl(doc.file_path)
    setBusy(false)
    if (!url) {
      setError('Could not open this file.')
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => void open()}
        disabled={busy}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{doc.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {prettyType(doc.file_type)} · {prettyDate(doc.created_at)}
            {doc.uploaded_by_name && ` · ${doc.uploaded_by_name}`}
          </p>
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {doc.is_confidential && (
            <span className="rounded-md bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
              Confidential
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {busy ? '…' : 'Open'}
          </span>
        </div>
      </button>
    </li>
  )
}
