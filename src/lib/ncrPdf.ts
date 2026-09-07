import { jsPDF } from 'jspdf'
import { APP_NAME_FULL } from '@/lib/appName'
import { COMPANY } from '@/lib/company'
import {
  NCR_SEVERITY_LABEL,
  NCR_STATUS_LABEL,
  type NcrRow,
} from '@/lib/types'

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

export interface NcrPdfOpts {
  ncr: NcrRow
  projectName: string
  siteAddress: string | null
  clientName: string | null
  raisedByName?: string | null
  assignedToName?: string | null
}

/**
 * Non-Conformance Report on the company letterhead — same margins, type scale,
 * brass rule and signature block as the PO, VO, SI and RA bill, so all five
 * read as one family of documents.
 *
 * Carries no rupee figure by design, exactly like the Site Instruction. An NCR
 * describes what does not conform and what was done about it; if it costs
 * money, that belongs on a variation order where somebody has to approve the
 * amount.
 */
function buildNcrDoc(opts: NcrPdfOpts): jsPDF {
  const { ncr, projectName, siteAddress, clientName } = opts
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 48
  const ink: [number, number, number] = [26, 26, 24]
  const muted: [number, number, number] = [107, 101, 96]
  const brass: [number, number, number] = [166, 124, 82]
  const danger: [number, number, number] = [155, 61, 61]
  const positive: [number, number, number] = [47, 111, 79]
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
  doc.text('NON-CONFORMANCE REPORT', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(ncr.ncr_no, W - M, y, { align: 'right' })
  y += 14
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`Raised: ${fmtDate(ncr.created_at)}`, W - M, y, { align: 'right' })
  y += 22

  // ---------- Project ----------
  doc.setFontSize(8)
  doc.text('PROJECT', M, y)
  y += 12
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.text(projectName, M, y)
  y += 13
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  if (clientName) {
    doc.text(`Client: ${clientName}`, M, y)
    y += 12
  }
  if (siteAddress) {
    for (const l of doc.splitTextToSize(siteAddress, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 11
    }
  }
  y += 12

  // ---------- Meta strip ----------
  const meta: [string, string][] = [
    ['AREA', ncr.area],
    ['SEVERITY', NCR_SEVERITY_LABEL[ncr.severity]],
    ['STANDARD', ncr.standard_ref ?? '—'],
    ['STATUS', NCR_STATUS_LABEL[ncr.status]],
  ]
  const colW = (W - 2 * M) / meta.length
  const metaY = y
  meta.forEach(([label, value], i) => {
    const x = M + i * colW
    doc.setFontSize(8)
    doc.setTextColor(...muted)
    doc.text(label, x, metaY)
    doc.setFontSize(10)
    // Severity is the one field a reader should catch at a glance.
    doc.setTextColor(
      ...(label === 'SEVERITY' && ncr.severity !== 'minor' ? danger : ink),
    )
    doc.setFont('helvetica', 'bold')
    for (const [j, l] of doc.splitTextToSize(value, colW - 10).entries()) {
      doc.text(l as string, x, metaY + 14 + j * 12)
    }
    doc.setFont('helvetica', 'normal')
  })
  y = metaY + 50

  doc.setDrawColor(237, 233, 227)
  doc.setLineWidth(0.5)
  doc.line(M, y, W - M, y)
  y += 22

  // ---------- The non-conformance ----------
  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text('NON-CONFORMANCE', M, y)
  y += 16
  doc.setFontSize(11)
  doc.setTextColor(...ink)
  for (const l of doc.splitTextToSize(ncr.description, W - 2 * M)) {
    doc.text(l as string, M, y)
    y += 15
    if (y > H - 230) break // leave room for the corrective action and signatures
  }
  y += 12

  // ---------- Corrective action ----------
  doc.setDrawColor(237, 233, 227)
  doc.line(M, y, W - M, y)
  y += 20

  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text('CORRECTIVE ACTION', M, y)
  y += 16

  if (ncr.corrective_action) {
    doc.setFontSize(10)
    doc.setTextColor(...ink)
    for (const l of doc.splitTextToSize(ncr.corrective_action, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 13
      if (y > H - 175) break
    }
    if (ncr.corrected_at) {
      doc.setFontSize(9)
      doc.setTextColor(...muted)
      doc.text(`Recorded ${fmtDate(ncr.corrected_at)}`, M, y)
      y += 13
    }
  } else {
    // Ruled lines rather than a blank space, so the printed copy can be filled
    // in by hand on site and photographed back — the same reasoning as the
    // RFI's empty response block.
    doc.setDrawColor(214, 209, 202)
    for (let i = 0; i < 3; i++) {
      doc.line(M, y + i * 18, W - M, y + i * 18)
    }
    y += 58
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text('To be completed and re-inspected before this NCR can be closed.', M, y)
    y += 13
  }

  // ---------- Outcome ----------
  if (ncr.status === 'closed' && ncr.closed_at) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...positive)
    doc.text(`CLOSED on ${fmtDate(ncr.closed_at)} after re-inspection.`, M, y)
    doc.setFont('helvetica', 'normal')
    y += 14
  } else if (ncr.status === 'rejected' && ncr.reject_reason) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...danger)
    doc.text('CORRECTION REJECTED', M, y)
    y += 13
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    for (const l of doc.splitTextToSize(ncr.reject_reason, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 12
    }
  }

  if (ncr.photos.length > 0) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text(
      `${ncr.photos.length} photograph${ncr.photos.length === 1 ? '' : 's'} held against this report in ${APP_NAME_FULL}.`,
      M,
      y,
    )
  }

  // ---------- CANCELLED watermark ----------
  // Drawn last so it sits over the content, and light enough that the document
  // underneath stays legible — a cancelled NCR still has to be readable as the
  // record of what was once alleged.
  if (ncr.status === 'cancelled') {
    doc.saveGraphicsState()
    // @ts-expect-error — setGState/GState exist at runtime; jsPDF's types omit them.
    doc.setGState(new doc.GState({ opacity: 0.14 }))
    doc.setTextColor(...danger)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(92)
    doc.text('CANCELLED', W / 2, H / 2, { align: 'center', angle: 32 })
    doc.restoreGraphicsState()

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...danger)
    doc.text(
      `CANCELLED${ncr.cancelled_at ? ` on ${fmtDate(ncr.cancelled_at)}` : ''}`,
      M,
      H - 150,
    )
    if (ncr.cancel_reason) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      for (const [i, l] of doc
        .splitTextToSize(`Reason: ${ncr.cancel_reason}`, W - 2 * M)
        .entries()) {
        doc.text(l as string, M, H - 136 + i * 12)
      }
    }
  }

  // ---------- Signatures ----------
  const sy = H - 100
  doc.setDrawColor(...muted)
  doc.setLineWidth(0.5)
  doc.line(M, sy, M + 170, sy)
  doc.line(W - M - 170, sy, W - M, sy)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text('Corrective action by', M, sy + 14)
  doc.text(`For ${COMPANY.name}`, W - M, sy + 14, { align: 'right' })
  doc.text('Quality sign-off', W - M, sy + 28, { align: 'right' })

  return doc
}

export function generateNcrPdf(opts: NcrPdfOpts): void {
  buildNcrDoc(opts).save(`${opts.ncr.ncr_no}.pdf`)
}

export function generateNcrFile(opts: NcrPdfOpts): File {
  const blob = buildNcrDoc(opts).output('blob')
  return new File([blob], `${opts.ncr.ncr_no}.pdf`, {
    type: 'application/pdf',
  })
}
