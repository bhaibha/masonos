import { jsPDF } from 'jspdf'
import { COMPANY } from '@/lib/company'
import { drawLetterhead } from '@/lib/pdf/letterhead'
import { RFI_CATEGORY_LABEL, type RfiRow } from '@/lib/types'

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

export interface RfiPdfOpts {
  rfi: RfiRow
  projectName: string
  siteAddress: string | null
  clientName: string | null
}

/**
 * RFI on the company letterhead, matching the SI / PO / VO / invoice templates.
 *
 * Two-part document: the question, then the answer if one has been recorded.
 * An unanswered RFI prints with an empty, ruled response block — deliberately,
 * so it can be handed or emailed to the consultant to write into.
 */
function buildRfiDoc(opts: RfiPdfOpts): jsPDF {
  const { rfi, projectName, siteAddress, clientName } = opts
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
  doc.text('REQUEST FOR INFORMATION', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(rfi.rfi_number, W - M, y, { align: 'right' })
  y += 14
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`Raised: ${fmtDate(rfi.raised_date)}`, W - M, y, { align: 'right' })
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

  // ---------- To / category / required by ----------
  const meta: [string, string][] = [
    ['TO', rfi.addressed_display ?? '—'],
    ['CATEGORY', RFI_CATEGORY_LABEL[rfi.category]],
    [
      'RESPONSE REQUIRED BY',
      rfi.required_by ? fmtDate(rfi.required_by) : 'Not specified',
    ],
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
  y = metaY + 46

  doc.setDrawColor(237, 233, 227)
  doc.setLineWidth(0.5)
  doc.line(M, y, W - M, y)
  y += 20

  // ---------- Question ----------
  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text('QUESTION', M, y)
  y += 16
  doc.setFontSize(11)
  doc.setTextColor(...ink)
  for (const l of doc.splitTextToSize(rfi.question, W - 2 * M)) {
    doc.text(l as string, M, y)
    y += 15
    if (y > H - 300) break
  }
  y += 10

  if (rfi.attachments.length > 0) {
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text(
      `${rfi.attachments.length} attachment${rfi.attachments.length === 1 ? '' : 's'} held in the project document vault.`,
      M,
      y,
    )
    y += 16
  }

  doc.setDrawColor(237, 233, 227)
  doc.line(M, y, W - M, y)
  y += 20

  // ---------- Response ----------
  doc.setFontSize(8)
  doc.setTextColor(...muted)
  doc.text('RESPONSE', M, y)
  if (rfi.response_date) {
    doc.text(`Received ${fmtDate(rfi.response_date)}`, W - M, y, {
      align: 'right',
    })
  }
  y += 16

  if (rfi.response) {
    doc.setFontSize(11)
    doc.setTextColor(...ink)
    for (const l of doc.splitTextToSize(rfi.response, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 15
      if (y > H - 150) break
    }
  } else {
    // No answer yet: print ruled lines so the sheet can be handed over and
    // written on. An empty white gap would just look like a layout bug.
    doc.setFontSize(9)
    doc.setTextColor(...muted)
    doc.text('Awaiting response.', M, y)
    y += 16
    doc.setDrawColor(225, 220, 213)
    for (let i = 0; i < 5 && y < H - 160; i++) {
      doc.line(M, y, W - M, y)
      y += 20
    }
  }

  // ---------- CANCELLED watermark ----------
  if (rfi.status === 'cancelled') {
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
      `CANCELLED${rfi.cancelled_at ? ` on ${fmtDate(rfi.cancelled_at)}` : ''}`,
      M,
      H - 150,
    )
    if (rfi.cancel_reason) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      for (const [i, l] of doc
        .splitTextToSize(`Reason: ${rfi.cancel_reason}`, W - 2 * M)
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
  doc.text('Consultant / architect', M, sy + 14)
  doc.text(`For ${COMPANY.name}`, W - M, sy + 14, { align: 'right' })
  doc.text(
    rfi.raised_by_name ? `Raised by ${rfi.raised_by_name}` : 'Raised by',
    W - M,
    sy + 28,
    { align: 'right' },
  )

  return doc
}

export function generateRfiPdf(opts: RfiPdfOpts): void {
  buildRfiDoc(opts).save(`${opts.rfi.rfi_number}.pdf`)
}

export function generateRfiFile(opts: RfiPdfOpts): File {
  const blob = buildRfiDoc(opts).output('blob')
  return new File([blob], `${opts.rfi.rfi_number}.pdf`, {
    type: 'application/pdf',
  })
}
