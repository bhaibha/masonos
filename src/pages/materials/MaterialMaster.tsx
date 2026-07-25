import { Boxes } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select } from '@/components/Field'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { fetchCategories } from '@/lib/queries/expenses'
import { createMaterial, fetchMaterials } from '@/lib/queries/materials'
import {
  canEditMaterialMaster,
  type ExpenseCategory,
  type Material,
  MATERIAL_UNITS,
} from '@/lib/types'
import { useAuth } from '@/store/auth'

const qtyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

export default function MaterialMaster() {
  const role = useAuth((s) => s.role)
  const canEdit = canEditMaterialMaster(role)

  const [materials, setMaterials] = useState<Material[] | null>(null)
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [adding, setAdding] = useState(false)

  const [name, setName] = useState('')
  const [unit, setUnit] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [lowStock, setLowStock] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setMaterials(await fetchMaterials())
    } catch (err) {
      toast.error('Could not load materials.', { description: errText(err) })
    }
  }, [])

  useEffect(() => {
    void reload()
    fetchCategories().then(setCategories).catch(() => setCategories([]))
  }, [reload])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()

    if (name.trim() === '') {
      toast.error('Give the material a name.')
      return
    }
    if (unit === '') {
      toast.error('Pick a unit.')
      return
    }

    let low = 0
    if (lowStock.trim() !== '') {
      low = Number(lowStock)
      if (!Number.isFinite(low) || low < 0) {
        toast.error('Low-stock level must be zero or more.')
        return
      }
    }

    setBusy(true)
    try {
      await createMaterial({
        name: name.trim(),
        unit,
        category_id: categoryId ? Number(categoryId) : null,
        low_stock_level: low,
      })
      setName('')
      setUnit('')
      setCategoryId('')
      setLowStock('')
      setAdding(false)
      toast.success('Material added.')
      await reload()
    } catch (err) {
      // Supabase errors aren't Error instances — dig out the real message/code.
      const msg = errText(err) ?? 'Could not add the material.'
      const code = (err as { code?: string })?.code
      // unique (name, unit) in 003_materials_docs.sql → 23505
      if (code === '23505' || msg.toLowerCase().includes('duplicate')) {
        toast.error('Already in the material list', {
          description: `“${name.trim()}” in ${unit} already exists.`,
        })
      } else {
        toast.error('Could not add the material', { description: msg })
      }
    }
    setBusy(false)
  }

  return (
    <div className="space-y-4 pb-6">

      {canEdit && !adding && (
        <Button
          variant="outline"
          className="h-12 w-full text-base"
          onClick={() => setAdding(true)}
        >
          Add material
        </Button>
      )}

      {canEdit && adding && (
        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-xl border border-border p-4"
          noValidate
        >
          <FieldRow label="Name" htmlFor="name">
            <Input
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-12 text-base"
              placeholder="OPC 53 Cement"
            />
          </FieldRow>

          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Unit" htmlFor="unit">
              <Select
                id="unit"
                required
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              >
                <option value="">Select…</option>
                {MATERIAL_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </FieldRow>

            <FieldRow label="Low-stock at" htmlFor="low_stock">
              <Input
                id="low_stock"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={lowStock}
                onChange={(e) => setLowStock(e.target.value)}
                className="h-12 text-base tabular-nums"
                placeholder="0"
              />
            </FieldRow>
          </div>

          <FieldRow label="Category" htmlFor="category">
            <Select
              id="category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">None</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FieldRow>

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="ghost"
              className="h-12"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
            <Button type="submit" className="h-12" disabled={busy}>
              {busy ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </form>
      )}

      {materials === null && <ListSkeleton rows={5} />}

      {materials?.length === 0 && (
        <EmptyState
          icon={Boxes}
          title="No materials yet"
          body="Build the list of materials you buy — cement, steel, tiles. Stock is then tracked per project."
          actionLabel={canEdit ? 'Add your first material' : undefined}
          onAction={canEdit ? () => setAdding(true) : undefined}
        />
      )}

      {materials && materials.length > 0 && (
        <ul className="paper divide-y divide-border overflow-hidden">
          {materials.map((m) => (
            <li
              key={m.id}
              className="flex items-baseline justify-between gap-3 px-4 py-3"
            >
              <p className="truncate text-sm font-medium">{m.name}</p>
              <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {m.unit}
                {m.low_stock_level > 0 &&
                  ` · low at ${qtyFmt.format(m.low_stock_level)}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        The material list is shared across all projects. Stock is tracked per
        project.
      </p>
    </div>
  )
}
