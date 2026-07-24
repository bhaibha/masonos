import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { FieldRow, Select } from '@/components/Field'
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
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
      setError(err instanceof Error ? err.message : 'Could not load materials.')
    }
  }, [])

  useEffect(() => {
    void reload()
    fetchCategories().then(setCategories).catch(() => setCategories([]))
  }, [reload])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)

    if (name.trim() === '') {
      setError('Give the material a name.')
      return
    }
    if (unit === '') {
      setError('Pick a unit.')
      return
    }

    let low = 0
    if (lowStock.trim() !== '') {
      low = Number(lowStock)
      if (!Number.isFinite(low) || low < 0) {
        setError('Low-stock level must be zero or more.')
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
      setNotice('Material added.')
      await reload()
    } catch (err) {
      // Supabase errors aren't Error instances — dig out the real message/code.
      const msg = errText(err) ?? 'Could not add the material.'
      const code = (err as { code?: string })?.code
      // unique (name, unit) in 003_materials_docs.sql → 23505
      setError(
        code === '23505' || msg.toLowerCase().includes('duplicate')
          ? `“${name.trim()}” in ${unit} is already in the material list.`
          : msg,
      )
    }
    setBusy(false)
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

      {materials === null && !error && (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      )}

      {materials?.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No materials in the master list yet.
        </p>
      )}

      {materials && materials.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border">
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
