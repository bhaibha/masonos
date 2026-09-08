import { jsPDF } from 'jspdf'
import { COMPANY } from '@/lib/company'
import { APP_NAME } from '@/lib/appName'
import { drawLetterhead, drawPageFooters } from '@/lib/pdf/letterhead'
import {
  SNAG_SEVERITY_LABEL,
  SNAG_STATUS_LABEL,
  type SnagRow,
  type SnagSeverity,
  type SnagStatus,
} from '@/lib/types'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso))
}

const INK: [number, number, number] = [26, 26, 24]
const MUTED: [number, number, number] = [107, 101, 96]
const DANGER: [number, number, number] = [155, 61, 61]
const WARNING: [number, number, number] = [184, 134, 59]
const POSITIVE: [number, number, number] = [47, 111, 79]

const SEVERITY_TONE: Record<SnagSeverity, [number, number, number]> = {
  low: MUTED,
  medium: WARNING,
  high: DANGER,
}

const STATUS_TONE: Record<SnagStatus, [number, number, number]> = {
  open: DANGER,
  in_progress: WARNING,
  resolved: POSITIVE,
  verified: POSITIVE,
}

/**
 * Two documents, because a defect list has two readers who need different
 * things.
 *
 *  - **The punch list** is what you hand a subcontractor, or walk a client
 *    through at handover: everything outstanding, grouped by area, in the order
 *    somebody would actually walk the building. Multi-page, so it carries the
 *    page footer.
 *  - **The single snag sheet** is one defect issued to one trade, laid out like
 *    the NCR, with a resolution block that can be filled in by hand on site and
 *    photographed back.
 *
 * PHOTOS ARE COUNTED, NOT EMBEDDED — the same decision as the NCR. Every photo
 * would have to be downloaded from storage, which turns these into async
 * functions, and fifty snags with two pictures each is a document nobody can
 * email. The count tells the reader that the evidence exists and where it is.
 */

/* ------------------------------------------------------------------ */
/* Punch list                                                          */
/* ------------------------------------------------------------------ */

export interface SnagListPdfOpts {
  snags: SnagRow[]
  projectName: string
  siteAddress: string | null
  clientName: string | null
  /** Printed under the title so nobody argues about what the list covered. */
  filterNote?: string | null
  dlp?: { start: string | null; end: string | null; active: boolean } | null
}

