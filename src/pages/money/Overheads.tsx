import { Building2, Copy, Plus, Receipt, Settings2 } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  EMPTY_VENDOR,
  VendorField,
  type VendorValue,
} from '@/components/VendorField'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import {
  createOverhead,
  createOverheadCategory,
  deleteOverheadCategory,
  duplicateOverheads,
  fetchOverheadCategories,
  fetchOverheads,
  renameOverheadCategory,
  setOverheadCategoryActive,
  voidOverhead,
} from '@/lib/queries/overheads'
import { compressReceipt, signedReceiptUrl, uploadCompanyProof } from '@/lib/storage'
import {
  canEditOverheadCategories,
  canSeeOverheads,
  type OverheadCategoryRow,
  type OverheadRow,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

/**
 * Company overheads — rent, salaries off site, software, the CA's fee.
 *
 * Deliberately NOT project expenses (migration 040): these have no site, and
 * mixing them into `expenses` would have made every project figure wrong.
 *
 * Scoped by MONTH rather than by the P&L's period presets, because overheads
 * are entered monthly and "which month am I looking at" is the only question
 * anyone asks of this list. The period presets live on the P&L, where the
 * comparison against project margin happens.
 */
export default function Overheads() {
  const role = useAuth((s) => s.role)
  const allowed = canSeeOverheads(role)
  const canEditCats = canEditOverheadCategories(role)

  const [month, setMonth] = useState(() => currentMonth())
  const [categoryId, setCategoryId] = useState('')
  const [cats, setCats] = useState<OverheadCategoryRow[]>([])
  const [rows, setRows] = useState<OverheadRow[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState(false)
  const [voidTarget, setVoidTarget] = useState<OverheadRow | null>(null)
  const [copying, setCopying] = useState(false)

  const loadCats = useCallback(async () => {
    try {
      setCats(await fetchOverheadCategories())
    } catch (err) {
      toast.error('Could not load headings', { description: errText(err) })
    }
  }, [])

  const reload = useCallback(async () => {
    const { from, to } = monthRange(month)
    try {
      setRows(await fetchOverheads(from, to, categoryId || undefined))
    } catch (err) {
      toast.error('Could not load overheads', { description: errText(err) })
      setRows([])
    }
  }, [month, categoryId])

  useEffect(() => {
    if (!allowed) return
    void loadCats()
  }, [allowed, loadCats])

  useEffect(() => {
    if (!allowed) return
    setRows(null)
    void reload()
  }, [allowed, reload])

  if (!allowed) {
    return (
      <EmptyState
        icon={Building2}
        title="Restricted for your role"
        body="Company overheads are visible to the founder and accounts only."
      />
    )
  }

  // Live rows only. A voided row is shown but counts for nothing — the same
  // rule the server applies, so the two can never disagree on screen.
  const live = (rows ?? []).filter((r) => !r.voided_at)
  const total = live.reduce((s, r) => s + r.total, 0)

  async function copyLastMonth() {
    const source = previousMonth(month)
    setCopying(true)
    try {
      const n = await duplicateOverheads(`${source}-01`, `${month}-01`)
      toast.success(`Copied ${n} ${n === 1 ? 'entry' : 'entries'}`, {
        description: `From ${monthLabel(source)}. Edit anything that changed.`,
      })
      await reload()
    } catch (err) {
      toast.error('Could not copy that month', { description: errText(err) })
    } finally {
      setCopying(false)
    }
  }

  return (
    <div className="space-y-4 pb-6">
      <section className="paper p-5">
        <div className="grid grid-cols-2 gap-3">
          <FieldRow label="Month" htmlFor="oh_month">
            <Input
              id="oh_month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value || currentMonth())}
              className="h-12 text-base"
            />
          </FieldRow>

          <FieldRow label="Heading" htmlFor="oh_filter">
            <Select
              id="oh_filter"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">All headings</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {!c.active && ' (retired)'}
                </option>
              ))}
            </Select>
          </FieldRow>
        </div>

        <div className="mt-4 flex items-end justify-between gap-4 border-t border-border pt-4">
          <div>
            <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
              {monthLabel(month)}
              {categoryId &&
                ` · ${cats.find((c) => c.id === categoryId)?.name ?? ''}`}
            </p>
            <p className="figure mt-1 text-[28px] leading-none font-semibold">
              {formatInr(total)}
            </p>
          </div>
          <p className="pb-1 text-xs text-muted-foreground tabular-nums">
            {live.length} {live.length === 1 ? 'entry' : 'entries'}
          </p>
        </div>
      </section>

      <div className="flex gap-3">
        <Button className="h-11 flex-1" onClick={() => setAdding((a) => !a)}>
          <Plus className="size-4" aria-hidden="true" />
          {adding ? 'Close' : 'Add overhead'}
        </Button>
        <Button
          variant="outline"
          className="h-11"
          disabled={copying}
          onClick={() => void copyLastMonth()}
        >
          <Copy className="size-4" aria-hidden="true" />
          {copying ? 'Copying…' : 'Copy last month'}
        </Button>
      </div>

      {canEditCats && (
        <button
          type="button"
          onClick={() => setManaging((m) => !m)}
          className="flex w-full items-center justify-center gap-2 py-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <Settings2 className="size-4" aria-hidden="true" />
          {managing ? 'Done with headings' : 'Manage headings'}
        </button>
      )}

      {canEditCats && managing && (
        <CategoryManager
          cats={cats}
          onChanged={async () => {
            await loadCats()
            await reload()
          }}
        />
      )}

      {adding && (
        <OverheadForm
          month={month}
          cats={cats}
          canAddCategory={canEditCats}
          onCategoryAdded={loadCats}
          onSaved={async () => {
            setAdding(false)
            await reload()
          }}
        />
      )}

      {rows === null ? (
        <ListSkeleton rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={`Nothing recorded for ${monthLabel(month)}`}
          body="Rent, salaries off site, software, the CA — the costs that sit outside any one project. Add the first, or copy last month."
          actionLabel="Add overhead"
          onAction={() => setAdding(true)}
        />
      ) : (
        <Stagger className="space-y-2.5">
          {rows.map((r) => (
            <RevealItem key={r.id}>
              <OverheadCard row={r} onVoid={() => setVoidTarget(r)} />
            </RevealItem>
          ))}
        </Stagger>
      )}

      <p className="pt-1 text-xs text-muted-foreground">
        Overheads are never deleted — a wrong entry is voided with a reason and
        stays on record. Copying a month refuses if the target already has
        entries, so the office rent cannot be booked twice.
        {canEditCats &&
          ' Headings with entries behind them are retired, not removed, so past months keep reporting the same way.'}
      </p>

      {voidTarget && (
        <VoidOverheadDialog
          row={voidTarget}
          onCancel={() => setVoidTarget(null)}
          onDone={async () => {
            setVoidTarget(null)
            await reload()
          }}
        />
      )}
    </div>
  )
}

