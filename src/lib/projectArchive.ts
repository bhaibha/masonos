import JSZip from 'jszip'
import { supabase } from '@/lib/supabase'

/**
 * Handover archive for one project: every row we hold about it as CSV, every
 * file it owns, and an index page to navigate them offline.
 *
 * Built entirely in the browser. It could have been an Edge Function, but a
 * function would have to hold the whole archive in memory inside a 150-second
 * budget, and the browser has neither limit — it is already authenticated, RLS
 * already scopes what it can read, and the bytes end up on the user's disk
 * either way.
 *
 * RLS is doing the security here, not this file: every query below runs as the
 * signed-in user, so an archive can never contain more than that person could
 * already see on screen.
 */

export interface ArchiveProgress {
  /** what is happening right now, for the button label */
  label: string
  /** 0–100, rough */
  pct: number
}

/* ---------------- CSV ---------------- */

/**
 * Excel opens a bare .csv in the system encoding and mangles ₹ and accented
 * names, so every sheet gets a UTF-8 BOM. Values are quoted whenever they
 * contain a delimiter, a quote or a newline — a site log with a comma in it is
 * otherwise enough to shift every column after it.
 */
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''

  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]

  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s =
      typeof v === 'object' ? JSON.stringify(v) : String(v as string | number)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  const lines = [
    cols.join(','),
    ...rows.map((r) => cols.map((c) => cell(r[c])).join(',')),
  ]
  return `﻿${lines.join('\r\n')}`
}

/* ---------------- what to pull ---------------- */

/** table or view → the column that scopes it to a project */
const PROJECT_TABLES: { source: string; label: string }[] = [
  { source: 'expenses', label: 'expenses' },
  { source: 'budgets', label: 'budgets' },
  { source: 'petty_cash_entries', label: 'petty-cash' },
  { source: 'tasks', label: 'tasks' },
  { source: 'site_logs', label: 'site-logs' },
  { source: 'safety_checklists', label: 'safety-checklists' },
  { source: 'incidents', label: 'incidents' },
  { source: 'v_material_inward_rates', label: 'material-inward' },
  { source: 'material_issues', label: 'material-issues' },
  { source: 'purchase_orders', label: 'purchase-orders' },
  { source: 'goods_receipts', label: 'goods-receipts' },
  { source: 'po_invoices', label: 'vendor-invoices' },
  { source: 'variation_orders', label: 'variation-orders' },
  { source: 'site_instructions', label: 'site-instructions' },
  { source: 'rfis', label: 'rfis' },
  { source: 'snags', label: 'snags' },
  { source: 'invoices', label: 'invoices' },
  { source: 'invoice_items', label: 'invoice-items' },
  { source: 'ra_bills', label: 'ra-bills' },
  { source: 'ra_bill_lines', label: 'ra-bill-lines' },
  { source: 'retention_releases', label: 'retention' },
  { source: 'bank_guarantees', label: 'bank-guarantees' },
  { source: 'insurance_policies', label: 'insurance' },
  { source: 'compliance_items', label: 'compliance' },
  { source: 'drawings', label: 'drawings' },
  { source: 'drawing_revisions', label: 'drawing-revisions' },
  { source: 'documents', label: 'documents' },
]

/** bucket → the paths held in it, gathered from the rows above */
interface FileRef {
  bucket: string
  path: string
  /** folder inside the zip */
  group: string
}

