import { Image as ImageIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { RevealItem, Stagger } from '@/components/Reveal'
import { Skeleton } from '@/components/Skeleton'
import { type ClientPhoto, fetchPhotos, signedPhotoUrl } from '@/lib/queries/portal'

export default function PortalPhotos() {
  const [photos, setPhotos] = useState<ClientPhoto[] | null>(null)
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const [open, setOpen] = useState<ClientPhoto | null>(null)

  useEffect(() => {
    void (async () => {
      let list: ClientPhoto[] = []
      try {
        list = await fetchPhotos()
      } catch {
        list = []
      }
      setPhotos(list)

      // Signed urls resolve individually — one unreadable object must not blank
      // the whole gallery. Migration 068 grants a client read on a site-photos
      // object ONLY where a matching client_photos row exists, so a photo that
      // was unpublished between the list and the fetch correctly returns null.
      const entries = await Promise.all(
        list.map(async (p) => {
          // Signed against the photo's OWN bucket (074): a site-log photo is
          // in `site-photos`, a shared vault image in `documents`.
          const { url, error } = await signedPhotoUrl(p.photo_path, p.bucket)
          if (error) {
            console.error('[portal] photo url failed', {
              path: p.photo_path,
              bucket: p.bucket,
              source: p.source,
              error,
            })
          }
          return [p.photo_path, url] as const
        }),
      )
      setUrls(Object.fromEntries(entries))
    })()
  }, [])

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          Photos
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Shared by your project team as work progresses.
        </p>
      </div>

      {photos === null && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/3] w-full rounded-xl" />
          ))}
        </div>
      )}

      {photos?.length === 0 && (
        <EmptyState
          icon={ImageIcon}
          title="No photos yet"
          body="Your team shares site photos here as the work moves along."
        />
      )}

      {photos && photos.length > 0 && (
        <Stagger className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {photos.map((p) => {
            const url = urls[p.photo_path]
            return (
              <RevealItem key={p.id}>
                <button
                  type="button"
                  onClick={() => url && setOpen(p)}
                  disabled={!url}
                  className="paper group block w-full overflow-hidden p-0 text-left disabled:cursor-default"
                >
                  <div className="aspect-[4/3] w-full overflow-hidden bg-secondary">
                    {url ? (
                      <img
                        src={url}
                        alt={p.caption ?? 'Site photo'}
                        loading="lazy"
                        className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center">
                        <ImageIcon className="size-5 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  {(p.caption || p.taken_on) && (
                    <div className="px-3.5 py-3">
                      {p.caption && <p className="text-sm leading-snug">{p.caption}</p>}
                      {p.taken_on && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {fmtDate(p.taken_on)}
                        </p>
                      )}
                    </div>
                  )}
                </button>
              </RevealItem>
            )
          })}
        </Stagger>
      )}

      {/* Lightbox. Plain fixed overlay rather than a dialog component — one
          image and a close button does not need focus management machinery. */}
      {open && urls[open.photo_path] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(null)}
          role="presentation"
        >
          <button
            type="button"
            aria-label="Close"
            className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white"
            onClick={() => setOpen(null)}
          >
            <X className="size-5" />
          </button>
          <figure className="max-h-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
            <img
              src={urls[open.photo_path] as string}
              alt={open.caption ?? 'Site photo'}
              className="max-h-[80svh] w-auto rounded-lg object-contain"
            />
            {open.caption && (
              <figcaption className="mt-3 text-center text-sm text-white/80">
                {open.caption}
              </figcaption>
            )}
          </figure>
        </div>
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
