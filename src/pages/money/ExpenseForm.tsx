import { type FormEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { EMPTY_VENDOR, VendorField, type VendorValue } from '@/components/VendorField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { createExpense, fetchCategories } from '@/lib/queries/expenses'
import { fetchActivities } from '@/lib/queries/schedule'
import { compressReceipt, uploadReceipt } from '@/lib/storage'
import {
  EXPENSE_SOURCES,
  type ExpenseCategory,
  type ExpenseSource,
  type ScheduleActivity,
} from '@/lib/types'
import type { MoneyContext } from './MoneyLayout'

function today() {
  // Asia/Kolkata (CLAUDE.md rule 6) — not the browser's zone.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export default function ExpenseForm() {
  const { projectId } = useOutletContext<MoneyContext>()
  const navigate = useNavigate()

  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [activities, setActivities] = useState<ScheduleActivity[]>([])

  const [expenseDate, setExpenseDate] = useState(today())
  const [categoryId, setCategoryId] = useState('')
  const [activityId, setActivityId] = useState('')
  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [gstAmount, setGstAmount] = useState('')
  const [source, setSource] = useState<ExpenseSource>('bank')
  const [invoiceNo, setInvoiceNo] = useState('')

  const [receipt, setReceipt] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [compressedKb, setCompressedKb] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    fetchCategories().then(setCategories).catch(() => setCategories([]))
  }, [])

  // Optional. A project with no programme simply doesn't show the field —
  // better than an empty select nobody can explain.
  useEffect(() => {
    fetchActivities(projectId).then(setActivities).catch(() => setActivities([]))
  }, [projectId])

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  async function onPickReceipt(file: File | null) {
    setCompressedKb(null)
    if (preview) URL.revokeObjectURL(preview)

    if (!file) {
      setReceipt(null)
      setPreview(null)
      return
    }

    try {
      // Compress at pick time so the size is visible before submitting.
      const compressed = await compressReceipt(file)
      setReceipt(compressed)
      setPreview(URL.createObjectURL(compressed))
      setCompressedKb(Math.round(compressed.size / 1024))
    } catch {
      toast.error('Could not process that image. Try another photo.')
      setReceipt(null)
      setPreview(null)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setStatus(null)

    if (!categoryId) {
      toast.error('Pick a category.')
      return
    }

    const amountNum = Number(amount)
    const gstNum = gstAmount === '' ? 0 : Number(gstAmount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      toast.error('Amount must be greater than zero.')
      return
    }
    if (!Number.isFinite(gstNum) || gstNum < 0) {
      toast.error('GST cannot be negative.')
      return
    }

    setBusy(true)
    try {
      let receiptPath: string | null = null
      if (receipt) {
        setStatus('Uploading receipt…')
        receiptPath = await uploadReceipt(projectId, receipt)
      }

      setStatus('Saving expense…')
      await createExpense({
        project_id: projectId,
        expense_date: expenseDate,
        category_id: Number(categoryId),
        vendor_id: vendor.vendorId,
        vendor_name: vendor.vendorName,
        description,
        amount: amountNum,
        gst_amount: gstNum,
        source,
        invoice_no: invoiceNo,
        receipt_path: receiptPath,
        activity_id: activityId || null,
      })

      navigate('/money')
    } catch (err) {
      toast.error('Could not save the expense.', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={onSubmit} className="paper mb-6 space-y-5 p-5" noValidate>
      <FieldRow label="Date" htmlFor="expense_date">
        <Input
          id="expense_date"
          type="date"
          required
          value={expenseDate}
          onChange={(e) => setExpenseDate(e.target.value)}
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="Category" htmlFor="category">
        <Select
          id="category"
          required
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Select a category…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </FieldRow>

      {activities.length > 0 && (
        <FieldRow
          label="Schedule activity"
          htmlFor="activity"
          hint="Optional. Tagging it is what lets this spend count towards earned value — untagged, it still hits the ledger and the P&L."
        >
          <Select
            id="activity"
            value={activityId}
            onChange={(e) => setActivityId(e.target.value)}
          >
            <option value="">Not tied to an activity</option>
            {activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </FieldRow>
      )}

      <FieldRow
        label="Vendor"
        htmlFor="vendor"
        hint="Optional. Type to search, or enter a new name — save it to the list if you like."
      >
        <VendorField id="vendor" value={vendor} onChange={setVendor} />
      </FieldRow>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Amount (₹)" htmlFor="amount">
          <Input
            id="amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="0.00"
          />
        </FieldRow>

        <FieldRow label="GST (₹)" htmlFor="gst">
          <Input
            id="gst"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={gstAmount}
            onChange={(e) => setGstAmount(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="0.00"
          />
        </FieldRow>
      </div>

      <FieldRow label="Paid by" htmlFor="source">
        <Select
          id="source"
          value={source}
          onChange={(e) => setSource(e.target.value as ExpenseSource)}
        >
          {EXPENSE_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </FieldRow>

      <FieldRow label="Invoice no." htmlFor="invoice">
        <Input
          id="invoice"
          value={invoiceNo}
          onChange={(e) => setInvoiceNo(e.target.value)}
          className="h-12 text-base"
          placeholder="Optional"
        />
      </FieldRow>

      <FieldRow label="Description" htmlFor="description">
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What was bought, for which area"
        />
      </FieldRow>

      <FieldRow
        label="Receipt photo"
        htmlFor="receipt"
        hint={
          compressedKb !== null
            ? `Compressed to ${compressedKb} KB before upload.`
            : 'Camera opens directly. Compressed to under 300 KB.'
        }
      >
        <input
          ref={fileRef}
          id="receipt"
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => void onPickReceipt(e.target.files?.[0] ?? null)}
        />
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1 text-base"
            onClick={() => fileRef.current?.click()}
          >
            {receipt ? 'Retake photo' : 'Take photo'}
          </Button>
          {receipt && (
            <Button
              type="button"
              variant="ghost"
              className="h-12"
              onClick={() => void onPickReceipt(null)}
            >
              Remove
            </Button>
          )}
        </div>
        {preview && (
          <img
            src={preview}
            alt="Receipt preview"
            className="mt-3 max-h-56 w-full rounded-lg object-contain ring-1 ring-foreground/10"
          />
        )}
      </FieldRow>

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        {busy ? (status ?? 'Saving…') : 'Save expense'}
      </Button>
    </form>
  )
}
