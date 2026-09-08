import { jsPDF } from 'jspdf'
import { COMPANY } from '@/lib/company'
import { drawLetterhead, drawPageFooters } from '@/lib/pdf/letterhead'
import type {
  ComparisonCell,
  ComparisonItem,
  ComparisonSummary,
  ComparisonVendor,
  ComparisonVendorTotal,
} from '@/lib/types'

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

export interface RcPdfOpts {
  summary: ComparisonSummary
  items: ComparisonItem[]
  vendors: ComparisonVendor[]
  cells: ComparisonCell[]
  totals: ComparisonVendorTotal[]
  projectName: string
  siteAddress: string | null
}

/**
 * The comparative statement on the company letterhead.
 *
 * LANDSCAPE, because the document is a grid whose width grows with the number
 * of vendors — a portrait page would either clip the fourth column or shrink
 * the type past reading size on a printout somebody signs.
 *
 * Every figure printed here — line totals, subtotals, GST, grand totals and
 * which cell is the cheapest — is read from what Postgres computed. Nothing on
 * this page is arithmetic done in the browser, so the PDF and the screen cannot
 * disagree, and neither can disagree with the database.
 *
 * This is the client-facing evidence of competitive sourcing, so it prints the
 * quotes that LOST as prominently as the one that won, and prints the reason
 * verbatim wherever the cheapest rate was not taken.
 */
