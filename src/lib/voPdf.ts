import { jsPDF } from 'jspdf'
import { COMPANY } from '@/lib/company'
import { drawLetterhead } from '@/lib/pdf/letterhead'
import type { ProjectContract, VariationOrder } from '@/lib/types'

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

export interface VoPdfOpts {
  vo: VariationOrder
  projectName: string
  siteAddress: string | null
  clientName: string | null
  /** contract before this VO and the running revised total */
  contract: ProjectContract | null
}

function buildVoDoc(opts: VoPdfOpts): jsPDF {
  const { vo, projectName, siteAddress, clientName, contract } = opts
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const M = 48
  const ink: [number, number, number] = [26, 26, 24]
  const muted: [number, number, number] = [107, 101, 96]
  let y = drawLetterhead(doc, { margin: M })

  // Title
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('VARIATION ORDER', M, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(vo.vo_number, W - M, y, { align: 'right' })
  y += 16
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text(`Date: ${fmtDate(vo.created_at)}`, W - M, y, { align: 'right' })
  y += 20

  // Project / client
  doc.setFontSize(8)
  doc.text('PROJECT', M, y)
  y += 13
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
      y += 12
    }
  }
  y += 10

  // Variation detail
  doc.setTextColor(...ink)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text(vo.title, M, y)
  y += 16
  if (vo.description) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9.5)
    doc.setTextColor(...muted)
    for (const l of doc.splitTextToSize(vo.description, W - 2 * M)) {
      doc.text(l as string, M, y)
      y += 13
    }
  }
  y += 14

  // Cost impact + revised contract
  doc.setDrawColor(237, 233, 227)
  doc.setLineWidth(0.5)
  doc.line(M, y, W - M, y)
  y += 20

  const rows: [string, string, boolean][] = []
  if (contract) {
    rows.push(['Contract value (before)', rupee(contract.contract_value), false])
  }
  rows.push(['Cost impact of this variation', rupee(vo.cost_impact), false])
  if (contract) {
    rows.push([
      'Revised contract value',
      rupee(contract.revised_contract_value),
      true,
    ])
  }

  const danger: [number, number, number] = [155, 61, 61]
  for (const [label, val, bold] of rows) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(bold ? 12 : 10)
    doc.setTextColor(...(bold ? ink : muted))
    doc.text(label, M, y)
    const valColor: [number, number, number] =
      vo.cost_impact < 0 && !bold ? danger : ink
    doc.setTextColor(...valColor)
    doc.text(val, W - M, y, { align: 'right' })
    y += bold ? 22 : 17
  }

  // Signatures
  const sy = doc.internal.pageSize.getHeight() - 100
  doc.setDrawColor(...muted)
  doc.setLineWidth(0.5)
  doc.line(M, sy, M + 170, sy)
  doc.line(W - M - 170, sy, W - M, sy)
  doc.setFontSize(9)
  doc.setTextColor(...muted)
  doc.text('Client acceptance', M, sy + 14)
  doc.text(`For ${COMPANY.name}`, W - M, sy + 14, { align: 'right' })
  doc.text('Authorised signatory', W - M, sy + 28, { align: 'right' })

  return doc
}

export function generateVoPdf(opts: VoPdfOpts): void {
  buildVoDoc(opts).save(`${opts.vo.vo_number}.pdf`)
}

export function generateVoFile(opts: VoPdfOpts): File {
  const blob = buildVoDoc(opts).output('blob')
  return new File([blob], `${opts.vo.vo_number}.pdf`, {
    type: 'application/pdf',
  })
}
