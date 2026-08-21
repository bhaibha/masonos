import {
  Download,
  FileText,
  ScanLine,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import { deleteLearnDocument, learnDocumentUrl } from '@/lib/queries/learn'
import {
  EXTRACT_LABEL,
  type DocExtractStatus,
  type LearnDocumentRow,
} from '@/lib/types'
import { cn } from '@/lib/utils'

function prettySize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * ts_headline wraps matches in <b>. Rendering it as HTML would mean trusting
 * the contents of an uploaded PDF to be safe markup, which it is not — so the
 * string is SPLIT on the tags and re-emitted as React elements. The highlight
 * survives; nothing from a document can inject markup into the app.
 */
function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<b>|<\/b>)/g)
  let bold = false
  return (
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
      {parts.map((p, i) => {
        if (p === '<b>') {
          bold = true
          return null
        }
        if (p === '</b>') {
          bold = false
          return null
        }
        return bold ? (
          <mark key={i} className="bg-transparent font-semibold text-foreground">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      })}
    </p>
  )
}

const STATUS_TONE: Record<DocExtractStatus, string> = {
  ok: 'text-[var(--positive)]',
  no_text: 'text-[var(--warning)]',
  failed: 'text-[var(--danger)]',
  pending: 'text-muted-foreground',
}

export function LearnDocCard({
  doc,
  snippet,
  mayWrite,
  onDeleted,
}: {
  doc: LearnDocumentRow
  snippet?: string | null
  mayWrite: boolean
  onDeleted?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)

  async function open() {
    setBusy(true)
    const url = await learnDocumentUrl(doc.file_path)
    setBusy(false)
    if (!url) {
      toast.error('Could not open that file', {
        description: 'The link could not be signed. Try again in a moment.',
      })
      return
    }
    window.open(url, '_blank', 'noopener')
  }

  const Icon = doc.extract_status === 'no_text' ? ScanLine : FileText

  return (
    <article className="paper p-4">
      <div className="flex gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <p className="font-heading text-[15px] leading-snug font-semibold">
            {doc.title}
          </p>

          <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
            {doc.ref_no && `${doc.ref_no} · `}
            {doc.file_name}
            {doc.file_size ? ` · ${prettySize(doc.file_size)}` : ''}
            {doc.page_count ? ` · ${doc.page_count} pages` : ''}
          </p>

          {doc.description && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {doc.description}
            </p>
          )}

          {snippet && <Snippet html={snippet} />}

          {/* Searchability, stated. Somebody who uploaded a scan needs to know
              that a search will never find what is inside it — otherwise they
              conclude the library is broken. */}
          <p
            className={cn(
              'mt-2 flex items-start gap-1.5 text-[11px]',
              STATUS_TONE[doc.extract_status],
            )}
          >
            {doc.extract_status !== 'ok' && (
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
            )}
            <span>
              {EXTRACT_LABEL[doc.extract_status]}
              {doc.status !== 'published' && ' · Draft'}
              {doc.article_title && ` · on "${doc.article_title}"`}
            </span>
          </p>

          {doc.is_refs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {doc.is_refs.map((r) => (
                <span
                  key={r}
                  className="rounded-full border border-[var(--accent)] px-2 py-0.5 text-[10px] text-[var(--accent)]"
                >
                  {r}
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-10 flex-1 gap-1.5"
              disabled={busy}
              onClick={() => void open()}
            >
              <Download className="size-3.5" /> Open
            </Button>
            {mayWrite && (
              <Button
                variant="ghost"
                size="sm"
                className="h-10 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setConfirm(true)}
                aria-label="Delete this document"
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>

          {confirm && (
            <div className="mt-3 space-y-2 rounded-lg border border-border p-3">
              <p className="text-xs">
                Delete "{doc.title}"? The file goes with it.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10"
                  onClick={() => setConfirm(false)}
                >
                  Keep
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-10"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await deleteLearnDocument(doc.id, doc.file_path)
                      toast.success('Deleted')
                      onDeleted?.()
                    } catch (err) {
                      toast.error('Could not delete', {
                        description: errText(err),
                      })
                      setBusy(false)
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}
