import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { errText } from '@/lib/errText'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  createIssue,
  fetchStock,
  InsufficientStockError,
} from '@/lib/queries/materials'
import { canLogMaterials, type StockRow } from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const qtyFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

export default function IssueForm() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const navigate = useNavigate()

  // Issue from what's actually in stock, so the picker can't offer a material
  // this project has never received.
  const [stock, setStock] = useState<StockRow[]>([])

  const [materialId, setMaterialId] = useState('')
  const [issueDate, setIssueDate] = useState(todayIst())
  const [qty, setQty] = useState('')
  const [workArea, setWorkArea] = useState('')
  const [issuedTo, setIssuedTo] = useState('')
  const [remarks, setRemarks] = useState('')

  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!projectId) return
    fetchStock(projectId).then(setStock).catch(() => setStock([]))
  }, [projectId])

  const selected = stock.find((s) => s.material_id === materialId)

  if (!canLogMaterials(role)) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Your role can view stock but not issue materials.
      </p>
    )
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()

    if (!projectId) {
      toast.error('No project selected.')
      return
    }
    if (!materialId) {
      toast.error('Pick a material.')
      return
    }
    if (workArea.trim() === '') {
      toast.error('Work area is required.')
      return
    }

    const qtyNum = Number(qty)
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      toast.error('Quantity must be greater than zero.')
      return
    }

    setBusy(true)
    try {
      await createIssue({
        project_id: projectId,
        material_id: materialId,
        issue_date: issueDate,
        qty: qtyNum,
        work_area: workArea.trim(),
        issued_to: issuedTo.trim(),
        remarks,
      })
      navigate('/materials')
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        // The DB is the authority on stock, not the number we loaded earlier.
        toast.error('Insufficient stock', {
          description:
            `Available ${qtyFmt.format(err.available)}` +
            `${selected ? ` ${selected.unit}` : ''}, ` +
            `you asked for ${qtyFmt.format(err.requested)}.`,
        })
        // Refresh so the on-screen figure matches reality.
        if (projectId) fetchStock(projectId).then(setStock).catch(() => {})
      } else {
        toast.error('Could not issue the material.', { description: errText(err) })
      }
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="paper mb-6 space-y-5 p-5" noValidate>
      <FieldRow
        label="Material"
        htmlFor="material"
        hint={
          stock.length === 0
            ? 'Nothing in stock on this project yet — log a delivery first.'
            : undefined
        }
      >
        <Select
          id="material"
          required
          value={materialId}
          onChange={(e) => setMaterialId(e.target.value)}
        >
          <option value="">Select a material…</option>
          {stock.map((s) => (
            <option key={s.material_id} value={s.material_id}>
              {s.name} — {qtyFmt.format(s.in_stock)} {s.unit} in stock
            </option>
          ))}
        </Select>
      </FieldRow>

      {selected && (
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm tabular-nums">
          In stock: {qtyFmt.format(selected.in_stock)} {selected.unit}
          {selected.low_stock && (
            <span className="ml-2 text-destructive">· low</span>
          )}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Date" htmlFor="issue_date">
          <Input
            id="issue_date"
            type="date"
            required
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>

        <FieldRow
          label={selected ? `Qty (${selected.unit})` : 'Quantity'}
          htmlFor="qty"
        >
          <Input
            id="qty"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            required
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="0"
          />
        </FieldRow>
      </div>

      <FieldRow label="Work area" htmlFor="work_area">
        <Input
          id="work_area"
          required
          value={workArea}
          onChange={(e) => setWorkArea(e.target.value)}
          className="h-12 text-base"
          placeholder="GF slab, FF bathroom 2"
        />
      </FieldRow>

      <FieldRow label="Issued to" htmlFor="issued_to">
        <Input
          id="issued_to"
          value={issuedTo}
          onChange={(e) => setIssuedTo(e.target.value)}
          className="h-12 text-base"
          placeholder="Contractor or gang name"
        />
      </FieldRow>

      <FieldRow label="Remarks" htmlFor="remarks">
        <Textarea
          id="remarks"
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="Optional"
        />
      </FieldRow>

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        {busy ? 'Issuing…' : 'Issue material'}
      </Button>
    </form>
  )
}
