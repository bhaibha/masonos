import { useCallback, useEffect, useState } from 'react'
import { VendorForm } from '@/components/VendorForm'
import { Button } from '@/components/ui/button'
import { fetchVendors, setVendorActive } from '@/lib/queries/vendors'
import { canManageVendors, type Vendor } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

export default function Vendors() {
  const role = useAuth((s) => s.role)

  const [vendors, setVendors] = useState<Vendor[] | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      setVendors(await fetchVendors(showInactive))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load vendors.')
    }
  }, [showInactive])

  useEffect(() => {
    setVendors(null)
    void reload()
  }, [reload])

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
      next === false &&
      !window.confirm(
        `Deactivate ${v.name}? Past expenses keep the link — it just stops ` +
          `appearing in pickers.`,
      )
    ) {
      return
    }

    setBusyId(v.id)
    setError(null)
    setNotice(null)
    try {
      await setVendorActive(v.id, next)
      setNotice(next ? 'Vendor reactivated.' : 'Vendor deactivated.')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the vendor.')
    }
    setBusyId(null)
  }

  return (
    <div className="space-y-4 pb-6">
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm">{notice}</p>
      )}

      {!adding && !editingId && (
        <Button
          variant="outline"
          className="h-12 w-full text-base"
          onClick={() => setAdding(true)}
        >
          Add vendor
        </Button>
      )}

      {adding && (
        <div className="rounded-xl border border-border p-4">
          <p className="mb-3 text-sm font-medium">New vendor</p>
          <VendorForm
            idPrefix="new_vendor"
            onSaved={() => {
              setAdding(false)
              setNotice('Vendor added.')
              void reload()
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
          className="size-5"
        />
        Show deactivated vendors
      </label>

      {vendors === null && !error && (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      )}

      {vendors?.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No vendors yet.
        </p>
      )}

      {vendors && vendors.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {vendors.map((v) =>
            editingId === v.id ? (
              <li key={v.id} className="p-4">
                <p className="mb-3 text-sm font-medium">Edit vendor</p>
                <VendorForm
                  vendor={v}
                  idPrefix={`edit_${v.id}`}
                  onSaved={() => {
                    setEditingId(null)
                    setNotice('Vendor updated.')
                    void reload()
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li key={v.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p
                      className={cn(
                        'truncate text-sm font-medium',
                        !v.is_active && 'text-muted-foreground line-through',
                      )}
                    >
                      {v.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[v.category, v.phone].filter(Boolean).join(' · ') || '—'}
                    </p>
                    {v.gstin && (
                      <p className="truncate text-xs text-muted-foreground">
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
              </li>
            ),
          )}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Vendors are shared across all projects. Deactivating keeps history
        intact and only hides the vendor from pickers.
      </p>
    </div>
  )
}
