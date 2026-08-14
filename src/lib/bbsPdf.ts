import { jsPDF } from 'jspdf'
import { COMPANY } from '@/lib/company'
import type { BbsBar, BbsMember, BbsSteelByDia } from '@/lib/types'

const n2 = (v: number) =>
  new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v)

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d)
}

export interface BbsPdfOpts {
  members: BbsMember[]
  bars: BbsBar[]
  steel: BbsSteelByDia[]
  projectName: string
  siteAddress: string | null
  constantsNote: string
  /** from fn_bbs_mark_audit — the two boxes at the top of the firm's sheet */
  lastMark: string | null
  omittedMarks: string | null
}

const ink: [number, number, number] = [26, 26, 24]
const muted: [number, number, number] = [107, 101, 96]
const danger: [number, number, number] = [155, 61, 61]
const rule: [number, number, number] = [70, 70, 68]

/**
 * The bar bending schedule in the firm's own sheet layout.
 *
 * Laid out to match the sheet the office already uses, deliberately and almost
 * exactly: S/No · Bar Mark · No of bars · No of members · Shape · Length ·
 * Total Length, then ONE COLUMN PER DIAMETER carrying the weight, and the three
 * summary rows underneath — TOTAL (kg), TOTAL (tonnes), and the number of 12 m
 * pieces required. Plus a Member column, which their sheet does not have and
 * which was asked for: a bar mark on its own does not say which beam it is in.
 *
 * The 046 rule applies — take the client's own form, do not improve it. An app
 * that quietly re-designs a sheet the office has read for years leaves the
 * paper copy and the screen saying different things, and the office trusts the
 * paper.
 *
 * Every figure is read from what Postgres computed, including the per-diameter
 * weights, the tonnage and the piece counts. The unit weight in each column
 * heading is the SAME rounded number the weights were computed from (migration
 * 053), so a checker adding a column up by hand gets the printed total.
 */
