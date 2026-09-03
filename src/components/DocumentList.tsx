import { useState } from 'react'
import { toast } from 'sonner'
import { DeleteButton } from '@/components/DeleteAction'
import { Select } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { errText } from '@/lib/errText'
import { setDocumentShared, setDocumentSubfolder } from '@/lib/queries/documents'
import { signedDocumentUrl } from '@/lib/storage'
import {
  canUploadDocs,
  type DocSubfolder,
  type DocumentRow,
  PO_STATUS_LABEL,
  type PoStatus,
} from '@/lib/types'
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
  subfolders = [],
  currentSubfolder = null,
}: {
  docs: DocumentRow[]
  /** omit to hide the delete action (e.g. read-only embeds) */
  onChanged?: () => void | Promise<void>
  /** sub-folders of this document's folder, for the move action (031) */
  subfolders?: DocSubfolder[]
  /** the sub-folder currently open, or null at the folder root */
  currentSubfolder?: string | null
}) {
  return (
    <Stagger className="paper divide-y divide-border overflow-hidden">
      {docs.map((d) => (
        <RevealItem key={d.id}>
          <DocumentItem
            doc={d}
            onChanged={onChanged}
            subfolders={subfolders}
            currentSubfolder={currentSubfolder}
          />
        </RevealItem>
      ))}
    </Stagger>
  )
}

function DocumentItem({
  doc,
  onChanged,
  subfolders,
  currentSubfolder,
}: {
  doc: DocumentRow
  onChanged?: () => void | Promise<void>
  subfolders: DocSubfolder[]
  currentSubfolder: string | null
}) {
  const role = useAuth((s) => s.role)
  const [busy, setBusy] = useState(false)
  const [moving, setMoving] = useState(false)
  const [shared, setShared] = useState(doc.client_visible)
  const [sharing, setSharing] = useState(false)

  // Founder/PM only, matching who may publish a photo (065). And NEVER for a
  // confidential document: the curated view and the 068 storage policy both
  // refuse one regardless of this flag, so offering the toggle would promise
  // something the database would then decline.
  const canShare = (role === 'founder' || role === 'pm') && !doc.is_confidential

  async function toggleShare() {
    setSharing(true)
    try {
      await setDocumentShared(doc.id, !shared)
      setShared(!shared)
      toast.success(
        shared ? 'No longer shared with the client' : 'Shared with the client',
        {
          description: shared
            ? 'Any link they already had stops working.'
            : 'It appears in their portal straight away.',
        },
      )
    } catch (err) {
      // errText, not String(err): a Supabase PostgrestError is a plain object
      // and stringifies to "[object Object]", which hid the real cause of this
      // exact failure for a whole debugging round.
      toast.error('Could not change what the client sees', {
        description: errText(err),
      })
    }
    setSharing(false)
  }

  async function open() {
    setBusy(true)
    const url = await signedDocumentUrl(doc.file_path)
    setBusy(false)
    if (!url) {
      toast.error('Could not open this file', {
        description: 'The signed link could not be created — try again shortly.',
      })
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div>
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
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {doc.is_confidential && (
            <span className="rounded-md bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
              Confidential
            </span>
          )}
          {shared && (
            <span className="rounded-md bg-[var(--positive)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--positive)]">
              Client
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
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          <DeleteButton
            table="documents"
            id={doc.id}
            name={doc.title}
            role={role}
            onDeleted={onChanged}
            className="-ml-2"
          />

          {/* Sharing lives HERE, on the document, not on an Admin screen.
              Two places to manage visibility means the two eventually
              disagree, and the disagreement is silent. */}
          {canShare && (
            <button
              type="button"
              onClick={() => void toggleShare()}
              disabled={sharing}
              aria-pressed={shared}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                shared
                  ? 'bg-[var(--positive)]/15 text-[var(--positive)]'
                  : 'bg-secondary text-muted-foreground hover:text-foreground',
              )}
            >
              {shared ? 'Shared with client' : 'Share with client'}
            </button>
          )}

          {/* Filing a document into a sub-folder after the fact. Only offered
              when there is somewhere else for it to go. */}
          {canUploadDocs(role) &&
            (subfolders.length > 0 || currentSubfolder !== null) && (
              <Select
                value={doc.subfolder_id ?? ''}
                disabled={moving}
                aria-label={`Move ${doc.title}`}
                className="h-9 w-auto max-w-[60%] text-xs"
                onChange={async (e) => {
                  const next = e.target.value || null
                  if (next === (doc.subfolder_id ?? null)) return
                  setMoving(true)
                  try {
                    await setDocumentSubfolder(doc.id, next)
                    toast.success(
                      next
                        ? `Moved to ${subfolders.find((s) => s.id === next)?.name ?? 'sub-folder'}`
                        : 'Moved to the folder root',
                    )
                    await onChanged()
                  } catch (err) {
                    toast.error('Could not move the document', {
                      description: errText(err),
                    })
                  }
                  setMoving(false)
                }}
              >
                <option value="">Folder root</option>
                {subfolders.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
        </div>
      )}
    </div>
  )
}
