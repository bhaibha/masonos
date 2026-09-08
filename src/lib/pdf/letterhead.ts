import type { jsPDF } from 'jspdf'
import { COMPANY } from '@/lib/company'
import { LOGO_ASPECT, LOGO_PNG_DATA_URL } from '@/lib/pdf/logoAsset'

/**
 * THE ONE LETTERHEAD.
 *
 * Ten generators used to carry their own copy of this block — same colours,
 * same brass rule, six slightly different sets of y-increments, and three
 * different opinions about whether the tagline was optional. Changing the
 * company's phone number meant editing ten files and hoping. This is the single
 * definition; a generator now calls `drawLetterhead` and is told where its
 * content starts.
 *
 * Layout: the mark top-left, the company name and tagline beside it, the
 * postal/registration block right-aligned against the opposite margin, and a
 * thin brass rule under the lot. That is a standard letterhead and it is also
 * ~20pt shorter than the stacked version it replaces, which gives every
 * document back a couple of lines of body space.
 *
 * Colours are the app's own tokens, so a printed purchase order and the screen
 * it was raised on are the same document.
 */
export const PDF_INK: [number, number, number] = [26, 26, 24]
export const PDF_MUTED: [number, number, number] = [107, 101, 96]
export const PDF_BRASS: [number, number, number] = [166, 124, 82]
export const PDF_HAIRLINE: [number, number, number] = [237, 233, 227]

export interface LetterheadOpts {
  /** The caller's page margin in points. Portrait pages use 48, the landscape
   *  sheets 40–44. */
  margin?: number
  /**
   * 'standard' — A4 portrait: PO, invoice, VO, SI, RFI, RA bill, NCR.
   * 'compact'  — landscape and dense multi-page reports, where 20pt of header
   *              is 20pt of table. Same layout, smaller type.
   */
  scale?: 'standard' | 'compact'
}

interface Metrics {
  logoH: number
  nameSize: number
  taglineSize: number
  contactSize: number
  lead: number
  gap: number
  ruleGap: number
  contentGap: number
}

const METRICS: Record<'standard' | 'compact', Metrics> = {
  standard: {
    logoH: 46,
    nameSize: 19,
    taglineSize: 8.5,
    contactSize: 8,
    lead: 10,
    gap: 14,
    ruleGap: 12,
    contentGap: 26,
  },
  compact: {
    logoH: 36,
    nameSize: 16,
    taglineSize: 7.5,
    contactSize: 7,
    lead: 8.5,
    gap: 11,
    ruleGap: 10,
    contentGap: 22,
  },
}

/**
 * Draws the mark alone at an arbitrary position — for the BBS sheet, which is
 * the firm's own printed form and gets a small mark rather than our letterhead.
 *
 * Returns the width drawn, or 0 if the image could not be embedded.
 *
 * **`compression: 'FAST'` is not optional.** See the note in logoAsset.ts:
 * without it jsPDF writes the bitmap uncompressed and every document grows by
 * 347 KB instead of 48 KB.
 */
export function drawLogoMark(
  doc: jsPDF,
  x: number,
  y: number,
  height: number,
): number {
  const w = height * LOGO_ASPECT
  try {
    doc.addImage(
      LOGO_PNG_DATA_URL,
      'PNG',
      x,
      y,
      w,
      height,
      // A fixed alias, so a mark repeated on forty pages of a bar bending
      // schedule is embedded once rather than forty times.
      'ym-mark',
      'FAST',
    )
    return w
  } catch {
    // A document that refuses to generate because of its logo is a far worse
    // failure than one that prints without it — the firm can still send the
    // purchase order. Deliberately silent: there is no user action to suggest,
    // and a toast here would fire on a document that came out fine.
    return 0
  }
}

/**
 * Draws the letterhead at the top of the CURRENT page and returns the y at
 * which the caller's content should begin.
 *
 * The caller keeps its own `let y` — this returns a number rather than mutating
 * anything, so a generator can still lay out its own header afterwards.
 */
