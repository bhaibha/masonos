import { jsPDF } from 'jspdf'
import { COMPANY } from '@/lib/company'
import { drawLetterhead, drawPageFooters } from '@/lib/pdf/letterhead'
import type { GoodsReceiptRow, GrnLine, PurchaseOrder, Vendor } from '@/lib/types'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

const qty = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export interface GrnPdfOpts {
  grn: GoodsReceiptRow
  lines: GrnLine[]
  po: PurchaseOrder
  vendor: Vendor | null
  projectName: string
  siteAddress: string | null
  /** who signed the delivery in, for the receipt block */
  receivedByName?: string | null
}

/**
 * Goods Receipt Note, on the company letterhead — same family as the PO,
 * invoice, VO, SI, RFI, RA bill and NCR.
 *
 * CARRIES NO MONEY, AND THAT IS THE POINT
 * ---------------------------------------
 * The PO needs two variants — a priced office copy and a rate-free delivery
 * copy — because a supervisor may not see rates. A GRN needs only one, because
 * a goods receipt has nothing to hide: it records what physically arrived. No
 * rate, no amount, no total, so this is the one procurement document every
 * role can print and hand over without thinking about who is reading it.
 * `po_lines.rate` is revoked at the column level (012) anyway, so a priced
 * variant would fail for the very people who receive deliveries.
 *
 * NO RUNNING BALANCE
 * ------------------
 * Ordered and received-on-this-note are printed side by side, and the
 * difference for THIS delivery is flagged short or over. What is deliberately
 * absent is "received to date across all notes": `grn_lines` rows survive a
 * void (voiding reverses the material_inward rows it created, not the receipt
 * lines), so a browser-side sum would overstate. The correct cumulative figure
 * is `v_po_match.qty_received`, computed in Postgres, and it lives on the match
 * screen. A delivery note that quietly disagreed with the match screen would be
 * worse than one that doesn't try.
 *
 * A voided GRN still prints, with a VOID watermark — the stock it created has
 * been reversed, but the note is the record that a lorry once turned up, and
 * somebody will ask.
 */
