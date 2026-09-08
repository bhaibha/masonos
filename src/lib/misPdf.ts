import { jsPDF } from 'jspdf'
import { drawLetterhead, drawPageFooters } from '@/lib/pdf/letterhead'
import type {
  MisCategory,
  MisCompany,
  MisException,
  MisProject,
} from '@/lib/types'

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

/** Lakh/crore, because that is how the figures are spoken about in the room. */
function short(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)} L`
  return inr.format(v)
}

function fmtDate(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(`${d}T00:00:00Z`) : d
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: typeof d === 'string' ? 'UTC' : 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(dt)
}

export interface MisPdfOpts {
  company: MisCompany
  projects: MisProject[]
  exceptions: MisException[]
  categories: MisCategory[]
  periodFrom: string
  periodTo: string
}

const ink: [number, number, number] = [26, 26, 24]
const muted: [number, number, number] = [107, 101, 96]
const brass: [number, number, number] = [166, 124, 82]
const danger: [number, number, number] = [155, 61, 61]
const positive: [number, number, number] = [47, 111, 79]
const warn: [number, number, number] = [184, 134, 59]

/**
 * The board report.
 *
 * Portrait, because it is read in a room and passed across a table, not scrolled
 * on a phone. Landscape is for schedules and comparative statements where the
 * document genuinely widens with the data; this one does not.
 *
 * Every figure is read from what Postgres computed and passed in. Nothing is
 * summed while drawing — including the totals row of the project table, which
 * comes from fn_mis_company rather than from adding the rows above it, so the
 * headline and the table cannot disagree.
 *
 * It prints what the caller could see. A PM exporting this gets their own
 * projects and no overhead figure, which is the same thing they see on screen.
 */
function buildMisDoc(opts: MisPdfOpts): jsPDF {
  const { company, projects, exceptions, categories, periodFrom, periodTo } =
    opts

  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 44
  let y = M

  function pageBreak(needed = 60) {
    if (y > H - needed) {
      doc.addPage()
      y = M
    }
  }

  function rule(colour = brass, weight = 1) {
    doc.setDrawColor(...colour)
    doc.setLineWidth(weight)
    doc.line(M, y, W - M, y)
  }

  function heading(text: string) {
    pageBreak(80)
    y += 8
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(...ink)
    doc.text(text.toUpperCase(), M, y)
    y += 6
    rule([237, 233, 227], 0.8)
    y += 16
  }

  y = drawLetterhead(doc, { margin: M, scale: 'compact' })

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.setTextColor(...ink)
  doc.text('MANAGEMENT INFORMATION REPORT', M, y)
  y += 15
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(
    `Prepared ${fmtDate(new Date())}  ·  overheads for ${fmtDate(periodFrom)} to ${fmtDate(periodTo)}`,
    M,
    y,
  )
  y += 24

  // ---- KPI band ----
  // Four across, then three. Serif-weight figures are not available in jsPDF's
  // core fonts, so size and weight carry the emphasis instead.
  const kpis: [string, string, [number, number, number]?][] = [
    ['Active projects', `${company.active_count} of ${company.project_count}`],
    ['Contract value', short(company.contract_value)],
    ['Cost to date', short(company.total_cost)],
    [
      'Gross margin',
      `${short(company.gross_margin)}${
        company.blended_margin_pct !== null
          ? `  (${company.blended_margin_pct}%)`
          : ''
      }`,
      company.gross_margin < 0 ? danger : positive,
    ],
  ]

  const colW = (W - 2 * M) / 4
  kpis.forEach(([label, value, colour], i) => {
    const x = M + colW * i
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...muted)
    doc.text(label.toUpperCase(), x, y)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(...(colour ?? ink))
    doc.text(value, x, y + 16)
  })
  y += 34

  // Second row: the figures that need a sentence beside them.
  const row2: [string, string][] = [
    [
      'Net position',
      company.sees_overheads && company.net_position !== null
        ? short(company.net_position)
        : 'restricted',
    ],
    [
      'Overheads',
      company.sees_overheads && company.overheads !== null
        ? short(company.overheads)
        : 'restricted',
    ],
    ['Retention held', short(company.retention_held)],
    ['Open commitments', short(company.committed_open)],
  ]
  row2.forEach(([label, value], i) => {
    const x = M + colW * i
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...muted)
    doc.text(label.toUpperCase(), x, y)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(...ink)
    doc.text(value, x, y + 14)
  })
  y += 30

  // The honest caveat, printed rather than assumed known.
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(...muted)
  doc.text(
    company.sees_overheads
      ? 'Net position = project margin LIFETIME TO DATE less overheads for the period above. It is not a cash figure — no bank balance or receipts are tracked.'
      : 'Overheads and net position are restricted to founder and accounts.',
    M,
    y,
    { maxWidth: W - 2 * M },
  )
  y += 18

  // ---- Project comparison ----
  heading('Project performance')

  const cols = {
    name: M,
    revenue: M + 150,
    cost: M + 225,
    margin: M + 300,
    pct: M + 360,
    spi: M + 410,
    cpi: M + 450,
    health: W - M,
  }

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(...muted)
  doc.text('PROJECT', cols.name, y)
  doc.text('REVENUE', cols.revenue, y, { align: 'right' })
  doc.text('COST', cols.cost, y, { align: 'right' })
  doc.text('MARGIN', cols.margin, y, { align: 'right' })
  doc.text('%', cols.pct, y, { align: 'right' })
  doc.text('SPI', cols.spi, y, { align: 'right' })
  doc.text('CPI', cols.cpi, y, { align: 'right' })
  doc.text('STATUS', cols.health, y, { align: 'right' })
  y += 6
  rule([237, 233, 227], 0.5)
  y += 12

  doc.setFontSize(9)
  for (const p of projects) {
    pageBreak(50)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...ink)
    doc.text(p.project_name.slice(0, 26), cols.name, y)
    doc.text(short(p.revenue), cols.revenue, y, { align: 'right' })
    doc.text(short(p.total_cost), cols.cost, y, { align: 'right' })
    doc.setTextColor(...(p.gross_margin < 0 ? danger : ink))
    doc.text(short(p.gross_margin), cols.margin, y, { align: 'right' })
    doc.text(
      p.margin_pct === null ? '—' : String(p.margin_pct),
      cols.pct,
      y,
      { align: 'right' },
    )
    doc.setTextColor(...muted)
    doc.text(p.spi === null ? '—' : p.spi.toFixed(2), cols.spi, y, {
      align: 'right',
    })
    doc.text(p.cpi === null ? '—' : p.cpi.toFixed(2), cols.cpi, y, {
      align: 'right',
    })
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(
      ...(p.health === 'critical' ? danger : p.health === 'watch' ? warn : positive),
    )
    doc.text(
      p.health === 'critical' ? 'ATTENTION' : p.health === 'watch' ? 'WATCH' : 'OK',
      cols.health,
      y,
      { align: 'right' },
    )
    y += 15
    doc.setDrawColor(243, 240, 235)
    doc.setLineWidth(0.4)
    doc.line(M, y - 5, W - M, y - 5)
  }

  // Totals from the KPI call, NOT from adding the rows above — so the two can
  // never disagree in front of a board.
  y += 4
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...ink)
  doc.text('TOTAL', cols.name, y)
  doc.text(short(company.contract_value), cols.revenue, y, { align: 'right' })
  doc.text(short(company.total_cost), cols.cost, y, { align: 'right' })
  doc.text(short(company.gross_margin), cols.margin, y, { align: 'right' })
  doc.text(
    company.blended_margin_pct === null
      ? '—'
      : String(company.blended_margin_pct),
    cols.pct,
    y,
    { align: 'right' },
  )
  y += 18

  // ---- Exceptions ----
  heading('Needs attention')

  if (exceptions.length === 0) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...positive)
    doc.text('Nothing outstanding.', M, y)
    y += 18
  } else {
    doc.setFontSize(8.5)
    for (const e of exceptions) {
      pageBreak(50)
      const c = e.severity === 'critical' ? danger : warn
      doc.setFillColor(...c)
      doc.circle(M + 2.5, y - 3, 2.2, 'F')

      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...ink)
      doc.text(
        `${e.project_name ? e.project_name + ' — ' : ''}${e.title}`,
        M + 11,
        y,
      )
      y += 11
      if (e.detail) {
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7.5)
        doc.setTextColor(...muted)
        for (const l of doc.splitTextToSize(e.detail, W - 2 * M - 12).slice(0, 2)) {
          doc.text(l as string, M + 11, y)
          y += 9.5
        }
        doc.setFontSize(8.5)
      }
      y += 5
    }
  }

  // ---- Cost breakdown ----
  if (categories.length > 0) {
    heading('Cost by category')
    doc.setFontSize(9)
    for (const c of categories.slice(0, 12)) {
      pageBreak(40)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(...ink)
      doc.text(c.category_name, M, y)
      doc.setTextColor(...muted)
      doc.text(
        c.pct_of_total === null ? '' : `${c.pct_of_total}%`,
        W - M - 90,
        y,
        { align: 'right' },
      )
      doc.setTextColor(...ink)
      doc.text(short(c.amount), W - M, y, { align: 'right' })
      y += 14
    }
  }

  // ---- Footer ----
  drawPageFooters(doc, {
    margin: M,
    bottom: 24,
    onlyIfMultiPage: false,
    note: 'Internal management report. Figures are computed from the live database and cover only the projects the preparer may see.',
  })

  return doc
}

export function generateMisPdf(opts: MisPdfOpts): void {
  buildMisDoc(opts).save(`MIS-report-${opts.periodTo}.pdf`)
}

export function generateMisFile(opts: MisPdfOpts): File {
  const blob = buildMisDoc(opts).output('blob')
  return new File([blob], `MIS-report-${opts.periodTo}.pdf`, {
    type: 'application/pdf',
  })
}