export function drawLetterhead(doc: jsPDF, opts: LetterheadOpts = {}): number {
  const { margin: M = 48, scale = 'standard' } = opts
  const m = METRICS[scale]
  const W = doc.internal.pageSize.getWidth()
  const top = M

  // ---------- the mark ----------
  const logoW = drawLogoMark(doc, M, top, m.logoH)
  // If the image failed, the text block slides left into the space rather than
  // leaving a hole where the logo should have been.
  const textX = logoW > 0 ? M + logoW + m.gap : M

  // ---------- name + tagline, optically centred on the mark ----------
  const midY = top + m.logoH / 2
  const hasTagline = Boolean(COMPANY.tagline)
  // Cap height is roughly 0.72em; centring the PAIR means the name sits above
  // the mark's centre line and the tagline below it.
  const pairH = m.nameSize * 0.72 + (hasTagline ? m.lead + m.taglineSize * 0.72 : 0)
  let ty = midY - pairH / 2 + m.nameSize * 0.72

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(m.nameSize)
  doc.setTextColor(...PDF_INK)
  doc.text(COMPANY.name, textX, ty)

  if (hasTagline) {
    ty += m.lead + m.taglineSize * 0.72
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(m.taglineSize)
    doc.setTextColor(...PDF_MUTED)
    doc.text(COMPANY.tagline, textX, ty)
  }

  // ---------- address / registration, right-aligned ----------
  // Built from the array rather than hard-coded lines, so adding a second
  // office to COMPANY.addressLines re-centres the block instead of overlapping
  // the rule.
  const contact = [
    ...COMPANY.addressLines,
    `GSTIN ${COMPANY.gstin}`,
    `${COMPANY.phone}  ·  ${COMPANY.email}`,
  ]
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(m.contactSize)
  doc.setTextColor(...PDF_MUTED)
  const blockH = (contact.length - 1) * m.lead
  let cy = midY - blockH / 2 + m.contactSize * 0.36
  for (const line of contact) {
    doc.text(line, W - M, cy, { align: 'right' })
    cy += m.lead
  }

  // ---------- the rule ----------
  const ruleY = top + m.logoH + m.ruleGap
  doc.setDrawColor(...PDF_BRASS)
  doc.setLineWidth(1.2)
  doc.line(M, ruleY, W - M, ruleY)

  // Left in a known state: every generator that followed the old block assumed
  // it inherited charcoal ink at whatever size it set next, and one of them
  // relied on it.
  doc.setTextColor(...PDF_INK)
  doc.setFont('helvetica', 'normal')

  return ruleY + m.contentGap
}

export interface FooterOpts {
  margin?: number
  /**
   * A line (or two) of context specific to the document — the BBS sheet prints
   * the constants it was cut to, the MIS report prints that it is scoped to the
   * preparer. Printed left, above the page number.
   */
  note?: string | string[]
  /**
   * Default true. "Page 1 of 1" on a one-page invoice is noise, and the firm's
   * invoices are almost always one page.
   */
  onlyIfMultiPage?: boolean
  /** Distance from the bottom edge to the LAST line. */
  bottom?: number
}

/**
 * Stamps the footer on every page, after the body has been laid out.
 *
 * Must be called LAST: the page count is not known until the content has been
 * written, and this walks the finished pages with `setPage`. It restores the
 * page pointer to the last page afterwards, so a caller that keeps drawing is
 * not silently writing onto page 1.
 */
export function drawPageFooters(doc: jsPDF, opts: FooterOpts = {}): void {
  const {
    margin: M = 48,
    note,
    onlyIfMultiPage = true,
    bottom = 22,
  } = opts

  const pages = doc.getNumberOfPages()
  const notes = note === undefined ? [] : Array.isArray(note) ? note : [note]
  if (pages < 2 && onlyIfMultiPage && notes.length === 0) return

  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const showPage = pages > 1 || !onlyIfMultiPage

  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(...PDF_MUTED)

    // Notes stack UPWARDS from the baseline so the page number always sits on
    // the same line whether there are zero notes or two.
    notes.forEach((line, i) => {
      doc.text(line, M, H - bottom - (notes.length - 1 - i) * 9)
    })

    if (showPage) {
      doc.text(
        `${COMPANY.name}  ·  Page ${p} of ${pages}`,
        W - M,
        H - bottom,
        { align: 'right' },
      )
    }
  }

  doc.setPage(pages)
}
