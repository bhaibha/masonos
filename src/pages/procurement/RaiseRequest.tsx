import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { EMPTY_VENDOR, VendorField, type VendorValue } from '@/components/VendorField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchMaterials } from '@/lib/queries/materials'
import { createPurchaseOrder } from '@/lib/queries/procurement'
import { canSeeMoney, type Material } from '@/lib/types'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

interface DraftLine {
  key: number
  material_id: string
  qty: string
}

let keySeq = 1

export default function RaiseRequest({ onDone }: { onDone: () => void }) {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const showVendor = canSeeMoney(role) // supervisors can't resolve vendors

  const [materials, setMaterials] = useState<Material[]>([])
  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
  const [needBy, setNeedBy] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([
    { key: keySeq++, material_id: '', qty: '' },
  ])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchMaterials().then(setMaterials).catch(() => setMaterials([]))
  }, [])

  function patch(key: number, change: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)))
  }

  async function submit() {
    if (!projectId) return
    const clean = lines
      .filter((l) => l.material_id && Number(l.qty) > 0)
      .map((l) => ({ material_id: l.material_id, qty_ordered: Number(l.qty) }))

    if (clean.length === 0) {
      toast.error('Add at least one material with a quantity')
      return
    }

    setBusy(true)
    try {
      await createPurchaseOrder({
        project_id: projectId,
        vendor_id: vendor.vendorId,
        vendor_name: vendor.vendorName,
        need_by: needBy || null,
        notes,
        lines: clean,
      })
      toast.success('Request raised')
      onDone()
    } catch (err) {
      toast.error('Could not raise the request', {
        description: err instanceof Error ? err.message : undefined,
      })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5 pb-6">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        New purchase request
      </p>

      <div className="space-y-3">
        {lines.map((l) => (
          <div key={l.key} className="paper space-y-3 p-4">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <Select
                  aria-label="Material"
                  value={l.material_id}
                  onChange={(e) => patch(l.key, { material_id: e.target.value })}
                >
                  <option value="">Select a material…</option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.unit})
                    </option>
                  ))}
                </Select>
              </div>
              {lines.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  aria-label="Remove line"
                  onClick={() =>
                    setLines((ls) => ls.filter((x) => x.key !== l.key))
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              value={l.qty}
              onChange={(e) => patch(l.key, { qty: e.target.value })}
              placeholder="Quantity"
              className="h-12 text-base tabular-nums"
            />
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        className="h-11 w-full"
        onClick={() =>
          setLines((ls) => [...ls, { key: keySeq++, material_id: '', qty: '' }])
        }
      >
        Add another material
      </Button>

      {showVendor && (
        <FieldRow
          label="Suggested vendor"
          htmlFor="pr_vendor"
          hint="Optional. Type to search or enter a new name."
        >
          <VendorField id="pr_vendor" value={vendor} onChange={setVendor} />
        </FieldRow>
      )}

      <FieldRow label="Need by" htmlFor="pr_needby">
        <Input
          id="pr_needby"
          type="date"
          value={needBy}
          onChange={(e) => setNeedBy(e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Notes" htmlFor="pr_notes">
        <Textarea
          id="pr_notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="For which work, any spec detail"
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="ghost"
          className="h-12"
          onClick={onDone}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="h-12"
          onClick={() => void submit()}
          disabled={busy}
        >
          {busy ? 'Raising…' : 'Raise request'}
        </Button>
      </div>
    </div>
  )
}