function buildSnagListDoc(opts: SnagListPdfOpts): jsPDF {
  const { snags, projectName, siteAddress, clientName, filterNote, dlp } = opts
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 48

  let y = drawLetterhead(doc, { margin: M })

  doc.setTextColor(...INK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('SNAG LIST', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(`${snags.length} item${snags.length === 1 ? '' : 's'}`, W - M, y, {
    align: 'right',
  })
  y += 14
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text(`Issued ${fmtDate(new Date().toISOString())}`, W - M, y, {
    align: 'right',
  })
  y += 20

  // ---------- Project ----------
  doc.setFontSize(8)
  doc.text('PROJECT', M, y)
  y += 12
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...INK)
  doc.text(projectName, M, y)
  y += 13
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
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
  if (filterNote) {
    doc.text(filterNote, M, y)
    y += 12
  }
  // The liability window is the single most consequential fact on a handover
  // snag list, so it is stated rather than left to be worked out from dates.
  if (dlp?.end) {
    doc.setTextColor(...(dlp.active ? WARNING : MUTED))
    doc.text(
      dlp.active
        ? `Defects liability period runs to ${fmtDate(dlp.end)}.`
        : `Defects liability period ended ${fmtDate(dlp.end)}.`,
      M,
      y,
    )
    doc.setTextColor(...MUTED)
    y += 12
  }
  y += 10

  // ---------- Grouped by work area ----------
  // A punch list is walked, not read, so it is ordered the way somebody moves
  // through a building rather than by severity or by date raised.
  const byArea = new Map<string, SnagRow[]>()
  for (const s of snags) {
    const key = s.work_area || 'Unspecified area'
    const list = byArea.get(key)
    if (list) list.push(s)
    else byArea.set(key, [s])
  }
  const areas = [...byArea.keys()].sort((a, b) => a.localeCompare(b))

  const cols = { no: M, desc: M + 62, meta: W - M - 150, status: W - M }

  function pageBreak(needed: number) {
    if (y > H - needed) {
      doc.addPage()
      y = M
    }
  }

  function columnHeads() {
    doc.setFillColor(242, 238, 232)
    doc.rect(M, y - 11, W - 2 * M, 20, 'F')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text('SNAG', cols.no, y + 2)
    doc.text('DEFECT', cols.desc, y + 2)
    doc.text('TRADE / ASSIGNED', cols.meta, y + 2)
    doc.text('STATUS', cols.status, y + 2, { align: 'right' })
    y += 22
  }

  if (snags.length === 0) {
    doc.setFontSize(10)
    doc.setTextColor(...MUTED)
    doc.text(
      'No outstanding snags on this project at the date of issue.',
      M,
      y,
    )
    // Said plainly rather than left as a blank page: an empty list is a claim,
    // and the reader deserves to know it was a claim and not a printing fault.
    y += 14
    doc.setFontSize(8)
    doc.text(
      'This states that nothing is recorded, not that the works have been inspected.',
      M,
      y,
    )
    drawPageFooters(doc, { margin: M })
    return doc
  }

  columnHeads()

  for (const area of areas) {
    const items = byArea.get(area) ?? []
    pageBreak(90)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(...INK)
    doc.text(area.toUpperCase(), M, y)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text(
      `${items.length} item${items.length === 1 ? '' : 's'}`,
      W - M,
      y,
      { align: 'right' },
    )
    y += 6
    doc.setDrawColor(...MUTED)
    doc.setLineWidth(0.5)
    doc.line(M, y, W - M, y)
    y += 15

    for (const s of items) {
      pageBreak(70)

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(...INK)
      doc.text(s.snag_number, cols.no, y)

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9.5)
      const desc = doc.splitTextToSize(
        s.description,
        cols.meta - cols.desc - 14,
      ) as string[]
      // Two lines, then elide — the full text is in the app, and a punch list
      // whose rows run to a paragraph stops being walkable.
      const shown = desc.slice(0, 2)
      if (desc.length > 2) shown[1] = `${shown[1]?.replace(/\s+\S*$/, '') ?? ''}…`
      shown.forEach((l, i) => doc.text(l, cols.desc, y + i * 12))

      doc.setFontSize(8.5)
      doc.setTextColor(...MUTED)
      doc.text(s.trade ?? '—', cols.meta, y)
      if (s.assigned_display) {
        doc.text(
          (doc.splitTextToSize(s.assigned_display, 145) as string[])[0],
          cols.meta,
          y + 11,
        )
      }

      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...STATUS_TONE[s.status])
      doc.text(SNAG_STATUS_LABEL[s.status], cols.status, y, { align: 'right' })
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(...SEVERITY_TONE[s.severity])
      doc.setFontSize(8)
      doc.text(
        `${SNAG_SEVERITY_LABEL[s.severity]} severity`,
        cols.status,
        y + 11,
        { align: 'right' },
      )

      doc.setTextColor(...MUTED)
      const tail: string[] = [`Raised ${fmtDate(s.raised_date)}`]
      if (s.raised_during_dlp) tail.push('in DLP')
      if (s.photos.length > 0) {
        tail.push(
          `${s.photos.length} photo${s.photos.length === 1 ? '' : 's'} in ${APP_NAME}`,
        )
      }
      const bodyH = Math.max(shown.length * 12, 22)
      doc.setFontSize(7.5)
      doc.text(tail.join('  ·  '), cols.desc, y + bodyH)

      y += bodyH + 14
      doc.setDrawColor(237, 233, 227)
      doc.setLineWidth(0.5)
      doc.line(M, y - 8, W - M, y - 8)
    }
    y += 8
  }

  // ---------- Sign-off ----------
  pageBreak(110)
  y += 10
  const sy = Math.min(y + 40, H - 80)
  doc.setDrawColor(...MUTED)
  doc.setLineWidth(0.5)
  doc.line(M, sy, M + 170, sy)
  doc.line(W - M - 170, sy, W - M, sy)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text('Received by', M, sy + 14)
  doc.text(`For ${COMPANY.name}`, W - M, sy + 14, { align: 'right' })
  doc.text('Contractor / client', M, sy + 26)
  doc.text('Issued by', W - M, sy + 26, { align: 'right' })

  drawPageFooters(doc, { margin: M })
  return doc
}

export function generateSnagListPdf(opts: SnagListPdfOpts): void {
  const safe = opts.projectName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  buildSnagListDoc(opts).save(
    `snag-list-${safe || 'project'}-${new Date().toISOString().slice(0, 10)}.pdf`,
  )
}

export function generateSnagListFile(opts: SnagListPdfOpts): File {
  const blob = buildSnagListDoc(opts).output('blob')
  const safe = opts.projectName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  return new File(
    [blob],
    `snag-list-${safe || 'project'}-${new Date().toISOString().slice(0, 10)}.pdf`,
    { type: 'application/pdf' },
  )
}

/* ------------------------------------------------------------------ */
/* Single snag sheet                                                   */
/* ------------------------------------------------------------------ */

export interface SnagPdfOpts {
  snag: SnagRow
  projectName: string
  siteAddress: string | null
  clientName: string | null
  resolvedByName?: string | null
  verifiedByName?: string | null
}

