import { FileText } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { CancelDialog, CancelNote } from '@/components/VoidDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { amountInWords } from '@/lib/amountInWords'
import { COMPANY, companyNeedsSetup } from '@/lib/company'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import { generateInvoiceFile, generateInvoicePdf } from '@/lib/invoicePdf'
import { createDocument } from '@/lib/queries/documents'
import {
  fetchInvoices,
  fetchPayableVendors,
  issueInvoice,
} from '@/lib/queries/invoices'
import { fetchProject } from '@/lib/queries/projects'
import { uploadDocument } from '@/lib/storage'
import {
  canCancel,
  canIssueInvoice,
  INVOICE_TYPE_LABEL,
  type InvoiceRow,
  type InvoiceType,
} from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import type { MoneyContext } from './MoneyLayout'

/** First day of the current month, for the default billing period. */
function monthStart(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export default function Invoices() {
  const { projectId } = useOutletContext<MoneyContext>()
  const role = useAuth((s) => s.role)
  const mayIssue = canIssueInvoice(role)

  const [rows, setRows] = useState<InvoiceRow[] | null>(null)
  const [issuing, setIssuing] = useState(false)

  const reload = useCallback(async () => {
    try {
      setRows(await fetchInvoices(projectId))
    } catch (err) {
      toast.error('Could not load invoices', { description: errText(err) })
      setRows([])
    }
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (!mayIssue && rows !== null && rows.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Invoices aren't available for your role.
      </p>
    )
  }

  if (issuing) {
    return (
      <IssueForm
        projectId={projectId}
        onDone={() => {
          setIssuing(false)
          void reload()
        }}
        onCancel={() => setIssuing(false)}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      {mayIssue && (
        <Button className="h-12 w-full text-base" onClick={() => setIssuing(true)}>
          Raise invoice
        </Button>
      )}

      {rows === null && <ListSkeleton rows={3} />}

      {rows?.length === 0 && (
        <>
          <EmptyState
            icon={FileText}
            title="No invoices raised"
            body="Progress bills, management-fee invoices and vendor payment vouchers — each built from what's already recorded, with nothing retyped."
            actionLabel={mayIssue ? 'Raise the first one' : undefined}
            onAction={mayIssue ? () => setIssuing(true) : undefined}
          />
          <OtherProjectsHint />
        </>
      )}

      {rows && rows.length > 0 && (
        <Stagger className="space-y-3">
          {rows.map((inv) => (
            <RevealItem key={inv.id}>
              <InvoiceCard inv={inv} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ---------------- One invoice ---------------- */

function InvoiceCard({
  inv,
  onChanged,
}: {
  inv: InvoiceRow
  onChanged: () => Promise<void>
}) {
  const role = useAuth((s) => s.role)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const cancelled = inv.status === 'cancelled'

  async function output(file: boolean) {
    setBusy(true)
    try {
      const project = await fetchProject(inv.project_id)
      const opts = {
        invoice: inv,
        projectName: project?.name ?? '',
        siteAddress: project?.site_address ?? null,
        clientName: project?.client_name ?? null,
      }
      if (file) {
        const f = generateInvoiceFile(opts)
        const { path, fileType } = await uploadDocument(inv.project_id, f)
        await createDocument({
          project_id: inv.project_id,
          folder: 'invoices',
          title: `${inv.invoice_number} · ${INVOICE_TYPE_LABEL[inv.inv_type]}`,
          file_path: path,
          file_type: fileType,
          // Carries money — confidential, so supervisors never see it.
          is_confidential: true,
        })
        toast.success('Filed to Docs → Invoices')
      } else {
        generateInvoicePdf(opts)
        toast[companyNeedsSetup() ? 'warning' : 'success'](
          companyNeedsSetup()
            ? 'Invoice generated — fill company details in src/lib/company.ts'
            : 'Invoice PDF downloaded',
        )
      }
    } catch (err) {
      toast.error('Could not generate the invoice', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <article className="paper p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-heading text-[17px] font-semibold tabular-nums">
              {inv.invoice_number}
            </p>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {INVOICE_TYPE_LABEL[inv.inv_type]}
              {inv.vendor_name && ` · ${inv.vendor_name}`}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p
              className={cn(
                'figure text-[19px] font-semibold',
                cancelled && 'text-muted-foreground line-through',
              )}
            >
              {formatInr(inv.total)}
            </p>
            {cancelled && (
              <span className="mt-0.5 inline-block rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-destructive uppercase">
                Void
              </span>
            )}
          </div>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          {inv.invoice_date}
          {inv.period_from && inv.period_to &&
            ` · period ${inv.period_from} to ${inv.period_to}`}
          {` · ${inv.items.length} line${inv.items.length === 1 ? '' : 's'}`}
        </p>
      </button>

      {open && (
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          {inv.items.map((it) => (
            <div key={it.id} className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm">{it.description}</p>
              <p
                className={cn(
                  'shrink-0 text-sm tabular-nums',
                  it.amount < 0 && 'text-destructive',
                )}
              >
                {formatInr(it.amount)}
              </p>
            </div>
          ))}

          <div className="space-y-1 border-t border-border pt-2 text-sm tabular-nums">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatInr(inv.subtotal)}</span>
            </div>
            {(inv.gst_amount > 0 || inv.gst_pct > 0) && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {inv.inv_type === 'vendor_voucher'
                    ? 'GST as charged'
                    : `GST @ ${inv.gst_pct}% on the fee`}
                </span>
                <span>{formatInr(inv.gst_amount)}</span>
              </div>
            )}

            {/* The deduction sits BELOW tax, not inside the taxable subtotal —
                it's a gross figure and belongs against a gross value. */}
            {inv.less_previously_billed > 0 && (
              <>
                <div className="flex justify-between border-t border-border pt-1">
                  <span className="text-muted-foreground">
                    Cumulative gross value
                  </span>
                  <span>{formatInr(inv.subtotal + inv.gst_amount)}</span>
                </div>
                <div className="flex justify-between text-destructive">
                  <span>Less: previously billed</span>
                  <span>− {formatInr(inv.less_previously_billed)}</span>
                </div>
              </>
            )}

            <div className="flex justify-between border-t border-border pt-1 font-medium">
              <span>
                {inv.less_previously_billed > 0 ? 'Net payable this bill' : 'Total'}
              </span>
              <span className="figure text-base">{formatInr(inv.total)}</span>
            </div>
          </div>

          <p className="pt-1 text-xs text-muted-foreground italic">
            {amountInWords(inv.total)}
          </p>

          {inv.notes && (
            <p className="pt-1 text-xs text-muted-foreground">{inv.notes}</p>
          )}
        </div>
      )}

      {cancelled && (
        <CancelNote reason={inv.cancel_reason} at={inv.cancelled_at} />
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void output(false)}>
          Download
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void output(true)}>
          File to Docs
        </Button>
        {canCancel(role, 'invoices') && !cancelled && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setCancelling(true)}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Cancel
          </Button>
        )}
      </div>

      {cancelling && (
        <CancelDialog
          table="invoices"
          id={inv.id}
          summary={`${inv.invoice_number} · ${formatInr(inv.total)}`}
          consequence="The invoice keeps its number and stays on record, and its PDF prints with a VOID watermark. A cancelled progress bill also stops counting as 'previously billed' on the next one."
          onDone={async () => {
            setCancelling(false)
            await onChanged()
          }}
          onCancel={() => setCancelling(false)}
        />
      )}
    </article>
  )
}

/* ---------------- Raise ---------------- */

function IssueForm({
  projectId,
  onDone,
  onCancel,
}: {
  projectId: string
  onDone: () => void
  onCancel: () => void
}) {
  const [type, setType] = useState<InvoiceType>('progress')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(todayIst())
  const [vendorId, setVendorId] = useState('')
  const [gstPct, setGstPct] = useState(String(COMPANY.defaultGstPct))
  const [notes, setNotes] = useState('')
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchPayableVendors(projectId).then(setVendors).catch(() => setVendors([]))
  }, [projectId])

  async function submit(e: React.FormEvent) {
    e.preventDefault()

    if (to < from) {
      toast.error('The period ends before it starts')
      return
    }
    if (type === 'vendor_voucher' && !vendorId) {
      toast.error('Pick the vendor to pay')
      return
    }

    setBusy(true)
    try {
      await issueInvoice({
        project_id: projectId,
        inv_type: type,
        period_from: from,
        period_to: to,
        vendor_id: type === 'vendor_voucher' ? vendorId : null,
        gst_pct: Number(gstPct) || 0,
        notes,
      })
      toast.success('Invoice raised', {
        description: 'Figures were computed from what is already recorded.',
      })
      onDone()
    } catch (err) {
      // fn_issue_invoice raises readable messages — "no management fee
      // percentage set", "no posted invoices for that vendor" — surface them.
      toast.error('Could not raise the invoice', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="paper mb-6 space-y-5 p-5" noValidate>
      <p className="font-heading text-[18px] font-semibold">Raise invoice</p>

      <FieldRow
        label="Type"
        htmlFor="inv_type"
        hint="Every figure is calculated from expenses, the project's fee percentage, or posted vendor invoices — nothing is typed in."
      >
        <Select
          id="inv_type"
          value={type}
          onChange={(e) => setType(e.target.value as InvoiceType)}
        >
          {(Object.keys(INVOICE_TYPE_LABEL) as InvoiceType[]).map((t) => (
            <option key={t} value={t}>
              {INVOICE_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
      </FieldRow>

      <div className="grid grid-cols-2 gap-4">
        <FieldRow label="Period from" htmlFor="inv_from">
          <Input
            id="inv_from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Period to" htmlFor="inv_to">
          <Input
            id="inv_to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      {type === 'vendor_voucher' && (
        <FieldRow
          label="Vendor"
          htmlFor="inv_vendor"
          hint={
            vendors.length === 0
              ? 'No vendor on this project has a posted invoice yet.'
              : 'Only posted, un-voided invoices in the period are included.'
          }
        >
          <Select
            id="inv_vendor"
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            disabled={vendors.length === 0}
          >
            <option value="">Select…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </FieldRow>
      )}

      {type !== 'vendor_voucher' && (
        <FieldRow
          label="GST %"
          htmlFor="inv_gst"
          hint="Applied to the management fee only — reimbursed cost already bore its tax. Confirm the treatment with your accountant."
        >
          <Input
            id="inv_gst"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={gstPct}
            onChange={(e) => setGstPct(e.target.value)}
            className="h-12 text-base tabular-nums"
          />
        </FieldRow>
      )}

      <FieldRow label="Notes" htmlFor="inv_notes">
        <Textarea
          id="inv_notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Payment terms, reference, anything to print on the invoice"
        />
      </FieldRow>

      <div className="flex gap-3">
        <Button type="submit" disabled={busy} className="h-12 flex-1 text-base">
          {busy ? 'Raising…' : 'Raise invoice'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-12">
          Cancel
        </Button>
      </div>
    </form>
  )
}
