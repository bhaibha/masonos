import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { fetchVendors, registerFreeTextVendor } from '@/lib/queries/vendors'
import type { Vendor } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface VendorValue {
  /** null when the typed name isn't a registered vendor */
  vendorId: string | null
  vendorName: string
}

export const EMPTY_VENDOR: VendorValue = { vendorId: null, vendorName: '' }

/**
 * Flexible vendor entry: type to search registered vendors (typeahead). Pick
 * one → id + registered name. Type an unknown name → free text, id stays null,
 * with a one-tap "Save to vendor list" that registers it (and back-links past
 * records via fn_register_vendor).
 */
export function VendorField({
  value,
  onChange,
  id,
}: {
  value: VendorValue
  onChange: (v: VendorValue) => void
  id?: string
}) {
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const load = () => fetchVendors().then(setVendors).catch(() => setVendors([]))
  useEffect(() => {
    void load()
  }, [])

  // Close the dropdown on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const term = value.vendorName.trim().toLowerCase()
  const exact = useMemo(
    () => vendors.find((v) => v.name.toLowerCase() === term),
    [vendors, term],
  )
  const matches = useMemo(
    () =>
      term === ''
        ? vendors.slice(0, 6)
        : vendors
            .filter((v) => v.name.toLowerCase().includes(term))
            .slice(0, 6),
    [vendors, term],
  )

  const isUnregistered = value.vendorName.trim() !== '' && !value.vendorId

  function type(t: string) {
    // Auto-link if the typed text exactly matches a registered vendor.
    const ex = vendors.find((v) => v.name.toLowerCase() === t.trim().toLowerCase())
    onChange({ vendorId: ex?.id ?? null, vendorName: t })
    setOpen(true)
  }

  function pick(v: Vendor) {
    onChange({ vendorId: v.id, vendorName: v.name })
    setOpen(false)
  }

  async function saveToList() {
    setBusy(true)
    try {
      const vid = await registerFreeTextVendor(value.vendorName)
      onChange({ vendorId: vid, vendorName: value.vendorName.trim() })
      await load()
      toast.success(`${value.vendorName.trim()} saved to vendor list`)
    } catch (err) {
      toast.error('Could not save the vendor', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <div ref={boxRef} className="relative">
      <Input
        id={id}
        value={value.vendorName}
        onChange={(e) => type(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="Type or search a vendor"
        autoComplete="off"
        className="h-12 text-base"
      />

      {open && matches.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-popover shadow-[var(--shadow-card-lift)]">
          {matches.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => pick(v)}
                className={cn(
                  'flex min-h-11 w-full flex-col justify-center px-3 py-2 text-left transition-colors hover:bg-muted',
                  value.vendorId === v.id && 'bg-secondary',
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
        </ul>
      )}

      {isUnregistered && !exact && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">
            Not in your vendor list — kept as typed.
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => void saveToList()}
          >
            {busy ? 'Saving…' : 'Save to vendor list'}
          </Button>
        </div>
      )}
    </div>
  )
}
