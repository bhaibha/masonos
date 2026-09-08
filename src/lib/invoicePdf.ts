import { jsPDF } from 'jspdf'
import { amountInWords } from '@/lib/amountInWords'
import { COMPANY } from '@/lib/company'
import { drawLetterhead } from '@/lib/pdf/letterhead'
import {
  INVOICE_TYPE_LABEL,
  INVOICE_TYPE_PARTY,
  type InvoiceRow,
} from '@/lib/types'

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const rupee = (n: number) => `${n < 0 ? '-' : ''}Rs. ${inr.format(Math.abs(n))}`

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

export interface InvoicePdfOpts {
  invoice: InvoiceRow
  projectName: string
  siteAddress: string | null
  clientName: string | null
}

/**
 * Tax invoice on the company letterhead, matching the PO / VO / SI templates.
 *
 * Prints ONLY what fn_issue_invoice stored. The single arithmetic operation
 * here is the running Y position for layout — no total, tax or line amount is
 * derived in the browser. The "amount in words" line restates the stored total;
 * it doesn't recompute it.
 */
function buildInvoiceDoc(opts: InvoicePdfOpts): jsPDF {
  const { invoice: inv, projectName, siteAddress, clientName } = opts
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 48
  const ink: [number, number, number] = [26, 26, 24]
  const muted: [number, number, number] = [107, 101, 96]
  const danger: [number, number, number] = [155, 61, 61]
  let y = drawLetterhead(doc, { margin: M })

  // ---------- Title ----------
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(INVOICE_TYPE_LABEL[inv.inv_type].toUpperCase(), M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(inv.invoice_number, W - M, y, { align: 'right' })
  y += 14
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`Date: ${fmtDate(inv.invoice_date)}`, W - M, y, { align: 'right' })
  y += 12
  if (inv.period_from && inv.period_to) {
    doc.text(
      `Period: ${fmtDate(inv.period_from)} to ${fmtDate(inv.period_to)}`,
      W - M,
      y,
      { align: 'right' },
    )
  }
  y += 20

  // ---------- Billed to / project ----------
  const party = INVOICE_TYPE_PARTY[inv.inv_type]
  const partyName =
    inv.inv_type === 'vendor_voucher'
      ? (inv.vendor_name ?? '—')
      : (clientName ?? '—')

  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text(party.toUpperCase(), M, y)
  doc.text('PROJECT', W / 2, y)
  y += 13
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...ink)
  doc.text(partyName, M, y)
  doc.text(projectName, W / 2, y)
  y += 13
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  if (siteAddress) {
    for (const l of doc.splitTextToSize(siteAddress, W / 2 - M - 10)) {
      doc.text(l as string, W / 2, y)
      y += 11
    }
  }
  y += 14

  // ---------- Line items ----------
  const colAmt = W - M
  doc.setDrawColor(237, 233, 227)
  doc.setLineWidth(0.5)
  doc.line(M, y, W - M, y)
  y += 14
  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text('DESCRIPTION', M, y)
  doc.text('AMOUNT', colAmt, y, { align: 'right' })
  y += 8
  doc.line(M, y, W - M, y)
  y += 16

  doc.setFontSize(9.5)
  for (const item of inv.items) {
    doc.setTextColor(...ink)
    const lines = doc.splitTextToSize(item.description, W - 2 * M - 110)
    const negative = item.amount < 0
    doc.setTextColor(...(negative ? danger : ink))
    doc.text(rupee(item.amount), colAmt, y, { align: 'right' })
    doc.setTextColor(...ink)
    for (const [i, l] of lines.entries()) {
      doc.text(l as string, M, y + i * 12)
    }
    y += Math.max(lines.length * 12, 12) + 6
    if (y > H - 230) break
  }

  y += 6
  doc.setDrawColor(237, 233, 227)
  doc.line(M, y, W - M, y)
  y += 18

  // ---------- Totals (every figure stored, none derived here) ----------
  // Running-account order: cumulative taxable value, then tax on it, then the
  // gross deduction, then the net. Each line has to stand up on its own — the
  // GST figure must be justifiable against the taxable value printed above it.
  const rows: [string, string, boolean][] = [
    ['Subtotal', rupee(inv.subtotal), false],
  ]
  if (inv.gst_amount > 0 || inv.gst_pct > 0) {
    rows.push([
      inv.inv_type === 'vendor_voucher'
        ? 'GST as charged by the vendor'
        : `GST @ ${inv.gst_pct}% on the management fee`,
      rupee(inv.gst_amount),
      false,
    ])
  }
  if (inv.less_previously_billed > 0) {
    rows.push([
      'Cumulative gross value',
      rupee(inv.subtotal + inv.gst_amount),
      false,
    ])
    rows.push([
      'Less: previously billed',
      `- ${rupee(inv.less_previously_billed)}`,
      false,
    ])
  }
  rows.push([
    inv.less_previously_billed > 0 ? 'Net payable this bill' : 'Total payable',
    rupee(inv.total),
    true,
  ])

  for (const [label, val, bold] of rows) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(bold ? 12 : 10)
    doc.setTextColor(...(bold ? ink : muted))
    doc.text(label, W - M - 200, y, { align: 'right' })
    doc.setTextColor(...ink)
    doc.text(val, colAmt, y, { align: 'right' })
    y += bold ? 22 : 16
  }

  // ---------- Amount in words ----------
  y += 4
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text('Amount in words', M, y)
  y += 12
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9.5)
  doc.setTextColor(...ink)
  for (const l of doc.splitTextToSize(amountInWords(inv.total), W - 2 * M)) {
    doc.text(l as string, M, y)
    y += 12
  }

  if (inv.notes) {
    y += 8
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    for (const l of doc.splitTextToSize(inv.notes, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 11
      if (y > H - 130) break
    }
  }

  // ---------- VOID watermark ----------
  // Same treatment as the site instruction: light enough that the document
  // stays readable, because a cancelled invoice is still a record of what was
  // once billed. The reason prints at full opacity.
  if (inv.status === 'cancelled') {
    doc.saveGraphicsState()
    // @ts-expect-error — setGState/GState exist at runtime; jsPDF's types omit them.
    doc.setGState(new doc.GState({ opacity: 0.14 }))
    doc.setTextColor(...danger)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(120)
    doc.text('VOID', W / 2, H / 2, { align: 'center', angle: 32 })
    doc.restoreGraphicsState()

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...danger)
    doc.text(
      `CANCELLED${inv.cancelled_at ? ` on ${fmtDate(inv.cancelled_at)}` : ''}`,
      M,
      H - 150,
    )
    if (inv.cancel_reason) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      for (const [i, l] of doc
        .splitTextToSize(`Reason: ${inv.cancel_reason}`, W - 2 * M)
        .entries()) {
        doc.text(l as string, M, H - 136 + i * 12)
      }
    }
  }

  // ---------- Signature ----------
  const sy = H - 100
  doc.setDrawColor(...muted)
  doc.setLineWidth(0.5)
  doc.line(W - M - 170, sy, W - M, sy)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`For ${COMPANY.name}`, W - M, sy + 14, { align: 'right' })
  doc.text('Authorised signatory', W - M, sy + 28, { align: 'right' })
  doc.text(
    'This is a computer-generated document.',
    M,
    sy + 28,
  )

  return doc
}

export function generateInvoicePdf(opts: InvoicePdfOpts): void {
  buildInvoiceDoc(opts).save(`${opts.invoice.invoice_number}.pdf`)
}

export function generateInvoiceFile(opts: InvoicePdfOpts): File {
  const blob = buildInvoiceDoc(opts).output('blob')
  return new File([blob], `${opts.invoice.invoice_number}.pdf`, {
    type: 'application/pdf',
  })
}
