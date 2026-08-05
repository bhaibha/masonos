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

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((r) => r.map(csvCell).join(',')),
  ]
  return `﻿${lines.join('\r\n')}`
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
