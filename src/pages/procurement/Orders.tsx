import { PackageSearch, Send } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { FieldRow, Select } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { COMPANY, companyNeedsSetup } from '@/lib/company'
import { formatInr } from '@/lib/format'
import { generatePoFile, generatePoPdf } from '@/lib/poPdf'
import { shareDocument } from '@/lib/share'
import { createDocument } from '@/lib/queries/documents'
import { fetchProject } from '@/lib/queries/projects'
import {
  approvePurchaseOrder,
  fetchPoLines,
  fetchPurchaseOrders,
} from '@/lib/queries/procurement'
import { fetchVendor } from '@/lib/queries/vendors'
import { VendorField, type VendorValue } from '@/components/VendorField'
import { DeleteButton } from '@/components/DeleteAction'
import { CancelDialog, CancelNote } from '@/components/VoidDialog'
import { uploadDocument } from '@/lib/storage'
import { supabase } from '@/lib/supabase'
import {
  canApprovePO,
  canCancel,
  canRaisePR,
  canSeeMoney,
  PO_STATUS_LABEL,
  type PoLine,
  type PoStatus,
  type PurchaseOrder,
  type Vendor,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'
import InvoiceMatch from './InvoiceMatch'
import RaiseRequest from './RaiseRequest'
import ReceiveForm from './ReceiveForm'

/** A name-only vendor for PDFs when the PO used a free-text vendor. */
function synthVendor(name: string): Vendor {
  return { id: '', name, phone: null, gstin: null, category: null, is_active: true }
}

/**
 * Generates the approved PO on the letterhead and files it in the Document
 * Vault's Purchase Orders folder, linked to the PO so the folder shows its live
 * status. Marked confidential (it carries rates), so supervisors don't see it.
 * Re-fetches the PO with rates + vendor + project fresh, since the caller only
 * has the pre-approval row.
 */
async function archivePoDocument(poId: string): Promise<void> {
  const { data: poRow } = await supabase
    .from('purchase_orders')
    .select(
      'id, po_number, project_id, vendor_id, vendor_name, status, need_by, notes, raised_by, approved_by, created_at',
    )
    .eq('id', poId)
    .single()
  if (!poRow) return

  const raw = poRow as Record<string, unknown>
  const po = {
    ...raw,
    vendor_display: (raw.vendor_name as string | null) ?? null,
    vendor_registered: raw.vendor_id !== null,
    line_count: 0,
    ordered_value: null,
  } as unknown as PurchaseOrder

  // Don't refile copies that already exist (makes this safe to run manually
  // and on re-approval). Full = confidential, delivery = not.
  const { data: existing } = await supabase
    .from('documents')
    .select('is_confidential')
    .eq('po_id', poId)
    .eq('folder', 'purchase_orders')
  const hasFull = (existing ?? []).some((d) => d.is_confidential === true)
  const hasDelivery = (existing ?? []).some((d) => d.is_confidential === false)
  if (hasFull && hasDelivery) return

  const [lines, vendor, project] = await Promise.all([
    fetchPoLines(poId, true),
    po.vendor_id ? fetchVendor(po.vendor_id) : Promise.resolve(null),
    fetchProject(po.project_id),
  ])

  // Free-text vendor (no id): give the PDF a name-only vendor so the block
  // isn't blank.
  const pdfVendor =
    vendor ?? (po.vendor_display ? synthVendor(po.vendor_display) : null)

  const pdfOpts = {
    po,
    lines,
    vendor: pdfVendor,
    projectName: project?.name ?? '',
    siteAddress: project?.site_address ?? null,
    gstPct: COMPANY.defaultGstPct,
  }
  const vsuffix = pdfVendor?.name ? ` · ${pdfVendor.name}` : ''

  // Two copies filed to the Purchase Orders folder:
  //  1. Full priced PO — confidential (has rates), for founder/pm/accounts.
  //  2. Delivery copy — no rates, NOT confidential, so the supervisor can open
  //     it and chase the vendor for delivery.
  if (!hasFull) {
    const fullFile = generatePoFile(pdfOpts, 'full')
    const fullUp = await uploadDocument(po.project_id, fullFile)
    await createDocument({
      project_id: po.project_id,
      folder: 'purchase_orders',
      // 075: a PO carries rates, so it is never client-shareable.
      doc_kind: 'purchase_order',
      title: `${po.po_number}${vsuffix}`,
      file_path: fullUp.path,
      file_type: fullUp.fileType,
      is_confidential: true,
      po_id: po.id,
    })
  }

  if (!hasDelivery) {
    const delFile = generatePoFile(pdfOpts, 'delivery')
    const delUp = await uploadDocument(po.project_id, delFile)
    await createDocument({
      project_id: po.project_id,
      folder: 'purchase_orders',
      // 075: a PO carries rates, so it is never client-shareable.
      doc_kind: 'purchase_order',
      title: `${po.po_number} · Delivery copy${vsuffix}`,
      file_path: delUp.path,
      file_type: delUp.fileType,
      is_confidential: false,
      po_id: po.id,
    })
  }
}

const STATUS_TONE: Record<PoStatus, string> = {
  requested: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  approved: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  rejected: 'bg-destructive/10 text-destructive',
  receiving: 'bg-secondary text-secondary-foreground',
  received: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  closed: 'bg-secondary text-muted-foreground',
  cancelled: 'bg-secondary text-muted-foreground',
}

export default function Orders() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const withValues = canSeeMoney(role)

  const [rows, setRows] = useState<PurchaseOrder[] | null>(null)
  const [raising, setRaising] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setRows(await fetchPurchaseOrders(projectId, withValues))
    } catch (err) {
      toast.error('Could not load orders', {
        description: err instanceof Error ? err.message : undefined,
      })
      setRows([])
    }
  }, [projectId, withValues])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (raising) {
    return (
      <RaiseRequest
        onDone={() => {
          setRaising(false)
          void reload()
        }}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      {canRaisePR(role) && (
        <Button className="h-12 w-full text-base" onClick={() => setRaising(true)}>
          Raise request
        </Button>
      )}

      {rows === null && <ListSkeleton rows={3} />}

      {rows !== null && rows.length === 0 && (
        <>
          <EmptyState
            icon={PackageSearch}
            title="No purchase orders yet"
            body="Raise a request for materials — it becomes a purchase order once rates are approved."
            actionLabel={canRaisePR(role) ? 'Raise a request' : undefined}
            onAction={canRaisePR(role) ? () => setRaising(true) : undefined}
          />
          <OtherProjectsHint />
        </>
      )}

      {rows && rows.length > 0 && (
        <Stagger className="card-grid">
          {rows.map((po) => (
            <RevealItem key={po.id}>
              <OrderCard po={po} withRates={withValues} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function OrderCard({
  po,
  withRates,
  onChanged,
}: {
  po: PurchaseOrder
  withRates: boolean
  onChanged: () => Promise<void>
}) {
  const role = useAuth((s) => s.role)
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<PoLine[] | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const canApprove = canApprovePO(role) && po.status === 'requested'
  const cancelled = po.status === 'cancelled'
  // A still-requested PR has no number in anyone's hands yet — it's deletable.
  const isDraft = po.status === 'requested'
  // Closed orders are history. Everything else is still cancellable — the RPC
  // refuses if live receipts or invoices exist, and says which.
  const showCancel =
    canCancel(role, 'purchase_orders') &&
    !cancelled &&
    !isDraft &&
    po.status !== 'closed'

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && lines === null) {
      try {
        setLines(await fetchPoLines(po.id, withRates))
      } catch {
        setLines([])
      }
    }
  }

  return (
    <article className="paper p-5">
      <button
        type="button"
        onClick={() => void toggle()}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="font-heading text-[17px] font-semibold tabular-nums">
            {po.po_number}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {po.vendor_display ?? 'No vendor'}
            {po.vendor_display && !po.vendor_registered && (
              <span
                className="ml-1 inline-block size-1.5 rounded-full bg-[var(--warning)] align-middle"
                title="Unregistered vendor"
                aria-label="Unregistered vendor"
              />
            )}
            {' · '}
            {po.line_count} {po.line_count === 1 ? 'item' : 'items'}
            {po.need_by && ` · need by ${po.need_by}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11px] font-medium',
              STATUS_TONE[po.status],
            )}
          >
            {PO_STATUS_LABEL[po.status]}
          </span>
          {po.ordered_value !== null && po.ordered_value > 0 && (
            <span className="figure text-sm font-semibold">
              {formatInr(po.ordered_value)}
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="mt-4 border-t border-border pt-4">
          {lines === null ? (
            <p className="text-sm text-muted-foreground">Loading lines…</p>
          ) : canApprove ? (
            <ApproveForm
              poId={po.id}
              initialVendor={{
                vendorId: po.vendor_id,
                vendorName: po.vendor_display ?? '',
              }}
              lines={lines}
              onDone={onChanged}
            />
          ) : (
            <>
              <ul className="space-y-2">
                {lines.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0 truncate">{l.material_name}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {l.qty_ordered} {l.material_unit}
                      {l.rate !== null && ` · ${formatInr(l.rate)}`}
                      {l.line_total !== null && ` = ${formatInr(l.line_total)}`}
                    </span>
                  </li>
                ))}
              </ul>

              {/* Receiving — founder/pm/supervisor, once approved and not yet
                  fully received. Feeds stock via the GRN trigger. */}
              {canRaisePR(role) &&
                (po.status === 'approved' || po.status === 'receiving') && (
                  <div className="mt-4 border-t border-border pt-4">
                    <p className="mb-3 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                      Receive delivery
                    </p>
                    <ReceiveForm poId={po.id} lines={lines} onDone={onChanged} />
                  </div>
                )}

              {/* Invoice + 3-way match — money-roles only (rates). */}
              {withRates &&
                (po.status === 'receiving' || po.status === 'received') && (
                  <div className="mt-4 border-t border-border pt-4">
                    <InvoiceMatch po={po} />
                  </div>
                )}

              {/* PO document — only once approved and only for money-roles
                  (needs rates + vendor GSTIN). Not for a cancelled order. */}
              {withRates &&
                po.status !== 'requested' &&
                po.status !== 'rejected' &&
                !cancelled && <PoDocument po={po} lines={lines} />}

              {(showCancel || isDraft) && (
                <div className="mt-4 border-t border-border pt-4">
                  {/* A draft nobody has seen is deleted outright. Once approved
                      it has a number a vendor may hold, so it's cancelled and
                      keeps its place in the sequence. */}
                  {isDraft ? (
                    <DeleteButton
                      table="purchase_orders"
                      id={po.id}
                      name={`${po.po_number} · ${po.line_count} ${
                        po.line_count === 1 ? 'line' : 'lines'
                      }`}
                      role={role}
                      onDeleted={onChanged}
                      label="Delete request"
                      className="h-11 w-full"
                    />
                  ) : (
                    <Button
                      variant="ghost"
                      className="h-11 w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setCancelling(true)}
                    >
                      Cancel order
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Why it was cancelled — visible without expanding the card. */}
      {cancelled && (
        <CancelNote reason={po.cancel_reason} at={po.cancelled_at} />
      )}

      {cancelling && (
        <CancelDialog
          table="purchase_orders"
          id={po.id}
          summary={`${po.po_number}${
            po.vendor_display ? ` · ${po.vendor_display}` : ''
          } · ${po.line_count} ${po.line_count === 1 ? 'line' : 'lines'}`}
          consequence="The order keeps its number and stays on record, but drops out of active lists, committed value and the 3-way match. Blocked if any goods receipt or vendor invoice is still live — void those first."
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

function PoDocument({ po, lines }: { po: PurchaseOrder; lines: PoLine[] }) {
  const [gst, setGst] = useState(String(COMPANY.defaultGstPct))
  const [busy, setBusy] = useState(false)
  const [filing, setFiling] = useState(false)

  async function fileToDocs() {
    setFiling(true)
    try {
      await archivePoDocument(po.id)
      toast.success('Filed to Docs → Purchase Orders', {
        description: 'The supervisor can now open the delivery copy.',
      })
    } catch (err) {
      toast.error('Could not file to Docs', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    setFiling(false)
  }

  /**
   * Sends the full PO — rates included — to the vendor through the phone's
   * share sheet, or downloads it and opens WhatsApp with the message ready.
   *
   * Always the FULL copy, never the delivery copy: the vendor is the one party
   * who is supposed to see the rates. The delivery copy exists for site.
   */
  async function send() {
    setBusy(true)
    try {
      const [vendor, project] = await Promise.all([
        po.vendor_id ? fetchVendor(po.vendor_id) : Promise.resolve(null),
        fetchProject(po.project_id),
      ])

      const pdf = generatePoFile(
        {
          po,
          lines,
          vendor:
            vendor ?? (po.vendor_display ? synthVendor(po.vendor_display) : null),
          projectName: project?.name ?? '',
          siteAddress: project?.site_address ?? null,
          gstPct: Number(gst) || 0,
        },
        'full',
      )

      const message = [
        `${po.po_number} — purchase order`,
        project?.name ? `Project: ${project.name}` : null,
        po.need_by ? `Required by: ${po.need_by}` : null,
        '',
        'The order is attached. Please confirm acceptance and delivery date.',
        '',
        `— ${COMPANY.name}`,
      ]
        .filter(Boolean)
        .join('\n')

      const outcome = await shareDocument({
        file: pdf,
        message,
        phone: vendor?.phone ?? null,
        label: po.po_number,
      })

      if (outcome === 'shared') {
        toast.success('Shared', { description: 'Pick the app and send.' })
      } else if (outcome === 'downloaded-and-opened-whatsapp') {
        toast.success('PDF downloaded, WhatsApp opened', {
          description: vendor?.phone
            ? 'Attach the downloaded PO and send.'
            : 'No number on file for this vendor — pick the chat, attach and send.',
        })
      }
    } catch (err) {
      toast.error('Could not prepare the PO', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    setBusy(false)
  }

  async function download() {
    setBusy(true)
    try {
      const [vendor, project] = await Promise.all([
        po.vendor_id ? fetchVendor(po.vendor_id) : Promise.resolve(null),
        fetchProject(po.project_id),
      ])
      generatePoPdf({
        po,
        lines,
        vendor: vendor ?? (po.vendor_display ? synthVendor(po.vendor_display) : null),
        projectName: project?.name ?? '',
        siteAddress: project?.site_address ?? null,
        gstPct: Number(gst) || 0,
      })
      if (companyNeedsSetup()) {
        toast.warning('PO generated — fill in company details in src/lib/company.ts', {
          description: 'The letterhead still has placeholder GSTIN / address.',
        })
      } else {
        toast.success('Purchase order PDF downloaded')
      }
    } catch (err) {
      toast.error('Could not generate the PO', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
    setBusy(false)
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
      <label className="text-xs text-muted-foreground" htmlFor={`gst_${po.id}`}>
        GST
      </label>
      <Select
        id={`gst_${po.id}`}
        value={gst}
        onChange={(e) => setGst(e.target.value)}
        className="h-11 w-24"
      >
        {['0', '5', '12', '18', '28'].map((g) => (
          <option key={g} value={g}>
            {g}%
          </option>
        ))}
      </Select>
      <Button className="h-11" disabled={busy} onClick={() => void send()}>
        <Send className="size-4" aria-hidden="true" />
        Send to vendor
      </Button>
      <Button
        variant="outline"
        className="h-11 flex-1"
        disabled={busy}
        onClick={() => void download()}
      >
        {busy ? 'Preparing…' : 'Download PO'}
      </Button>
      <Button
        variant="outline"
        className="h-11 flex-1"
        disabled={filing}
        onClick={() => void fileToDocs()}
      >
        {filing ? 'Filing…' : 'File to Docs'}
      </Button>
    </div>
  )
}

function ApproveForm({
  poId,
  initialVendor,
  lines,
  onDone,
}: {
  poId: string
  initialVendor: VendorValue
  lines: PoLine[]
  onDone: () => Promise<void>
}) {
  const [vendor, setVendor] = useState<VendorValue>(initialVendor)
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, l.rate?.toString() ?? ''])),
  )
  const [busy, setBusy] = useState(false)

  async function approve() {
    if (vendor.vendorName.trim() === '') {
      toast.error('Enter the vendor this order goes to')
      return
    }
    const parsed: { lineId: string; rate: number }[] = []
    for (const l of lines) {
      const v = Number(rates[l.id])
      if (!Number.isFinite(v) || v < 0) {
        toast.error(`Enter a rate for ${l.material_name}`)
        return
      }
      parsed.push({ lineId: l.id, rate: v })
    }

    setBusy(true)
    try {
      await approvePurchaseOrder(poId, vendor, parsed)
      toast.success('Purchase order approved')
      // Archive the PO PDF into the vault's Purchase Orders folder. A failure
      // here must not undo the approval, so it's caught separately.
      await archivePoDocument(poId).catch(() => {
        toast.warning('Approved, but could not file the PO in Docs')
      })
      await onDone()
    } catch (err) {
      toast.error('Could not approve', {
        description: err instanceof Error ? err.message : undefined,
      })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Assign the vendor and set the agreed rate per unit to approve this into
        a purchase order.
      </p>

      <FieldRow label="Vendor" htmlFor={`appr_vendor_${poId}`}>
        <VendorField
          id={`appr_vendor_${poId}`}
          value={vendor}
          onChange={setVendor}
        />
      </FieldRow>

      {lines.map((l) => (
        <div key={l.id} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{l.material_name}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {l.qty_ordered} {l.material_unit}
            </p>
          </div>
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={rates[l.id] ?? ''}
            onChange={(e) => setRates((r) => ({ ...r, [l.id]: e.target.value }))}
            placeholder="Rate ₹"
            aria-label={`Rate for ${l.material_name}`}
            className="h-12 w-28 text-base tabular-nums"
          />
        </div>
      ))}
      <Button
        className="h-12 w-full"
        disabled={busy}
        onClick={() => void approve()}
      >
        {busy ? 'Approving…' : 'Approve purchase order'}
      </Button>
    </div>
  )
}