function buildBbsDoc(opts: BbsPdfOpts): jsPDF {
  const {
    members,
    bars,
    steel,
    projectName,
    siteAddress,
    constantsNote,
    lastMark,
    omittedMarks,
  } = opts

  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 28
  let y = M

  const memberById = new Map(members.map((m) => [m.member_id, m]))
  // Diameters actually used, in size order — the sheet only carries the columns
  // the job needs, so a job with no Ø25 does not print an empty Ø25 column.
  const dias = [...steel].sort((a, b) => a.dia_mm - b.dia_mm)

  // ---- Column geometry ----
  const fixed = { sno: 26, mark: 40, nbars: 34, nmem: 40, shape: 150, len: 40, tlen: 46 }
  const fixedW =
    fixed.sno + fixed.mark + 52 + fixed.nbars + fixed.nmem + fixed.shape +
    fixed.len + fixed.tlen
  const diaW = Math.max(46, (W - 2 * M - fixedW) / Math.max(dias.length, 1))

  const x = {
    sno: M,
    member: M + fixed.sno,
    mark: M + fixed.sno + 52,
    nbars: M + fixed.sno + 52 + fixed.mark,
    nmem: M + fixed.sno + 52 + fixed.mark + fixed.nbars,
    shape: M + fixed.sno + 52 + fixed.mark + fixed.nbars + fixed.nmem,
    len: M + fixed.sno + 52 + fixed.mark + fixed.nbars + fixed.nmem + fixed.shape,
    tlen:
      M + fixed.sno + 52 + fixed.mark + fixed.nbars + fixed.nmem + fixed.shape +
      fixed.len,
    diaStart:
      M + fixed.sno + 52 + fixed.mark + fixed.nbars + fixed.nmem + fixed.shape +
      fixed.len + fixed.tlen,
  }
  const right = W - M
  const diaX = (i: number) => x.diaStart + diaW * i

  function vline(xx: number, y1: number, y2: number) {
    doc.setDrawColor(...rule)
    doc.setLineWidth(0.5)
    doc.line(xx, y1, xx, y2)
  }
  function hline(yy: number, x1 = M, x2 = right) {
    doc.setDrawColor(...rule)
    doc.setLineWidth(0.5)
    doc.line(x1, yy, x2, yy)
  }

  // ------------------------------------------------------------------
  // Title + the two boxes
  // ------------------------------------------------------------------
  function titleBlock() {
    doc.setTextColor(...ink)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(18)
    doc.text('Details of bar bending schedule', W / 2, y + 4, { align: 'center' })
    y += 18
    doc.setFontSize(8)
    doc.setTextColor(...muted)
    doc.text(
      `${COMPANY.name}  ·  ${projectName}${siteAddress ? '  ·  ' + siteAddress : ''}`,
      W / 2,
      y,
      { align: 'center' },
    )
    doc.text(fmtDate(new Date()), right, y, { align: 'right' })
    y += 12
  }

  function headBox() {
    const top = y
    const bandH = 30
    hline(top)
    // Left half: the two bar-mark boxes from the firm's sheet.
    doc.setFontSize(8.5)
    doc.setTextColor(...ink)
    doc.setFont('helvetica', 'bold')
    doc.text('LAST BAR MARK:', M + 6, top + 19)
    doc.setFont('helvetica', 'bolditalic')
    doc.text(lastMark ?? '—', M + 92, top + 19)
    doc.setFont('helvetica', 'bold')
    doc.text('OMMITTED BAR MARK:', M + 150, top + 19)
    doc.setFont('helvetica', 'bolditalic')
    doc.text(omittedMarks ?? '—', M + 265, top + 19)

    // Right half spans the diameter columns.
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    const mid = (x.diaStart + right) / 2
    doc.text('STEEL QUANTITY (kg) FOR VARIOUS', mid, top + 12, { align: 'center' })
    doc.text('SIZES OF STEEL BARS', mid, top + 22, { align: 'center' })

    y = top + bandH
    hline(y)
    vline(M, top, y)
    vline(x.diaStart, top, y)
    vline(right, top, y)
  }

  function columnHeads() {
    const top = y
    const h = 26
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...ink)

    doc.text('S/No', x.sno + 3, top + 11)
    doc.text('Member', x.member + 3, top + 11)
    doc.text('Bar', x.mark + 3, top + 10)
    doc.text('Mark', x.mark + 3, top + 19)
    doc.text('No of', x.nbars + 3, top + 10)
    doc.text('bars', x.nbars + 3, top + 19)
    doc.text('No of', x.nmem + 3, top + 10)
    doc.text('members', x.nmem + 3, top + 19)
    doc.text('Shape', x.shape + fixed.shape / 2, top + 11, { align: 'center' })
    doc.text('Length', x.len + 3, top + 10)
    doc.text('(m)', x.len + 3, top + 19)
    doc.text('Total', x.tlen + 3, top + 10)
    doc.text('Length (m)', x.tlen + 3, top + 19)

    // Each diameter column carries the unit weight it was computed with.
    dias.forEach((s, i) => {
      const cx = diaX(i) + diaW / 2
      doc.setFont('helvetica', 'bold')
      doc.text(`φ${s.dia_mm}`, cx, top + 10, { align: 'center' })
      doc.setFont('helvetica', 'normal')
      doc.text(s.unit_weight_kg_m.toFixed(3), cx, top + 19, { align: 'center' })
    })

    y = top + h
    hline(y)
    for (const xx of [M, x.member, x.mark, x.nbars, x.nmem, x.shape, x.len, x.tlen, x.diaStart, right])
      vline(xx, top, y)
    dias.forEach((_, i) => {
      if (i > 0) vline(diaX(i), top, y)
    })
  }

  // ------------------------------------------------------------------
  // Shape schematics — the column the firm's sheet actually draws
  // ------------------------------------------------------------------
  /**
   * A small line drawing of the bar with its leg dimensions, the way the sheet
   * does it. Not to scale: it is a schematic, and a schematic drawn to scale
   * would make a 4950 mm bar and its 150 mm hooks unreadable side by side.
   */
  function drawShape(b: BbsBar, cx: number, cy: number, w: number) {
    doc.setDrawColor(...ink)
    doc.setLineWidth(0.9)
    doc.setFontSize(5.5)
    doc.setTextColor(...ink)
    const h = 13
    const legW = 9

    const label = (t: string, lx: number, ly: number, align: 'center' | 'right' = 'center') =>
      doc.text(t, lx, ly, { align, angle: 0 })

    switch (b.shape_code) {
      case 'STIRR-R': {
        const bw = Math.min(w - 24, 38)
        const bh = 15
        doc.rect(cx - bw / 2, cy - bh / 2, bw, bh)
        label(String(Math.round(b.a_mm)), cx, cy - bh / 2 - 2.5)
        doc.text(String(Math.round(b.b_mm)), cx - bw / 2 - 3, cy + 1.5, {
          align: 'right',
        })
        break
      }
      case 'STIRR-C': {
        doc.circle(cx, cy, 8)
        label(String(Math.round(b.a_mm)), cx, cy + 15)
        break
      }
      case 'SPIRAL': {
        for (let i = 0; i < 5; i++) {
          doc.ellipse(cx - 16 + i * 8, cy, 5, 3)
        }
        label(`${Math.round(b.a_mm)} dia @ ${Math.round(b.b_mm)}`, cx, cy + 11)
        break
      }
      case 'LBEND': {
        const run = Math.min(w - 30, 44)
        doc.line(cx - run / 2, cy + h / 2, cx + run / 2, cy + h / 2)
        doc.line(cx + run / 2, cy + h / 2, cx + run / 2, cy - h / 2)
        label(String(Math.round(b.a_mm)), cx, cy + h / 2 + 6)
        doc.text(String(Math.round(b.b_mm)), cx + run / 2 + 2, cy, { align: 'left' })
        break
      }
      case 'UBEND':
      case 'HOOK': {
        const run = Math.min(w - 34, 46)
        // Two turned-down legs and a base — the "150 ⌐____⌐ 150" on the sheet.
        doc.line(cx - run / 2, cy + h / 2, cx + run / 2, cy + h / 2)
        doc.line(cx - run / 2, cy + h / 2, cx - run / 2, cy - h / 2 + 2)
        doc.line(cx + run / 2, cy + h / 2, cx + run / 2, cy - h / 2 + 2)
        label(String(Math.round(b.shape_code === 'UBEND' ? b.b_mm : b.a_mm)), cx, cy + h / 2 + 6)
        if (b.shape_code === 'UBEND') {
          doc.text(String(Math.round(b.a_mm)), cx - run / 2 - 2, cy, { align: 'right' })
          doc.text(String(Math.round(b.c_mm)), cx + run / 2 + 2, cy, { align: 'left' })
        }
        break
      }
      case 'CRANK': {
        const run = Math.min(w - 30, 50)
        const x0 = cx - run / 2
        const x1 = cx + run / 2
        doc.line(x0, cy + 4, x0 + legW, cy + 4)
        doc.line(x0 + legW, cy + 4, x0 + legW + 6, cy - 4)
        doc.line(x0 + legW + 6, cy - 4, x1 - legW - 6, cy - 4)
        doc.line(x1 - legW - 6, cy - 4, x1 - legW, cy + 4)
        doc.line(x1 - legW, cy + 4, x1, cy + 4)
        label(String(Math.round(b.a_mm)), cx, cy + 12)
        break
      }
      default: {
        const run = Math.min(w - 24, 50)
        doc.line(cx - run / 2, cy, cx + run / 2, cy)
        label(String(Math.round(b.a_mm)), cx, cy + 7)
      }
    }
  }

  // ------------------------------------------------------------------
  // Rows
  // ------------------------------------------------------------------
  titleBlock()
  headBox()
  columnHeads()

  const rowH = 30
  let sno = 0

  // Sheet order: as scheduled, member by member.
  const ordered = [...bars].sort((a, b) => {
    const ma = memberById.get(a.member_id)
    const mb = memberById.get(b.member_id)
    const byMark = (ma?.mark ?? '').localeCompare(mb?.mark ?? '')
    return byMark !== 0 ? byMark : a.sort_order - b.sort_order
  })

  for (const b of ordered) {
    if (y + rowH > H - 96) {
      doc.addPage()
      y = M
      titleBlock()
      headBox()
      columnHeads()
    }

    const top = y
    sno += 1
    const mem = memberById.get(b.member_id)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...ink)
    doc.text(String(sno), x.sno + 3, top + rowH / 2 + 2)
    doc.text(mem?.mark ?? '—', x.member + 3, top + rowH / 2 + 2)
    doc.text(b.bar_mark, x.mark + 3, top + rowH / 2 + 2)
    doc.text(String(b.qty_per_member), x.nbars + 3, top + rowH / 2 + 2)
    doc.text(String(mem?.member_count ?? 1), x.nmem + 3, top + rowH / 2 + 2)

    drawShape(b, x.shape + fixed.shape / 2, top + rowH / 2, fixed.shape)

    doc.setFontSize(7.5)
    doc.setTextColor(...ink)
    doc.text(b.cutting_length_m.toFixed(3), x.len + fixed.len - 3, top + rowH / 2 + 2, {
      align: 'right',
    })
    doc.text(b.total_length_m.toFixed(3), x.tlen + fixed.tlen - 3, top + rowH / 2 + 2, {
      align: 'right',
    })

    // The weight lands in this bar's own diameter column and nowhere else —
    // that is the whole point of the matrix.
    dias.forEach((s, i) => {
      if (s.dia_mm !== b.dia_mm) return
      doc.text(n2(b.total_weight_kg), diaX(i) + diaW - 4, top + rowH / 2 + 2, {
        align: 'right',
      })
    })

    if (b.warning) {
      doc.setTextColor(...danger)
      doc.setFontSize(5.5)
      doc.text('CHECK DIMENSIONS', x.shape + 3, top + rowH - 3)
      doc.setTextColor(...ink)
    }

    y = top + rowH
    hline(y)
    for (const xx of [M, x.member, x.mark, x.nbars, x.nmem, x.shape, x.len, x.tlen, x.diaStart, right])
      vline(xx, top, y)
    dias.forEach((_, i) => {
      if (i > 0) vline(diaX(i), top, y)
    })
  }

  // ------------------------------------------------------------------
  // The three summary rows
  // ------------------------------------------------------------------
  if (y + 66 > H - 60) {
    doc.addPage()
    y = M
    titleBlock()
    columnHeads()
  }

  const summary: [string, (s: BbsSteelByDia) => string][] = [
    ['TOTAL (kg)', (s) => n2(s.total_weight_kg)],
    ['TOTAL (tonnes)', (s) => s.total_tonnes.toFixed(5)],
    ['No of pieces required (per 12m length)', (s) => `${s.pieces_required} pcs`],
  ]

  for (const [label, get] of summary) {
    const top = y
    const h = 20
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.setTextColor(...ink)
    doc.text(label, x.diaStart - 6, top + 13, { align: 'right' })

    doc.setFont('helvetica', 'normal')
    dias.forEach((s, i) => {
      doc.text(get(s), diaX(i) + diaW - 4, top + 13, { align: 'right' })
    })

    y = top + h
    hline(y)
    vline(M, top, y)
    vline(x.diaStart, top, y)
    vline(right, top, y)
    dias.forEach((_, i) => {
      if (i > 0) vline(diaX(i), top, y)
    })
  }

  // Grand total — not on the firm's sheet, but the figure everyone asks for
  // next, and it is the sum of a row that is already printed.
  const grand = steel.reduce((a, s) => a + s.total_weight_kg, 0)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...ink)
  doc.text(
    `GRAND TOTAL  ${n2(grand)} kg  =  ${(grand / 1000).toFixed(3)} tonnes`,
    right,
    y + 15,
    { align: 'right' },
  )
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  doc.setTextColor(...muted)
  doc.text('Excludes wastage and lap lengths.', M, y + 15)

  // ---- Footer: the constants this was cut to, on every page ----
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6)
    doc.setTextColor(...muted)
    doc.text(constantsNote, M, H - 20)
    doc.text(`Page ${p} of ${pages}`, right, H - 20, { align: 'right' })
    doc.text(
      'Cutting lengths computed to IS 2502. Piece count is a straight ceiling of total length, not a cutting optimisation. Check against the structural drawing before cutting.',
      M,
      H - 12,
    )
  }

  return doc
}

export function generateBbsPdf(opts: BbsPdfOpts): void {
  buildBbsDoc(opts).save(`BBS-${opts.projectName.replace(/[^\w-]+/g, '_')}.pdf`)
}

export function generateBbsFile(opts: BbsPdfOpts): File {
  const blob = buildBbsDoc(opts).output('blob')
  return new File([blob], `BBS-${opts.projectName.replace(/[^\w-]+/g, '_')}.pdf`, {
    type: 'application/pdf',
  })
}