/* ---------------- one row ---------------- */

function OverheadCard({
  row: r,
  onVoid,
}: {
  row: OverheadRow
  onVoid: () => void
}) {
  const voided = r.voided_at !== null

  async function openProof() {
    if (!r.proof_path) return
    const url = await signedReceiptUrl(r.proof_path)
    if (!url) {
      toast.error('Could not open that proof')
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <article className={cn('paper p-4', voided && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {r.category_name}
            {voided && (
              <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-destructive uppercase">
                Void
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {r.spend_date}
            {r.vendor_display && ` · ${r.vendor_display}`}
          </p>
          {r.description && (
            <p className="mt-1.5 text-sm break-words text-muted-foreground">
              {r.description}
            </p>
          )}
        </div>

        <div className="shrink-0 text-right">
          <p
            className={cn(
              'figure text-[18px] leading-none font-semibold',
              voided && 'line-through',
            )}
          >
            {formatInr(r.total)}
          </p>
          {r.gst_amount > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
              incl. {formatInr(r.gst_amount)} GST
            </p>
          )}
        </div>
      </div>

      {voided ? (
        <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
          Voided — {r.void_reason}
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          {r.proof_path && (
            <Button
              variant="outline"
              className="h-10 flex-1"
              onClick={() => void openProof()}
            >
              View proof
            </Button>
          )}
          <Button variant="ghost" className="h-10" onClick={onVoid}>
            Void
          </Button>
        </div>
      )}
    </article>
  )
}

/* ---------------- void ---------------- */

/**
 * Own dialog rather than the shared VoidDialog: that one dispatches through
 * `fn_void_record`, and 040 deliberately gave overheads their own function
 * (no project, no stock, nothing to cascade). Same contract — mandatory
 * reason, server-side.
 */
function VoidOverheadDialog({
  row,
  onDone,
  onCancel,
}: {
  row: OverheadRow
  onDone: () => void | Promise<void>
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (reason.trim().length < 3) {
      toast.error('Enter a reason', {
        description: 'It is stored in the audit log — make it useful.',
      })
      return
    }
    setSaving(true)
    try {
      await voidOverhead(row.id, reason.trim())
      toast.success('Overhead voided', {
        description: 'It stays on record and no longer counts.',
      })
      await onDone()
    } catch (err) {
      toast.error('Could not void that overhead', {
        description: errText(err),
      })
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/25 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onCancel()
      }}
    >
      <form
        onSubmit={submit}
        className="paper w-full max-w-md space-y-5 rounded-b-none p-6 sm:rounded-2xl"
      >
        <div>
          <h2 className="font-heading text-[20px] leading-tight font-semibold">
            Void this overhead?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatInr(row.total)} · {row.category_name} · {row.spend_date}
          </p>
        </div>

        <p className="rounded-lg bg-secondary/60 p-3 text-xs leading-relaxed text-muted-foreground">
          It stays on record marked VOID and drops out of the month's total and
          the company net position. Nothing else changes.
        </p>

        <div className="space-y-2">
          <label htmlFor="oh_void_reason" className="text-sm font-medium">
            Reason <span className="text-destructive">*</span>
          </label>
          <Textarea
            id="oh_void_reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Entered twice — same rent invoice"
            disabled={saving}
          />
        </div>

        <div className="flex gap-3">
          <Button
            type="submit"
            disabled={saving}
            className="h-12 flex-1 bg-destructive text-base text-white hover:bg-destructive/90"
          >
            {saving ? 'Working…' : 'Void overhead'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-12"
            disabled={saving}
            onClick={onCancel}
          >
            Go back
          </Button>
        </div>
      </form>
    </div>
  )
}

/* ---------------- headings ---------------- */

/**
 * Founder-only chart of headings: rename, retire, restore, and delete only
 * where nothing has ever used it.
 *
 * Renaming is safe because entries reference the heading by id — correcting a
 * spelling updates the history rather than forking it. Retiring is the answer
 * for anything with money behind it: the heading vanishes from new entries and
 * every past month reports exactly as it always did.
 */
function CategoryManager({
  cats,
  onChanged,
}: {
  cats: OverheadCategoryRow[]
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  async function run(id: string, work: () => Promise<void>, fail: string) {
    setBusy(id)
    try {
      await work()
      await onChanged()
    } catch (err) {
      toast.error(fail, { description: errText(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="paper space-y-1 p-5">
      <h3 className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        Overhead headings
      </h3>
      <p className="pb-2 text-xs text-muted-foreground">
        Only you can change these. Accounts picks from the list.
      </p>

      <ul className="divide-y divide-border">
        {cats.map((c) => (
          <li key={c.id} className="py-2.5">
            {editing === c.id ? (
              <div className="flex items-center gap-2">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="h-11 flex-1"
                  autoFocus
                />
                <Button
                  type="button"
                  className="h-11"
                  disabled={busy === c.id}
                  onClick={() =>
                    void run(
                      c.id,
                      async () => {
                        await renameOverheadCategory(c.id, draft)
                        setEditing(null)
                        toast.success('Heading renamed', {
                          description:
                            'Past entries follow the new name — they point at the heading, not at the text.',
                        })
                      },
                      'Could not rename that heading',
                    )
                  }
                >
                  Save
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span
                  className={cn(
                    'min-w-0 truncate text-sm',
                    !c.active && 'text-muted-foreground line-through',
                  )}
                >
                  {c.name}
                </span>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 px-2 text-xs"
                    onClick={() => {
                      setEditing(c.id)
                      setDraft(c.name)
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 px-2 text-xs"
                    disabled={busy === c.id}
                    onClick={() =>
                      void run(
                        c.id,
                        async () => {
                          await setOverheadCategoryActive(c.id, !c.active)
                          toast.success(
                            c.active
                              ? `"${c.name}" retired`
                              : `"${c.name}" back in use`,
                            {
                              description: c.active
                                ? 'Hidden from new entries. Past months are untouched.'
                                : undefined,
                            },
                          )
                        },
                        'Could not change that heading',
                      )
                    }
                  >
                    {c.active ? 'Retire' : 'Restore'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 px-2 text-xs text-destructive"
                    disabled={busy === c.id}
                    onClick={() =>
                      void run(
                        c.id,
                        async () => {
                          await deleteOverheadCategory(c.id)
                          toast.success(`"${c.name}" removed`)
                        },
                        'Could not remove that heading',
                      )
                    }
                  >
                    Delete
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="pt-3 text-xs text-muted-foreground">
        Delete only works on a heading nothing has ever used — the typo you made
        a minute ago. Anything with entries behind it must be retired, or a past
        month would silently change shape.
      </p>
    </section>
  )
}

/* ---------------- entry form ---------------- */

function OverheadForm({
  month,
  cats,
  canAddCategory,
  onCategoryAdded,
  onSaved,
}: {
  month: string
  cats: OverheadCategoryRow[]
  canAddCategory: boolean
  onCategoryAdded: () => Promise<void>
  onSaved: () => void | Promise<void>
}) {
  // Only live headings are pickable for new money — a retired one still
  // reports its history, but nothing new should land in it.
  const active = cats.filter((c) => c.active)

  const [spendDate, setSpendDate] = useState(() => defaultDay(month))
  const [categoryId, setCategoryId] = useState('')
  const [newCat, setNewCat] = useState('')
  const [addingCat, setAddingCat] = useState(false)
  const [savingCat, setSavingCat] = useState(false)
  const [vendor, setVendor] = useState<VendorValue>(EMPTY_VENDOR)
  const [amount, setAmount] = useState('')
  const [gstAmount, setGstAmount] = useState('')
  const [description, setDescription] = useState('')

  const [proof, setProof] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => setSpendDate(defaultDay(month)), [month])

  // Default to the first live heading once they arrive, without clobbering a
  // choice already made.
  useEffect(() => {
    setCategoryId((c) => (c === '' && active[0] ? active[0].id : c))
  }, [active])

  async function saveNewCategory() {
    const name = newCat.trim()
    if (name.length < 2) {
      toast.error('Give the heading a name.')
      return
    }
    setSavingCat(true)
    try {
      const id = await createOverheadCategory(name)
      await onCategoryAdded()
      setCategoryId(id)
      setNewCat('')
      setAddingCat(false)
      toast.success(`Added "${name}"`, {
        description: 'Available from now on, for you and for accounts.',
      })
    } catch (err) {
      // The unique index speaks plainly enough on a duplicate; say what it
      // means rather than showing the constraint name.
      const msg = errText(err) ?? ''
      toast.error('Could not add that heading', {
        description: /duplicate|unique/i.test(msg)
          ? 'A heading with that name already exists — pick it from the list.'
          : msg,
      })
    } finally {
      setSavingCat(false)
    }
  }

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  async function onPickProof(file: File | null) {
    if (preview) URL.revokeObjectURL(preview)
    if (!file) {
      setProof(null)
      setPreview(null)
      return
    }
    try {
      const compressed = await compressReceipt(file)
      setProof(compressed)
      setPreview(URL.createObjectURL(compressed))
    } catch {
      toast.error('Could not process that image. Try another photo.')
      setProof(null)
      setPreview(null)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()

    if (!categoryId) {
      toast.error('Pick a heading.')
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
      let proofPath: string | null = null
      if (proof) {
        setStatus('Uploading proof…')
        proofPath = await uploadCompanyProof(proof)
      }

      setStatus('Saving…')
      await createOverhead({
        spend_date: spendDate,
        category_id: categoryId,
        amount: amountNum,
        gst_amount: gstNum,
        vendor_id: vendor.vendorId,
        vendor_name: vendor.vendorName,
        description,
        proof_path: proofPath,
      })

      toast.success('Overhead recorded', {
        description: `${formatInr(amountNum + gstNum)} · ${
          cats.find((c) => c.id === categoryId)?.name ?? ''
        }`,
      })
      await onSaved()
    } catch (err) {
      toast.error('Could not save that overhead', { description: errText(err) })
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <form onSubmit={onSubmit} className="paper space-y-5 p-5" noValidate>
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Date" htmlFor="oh_date">
          <Input
            id="oh_date"
            type="date"
            required
            value={spendDate}
            onChange={(e) => setSpendDate(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>

        <FieldRow label="Heading" htmlFor="oh_category">
          <Select
            id="oh_category"
            required
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">Select…</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FieldRow>
      </div>

      {/* Founder-only. Accounts records money against the headings; only the
          founder decides what they are, or two people invent "Internet" and
          "Office utilities" for the same bill. */}
      {canAddCategory &&
        (addingCat ? (
          <div className="flex items-end gap-2">
            <FieldRow
              label="New heading"
              htmlFor="oh_new_cat"
              hint="Check the list first — a second name for the same cost splits the year's comparison."
            >
              <Input
                id="oh_new_cat"
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                placeholder="e.g. Vehicle & fuel"
                className="h-12 text-base"
              />
            </FieldRow>
            <Button
              type="button"
              className="h-12"
              disabled={savingCat}
              onClick={() => void saveNewCategory()}
            >
              {savingCat ? 'Adding…' : 'Add'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-12"
              disabled={savingCat}
              onClick={() => {
                setAddingCat(false)
                setNewCat('')
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAddingCat(true)}
            className="text-sm font-medium text-primary hover:underline"
          >
            + Add a new heading
          </button>
        ))}

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Amount (₹)" htmlFor="oh_amount">
          <Input
            id="oh_amount"
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

        <FieldRow label="GST (₹)" htmlFor="oh_gst">
          <Input
            id="oh_gst"
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

      <FieldRow
        label="Paid to"
        htmlFor="oh_vendor"
        hint="Optional. The landlord or your CA is rarely in the vendor list — free text is fine."
      >
        <VendorField id="oh_vendor" value={vendor} onChange={setVendor} />
      </FieldRow>

      <FieldRow label="Note" htmlFor="oh_desc">
        <Textarea
          id="oh_desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Office rent — March, Indiranagar"
        />
      </FieldRow>

      <FieldRow
        label="Proof"
        htmlFor="oh_proof"
        hint="Optional. Compressed to under 300 KB."
      >
        <input
          ref={fileRef}
          id="oh_proof"
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => void onPickProof(e.target.files?.[0] ?? null)}
        />
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1 text-base"
            onClick={() => fileRef.current?.click()}
          >
            {proof ? 'Replace photo' : 'Attach photo'}
          </Button>
          {proof && (
            <Button
              type="button"
              variant="ghost"
              className="h-12"
              onClick={() => void onPickProof(null)}
            >
              Remove
            </Button>
          )}
        </div>
        {preview && (
          <img
            src={preview}
            alt="Proof preview"
            className="mt-3 max-h-56 w-full rounded-lg object-contain ring-1 ring-foreground/10"
          />
        )}
      </FieldRow>

      <Button type="submit" disabled={busy} className="h-12 w-full text-base">
        {busy ? (status ?? 'Saving…') : 'Save overhead'}
      </Button>
    </form>
  )
}

/* ---------------- month helpers ---------------- */

/** `YYYY-MM` for today in Asia/Kolkata (CLAUDE.md rule 6). */
function currentMonth(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7)
}

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  return `${py}-${String(pm).padStart(2, '0')}`
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Today when the selected month IS this month, otherwise the 1st. Typing a
 * date is the slowest part of this form and the month is already chosen.
 */
function defaultDay(month: string): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  return today.startsWith(month) ? today : `${month}-01`
}
