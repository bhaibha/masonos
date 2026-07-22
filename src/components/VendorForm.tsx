import { useState } from 'react'
import { toast } from 'sonner'
import { FieldRow } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createVendor, updateVendor } from '@/lib/queries/vendors'
import type { NewVendor, Vendor } from '@/lib/types'

/**
 * Deliberately renders a <div>, not a <form>, and every button is
 * type="button". This lets it be dropped inside the expense form's <form>
 * without nesting forms — which is invalid HTML and makes the outer Enter key
 * and submit behaviour unpredictable.
 */
export function VendorForm({
  vendor,
  idPrefix = 'vendor',
  onSaved,
  onCancel,
}: {
  /** omit to create */
  vendor?: Vendor
  idPrefix?: string
  onSaved: (v: Vendor) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(vendor?.name ?? '')
  const [phone, setPhone] = useState(vendor?.phone ?? '')
  const [gstin, setGstin] = useState(vendor?.gstin ?? '')
  const [category, setCategory] = useState(vendor?.category ?? '')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)

    if (name.trim() === '') {
      setError('Vendor name is required.')
      return
    }

    const payload: NewVendor = {
      name: name.trim(),
      phone: phone.trim(),
      gstin: gstin.trim().toUpperCase(),
      category: category.trim(),
    }

    setBusy(true)
    try {
      const saved = vendor
        ? await updateVendor(vendor.id, payload)
        : await createVendor(payload)
      // Success toast is raised by the parent (which knows add vs edit vs
      // inline-on-expense-form context). Here we only surface failures.
      onSaved(saved)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save the vendor.'
      setError(msg)
      toast.error('Could not save the vendor', { description: msg })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <FieldRow label="Name" htmlFor={`${idPrefix}_name`}>
        <Input
          id={`${idPrefix}_name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-12 text-base"
          placeholder="Sri Lakshmi Traders"
          autoComplete="off"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Phone" htmlFor={`${idPrefix}_phone`}>
          <Input
            id={`${idPrefix}_phone`}
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="h-12 text-base"
            placeholder="Optional"
            autoComplete="off"
          />
        </FieldRow>

        <FieldRow label="Category" htmlFor={`${idPrefix}_category`}>
          <Input
            id={`${idPrefix}_category`}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-12 text-base"
            placeholder="Cement, Steel…"
            autoComplete="off"
          />
        </FieldRow>
      </div>

      <FieldRow label="GSTIN" htmlFor={`${idPrefix}_gstin`}>
        <Input
          id={`${idPrefix}_gstin`}
          value={gstin}
          onChange={(e) => setGstin(e.target.value)}
          className="h-12 text-base uppercase"
          placeholder="Optional"
          autoCapitalize="characters"
          autoComplete="off"
        />
      </FieldRow>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="ghost"
          className="h-12"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="h-12"
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? 'Saving…' : vendor ? 'Save changes' : 'Add vendor'}
        </Button>
      </div>
    </div>
  )
}
