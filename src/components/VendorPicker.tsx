import { useMemo, useState } from 'react'
import { VendorForm } from '@/components/VendorForm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Vendor } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Searchable vendor selector with inline creation.
 *
 * Not a native <select> — unlike the category picker, the vendor list grows
 * without bound and needs filtering. Rendered as buttons rather than a
 * shadcn Command palette so it works without adding a component from the
 * registry, and keeps 48px rows for one-handed use.
 */
export function VendorPicker({
  vendors,
  value,
  onChange,
  onVendorCreated,
}: {
  vendors: Vendor[]
  value: string
  onChange: (vendorId: string) => void
  onVendorCreated: (v: Vendor) => void
}) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [term, setTerm] = useState('')

  const selected = vendors.find((v) => v.id === value) ?? null

  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase()
    if (t === '') return vendors
    return vendors.filter(
      (v) =>
        v.name.toLowerCase().includes(t) ||
        (v.category ?? '').toLowerCase().includes(t) ||
        (v.phone ?? '').includes(t),
    )
  }, [vendors, term])

  function close() {
    setOpen(false)
    setAdding(false)
    setTerm('')
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-12 flex-1 justify-start text-base font-normal"
          onClick={() => setOpen(true)}
        >
          {selected ? selected.name : 'None — tap to choose'}
        </Button>
        {selected && (
          <Button
            type="button"
            variant="ghost"
            className="h-12"
            onClick={() => onChange('')}
          >
            Clear
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border p-3">
      {adding ? (
        <>
          <p className="mb-3 text-sm font-medium">New vendor</p>
          <VendorForm
            idPrefix="inline_vendor"
            onSaved={(v) => {
              onVendorCreated(v)
              onChange(v.id)
              close()
            }}
            onCancel={() => setAdding(false)}
          />
        </>
      ) : (
        <>
          <Input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search vendors"
            aria-label="Search vendors"
            className="h-12 text-base"
            autoFocus
          />

          <ul className="mt-2 max-h-64 overflow-y-auto">
            <li>
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  close()
                }}
                className={cn(
                  'flex h-12 w-full items-center rounded-lg px-3 text-left text-sm transition-colors hover:bg-muted',
                  value === '' && 'bg-secondary',
                )}
              >
                None
              </button>
            </li>

            {filtered.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(v.id)
                    close()
                  }}
                  className={cn(
                    'flex min-h-12 w-full flex-col justify-center rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted',
                    value === v.id && 'bg-secondary',
                  )}
                >
                  <span className="text-sm font-medium">{v.name}</span>
                  {(v.category || v.phone) && (
                    <span className="text-xs text-muted-foreground">
                      {[v.category, v.phone].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </button>
              </li>
            ))}

            {filtered.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                No vendor matches “{term}”.
              </li>
            )}
          </ul>

          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border pt-2">
            <Button
              type="button"
              variant="ghost"
              className="h-12"
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-12"
              onClick={() => setAdding(true)}
            >
              ＋ Add new vendor
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
