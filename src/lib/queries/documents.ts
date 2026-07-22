import { supabase } from '@/lib/supabase'
import type {
  DocFolder,
  DocumentRow,
  NewDocument,
  PoStatus,
} from '@/lib/types'

const COLUMNS =
  'id, project_id, folder, title, file_path, file_type, is_confidential, uploaded_by, created_at, po_id, profiles(full_name)'

type Joined = { profiles: { full_name: string } | { full_name: string }[] | null }

function mapRow(r: unknown): DocumentRow {
  const row = r as DocumentRow & Joined
  const p = row.profiles
  return {
    id: row.id,
    project_id: row.project_id,
    folder: row.folder,
    title: row.title,
    file_path: row.file_path,
    file_type: row.file_type,
    is_confidential: row.is_confidential,
    uploaded_by: row.uploaded_by,
    uploaded_by_name:
      (Array.isArray(p) ? p[0]?.full_name : p?.full_name) ?? null,
    created_at: row.created_at,
    po_id: (row.po_id as string | null) ?? null,
    po_status: null,
  }
}

/** Fills in po_status for any rows linked to a PO (Purchase Orders folder). */
async function attachPoStatus(rows: DocumentRow[]): Promise<DocumentRow[]> {
  const ids = [...new Set(rows.map((r) => r.po_id).filter(Boolean))] as string[]
  if (ids.length === 0) return rows

  const { data } = await supabase
    .from('purchase_orders')
    .select('id, status')
    .in('id', ids)

  const statusById = new Map(
    (data ?? []).map((p) => [p.id as string, p.status as PoStatus]),
  )
  for (const r of rows) {
    if (r.po_id) r.po_status = statusById.get(r.po_id) ?? null
  }
  return rows
}

/**
 * Documents for a project, optionally narrowed to one folder or a title search.
 *
 * CONFIDENTIALITY IS NOT FILTERED HERE. `docs_read` in 003_materials_docs.sql
 * already restricts confidential rows to founder/pm/accounts:
 *
 *   using (is_member(project_id)
 *          and (not is_confidential or my_role() in ('founder','pm','accounts')))
 *
 * A supervisor's request simply comes back without those rows. Adding a
 * client-side `.eq('is_confidential', false)` would be redundant at best and,
 * worse, would imply the browser is the thing enforcing it.
 */
export async function fetchDocuments(
  projectId: string,
  opts: { folder?: DocFolder; search?: string } = {},
): Promise<DocumentRow[]> {
  let q = supabase
    .from('documents')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(500)

  if (opts.folder) q = q.eq('folder', opts.folder)

  if (opts.search && opts.search.trim() !== '') {
    // Escape PostgREST pattern metacharacters so a stray % or _ can't widen
    // the match beyond what the user typed.
    const term = opts.search.trim().replace(/[%_\\]/g, '\\$&')
    q = q.ilike('title', `%${term}%`)
  }

  const { data, error } = await q
  if (error) throw error
  return attachPoStatus((data ?? []).map(mapRow))
}

/** Per-folder counts for the project, after RLS has done its filtering. */
export async function fetchFolderCounts(
  projectId: string,
): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('documents')
    .select('folder')
    .eq('project_id', projectId)

  if (error) throw error

  const counts: Record<string, number> = {}
  for (const r of data ?? []) {
    const f = r.folder as string
    counts[f] = (counts[f] ?? 0) + 1
  }
  return counts
}

export async function createDocument(input: NewDocument): Promise<void> {
  const { error } = await supabase.from('documents').insert({
    project_id: input.project_id,
    folder: input.folder,
    title: input.title,
    file_path: input.file_path,
    file_type: input.file_type,
    is_confidential: input.is_confidential,
    po_id: input.po_id ?? null,
  })
  if (error) throw error
}
