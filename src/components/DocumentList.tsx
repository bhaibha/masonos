import { useState } from 'react'
import { DeleteButton } from '@/components/DeleteAction'
import { signedDocumentUrl } from '@/lib/storage'
import { type DocumentRow, PO_STATUS_LABEL, type PoStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

const PO_STATUS_TONE: Partial<Record<PoStatus, string>> = {
  requested: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  approved: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  receiving: 'bg-secondary text-secondary-foreground',
  received: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  rejected: 'bg-destructive/10 text-destructive',
  closed: 'bg-secondary text-muted-foreground',
  cancelled: 'bg-secondary text-muted-foreground',
}

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

export function DocumentList({
  docs,
  onChanged,
}: {
  docs: DocumentRow[]
  /** omit to hide the delete action (e.g. read-only embeds) */
  onChanged?: () => void | Promise<void>
}) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border">
      {docs.map((d) => (
        <DocumentItem key={d.id} doc={d} onChanged={onChanged} />
      ))}
    </ul>
  )
}

function DocumentItem({
  doc,
  onChanged,
}: {
  doc: DocumentRow
  onChanged?: () => void | Promise<void>
}) {
  const role = useAuth((s) => s.role)
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
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{doc.title}</p>
            {doc.po_status && (
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                  PO_STATUS_TONE[doc.po_status] ??
                    'bg-secondary text-muted-foreground',
                )}
              >
                {PO_STATUS_LABEL[doc.po_status]}
              </span>
            )}
          </div>
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

      {/* Outside the button — nesting a button inside a button is invalid and
          the click would fall through to "open the file". */}
      {onChanged && (
        <div className="px-4 pb-2">
          <DeleteButton
            table="documents"
            id={doc.id}
            name={doc.title}
            role={role}
            onDeleted={onChanged}
            className="-ml-2"
          />
        </div>
      )}
    </li>
  )
}
