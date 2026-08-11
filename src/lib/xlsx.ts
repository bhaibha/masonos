import JSZip from 'jszip'

/**
 * A small, dependency-free .xlsx writer.
 *
 * An xlsx file is a zip of XML, and jszip is already in the project for the
 * handover archive — so this costs no new dependency, against roughly a
 * megabyte for SheetJS or ExcelJS. It writes exactly what these exports need
 * and nothing else: typed cells, column widths, a frozen bold header row and
 * an autofilter.
 *
 * Why xlsx rather than the CSV helpers next door: a CSV has no types. A
 * programme exported as CSV opens with dates as text (so they sort
 * alphabetically — 01-Apr before 02-Jan), percentages as bare numbers, and
 * rupee figures that Excel may or may not decide are numeric. For a 120-row
 * schedule somebody is going to filter and sort, that is the difference
 * between a working sheet and a wall of strings.
 *
 * Dates are written as Excel serials, not strings, for the same reason.
 */

export type CellType = 'text' | 'number' | 'int' | 'money' | 'date' | 'percent'

/**
 * Background fills, for drawing a Gantt out of cells.
 *
 * A bar made of filled cells beats an embedded picture: it prints, it survives
 * a column being widened, and someone can drag it. A PNG of the chart would be
 * a screenshot in a spreadsheet.
 */
export type XlsxFill =
  | 'bar'
  | 'barDone'
  | 'barCritical'
  | 'barCriticalDone'
  | 'today'

export type XlsxValue = string | number | null | undefined | boolean
export type XlsxCell = XlsxValue | { v: XlsxValue; fill: XlsxFill }

export interface XlsxColumn {
  header: string
  type: CellType
  /** approximate character width */
  width?: number
  /** fill applied to this column's HEADER cell only */
  headerFill?: XlsxFill
}

export interface XlsxSheet {
  name: string
  columns: XlsxColumn[]
  rows: XlsxCell[][]
  /** columns frozen on the left, in addition to the header row */
  freezeCols?: number
}

/* ---------------- style indices, matching styles.xml below ---------------- */
const S_DEFAULT = 0
const S_HEADER = 1
const S_DATE = 2
const S_MONEY = 3
const S_PERCENT = 4
const S_INT = 5
const S_BAR = 6
const S_BAR_DONE = 7
const S_BAR_CRIT = 8
const S_BAR_CRIT_DONE = 9
const S_TODAY = 10

const FILL_STYLE: Record<XlsxFill, number> = {
  bar: S_BAR,
  barDone: S_BAR_DONE,
  barCritical: S_BAR_CRIT,
  barCriticalDone: S_BAR_CRIT_DONE,
  today: S_TODAY,
}

function styleFor(t: CellType): number {
  switch (t) {
    case 'date':
      return S_DATE
    case 'money':
      return S_MONEY
    case 'percent':
      return S_PERCENT
    case 'int':
      return S_INT
    default:
      return S_DEFAULT
  }
}

/** XML text escaping. Site notes contain ampersands and angle brackets. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not legal in XML 1.0 and corrupt the whole file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

/**
 * Excel's day zero is 1899-12-30 — the sheet inherits a deliberate Lotus 1-2-3
 * bug that treats 1900 as a leap year, and 30 December is the offset that makes
 * every date after 1 March 1900 come out right.
 */
function excelSerial(iso: string): number | null {
  const t = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(t)) return null
  return Math.round(t / 86_400_000) + 25_569
}

/** 0 → A, 25 → Z, 26 → AA */
function colName(i: number): string {
  let s = ''
  let n = i
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  }
  return s
}

function cell(ref: string, raw: XlsxCell, type: CellType): string {
  const hasFill =
    raw !== null && typeof raw === 'object' && 'fill' in raw
  const value = hasFill ? raw.v : (raw as XlsxValue)
  const s = hasFill ? FILL_STYLE[raw.fill] : styleFor(type)

  // A filled cell with no value is the whole point of the Gantt — emit it.
  if (value === null || value === undefined || value === '') {
    return hasFill ? `<c r="${ref}" s="${s}"/>` : ''
  }

  if (type === 'date') {
    const serial = excelSerial(String(value))
    if (serial === null) return inlineStr(ref, String(value), S_DEFAULT)
    return `<c r="${ref}" s="${s}"><v>${serial}</v></c>`
  }

  if (type === 'number' || type === 'money' || type === 'percent' || type === 'int') {
    const n = Number(value)
    if (!Number.isFinite(n)) return inlineStr(ref, String(value), S_DEFAULT)
    return `<c r="${ref}" s="${s}"><v>${n}</v></c>`
  }

  return inlineStr(ref, String(value), s)
}

