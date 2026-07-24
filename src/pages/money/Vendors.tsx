import { Store } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { VendorForm } from '@/components/VendorForm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import {
  fetchUnregisteredVendors,
  fetchVendors,
  registerFreeTextVendor,
  setVendorActive,
  type UnregisteredVendor,
} from '@/lib/queries/vendors'
import { canManageVendors, type Vendor } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

export default function Vendors() {
  const role = useAuth((s) => s.role)

  const [vendors, setVendors] = useState<Vendor[] | null>(null)
  const [unregistered, setUnregistered] = useState<UnregisteredVendor[]>([])
  const [showInactive, setShowInactive] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [term, setTerm] = useState('')

  const reload = useCallback(async () => {
    try {
      const [list, unreg] = await Promise.all([
        fetchVendors(showInactive),
        fetchUnregisteredVendors(),
      ])
      setVendors(list)
      setUnregistered(unreg)
    } catch (err) {
      toast.error('Could not load vendors', { description: errText(err) })
      setVendors([])
    }
  }, [showInactive])

  async function registerUnregistered(name: string) {
    setBusyId(name)
    try {
      await registerFreeTextVendor(name)
      toast.success(`${name} added to vendor list`)
      await reload()
    } catch (err) {
      toast.error('Could not add the vendor', { description: errText(err) })
    }
    setBusyId(null)
  }

  useEffect(() => {
    setVendors(null)
    void reload()
  }, [reload])

  const filtered = useMemo(() => {
    if (!vendors) return null
    const t = term.trim().toLowerCase()
    if (t === '') return vendors
    return vendors.filter(
      (v) =>
        v.name.toLowerCase().includes(t) ||
        (v.category ?? '').toLowerCase().includes(t) ||
        (v.phone ?? '').includes(t) ||
        (v.gstin ?? '').toLowerCase().includes(t),
    )
  }, [vendors, term])

  if (!canManageVendors(role)) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Vendors aren't available for your role.
      </p>
    )
  }

  async function toggleActive(v: Vendor) {
    const next = !v.is_active
    if (
      !next &&
      !window.confirm(
        `Deactivate ${v.name}? Past expenses keep the link — it just stops ` +
          `appearing in pickers.`,
      )
    ) {
      return
    }

    setBusyId(v.id)
    try {
      await setVendorActive(v.id, next)
      toast.success(next ? `${v.name} reactivated` : `${v.name} deactivated`)
      await reload()
    } catch (err) {
      toast.error('Could not update the vendor', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    setBusyId(null)
  }

  const hasVendors = filtered !== null && filtered.length > 0
  const searching = term.trim() !== ''

  return (
    <div className="space-y-4 pb-6">
      {!adding && !editingId && (
        <Button
          className="h-12 w-full text-base"
          onClick={() => setAdding(true)}
        >
          Add vendor
        </Button>
      )}

      {adding && (
        <div className="paper p-5">
          <p className="mb-4 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            New vendor
          </p>
          <VendorForm
            idPrefix="new_vendor"
            onSaved={(v) => {
              setAdding(false)
              toast.success(`${v.name} added`)
              void reload()
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {/* Search + inactive toggle only once there's something to search. */}
      {(hasVendors || searching || showInactive) && (
        <div className="space-y-3">
          <Input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search name, category, phone or GSTIN"
            aria-label="Search vendors"
            className="h-12 text-base"
          />
          <label className="flex items-center gap-3 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="size-5 accent-[var(--primary)]"
            />
            Show deactivated vendors
          </label>
        </div>
      )}

      {vendors === null && <ListSkeleton rows={4} />}

      {vendors !== null && filtered !== null && filtered.length === 0 && (
        searching ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No vendor matches “{term}”.
          </p>
        ) : (
          <EmptyState
            icon={Store}
            title="No vendors yet"
            body="Add the suppliers and contractors you buy from — they'll show up as options when you record an expense."
            actionLabel="Add your first vendor"
            onAction={() => setAdding(true)}
          />
        )
      )}

      {hasVendors && (
        <Stagger className="paper divide-y divide-border overflow-hidden">
          {filtered.map((v) => (
            <RevealItem key={v.id}>
              {editingId === v.id ? (
                <div className="p-5">
                  <p className="mb-4 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                    Edit vendor
                  </p>
                  <VendorForm
                    vendor={v}
                    idPrefix={`edit_${v.id}`}
                    onSaved={(saved) => {
                      setEditingId(null)
                      toast.success(`${saved.name} updated`)
                      void reload()
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p
                      className={cn(
                        'truncate font-medium',
                        !v.is_active && 'text-muted-foreground line-through',
                      )}
                    >
                      {v.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[v.category, v.phone].filter(Boolean).join(' · ') || '—'}
                    </p>
                    {v.gstin && (
                      <p className="truncate text-xs text-muted-foreground tabular-nums">
                        GSTIN {v.gstin}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingId(v.id)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === v.id}
                      onClick={() => void toggleActive(v)}
                    >
                      {v.is_active ? 'Deactivate' : 'Restore'}
                    </Button>
                  </div>
                </div>
              )}
            </RevealItem>
          ))}
        </Stagger>
      )}

      {hasVendors && (
        <p className="text-xs text-muted-foreground">
          Vendors are shared across all projects. Deactivating keeps history
          intact and only hides the vendor from pickers.
        </p>
      )}

      {unregistered.length > 0 && (
        <div className="space-y-3 pt-2">
          <div>
            <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Unregistered vendors
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Names typed into expenses, orders or deliveries that aren't in the
              list yet. Adding one registers it and links those past records.
            </p>
          </div>
          <ul className="paper divide-y divide-border overflow-hidden">
            {unregistered.map((u) => (
              <li
                key={u.vendor_name}
                className="flex items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm font-medium">
                    {u.vendor_name}
                    <span
                      className="inline-block size-1.5 shrink-0 rounded-full bg-[var(--warning)]"
                      aria-hidden="true"
                    />
                  </p>
                  <p className="text-xs text-muted-foreground">
                    used on {u.uses} {u.uses === 1 ? 'record' : 'records'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === u.vendor_name}
                  onClick={() => void registerUnregistered(u.vendor_name)}
                >
                  {busyId === u.vendor_name ? 'Adding…' : 'Add to vendor list'}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
