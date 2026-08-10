/**
 * Small CSV helpers shared by the export screens.
 *
 * Two things here are not optional, and both come from Excel rather than from
 * the CSV spec:
 *
 * 1. The UTF-8 BOM. Without it Excel opens the file in the system codepage and
 *    turns ₹ into Ã¢â€šÂ¹ and any accented name into noise.
 * 2. CRLF line endings, which older Excel builds on Windows still expect.
 *
 * Quoting follows RFC 4180: wrap whenever the value contains a comma, quote or
 * newline, and double any embedded quote. A site note containing a comma is
 * otherwise enough to shift every column after it.
 */

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** One header row plus its rows, with no BOM. Use for a section of a file. */
export function csvBlock(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((r) => r.map(csvCell).join(',')),
  ]
  return lines.join('\r\n')
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return `﻿${csvBlock(headers, rows)}`
}

/**
 * Several tables in one file, separated by a blank line.
 *
 * The BOM belongs at the very start of the FILE, not at the start of each
 * block — a stray one mid-file shows up as a visible junk character in the
 * first cell of that section, which is exactly the sort of thing a CA notices
 * and nobody can explain.
 */
export function toCsvSections(
  sections: { headers: string[]; rows: unknown[][] }[],
): string {
  return `﻿${sections
    .map((s) => csvBlock(s.headers, s.rows))
    .join('\r\n\r\n')}`
}

/** Triggers a download. `name` should not include the extension. */
export function downloadCsv(name: string, csv: string): void {
  const safe = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = `${safe || 'export'}.csv`
  a.click()

  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