function buildRcDoc(opts: RcPdfOpts): jsPDF {
  const { summary, items, vendors, cells, totals, projectName, siteAddress } =
    opts

  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 40
  const ink: [number, number, number] = [26, 26, 24]
  const muted: [number, number, number] = [107, 101, 96]
  const brass: [number, number, number] = [166, 124, 82]
  const positive: [number, number, number] = [47, 111, 79]
  let y = M

  const cellAt = new Map<string, ComparisonCell>()
  for (const c of cells) cellAt.set(`${c.item_id}|${c.vendor_col_id}`, c)
  const totalFor = new Map(totals.map((t) => [t.vendor_col_id, t]))

  y = drawLetterhead(doc, { margin: M, scale: 'compact' })

  // ---- Title + meta ----
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text('COMPARATIVE STATEMENT', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(summary.comparison_no, W - M, y, { align: 'right' })
  y += 15
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(summary.title, M, y)
  doc.text(`Date: ${fmtDate(summary.created_at)}`, W - M, y, { align: 'right' })
  y += 12
  doc.text(`Project: ${projectName}`, M, y)
  if (summary.need_by) {
    doc.text(`Required by: ${fmtDate(summary.need_by)}`, W - M, y, {
      align: 'right',
    })
  }
  y += 12
  if (siteAddress) {
    doc.text(siteAddress, M, y)
    y += 12
  }
  y += 10

  // ---- Column geometry ----
  // The item block is fixed; the vendors share whatever is left, so three
  // vendors get wide columns and six get narrow ones rather than the last one
  // falling off the page.
  const descW = 168
  const qtyW = 62
  const gridL = M + descW + qtyW
  const gridR = W - M
  const colW = Math.max(70, (gridR - gridL) / Math.max(vendors.length, 1))

  function vendorX(i: number): number {
    return gridL + colW * i
  }

  // ---- Header band ----
  doc.setFillColor(242, 238, 232)
  doc.rect(M, y - 12, W - 2 * M, 30, 'F')
  doc.setTextColor(...muted)
  doc.setFontSize(7.5)
  doc.text('ITEM', M + 2, y)
  doc.text('QTY', gridL - 6, y, { align: 'right' })

  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  vendors.forEach((v, i) => {
    const name = doc.splitTextToSize(v.vendor_display, colW - 10)
    doc.text(name[0] as string, vendorX(i) + colW - 6, y, { align: 'right' })
  })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(...muted)
  vendors.forEach((v, i) => {
    const t = totalFor.get(v.id)
    const bits = [
      v.delivery_days !== null ? `${v.delivery_days}d` : null,
      `GST ${v.gst_pct}%`,
      t && t.items_missing > 0 ? `${t.items_missing} not quoted` : null,
    ].filter(Boolean)
    doc.text(bits.join(' · '), vendorX(i) + colW - 6, y + 11, { align: 'right' })
  })
  doc.text('RATE / AMOUNT', gridL - 6, y + 11, { align: 'right' })
  y += 28

  // ---- Rows ----
  doc.setFontSize(8.5)
  for (const it of items) {
    if (y > H - 130) {
      doc.addPage()
      y = M + 10
    }

    doc.setTextColor(...ink)
    doc.setFont('helvetica', 'normal')
    const nameLines = doc.splitTextToSize(it.description, descW - 6) as string[]
    doc.text(nameLines[0], M + 2, y)
    doc.setTextColor(...muted)
    doc.text(`${it.qty} ${it.unit}`, gridL - 6, y, { align: 'right' })

    vendors.forEach((v, i) => {
      const c = cellAt.get(`${it.id}|${v.id}`)
      const x = vendorX(i) + colW - 6
      if (!c || c.rate === null) {
        doc.setTextColor(...muted)
        doc.setFont('helvetica', 'normal')
        doc.text('—', x, y, { align: 'right' })
        return
      }

      // The cheapest quote on the line is set in bold; the awarded one carries
      // a tick. They are usually the same cell — when they are not, that is
      // precisely what the reader is looking for.
      doc.setFont('helvetica', c.is_lowest ? 'bold' : 'normal')
      doc.setTextColor(...(c.is_awarded ? positive : ink))
      const tick = c.is_awarded ? '✓ ' : ''
      doc.text(`${tick}${inr.format(c.rate)}`, x, y, { align: 'right' })
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(...muted)
      doc.text(inr.format(c.line_total ?? 0), x, y + 10, { align: 'right' })
      doc.setFontSize(8.5)
    })

    y += 15
    // Second line of a long description, under the first.
    if (nameLines.length > 1) {
      doc.setTextColor(...muted)
      doc.setFontSize(7.5)
      doc.text(nameLines[1], M + 2, y - 3)
      doc.setFontSize(8.5)
      y += 8
    }
    y += 6

    doc.setDrawColor(237, 233, 227)
    doc.setLineWidth(0.5)
    doc.line(M, y - 8, W - M, y - 8)
  }

  // ---- Totals block ----
  if (y > H - 120) {
    doc.addPage()
    y = M + 10
  }
  y += 6
  doc.setDrawColor(...muted)
  doc.setLineWidth(0.6)
  doc.line(M, y - 10, W - M, y - 10)

  const totalRows: [string, (t: ComparisonVendorTotal) => string, boolean][] = [
    ['Subtotal', (t) => inr.format(t.subtotal), false],
    ['GST', (t) => inr.format(t.gst_amount), false],
    ['Grand total', (t) => inr.format(t.grand_total), true],
  ]

  for (const [label, get, bold] of totalRows) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(bold ? 9.5 : 8.5)
    doc.setTextColor(...(bold ? ink : muted))
    doc.text(label, gridL - 6, y, { align: 'right' })
    vendors.forEach((v, i) => {
      const t = totalFor.get(v.id)
      if (!t) return
      // Only a vendor who priced every item can be marked the lowest — a total
      // built from eight of ten lines is cheaper for the wrong reason.
      doc.setTextColor(...(bold && t.is_lowest_total ? positive : ink))
      doc.text(get(t), vendorX(i) + colW - 6, y, { align: 'right' })
    })
    y += bold ? 18 : 14
  }

  const lowest = totals.find((t) => t.is_lowest_total)
  if (lowest) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...positive)
    doc.text(
      `Lowest complete quote: ${lowest.vendor_display} — Rs. ${inr.format(lowest.grand_total)}`,
      M,
      y,
    )
    y += 16
  }

  // ---- Award + justification ----
  const awarded = items.filter((i) => i.awarded_quote_id !== null)
  if (awarded.length > 0) {
    if (y > H - 110) {
      doc.addPage()
      y = M + 10
    }
    doc.setDrawColor(...brass)
    doc.setLineWidth(0.8)
    doc.line(M, y, W - M, y)
    y += 16

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...ink)
    doc.text('AWARD', M, y)
    y += 14

    // Grouped by winning vendor, because a split award is normal here and a
    // per-line list of ten identical vendor names reads as noise.
    const byVendor = new Map<string, string[]>()
    for (const it of awarded) {
      const cell = cells.find(
        (c) => c.item_id === it.id && c.quote_id === it.awarded_quote_id,
      )
      if (!cell) continue
      const v = vendors.find((x) => x.id === cell.vendor_col_id)
      const key = v?.vendor_display ?? '—'
      byVendor.set(key, [...(byVendor.get(key) ?? []), it.description])
    }

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    for (const [vendorName, lines] of byVendor) {
      doc.setTextColor(...ink)
      doc.setFont('helvetica', 'bold')
      doc.text(vendorName, M, y)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(...muted)
      const listed = doc.splitTextToSize(
        `${lines.length} item${lines.length === 1 ? '' : 's'}: ${lines.join(', ')}`,
        W - 2 * M - 130,
      ) as string[]
      doc.text(listed[0], M + 130, y)
      y += 13
      if (listed.length > 1) {
        doc.text(listed[1], M + 130, y)
        y += 13
      }
    }

    // The reasons. This is the paragraph the Open Book client actually reads,
    // so it is printed verbatim rather than summarised.
    const reasons = awarded.filter((i) => i.award_reason)
    if (reasons.length > 0) {
      y += 6
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8)
      doc.setTextColor(...ink)
      doc.text('Where the lowest rate was not taken', M, y)
      y += 12
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      doc.setTextColor(...muted)
      for (const it of reasons) {
        if (y > H - 80) {
          doc.addPage()
          y = M + 10
        }
        const txt = doc.splitTextToSize(
          `${it.description} — ${it.award_reason}`,
          W - 2 * M,
        ) as string[]
        for (const l of txt.slice(0, 2)) {
          doc.text(l, M, y)
          y += 11
        }
      }
    } else {
      y += 4
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      doc.setTextColor(...positive)
      doc.text('Every line was awarded at the lowest quoted rate.', M, y)
      y += 12
    }
  }

  // ---- Signatory ----
  const sy = doc.internal.pageSize.getHeight() - 60
  doc.setDrawColor(...muted)
  doc.setLineWidth(0.5)
  doc.line(W - M - 170, sy, W - M, sy)
  doc.setFontSize(8.5)
  doc.setTextColor(...muted)
  doc.text(`For ${COMPANY.name}`, W - M, sy + 13, { align: 'right' })
  doc.text('Authorised signatory', W - M, sy + 25, { align: 'right' })

  // A comparative statement routinely runs to several pages — one page per
  // vendor block once there are more than three or four — so the reader needs
  // to know whether they are holding all of it.
  drawPageFooters(doc, { margin: M })

  return doc
}

export function generateRcPdf(opts: RcPdfOpts): void {
  buildRcDoc(opts).save(`${opts.summary.comparison_no}.pdf`)
}

/** Returns the statement as a File, for filing to the Document Vault. */
export function generateRcFile(opts: RcPdfOpts): File {
  const blob = buildRcDoc(opts).output('blob')
  return new File([blob], `${opts.summary.comparison_no}.pdf`, {
    type: 'application/pdf',
  })
}
