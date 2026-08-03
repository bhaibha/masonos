import { jsPDF } from 'jspdf'
import { amountInWords } from '@/lib/amountInWords'
import { COMPANY } from '@/lib/company'
import { RA_STATUS_LABEL, type RaBillLine, type RaBillRow } from '@/lib/types'

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const rupee = (n: number) => `${n < 0 ? '-' : ''}Rs. ${inr.format(Math.abs(n))}`
const qty = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

export interface RaBillPdfOpts {
  bill: RaBillRow
  lines: RaBillLine[]
  projectName: string
  siteAddress: string | null
}

/**
 * Certificate on the company letterhead, matching the invoice / PO / VO / SI
 * templates.
 *
 * Prints ONLY what the database computed. The four figures in the summary block
 * are the frozen snapshot from fn_certify_ra_bill; the one arithmetic operation
 * in this file is the running Y position. The words line restates the stored
 * net — it doesn't recompute it.
 */
function buildRaDoc(opts: RaBillPdfOpts): jsPDF {
  const { bill, lines, projectName, siteAddress } = opts
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 48
  const ink: [number, number, number] = [26, 26, 24]
  const muted: [number, number, number] = [107, 101, 96]
  const brass: [number, number, number] = [166, 124, 82]
  const danger: [number, number, number] = [155, 61, 61]
  let y = M

  // ---------- Letterhead ----------
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.text(COMPANY.name, M, y)
  y += 16
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  if (COMPANY.tagline) {
    doc.text(COMPANY.tagline, M, y)
    y += 12
  }
  for (const line of COMPANY.addressLines) {
    doc.text(line, M, y)
    y += 11
  }
  doc.text(`GSTIN: ${COMPANY.gstin}`, M, y)
  y += 11
  doc.text(`${COMPANY.phone}  ·  ${COMPANY.email}`, M, y)
  y += 18

  doc.setDrawColor(...brass)
  doc.setLineWidth(1.2)
  doc.line(M, y, W - M, y)
  y += 26

  // ---------- Title ----------
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('RUNNING ACCOUNT BILL CERTIFICATE', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(bill.bill_no, W - M, y, { align: 'right' })
  y += 14
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  if (bill.certified_at) {
    doc.text(`Certified: ${fmtDate(bill.certified_at)}`, W - M, y, {
      align: 'right',
    })
    y += 12
  }
  doc.text(
    bill.period_from
      ? `Period: ${fmtDate(bill.period_from)} to ${fmtDate(bill.period_to)}`
      : `Up to: ${fmtDate(bill.period_to)}`,
    W - M,
    y,
    { align: 'right' },
  )
  y += 20

  // ---------- Contractor / project ----------
  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text('CONTRACTOR', M, y)
  doc.text('PROJECT', W / 2, y)
  y += 13
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...ink)
  doc.text(bill.vendor_name ?? bill.contractor_name ?? '—', M, y)
  doc.text(projectName, W / 2, y)
  y += 13
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  if (bill.contractor_bill_no) {
    doc.text(`Their bill no: ${bill.contractor_bill_no}`, M, y)
  }
  if (siteAddress) {
    for (const l of doc.splitTextToSize(siteAddress, W / 2 - M - 10)) {
      doc.text(l as string, W / 2, y)
      y += 11
    }
  } else {
    y += 11
  }
  y += 14

  // ---------- Measurement table ----------
  const cols = { desc: M, unit: 300, qty: 360, rate: 440, amt: W - M }

  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text('WORK MEASURED TO DATE', cols.desc, y)
  doc.text('UNIT', cols.unit, y)
  doc.text('QTY', cols.qty, y, { align: 'right' })
  doc.text('RATE', cols.rate, y, { align: 'right' })
  doc.text('AMOUNT', cols.amt, y, { align: 'right' })
  y += 6
  doc.setDrawColor(220, 216, 210)
  doc.setLineWidth(0.5)
  doc.line(M, y, W - M, y)
  y += 13

  doc.setFontSize(9)
  doc.setTextColor(...ink)
  for (const l of lines) {
    if (y > H - 250) {
      doc.addPage()
      y = M
    }
    const wrapped = doc.splitTextToSize(l.description, cols.unit - M - 12)
    doc.text(wrapped[0] as string, cols.desc, y)
    doc.text(l.unit ?? '—', cols.unit, y)
    doc.text(qty.format(l.qty_to_date), cols.qty, y, { align: 'right' })
    doc.text(inr.format(l.rate), cols.rate, y, { align: 'right' })
    doc.text(inr.format(l.amount), cols.amt, y, { align: 'right' })
    y += 13
    for (const extra of wrapped.slice(1)) {
      doc.setTextColor(...muted)
      doc.text(extra as string, cols.desc, y)
      doc.setTextColor(...ink)
      y += 11
    }
  }

  y += 4
  doc.setDrawColor(220, 216, 210)
  doc.line(M, y, W - M, y)
  y += 18

  // ---------- The running account ----------
  const row = (label: string, value: string, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(bold ? 11 : 10)
    doc.setTextColor(...(bold ? ink : muted))
    doc.text(label, W / 2 - 40, y, { align: 'right' })
    doc.setTextColor(...ink)
    doc.text(value, W - M, y, { align: 'right' })
    y += bold ? 18 : 15
  }

  row('Gross value of work to date', rupee(bill.gross_work_value))
  row('Less: previously certified', `- ${rupee(bill.less_previously_certified)}`)
  row('Value of this bill', rupee(bill.value_this_bill), true)
  row(
    `Less: retention @ ${bill.retention_pct}%`,
    `- ${rupee(bill.retention_amount)}`,
  )

  y += 4
  doc.setDrawColor(...brass)
  doc.setLineWidth(1)
  doc.line(W / 2 - 60, y, W - M, y)
  y += 18
  row('NET CERTIFIED FOR PAYMENT', rupee(bill.net_certified), true)

  // Claimed vs certified — the gap is the most useful line on the sheet.
  if (bill.claimed_amount !== null) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text(
      `Contractor claimed ${rupee(bill.claimed_amount)} for this bill.`,
      M,
      y,
    )
    y += 14
  }

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  for (const l of doc.splitTextToSize(
    `Net certified in words: ${amountInWords(bill.net_certified)}`,
    W - 2 * M,
  )) {
    doc.text(l as string, M, y)
    y += 12
  }

  if (bill.notes) {
    y += 6
    doc.setFontSize(8)
    doc.text('NOTES', M, y)
    y += 12
    doc.setFontSize(9)
    for (const l of doc.splitTextToSize(bill.notes, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 11
      if (y > H - 130) break
    }
  }

  // ---------- VOID watermark ----------
  // Rejected as well as cancelled: both mean "do not pay against this sheet",
  // and a rejected bill still circulates on site. Light enough to stay
  // readable, with the reason at full opacity.
  const voided = bill.status === 'cancelled' || bill.status === 'rejected'
  if (voided) {
    const reason =
      bill.status === 'cancelled' ? bill.cancel_reason : bill.reject_reason
    const when =
      bill.status === 'cancelled' ? bill.cancelled_at : bill.rejected_at

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
      `${RA_STATUS_LABEL[bill.status].toUpperCase()}${when ? ` on ${fmtDate(when)}` : ''}`,
      M,
      H - 150,
    )
    if (reason) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      for (const [i, l] of doc
        .splitTextToSize(`Reason: ${reason}`, W - 2 * M)
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
  doc.text('Certified by', W - M, sy + 28, { align: 'right' })
  doc.text('This is a computer-generated document.', M, sy + 28)

  return doc
}

export function generateRaBillPdf(opts: RaBillPdfOpts): void {
  buildRaDoc(opts).save(`${opts.bill.bill_no}.pdf`)
}

export function generateRaBillFile(opts: RaBillPdfOpts): File {
  const blob = buildRaDoc(opts).output('blob')
  return new File([blob], `${opts.bill.bill_no}.pdf`, {
    type: 'application/pdf',
  })
}