function inlineStr(ref: string, text: string, s: number): string {
  // xml:space="preserve" so a leading or trailing space survives the round trip.
  return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`
}

function sheetXml(sheet: XlsxSheet): string {
  const lastCol = colName(sheet.columns.length - 1)

  const cols = sheet.columns
    .map(
      (c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 14}" customWidth="1"/>`,
    )
    .join('')

  const header =
    `<row r="1">` +
    sheet.columns
      .map((c, i) =>
        inlineStr(
          `${colName(i)}1`,
          c.header,
          c.headerFill ? FILL_STYLE[c.headerFill] : S_HEADER,
        ),
      )
      .join('') +
    `</row>`

  const body = sheet.rows
    .map((row, r) => {
      const n = r + 2
      const cells = sheet.columns
        .map((c, i) => cell(`${colName(i)}${n}`, row[i], c.type))
        .join('')
      return `<row r="${n}">${cells}</row>`
    })
    .join('')

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    // Frozen header: 120 rows of schedule is unreadable if the titles scroll away.
    `<sheetViews><sheetView workbookViewId="0">` +
    // Freezing the label columns as well is what makes a 60-week Gantt
    // readable: scroll right and you still know which activity you're on.
    `<pane xSplit="${sheet.freezeCols ?? 0}" ySplit="1" ` +
    `topLeftCell="${colName(sheet.freezeCols ?? 0)}2" ` +
    `activePane="bottomRight" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${cols}</cols>` +
    `<sheetData>${header}${body}</sheetData>` +
    `<autoFilter ref="A1:${lastCol}1"/>` +
    `</worksheet>`
  )
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="3">` +
  `<numFmt numFmtId="164" formatCode="dd-mmm-yyyy"/>` +
  // Indian grouping: 12,34,567.00 rather than 1,234,567.00.
  `<numFmt numFmtId="165" formatCode="#,##,##0.00"/>` +
  `<numFmt numFmtId="166" formatCode="0.0&quot;%&quot;"/>` +
  `</numFmts>` +
  `<fonts count="2">` +
  `<font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
  `</fonts>` +
  `<fills count="8">` +
  `<fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill>` +
  // 2 header — the design system's warm border colour
  `<fill><patternFill patternType="solid"><fgColor rgb="FFEDE9E3"/><bgColor indexed="64"/></patternFill></fill>` +
  // 3 planned bar, 4 completed bar (brass), 5 critical planned, 6 critical
  // done (danger red), 7 the week containing today
  `<fill><patternFill patternType="solid"><fgColor rgb="FFE4DFD8"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFA67C52"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFEFD9D9"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF9B3D3D"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF2F6F4F"/><bgColor indexed="64"/></patternFill></fill>` +
  `</fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="11">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  // 6–10, the Gantt fills
  `<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="6" borderId="0" xfId="0" applyFill="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="7" borderId="0" xfId="0" applyFill="1"/>` +
  `</cellXfs>` +
  // Some readers (openpyxl among them) warn about a workbook with no named
  // style. Excel tolerates it; declaring Normal costs one line and silences it.
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`

/** Excel rejects a sheet name over 31 chars or containing : \ / ? * [ ] */
function safeSheetName(name: string, index: number): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim()
  return cleaned || `Sheet${index + 1}`
}

export async function buildXlsx(sheets: XlsxSheet[]): Promise<Blob> {
  // createFolders: false — no bare directory entries in the archive. Excel
  // does not mind them, but stricter OOXML readers do.
  const zip = new JSZip()
  const names = sheets.map((s, i) => safeSheetName(s.name, i))

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      `</Types>`,
    { createFolders: false },
  )

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
    { createFolders: false },
  )

  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>` +
      names
        .map(
          (n, i) =>
            `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
        )
        .join('') +
      `</sheets></workbook>`,
    { createFolders: false },
  )

  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
    { createFolders: false },
  )

  zip.file('xl/styles.xml', STYLES_XML, { createFolders: false })
  sheets.forEach((s, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s), {
      createFolders: false,
    })
  })

  return zip.generateAsync({
    type: 'blob',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
  })
}

/** Builds and downloads. `name` should not include the extension. */
export async function downloadXlsx(
  name: string,
  sheets: XlsxSheet[],
): Promise<void> {
  const blob = await buildXlsx(sheets)
  const safe = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = `${safe || 'export'}.xlsx`
  a.click()

  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
