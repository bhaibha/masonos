import { jsPDF } from 'jspdf'
import { COMPANY } from '@/lib/company'
import { drawLetterhead } from '@/lib/pdf/letterhead'
import type { SiRow } from '@/lib/types'

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

export interface SiPdfOpts {
  si: SiRow
  projectName: string
  siteAddress: string | null
  clientName: string | null
}

/**
 * Site Instruction on the company letterhead, matching the PO and VO templates
 * exactly — same margins, same type scale, same brass rule, same signature
 * block — so the three read as one family of documents.
 *
 * Carries no rupee figure by design. A cost-bearing instruction names its
 * variation order; the amount stays on the VO.
 */
function buildSiDoc(opts: SiPdfOpts): jsPDF {
  const { si, projectName, siteAddress, clientName } = opts
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 48
  const ink: [number, number, number] = [26, 26, 24]
  const muted: [number, number, number] = [107, 101, 96]
  const danger: [number, number, number] = [155, 61, 61]
  let y = drawLetterhead(doc, { margin: M })

  // ---------- Title block ----------
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('SITE INSTRUCTION', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(si.si_number, W - M, y, { align: 'right' })
  y += 14
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`Issued: ${fmtDate(si.issued_date)}`, W - M, y, { align: 'right' })
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

  // ---------- Addressed to / where / by when ----------
  const meta: [string, string][] = [
    ['TO', si.addressed_display ?? '—'],
    ['WORK AREA', si.work_area ?? '—'],
    ['REQUIRED BY', si.required_by ? fmtDate(si.required_by) : 'Not specified'],
  ]
  const colW = (W - 2 * M) / meta.length
  const metaY = y
  meta.forEach(([label, value], i) => {
    const x = M + i * colW
    doc.setFontSize(8)
    doc.setTextColor(...muted)
    doc.text(label, x, metaY)
    doc.setFontSize(10)
    doc.setTextColor(...ink)
    doc.setFont('helvetica', 'bold')
    for (const [j, l] of doc.splitTextToSize(value, colW - 10).entries()) {
      doc.text(l as string, x, metaY + 14 + j * 12)
    }
    doc.setFont('helvetica', 'normal')
  })
  y = metaY + 44

  doc.setDrawColor(237, 233, 227)
  doc.setLineWidth(0.5)
  doc.line(M, y, W - M, y)
  y += 22

  // ---------- The instruction ----------
  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text('INSTRUCTION', M, y)
  y += 16
  doc.setFontSize(11)
  doc.setTextColor(...ink)
  for (const l of doc.splitTextToSize(si.instruction, W - 2 * M)) {
    doc.text(l as string, M, y)
    y += 15
    if (y > H - 190) break // leave room for the cost note and signatures
  }
  y += 12

  // ---------- Cost implication ----------
  doc.setDrawColor(237, 233, 227)
  doc.line(M, y, W - M, y)
  y += 20

  doc.setFontSize(10)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...(si.has_cost_implication ? danger : ink))
  doc.text(
    si.has_cost_implication
      ? 'This instruction carries a cost implication.'
      : 'No cost implication — to be carried out within the existing scope.',
    M,
    y,
  )
  y += 14
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  if (si.has_cost_implication) {
    doc.text(
      si.variation_number
        ? `Priced under variation order ${si.variation_number}. No amount is stated on this instruction.`
        : 'A variation order is to be raised. Do not proceed on cost until it is approved.',
      M,
      y,
    )
    y += 13
  }

  if (si.attachments.length > 0) {
    doc.text(
      `${si.attachments.length} attachment${si.attachments.length === 1 ? '' : 's'} held in the project document vault.`,
      M,
      y,
    )
  }

  // ---------- CANCELLED watermark ----------
  // Drawn last so it sits over the content, and kept light enough that the
  // document underneath is still legible — a cancelled instruction still has
  // to be readable as a record of what was once instructed.
  if (si.status === 'cancelled') {
    doc.saveGraphicsState()
    // @ts-expect-error — setGState/GState exist at runtime; jsPDF's types omit them.
    doc.setGState(new doc.GState({ opacity: 0.14 }))
    doc.setTextColor(...danger)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(92)
    doc.text('CANCELLED', W / 2, H / 2, { align: 'center', angle: 32 })
    doc.restoreGraphicsState()

    // Legible reason, at full opacity, under the instruction.
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...danger)
    doc.text(
      `CANCELLED${si.cancelled_at ? ` on ${fmtDate(si.cancelled_at)}` : ''}`,
      M,
      H - 150,
    )
    if (si.cancel_reason) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      for (const [i, l] of doc
        .splitTextToSize(`Reason: ${si.cancel_reason}`, W - 2 * M)
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
  doc.text('Received / acknowledged', M, sy + 14)
  doc.text(`For ${COMPANY.name}`, W - M, sy + 14, { align: 'right' })
  doc.text('Authorised signatory', W - M, sy + 28, { align: 'right' })

  return doc
}

export function generateSiPdf(opts: SiPdfOpts): void {
  buildSiDoc(opts).save(`${opts.si.si_number}.pdf`)
}

export function generateSiFile(opts: SiPdfOpts): File {
  const blob = buildSiDoc(opts).output('blob')
  return new File([blob], `${opts.si.si_number}.pdf`, {
    type: 'application/pdf',
  })
}
