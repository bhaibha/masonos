import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { VendorPicker } from '@/components/VendorPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createExpense, fetchCategories } from '@/lib/queries/expenses'
import { fetchVendors } from '@/lib/queries/vendors'
import { compressReceipt, uploadReceipt } from '@/lib/storage'
import {
  EXPENSE_SOURCES,
  type ExpenseCategory,
  type ExpenseSource,
  type Vendor,
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
  const [vendors, setVendors] = useState<Vendor[]>([])

  const [expenseDate, setExpenseDate] = useState(today())
  const [categoryId, setCategoryId] = useState('')
  const [vendorId, setVendorId] = useState('')
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
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchCategories().then(setCategories).catch(() => setCategories([]))
    fetchVendors().then(setVendors).catch(() => setVendors([]))
  }, [])

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  async function onPickReceipt(file: File | null) {
    setError(null)
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
      setError('Could not process that image. Try another photo.')
      setReceipt(null)
      setPreview(null)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setStatus(null)

    if (!categoryId) {
      setError('Pick a category.')
      return
    }

    const amountNum = Number(amount)
    const gstNum = gstAmount === '' ? 0 : Number(gstAmount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setError('Amount must be greater than zero.')
      return
    }
    if (!Number.isFinite(gstNum) || gstNum < 0) {
      setError('GST cannot be negative.')
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
        vendor_id: vendorId || null,
        description,
        amount: amountNum,
        gst_amount: gstNum,
        source,
        invoice_no: invoiceNo,
        receipt_path: receiptPath,
      })

      navigate('/money')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the expense.')
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 pb-6" noValidate>
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

      <FieldRow
        label="Vendor"
        htmlFor="vendor"
        hint="Optional. Search, or add a new vendor without leaving this form."
      >
        <VendorPicker
          vendors={vendors}
          value={vendorId}
          onChange={setVendorId}
          onVendorCreated={(v) =>
            setVendors((list) =>
              [...list, v].sort((a, b) => a.name.localeCompare(b.name)),
            )
          }
        />
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

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        {busy ? (status ?? 'Saving…') : 'Save expense'}
      </Button>
    </form>
  )
}
