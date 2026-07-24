import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { EMPTY_VENDOR, VendorField, type VendorValue } from '@/components/VendorField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createInward, fetchMaterials } from '@/lib/queries/materials'
import { compressImage, uploadReceipt } from '@/lib/storage'
import {
  canLogMaterials,
  canSeeMaterialRates,
  type Material,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

export default function InwardForm() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const showRates = canSeeMaterialRates(role)
  const navigate = useNavigate()

  const [materials, setMaterials] = useState<Material[]>([])

  const [materialId, setMaterialId] = useState('')
  const [inwardDate, setInwardDate] = useState(todayIst())
  const [qty, setQty] = useState('')
  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
  const [challanNo, setChallanNo] = useState('')
  const [rate, setRate] = useState('')
  const [remarks, setRemarks] = useState('')

  const [photo, setPhoto] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [photoKb, setPhotoKb] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchMaterials().then(setMaterials).catch(() => setMaterials([]))
  }, [])

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  const unit = materials.find((m) => m.id === materialId)?.unit ?? ''

  async function onPickPhoto(file: File | null) {
    setError(null)
    setPhotoKb(null)
    if (preview) URL.revokeObjectURL(preview)

    if (!file) {
      setPhoto(null)
      setPreview(null)
      return
    }

    try {
      const compressed = await compressImage(file)
      setPhoto(compressed)
      setPreview(URL.createObjectURL(compressed))
      setPhotoKb(Math.round(compressed.size / 1024))
    } catch {
      setError('Could not process that image. Try another photo.')
      setPhoto(null)
      setPreview(null)
    }
  }

  if (!canLogMaterials(role)) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Your role can view stock but not log deliveries.
      </p>
    )
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!projectId) {
      setError('No project selected.')
      return
    }
    if (!materialId) {
      setError('Pick a material.')
      return
    }

    const qtyNum = Number(qty)
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      setError('Quantity must be greater than zero.')
      return
    }

    let rateNum: number | null = null
    if (showRates && rate.trim() !== '') {
      rateNum = Number(rate)
      if (!Number.isFinite(rateNum) || rateNum < 0) {
        setError('Rate must be zero or more.')
        return
      }
    }

    setBusy(true)
    try {
      let photoPath: string | null = null
      if (photo) {
        setStatus('Uploading challan…')
        photoPath = await uploadReceipt(projectId, photo)
      }

      setStatus('Saving delivery…')
      await createInward({
        project_id: projectId,
        material_id: materialId,
        inward_date: inwardDate,
        qty: qtyNum,
        vendor_id: vendor.vendorId,
        vendor_name: vendor.vendorName,
        challan_no: challanNo,
        rate: rateNum,
        challan_photo: photoPath,
        remarks,
      })

      navigate('/materials')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the delivery.')
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 pb-6" noValidate>
      <FieldRow label="Material" htmlFor="material">
        <Select
          id="material"
          required
          value={materialId}
          onChange={(e) => setMaterialId(e.target.value)}
        >
          <option value="">Select a material…</option>
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.unit})
            </option>
          ))}
        </Select>
      </FieldRow>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Date" htmlFor="inward_date">
          <Input
            id="inward_date"
            type="date"
            required
            value={inwardDate}
            onChange={(e) => setInwardDate(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>

        <FieldRow label={unit ? `Qty (${unit})` : 'Quantity'} htmlFor="qty">
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

      {showRates && (
        <>
          <FieldRow
            label="Vendor"
            htmlFor="vendor"
            hint="Optional. Type to search or enter a new name."
          >
            <VendorField id="vendor" value={vendor} onChange={setVendor} />
          </FieldRow>

          <FieldRow label="Rate per unit (₹)" htmlFor="rate">
            <Input
              id="rate"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className="h-12 text-base tabular-nums"
              placeholder="Optional"
            />
          </FieldRow>
        </>
      )}

      <FieldRow label="Challan no." htmlFor="challan">
        <Input
          id="challan"
          value={challanNo}
          onChange={(e) => setChallanNo(e.target.value)}
          className="h-12 text-base"
          placeholder="Optional"
        />
      </FieldRow>

      <FieldRow label="Remarks" htmlFor="remarks">
        <Textarea
          id="remarks"
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="Condition on arrival, short delivery, etc."
        />
      </FieldRow>

      <FieldRow
        label="Challan photo"
        htmlFor="challan_photo"
        hint={
          photoKb !== null
            ? `Compressed to ${photoKb} KB before upload.`
            : 'Camera opens directly. Compressed to under 300 KB.'
        }
      >
        <input
          ref={fileRef}
          id="challan_photo"
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => void onPickPhoto(e.target.files?.[0] ?? null)}
        />
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1 text-base"
            onClick={() => fileRef.current?.click()}
          >
            {photo ? 'Retake photo' : 'Take photo'}
          </Button>
          {photo && (
            <Button
              type="button"
              variant="ghost"
              className="h-12"
              onClick={() => void onPickPhoto(null)}
            >
              Remove
            </Button>
          )}
        </div>
        {preview && (
          <img
            src={preview}
            alt="Challan preview"
            className="mt-3 max-h-56 w-full rounded-lg object-contain ring-1 ring-foreground/10"
          />
        )}
      </FieldRow>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        {busy ? (status ?? 'Saving…') : 'Log delivery'}
      </Button>
    </form>
  )
}
