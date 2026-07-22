import { jsPDF } from 'jspdf'
import { COMPANY } from '@/lib/company'
import type { PoLine, PurchaseOrder, Vendor } from '@/lib/types'

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const rupee = (n: number) => `Rs. ${inr.format(n)}`

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

/**
 * A purchase order on the company letterhead.
 *
 * Line amounts are the Postgres-computed `line_total` (never recomputed here).
 * The document-level subtotal, GST and grand total are a print-time roll-up for
 * the PDF only — they aren't stored; the authoritative cost figure is written
 * when the vendor invoice is posted (fn_post_invoice).
 *
 * Uses jsPDF's built-in Helvetica and hand-drawn rules — no autotable/font
 * dependencies. Colours match the app: charcoal ink, brass accent.
 */
export interface PoPdfOpts {
  po: PurchaseOrder
  lines: PoLine[]
  vendor: Vendor | null
  projectName: string
  siteAddress: string | null
  gstPct: number
}

/**
 * 'full'     — priced PO with rates, amounts and totals (confidential).
 * 'delivery' — rate-free copy for site follow-up: materials + quantities only,
 *              no rates/amounts/totals. Safe for supervisors to see.
 */
export type PoPdfVariant = 'full' | 'delivery'

/** Draws the PO and returns the jsPDF instance (not saved). */
function buildPoDoc(opts: PoPdfOpts, variant: PoPdfVariant = 'full'): jsPDF {
  const { po, lines, vendor, projectName, siteAddress, gstPct } = opts
  const priced = variant === 'full'

  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const M = 48
  const ink: [number, number, number] = [26, 26, 24]
  const muted: [number, number, number] = [107, 101, 96]
  const brass: [number, number, number] = [166, 124, 82]
  let y = M

  // ---- Letterhead ----
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.text(COMPANY.name, M, y)
  y += 16
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(COMPANY.tagline, M, y)
  y += 14
  for (const line of COMPANY.addressLines) {
    doc.text(line, M, y)
    y += 12
  }
  doc.text(`GSTIN: ${COMPANY.gstin}`, M, y)
  y += 12
  doc.text(`${COMPANY.phone}  ·  ${COMPANY.email}`, M, y)
  y += 14

  doc.setDrawColor(...brass)
  doc.setLineWidth(1.2)
  doc.line(M, y, W - M, y)
  y += 26

  // ---- Title + meta ----
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(priced ? 'PURCHASE ORDER' : 'DELIVERY ORDER', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(po.po_number, W - M, y, { align: 'right' })
  y += 16
  if (!priced) {
    doc.setFontSize(8)
    doc.setTextColor(...muted)
    doc.text('For delivery follow-up · pricing on the office copy', M, y)
  }
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`Date: ${fmtDate(po.created_at)}`, W - M, y, { align: 'right' })
  y += 12
  doc.text(`Need by: ${fmtDate(po.need_by)}`, W - M, y, { align: 'right' })
  y += 20

  // ---- Vendor + deliver-to ----
  const colR = W / 2 + 10
  doc.setTextColor(...muted)
  doc.setFontSize(8)
  doc.text('VENDOR', M, y)
  doc.text('DELIVER TO', colR, y)
  y += 13
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.text(vendor?.name ?? '—', M, y)
  doc.text(projectName, colR, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  let vy = y + 13
  if (vendor?.gstin) {
    doc.text(`GSTIN: ${vendor.gstin}`, M, vy)
    vy += 12
  }
  if (vendor?.phone) {
    doc.text(vendor.phone, M, vy)
    vy += 12
  }
  let dy = y + 13
  if (siteAddress) {
    for (const l of doc.splitTextToSize(siteAddress, W / 2 - M)) {
      doc.text(l as string, colR, dy)
      dy += 12
    }
  }
  y = Math.max(vy, dy) + 12

  // ---- Line table ----
  // Delivery copy: quantity is the last (right-aligned) column, no rate/amount.
  const cols = priced
    ? { idx: M, name: M + 26, qty: W - M - 210, rate: W - M - 120, amt: W - M }
    : { idx: M, name: M + 26, qty: W - M, rate: 0, amt: 0 }
  doc.setFillColor(242, 238, 232)
  doc.rect(M, y - 11, W - 2 * M, 20, 'F')
  doc.setTextColor(...muted)
  doc.setFontSize(8)
  doc.text('#', cols.idx, y + 2)
  doc.text('MATERIAL', cols.name, y + 2)
  doc.text('QTY', cols.qty, y + 2, { align: 'right' })
  if (priced) {
    doc.text('RATE', cols.rate, y + 2, { align: 'right' })
    doc.text('AMOUNT', cols.amt, y + 2, { align: 'right' })
  }
  y += 22

  doc.setTextColor(...ink)
  doc.setFontSize(9.5)
  let subtotal = 0
  lines.forEach((l, i) => {
    const amt = l.line_total ?? 0
    subtotal += amt
    doc.text(String(i + 1), cols.idx, y)
    const name = doc.splitTextToSize(
      l.material_name ?? l.material_id,
      cols.qty - cols.name - 12,
    )
    doc.text(name[0] as string, cols.name, y)
    doc.text(`${l.qty_ordered} ${l.material_unit ?? ''}`.trim(), cols.qty, y, { align: 'right' })
    if (priced) {
      doc.text(l.rate !== null ? inr.format(l.rate) : '—', cols.rate, y, { align: 'right' })
      doc.text(inr.format(amt), cols.amt, y, { align: 'right' })
    }
    y += 17
    doc.setDrawColor(237, 233, 227)
    doc.setLineWidth(0.5)
    doc.line(M, y - 6, W - M, y - 6)
  })

  // ---- Totals (priced copy only) ----
  if (priced) {
    y += 8
    const gstAmt = Math.round(subtotal * gstPct) / 100
    const grand = subtotal + gstAmt
    const labelX = W - M - 130
    const totals: [string, string, boolean][] = [
      ['Subtotal', rupee(subtotal), false],
      [`GST (${gstPct}%)`, rupee(gstAmt), false],
      ['Total', rupee(grand), true],
    ]
    for (const [label, val, bold] of totals) {
      doc.setFont('helvetica', bold ? 'bold' : 'normal')
      doc.setTextColor(...(bold ? ink : muted))
      doc.setFontSize(bold ? 11 : 9.5)
      doc.text(label, labelX, y, { align: 'right' })
      doc.setTextColor(...ink)
      doc.text(val, cols.amt, y, { align: 'right' })
      y += bold ? 20 : 16
    }
  }

  // ---- Notes + signatory ----
  if (po.notes) {
    y += 10
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...muted)
    doc.text('Notes', M, y)
    y += 12
    doc.setTextColor(...ink)
    doc.setFontSize(9)
    for (const l of doc.splitTextToSize(po.notes, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 12
    }
  }

  const sy = doc.internal.pageSize.getHeight() - 90
  doc.setDrawColor(...muted)
  doc.setLineWidth(0.5)
  doc.line(W - M - 160, sy, W - M, sy)
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`For ${COMPANY.name}`, W - M, sy + 14, { align: 'right' })
  doc.text('Authorised signatory', W - M, sy + 28, { align: 'right' })

  return doc
}

/** Triggers a browser download of the PO PDF. */
export function generatePoPdf(opts: PoPdfOpts): void {
  buildPoDoc(opts).save(`${opts.po.po_number}.pdf`)
}

/** Returns the PO PDF as a File, for archiving to the Document Vault. */
export function generatePoFile(
  opts: PoPdfOpts,
  variant: PoPdfVariant = 'full',
): File {
  const blob = buildPoDoc(opts, variant).output('blob')
  const suffix = variant === 'delivery' ? '-delivery' : ''
  return new File([blob], `${opts.po.po_number}${suffix}.pdf`, {
    type: 'application/pdf',
  })
}
