/**
 * Pulling the text out of an uploaded document, in the browser.
 *
 * WHY HERE AND NOT IN AN EDGE FUNCTION
 * ------------------------------------
 * The file is already in the browser's hands at upload time, so parsing it
 * there costs one dynamic import and no server round trip, no secret, and no
 * deploy step. 058 spent an afternoon on an Edge Function that was deployed,
 * keyed and still unreachable; not adding a second one is worth something.
 *
 * The cost is that extraction happens on whatever machine did the upload. That
 * is acceptable because uploading reference documents is office work on a
 * laptop — unlike a site photo, which is the phone-in-the-sun case the rest of
 * this app is designed around.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No OCR. A scanned PDF is a picture of a page and has no text layer at all;
 * pdf.js correctly returns nothing for it. That is reported as `no_text` with
 * a sentence saying so, rather than stored as an empty string that looks like a
 * successful extraction. A library that quietly contains documents nobody can
 * search is worse than one that says which ones they are.
 */

/** Mirrors the doc_extract_status enum in migration 059. */
export type ExtractStatus = 'pending' | 'ok' | 'no_text' | 'failed'

export interface ExtractResult {
  text: string
  pageCount: number | null
  status: ExtractStatus
  /** Shown on screen. Null when the extraction simply worked. */
  note: string | null
}

/**
 * Below this, whatever came back is not a text layer — it is the handful of
 * stray characters a scanner's software sometimes leaves behind, or a single
 * page number. Treating that as "searchable" is worse than admitting there is
 * nothing, because it makes the document look indexed when it isn't.
 */
const MIN_USEFUL_CHARS = 40

/**
 * Pages are capped so one enormous document cannot lock up the tab. 400 pages
 * is far past any IS code the firm actually files, and the cap is REPORTED
 * rather than silently applied — a document whose second half is missing from
 * search should say so.
 */
const MAX_PAGES = 400

/** Loaded on demand: pdf.js is ~400KB and belongs nowhere near the main bundle. */
async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist')
  // Vite resolves `?url` to the emitted asset path. Without a worker, pdf.js
  // parses on the main thread and freezes the tab on anything large.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url'))
    .default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  return pdfjs
}

/**
 * Collapses the whitespace pdf.js produces without joining words that were
 * genuinely separate. Kept simple on purpose: aggressive cleanup of a technical
 * document tends to eat the very things people search for — "M25", "8 mm c/c",
 * clause numbers.
 */
function tidy(raw: string): string {
  return raw
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function extractPdf(file: File): Promise<ExtractResult> {
  const pdfjs = await loadPdfJs()
  const buf = await file.arrayBuffer()

  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise

  const total = doc.numPages
  const pages = Math.min(total, MAX_PAGES)
  const out: string[] = []

  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const line = content.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
    out.push(line)
    page.cleanup()
  }

  await doc.cleanup()

  const text = tidy(out.join('\n'))

  if (text.length < MIN_USEFUL_CHARS) {
    return {
      text: '',
      pageCount: total,
      status: 'no_text',
      note:
        'This PDF has no text layer — it is almost certainly a scan. The file ' +
        'is stored and can be opened, but searching will not find what is ' +
        'inside it.',
    }
  }

  return {
    text,
    pageCount: total,
    status: 'ok',
    note:
      total > MAX_PAGES
        ? `Only the first ${MAX_PAGES} of ${total} pages were indexed. The ` +
          'whole file is stored and opens normally.'
        : null,
  }
}

/** Plain text and markdown need no parsing. */
async function extractPlain(file: File): Promise<ExtractResult> {
  const text = tidy(await file.text())
  return text.length < MIN_USEFUL_CHARS
    ? { text: '', pageCount: null, status: 'no_text', note: 'The file is empty.' }
    : { text, pageCount: null, status: 'ok', note: null }
}

/**
 * Best-effort text for any uploaded file.
 *
 * NEVER THROWS. A document that could not be parsed must still be filed —
 * losing the upload because the text extraction failed would trade the thing
 * the user asked for against a convenience. Failure comes back as `failed`
 * with the reason, and the file uploads regardless.
 */
export async function extractText(file: File): Promise<ExtractResult> {
  const name = file.name.toLowerCase()
  const type = file.type

  try {
    if (type === 'application/pdf' || name.endsWith('.pdf')) {
      return await extractPdf(file)
    }

    if (
      type.startsWith('text/') ||
      /\.(txt|md|csv)$/.test(name)
    ) {
      return await extractPlain(file)
    }

    // DOCX, XLSX, DWG, images. Each would need its own parser, and guessing at
    // one produces plausible nonsense — which in a searchable library is worse
    // than a gap, because a wrong answer looks like an answer.
    return {
      text: '',
      pageCount: null,
      status: 'no_text',
      note:
        'Only PDF and plain text can be read for searching. This file is ' +
        'stored and opens normally, but its contents are not searchable.',
    }
  } catch (err) {
    return {
      text: '',
      pageCount: null,
      status: 'failed',
      note: `Could not read this file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}
