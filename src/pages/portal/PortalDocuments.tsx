import { Download, FileText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import {
  type ClientDocument,
  fetchDocuments,
  signedDocumentUrl,
} from '@/lib/queries/portal'

const FOLDER_LABEL: Record<string, string> = {
  contracts: 'Contract',
  drawings: 'Drawing',
  permits: 'Permit',
  invoices: 'Invoice',
  qc_certificates: 'Quality',
  photos: 'Photo',
  other: 'Document',
}

export default function PortalDocuments() {
  const [docs, setDocs] = useState<ClientDocument[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void fetchDocuments()
      .then(setDocs)
      .catch(() => setDocs([]))
  }, [])

  async function open(doc: ClientDocument) {
    setBusy(doc.id)
    const { url, error } = await signedDocumentUrl(doc.file_path)
    setBusy(null)
    if (!url) {
      // Say what actually happened. Guessing at a cause here ("your team may
      // have unshared it") was wrong the first time it fired — the real reason
      // was a storage policy that had not been created yet.
      toast.error('Could not open that file', {
        description: error ?? 'Storage refused the request.',
      })
      console.error('[portal] signed url failed', {
        bucket: 'documents',
        path: doc.file_path,
        error,
      })
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Documents
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything your project team has shared with you.
        </p>
      </div>

      {docs === null && <ListSkeleton rows={4} />}

      {docs?.length === 0 && (
        <EmptyState
          icon={FileText}
          title="No documents shared yet"
          body="Drawings, contracts and certificates your team shares will appear here."
        />
      )}

      {docs && docs.length > 0 && (
        <Stagger className="space-y-3">
          {docs.map((d) => (
            <RevealItem key={d.id}>
              <div className="paper flex items-center justify-between gap-4 p-5">
                <div className="min-w-0">
                  <p className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                    {FOLDER_LABEL[d.folder] ?? 'Document'}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-medium">{d.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Shared {fmtDate(d.created_at)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="h-11 shrink-0"
                  disabled={busy === d.id}
                  onClick={() => void open(d)}
                >
                  <Download className="size-4" />
                  {busy === d.id ? 'Opening…' : 'Open'}
                </Button>
              </div>
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