function collectFiles(
  data: Record<string, Record<string, unknown>[]>,
): FileRef[] {
  const out: FileRef[] = []
  const push = (bucket: string, group: string, v: unknown) => {
    if (typeof v === 'string' && v.trim() !== '') out.push({ bucket, path: v, group })
    else if (Array.isArray(v))
      for (const p of v) if (typeof p === 'string' && p) out.push({ bucket, path: p, group })
  }

  for (const r of data['documents'] ?? []) push('documents', 'documents', r.file_path)
  for (const r of data['expenses'] ?? []) push('receipts', 'receipts', r.receipt_path)
  for (const r of data['material-inward'] ?? [])
    push('receipts', 'challans', r.challan_photo)
  for (const r of data['site-logs'] ?? []) push('site-photos', 'site-photos', r.photos)
  for (const r of data['snags'] ?? []) {
    push('site-photos', 'snags', r.photos)
    push('site-photos', 'snags', r.resolution_photos)
  }
  for (const r of data['incidents'] ?? []) push('site-photos', 'incidents', r.photos)
  for (const r of data['site-instructions'] ?? [])
    push('site-photos', 'site-instructions', r.attachments)
  for (const r of data['rfis'] ?? []) push('site-photos', 'rfis', r.attachments)
  for (const r of data['compliance'] ?? [])
    push('compliance', 'compliance-proofs', r.proof_path)
  for (const r of data['bank-guarantees'] ?? [])
    push('compliance', 'bank-guarantees', r.file_path)
  for (const r of data['insurance'] ?? []) push('compliance', 'insurance', r.file_path)
  for (const r of data['drawing-revisions'] ?? [])
    push('drawings', 'drawings', r.file_path)

  // The same object can be referenced twice; download it once.
  const seen = new Set<string>()
  return out.filter((f) => {
    const k = `${f.bucket}/${f.path}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/* ---------------- the archive ---------------- */

export async function buildProjectArchive(
  projectId: string,
  projectName: string,
  onProgress: (p: ArchiveProgress) => void,
): Promise<{ blob: Blob; fileCount: number; missing: number }> {
  const zip = new JSZip()
  const data: Record<string, Record<string, unknown>[]> = {}

  // ---------- rows ----------
  for (const [i, t] of PROJECT_TABLES.entries()) {
    onProgress({
      label: `Reading ${t.label}…`,
      pct: Math.round((i / PROJECT_TABLES.length) * 35),
    })

    // A table that doesn't exist yet, or that RLS hides entirely, is not an
    // error — the archive just doesn't contain it.
    const { data: rows, error } = await supabase
      .from(t.source)
      .select('*')
      .eq('project_id', projectId)

    if (error) continue
    const list = (rows ?? []) as unknown as Record<string, unknown>[]
    data[t.label] = list
    if (list.length > 0) zip.file(`data/${t.label}.csv`, toCsv(list))
  }

  // Child tables that hang off a parent rather than the project directly.
  const poIds = (data['purchase-orders'] ?? []).map((r) => r.id as string)
  if (poIds.length > 0) {
    const { data: lines } = await supabase
      .from('v_po_lines_rated')
      .select('*')
      .in('po_id', poIds)
    const list = (lines ?? []) as unknown as Record<string, unknown>[]
    if (list.length > 0) zip.file('data/purchase-order-lines.csv', toCsv(list))
  }

  // ---------- files ----------
  const refs = collectFiles(data)
  let missing = 0
  let stored = 0

  for (const [i, f] of refs.entries()) {
    onProgress({
      label: `Downloading files ${i + 1} of ${refs.length}…`,
      pct: 35 + Math.round((i / Math.max(refs.length, 1)) * 60),
    })

    const { data: blob, error } = await supabase.storage
      .from(f.bucket)
      .download(f.path)

    if (error || !blob) {
      // Counted and reported rather than aborting: one unreadable object
      // shouldn't cost you the other four hundred.
      missing += 1
      continue
    }

    const name = f.path.split('/').pop() ?? 'file'
    zip.file(`files/${f.group}/${name}`, blob)
    stored += 1
  }

  // ---------- index ----------
  onProgress({ label: 'Writing the index…', pct: 96 })

  const counts = Object.entries(data)
    .filter(([, rows]) => rows.length > 0)
    .map(([label, rows]) => `<li>${label}: ${rows.length} rows</li>`)
    .join('')

  zip.file(
    'index.html',
    `<!doctype html><meta charset="utf-8">
<title>${escapeHtml(projectName)} — project archive</title>
<style>
 body{font:15px/1.6 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.5rem;color:#1A1A18;background:#FAF8F5}
 h1{font-size:1.6rem;margin-bottom:.25rem} p.sub{color:#6B6560;margin-top:0}
 ul{padding-left:1.2rem} code{background:#EDE9E3;padding:.1rem .3rem;border-radius:.2rem}
</style>
<h1>${escapeHtml(projectName)}</h1>
<p class="sub">Project archive exported ${new Date().toLocaleString('en-IN')}</p>
<h2>What's in here</h2>
<p><code>data/</code> — one CSV per record type. Open in Excel or Google Sheets.</p>
<p><code>files/</code> — every document, drawing, photo, receipt and scan, grouped by what it belongs to.</p>
<h2>Records</h2><ul>${counts}</ul>
<p>${stored} file${stored === 1 ? '' : 's'} included${missing > 0 ? `, ${missing} could not be read` : ''}.</p>
<p class="sub">Generated by Mason OS. Figures are as they stood at export; this is a
snapshot, not a live report.</p>`,
  )

  onProgress({ label: 'Compressing…', pct: 98 })

  // DEFLATE at a low level: most of the payload is already-compressed JPEG and
  // PDF, so a higher setting costs seconds and saves almost nothing. The CSVs
  // still shrink well.
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 3 },
  })

  return { blob, fileCount: stored, missing }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c] ?? c,
  )
}

/** Saves the archive to the user's downloads. */
export function saveArchive(blob: Blob, projectName: string): void {
  const safe = projectName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  const stamp = new Date().toISOString().slice(0, 10)
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = `${safe || 'project'}-archive-${stamp}.zip`
  a.click()

  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