function buildGrnDoc(opts: GrnPdfOpts): jsPDF {
  const { grn, lines, po, vendor, projectName, siteAddress, receivedByName } =
    opts
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 48
  const ink: [number, number, number] = [26, 26, 24]
  const muted: [number, number, number] = [107, 101, 96]
  const danger: [number, number, number] = [155, 61, 61]
  const warning: [number, number, number] = [184, 134, 59]
  const positive: [number, number, number] = [47, 111, 79]

  let y = drawLetterhead(doc, { margin: M })

  // ---------- Title ----------
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('GOODS RECEIPT NOTE', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(grn.grn_no, W - M, y, { align: 'right' })
  y += 14
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`Received: ${fmtDate(grn.received_date)}`, W - M, y, {
    align: 'right',
  })
  y += 12
  doc.text(`Against ${po.po_number}`, W - M, y, { align: 'right' })
  y += 20

  // ---------- Vendor / delivered to ----------
  const colR = W / 2 + 10
  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text('RECEIVED FROM', M, y)
  doc.text('DELIVERED TO', colR, y)
  y += 13
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...ink)
  // `vendor_display` already resolves registered-vendor-or-free-text (017), so
  // it is the right fallback when the full Vendor row wasn't loaded.
  doc.text(vendor?.name ?? po.vendor_display ?? '—', M, y)
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

  // ---------- Lines ----------
  const cols = {
    idx: M,
    name: M + 26,
    ordered: W - M - 210,
    received: W - M - 105,
    status: W - M,
  }
  doc.setFillColor(242, 238, 232)
  doc.rect(M, y - 11, W - 2 * M, 20, 'F')
  doc.setTextColor(...muted)
  doc.setFontSize(8)
  doc.text('#', cols.idx, y + 2)
  doc.text('MATERIAL', cols.name, y + 2)
  doc.text('ORDERED', cols.ordered, y + 2, { align: 'right' })
  doc.text('RECEIVED', cols.received, y + 2, { align: 'right' })
  doc.text('AGAINST ORDER', cols.status, y + 2, { align: 'right' })
  y += 22

  doc.setFontSize(9.5)
  doc.setFont('helvetica', 'normal')

  // The ordered quantity is RIGHT-aligned at cols.ordered, so it grows
  // leftwards into whatever space the material name thinks it has. Measuring
  // the widest one and reserving it is the only version that cannot collide —
  // a fixed guess is right until somebody orders 12,000.00 kg of something.
  // Found by rendering: "TMT bar Fe500D 16mm — IS 1786, supplied in 12 m"
  // printed straight through "1,800.00 kg".
  const widestQty = lines.reduce(
    (w, l) =>
      Math.max(
        w,
        doc.getTextWidth(
          `${qty.format(l.qty_ordered)}${l.material_unit ? ` ${l.material_unit}` : ''}`,
        ),
      ),
    0,
  )
  const nameW = Math.max(80, cols.ordered - cols.name - widestQty - 16)

  lines.forEach((l, i) => {
    if (y > H - 210) {
      doc.addPage()
      y = M
    }

    doc.setTextColor(...ink)
    doc.setFont('helvetica', 'normal')
    doc.text(String(i + 1), cols.idx, y)
    const name = doc.splitTextToSize(l.material_name, nameW) as string[]
    doc.text(name[0], cols.name, y)
    const u = l.material_unit ? ` ${l.material_unit}` : ''
    doc.text(`${qty.format(l.qty_ordered)}${u}`, cols.ordered, y, {
      align: 'right',
    })
    doc.setFont('helvetica', 'bold')
    doc.text(`${qty.format(l.qty_received)}${u}`, cols.received, y, {
      align: 'right',
    })
    doc.setFont('helvetica', 'normal')

    // Short and over are the two things the store-keeper and the vendor will
    // argue about, so they are named on the line rather than left to be worked
    // out by subtracting two columns.
    const diff = l.qty_received - l.qty_ordered
    const [label, tone]: [string, [number, number, number]] =
      Math.abs(diff) < 0.005
        ? ['Complete', positive]
        : diff < 0
          ? [`Short by ${qty.format(-diff)}${u}`, warning]
          : [`Over by ${qty.format(diff)}${u}`, warning]
    doc.setFontSize(8.5)
    doc.setTextColor(...tone)
    doc.text(label, cols.status, y, { align: 'right' })
    doc.setFontSize(9.5)

    y += 17
    if (name.length > 1) {
      doc.setTextColor(...muted)
      doc.setFontSize(8)
      doc.text(name[1], cols.name, y - 4)
      doc.setFontSize(9.5)
      y += 8
    }
    doc.setDrawColor(237, 233, 227)
    doc.setLineWidth(0.5)
    doc.line(M, y - 6, W - M, y - 6)
  })

  y += 10

  // ---------- Note + challan ----------
  if (grn.note) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...muted)
    doc.text('NOTE ON RECEIPT', M, y)
    y += 12
    doc.setFontSize(9)
    doc.setTextColor(...ink)
    for (const l of doc.splitTextToSize(grn.note, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 12
      if (y > H - 150) break
    }
    y += 6
  }

  // ---------- Void watermark ----------
  // A voided GRN is still printed. The stock it created has been reversed, but
  // the note is the record that a delivery once happened, and somebody will
  // eventually ask what arrived that day.
  if (grn.voided_at) {
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
    doc.text(`VOIDED on ${fmtDate(grn.voided_at)} — stock reversed`, M, H - 150)
    if (grn.void_reason) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      for (const [i, l] of doc
        .splitTextToSize(`Reason: ${grn.void_reason}`, W - 2 * M)
        .entries()) {
        doc.text(l as string, M, H - 136 + i * 12)
      }
    }
  }

  // ---------- Signatures ----------
  // Three, not two: the delivery driver signs that they handed it over, our
  // store signs that they took it, and the office countersigns. A GRN with one
  // signature settles nothing when a load is disputed.
  const sy = H - 100
  doc.setDrawColor(...muted)
  doc.setLineWidth(0.5)
  const sigW = 150
  const gap = (W - 2 * M - sigW * 3) / 2
  const xs = [M, M + sigW + gap, M + (sigW + gap) * 2]
  const labels = [
    ['Delivered by', "Vendor's representative"],
    ['Received by', receivedByName ?? 'Site store'],
    [`For ${COMPANY.name}`, 'Checked and accepted'],
  ]
  xs.forEach((x, i) => {
    doc.line(x, sy, x + sigW, sy)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text(labels[i][0], x, sy + 14)
    doc.setFontSize(8)
    doc.text(labels[i][1], x, sy + 26)
  })

  drawPageFooters(doc, { margin: M })
  return doc
}

/** Triggers a browser download of the GRN. */
export function generateGrnPdf(opts: GrnPdfOpts): void {
  buildGrnDoc(opts).save(`${opts.grn.grn_no}.pdf`)
}

/** Returns the GRN as a File, for archiving to the Document Vault. */
export function generateGrnFile(opts: GrnPdfOpts): File {
  const blob = buildGrnDoc(opts).output('blob')
  return new File([blob], `${opts.grn.grn_no}.pdf`, {
    type: 'application/pdf',
  })
}
