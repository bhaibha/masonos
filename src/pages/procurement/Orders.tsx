import { PackageSearch } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { COMPANY, companyNeedsSetup } from '@/lib/company'
import { formatInr } from '@/lib/format'
import { generatePoFile, generatePoPdf } from '@/lib/poPdf'
import { createDocument } from '@/lib/queries/documents'
import { fetchProject } from '@/lib/queries/projects'
import {
  approvePurchaseOrder,
  fetchPoLines,
  fetchPurchaseOrders,
} from '@/lib/queries/procurement'
import { fetchVendor, fetchVendors } from '@/lib/queries/vendors'
import { uploadDocument } from '@/lib/storage'
import { supabase } from '@/lib/supabase'
import {
  canApprovePO,
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
import RaiseRequest from './RaiseRequest'

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
      'id, po_number, project_id, vendor_id, status, need_by, notes, raised_by, approved_by, created_at',
    )
    .eq('id', poId)
    .single()
  if (!poRow) return

  const po = {
    ...(poRow as Record<string, unknown>),
    vendor_name: null,
    line_count: 0,
    ordered_value: null,
  } as unknown as PurchaseOrder

  const [lines, vendor, project] = await Promise.all([
    fetchPoLines(poId, true),
    po.vendor_id ? fetchVendor(po.vendor_id) : Promise.resolve(null),
    fetchProject(po.project_id),
  ])

  const file = generatePoFile({
    po,
    lines,
    vendor,
    projectName: project?.name ?? '',
    siteAddress: project?.site_address ?? null,
    gstPct: COMPANY.defaultGstPct,
  })

  const { path, fileType } = await uploadDocument(po.project_id, file)
  await createDocument({
    project_id: po.project_id,
    folder: 'purchase_orders',
    title: `${po.po_number}${vendor?.name ? ` · ${vendor.name}` : ''}`,
    file_path: path,
    file_type: fileType,
    is_confidential: true,
    po_id: po.id,
  })
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
        <EmptyState
          icon={PackageSearch}
          title="No purchase orders yet"
          body="Raise a request for materials — it becomes a purchase order once rates are approved."
          actionLabel={canRaisePR(role) ? 'Raise a request' : undefined}
          onAction={canRaisePR(role) ? () => setRaising(true) : undefined}
        />
      )}

      {rows && rows.length > 0 && (
        <Stagger className="space-y-3">
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
  const canApprove = canApprovePO(role) && po.status === 'requested'

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
            {po.vendor_name ?? 'No vendor'} · {po.line_count}{' '}
            {po.line_count === 1 ? 'item' : 'items'}
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
              initialVendorId={po.vendor_id}
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

              {/* PO document — only once approved and only for money-roles
                  (needs rates + vendor GSTIN). */}
              {withRates && po.status !== 'requested' && po.status !== 'rejected' && (
                <PoDocument po={po} lines={lines} />
              )}
            </>
          )}
        </div>
      )}
    </article>
  )
}

function PoDocument({ po, lines }: { po: PurchaseOrder; lines: PoLine[] }) {
  const [gst, setGst] = useState(String(COMPANY.defaultGstPct))
  const [busy, setBusy] = useState(false)

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
        vendor,
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
    <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
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
      <Button
        variant="outline"
        className="h-11 flex-1"
        disabled={busy}
        onClick={() => void download()}
      >
        {busy ? 'Preparing…' : 'Download PO'}
      </Button>
    </div>
  )
}

function ApproveForm({
  poId,
  initialVendorId,
  lines,
  onDone,
}: {
  poId: string
  initialVendorId: string | null
  lines: PoLine[]
  onDone: () => Promise<void>
}) {
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [vendorId, setVendorId] = useState(initialVendorId ?? '')
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, l.rate?.toString() ?? ''])),
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchVendors().then(setVendors).catch(() => setVendors([]))
  }, [])

  async function approve() {
    if (!vendorId) {
      toast.error('Choose the vendor this order goes to')
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
      await approvePurchaseOrder(poId, vendorId, parsed)
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
        <Select
          id={`appr_vendor_${poId}`}
          value={vendorId}
          onChange={(e) => setVendorId(e.target.value)}
        >
          <option value="">Select a vendor…</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
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