function buildSnagDoc(opts: SnagPdfOpts): jsPDF {
  const {
    snag: s,
    projectName,
    siteAddress,
    clientName,
    resolvedByName,
    verifiedByName,
  } = opts
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 48

  let y = drawLetterhead(doc, { margin: M })

  // ---------- Title ----------
  doc.setTextColor(...INK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('SNAG', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(s.snag_number, W - M, y, { align: 'right' })
  y += 14
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text(`Raised: ${fmtDate(s.raised_date)}`, W - M, y, { align: 'right' })
  y += 22

  // ---------- Project ----------
  doc.setFontSize(8)
  doc.text('PROJECT', M, y)
  y += 12
  doc.setTextColor(...INK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.text(projectName, M, y)
  y += 13
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
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
  const meta: [string, string, [number, number, number]][] = [
    ['AREA', s.work_area || '—', INK],
    ['TRADE', s.trade ?? '—', INK],
    ['SEVERITY', SNAG_SEVERITY_LABEL[s.severity], SEVERITY_TONE[s.severity]],
    ['STATUS', SNAG_STATUS_LABEL[s.status], STATUS_TONE[s.status]],
  ]
  const colW = (W - 2 * M) / meta.length
  const metaY = y
  meta.forEach(([label, value, tone], i) => {
    const x = M + i * colW
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text(label, x, metaY)
    doc.setFontSize(10)
    doc.setTextColor(...tone)
    doc.setFont('helvetica', 'bold')
    for (const [j, l] of doc.splitTextToSize(value, colW - 10).entries()) {
      doc.text(l as string, x, metaY + 14 + j * 12)
    }
    doc.setFont('helvetica', 'normal')
  })
  y = metaY + 50

  if (s.assigned_display) {
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text('ASSIGNED TO', M, y)
    doc.setFontSize(10)
    doc.setTextColor(...INK)
    doc.text(s.assigned_display, M + 80, y)
    // Whether the firm holds a contract with this party changes who chases it,
    // so it is stated rather than implied by the name.
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text(
      s.assigned_registered ? '(registered vendor)' : '(not a registered vendor)',
      W - M,
      y,
      { align: 'right' },
    )
    y += 18
  }

  if (s.raised_during_dlp) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...WARNING)
    doc.text('Raised within the defects liability period.', M, y)
    doc.setFont('helvetica', 'normal')
    y += 16
  }

  doc.setDrawColor(237, 233, 227)
  doc.setLineWidth(0.5)
  doc.line(M, y, W - M, y)
  y += 22

  // ---------- The defect ----------
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text('DEFECT', M, y)
  y += 16
  doc.setFontSize(11)
  doc.setTextColor(...INK)
  for (const l of doc.splitTextToSize(s.description, W - 2 * M)) {
    doc.text(l as string, M, y)
    y += 15
    if (y > H - 250) break
  }
  y += 6

  if (s.photos.length > 0) {
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    doc.text(
      `${s.photos.length} photograph${s.photos.length === 1 ? '' : 's'} held against this snag in ${APP_NAME}.`,
      M,
      y,
    )
    y += 16
  }

  // ---------- Rectification ----------
  doc.setDrawColor(237, 233, 227)
  doc.line(M, y, W - M, y)
  y += 20
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text('RECTIFICATION', M, y)
  y += 16

  if (s.resolution_note) {
    doc.setFontSize(10)
    doc.setTextColor(...INK)
    for (const l of doc.splitTextToSize(s.resolution_note, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 13
      if (y > H - 175) break
    }
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    if (s.resolved_at) {
      doc.text(
        `Resolved ${fmtDate(s.resolved_at)}${resolvedByName ? ` by ${resolvedByName}` : ''}`,
        M,
        y,
      )
      y += 13
    }
    if (s.resolution_photos.length > 0) {
      doc.text(
        `${s.resolution_photos.length} photograph${s.resolution_photos.length === 1 ? '' : 's'} of the completed work.`,
        M,
        y,
      )
      y += 13
    }
  } else {
    // Ruled lines rather than blank space, so the printed sheet can be
    // completed by hand on site and photographed back — the same reasoning as
    // the RFI response block and the NCR's corrective action.
    doc.setDrawColor(214, 209, 202)
    for (let i = 0; i < 3; i++) doc.line(M, y + i * 18, W - M, y + i * 18)
    y += 58
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    doc.text(
      'To be completed and re-inspected before this snag can be closed.',
      M,
      y,
    )
    y += 13
  }

  if (s.status === 'verified' && s.verified_at) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...POSITIVE)
    doc.text(
      `VERIFIED on ${fmtDate(s.verified_at)}${verifiedByName ? ` by ${verifiedByName}` : ''}.`,
      M,
      y,
    )
    doc.setFont('helvetica', 'normal')
  }

  // ---------- Signatures ----------
  const sy = H - 100
  doc.setDrawColor(...MUTED)
  doc.setLineWidth(0.5)
  doc.line(M, sy, M + 170, sy)
  doc.line(W - M - 170, sy, W - M, sy)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  doc.text('Rectified by', M, sy + 14)
  doc.text(`For ${COMPANY.name}`, W - M, sy + 14, { align: 'right' })
  doc.text('Verified on site', W - M, sy + 28, { align: 'right' })

  return doc
}

export function generateSnagPdf(opts: SnagPdfOpts): void {
  buildSnagDoc(opts).save(`${opts.snag.snag_number}.pdf`)
}

export function generateSnagFile(opts: SnagPdfOpts): File {
  const blob = buildSnagDoc(opts).output('blob')
  return new File([blob], `${opts.snag.snag_number}.pdf`, {
    type: 'application/pdf',
  })
}
