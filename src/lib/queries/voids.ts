import { supabase } from '@/lib/supabase'
import type {
  CancellableTable,
  DeletableTable,
  GoodsReceiptRow,
  MovementRow,
  VoidableTable,
} from '@/lib/types'

/**
 * Voiding goes through fn_void_record (migration 020) and nowhere else.
 *
 * The function is SECURITY DEFINER and does the real work: checks the caller's
 * role, refuses a blank reason, blocks unsafe voids (stock below zero, an
 * invoice already posted, a child row whose parent should be voided instead),
 * cascades to derived rows, and writes the audit entry. No UPDATE policy on
 * voided_at exists, so there is no way to bypass it from the client.
 */
export async function voidRecord(
  table: VoidableTable,
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_void_record', {
    p_table: table,
    p_id: id,
    p_reason: reason,
  })
  if (error) throw error
}

/**
 * Cancels a PO or VO through fn_cancel_document (migration 021).
 *
 * Cancelling is not the same as voiding. These are workflow documents: the row
 * keeps its identity and its number, the status becomes `cancelled`, and it
 * drops out of active lists and of every value/match calculation server-side.
 *
 * The function refuses to cancel a PO that still has live goods receipts or
 * invoices — those have to be voided first, because they moved stock and money.
 */
export async function cancelDocument(
  table: CancellableTable,
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_cancel_document', {
    p_table: table,
    p_id: id,
    p_reason: reason,
  })
  if (error) throw error
}

/**
 * Hard-deletes a record through fn_delete_record (migration 022).
 *
 * Only for records with no downstream effect. The function does the reference
 * checks server-side and raises a message naming what's in the way — "used by
 * 4 records", "rolled over to a later day", "cancel it instead". There are no
 * DELETE policies on these tables, so this RPC is the only route.
 */
export async function deleteRecord(
  table: DeletableTable,
  id: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_delete_record', {
    p_table: table,
    p_id: id,
  })
  if (error) throw error
}

/** Rejects a still-submitted VO, with the reason recorded (migration 021). */
export async function rejectVariation(
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_reject_variation', {
    p_id: id,
    p_reason: reason,
  })
  if (error) throw error
}

/**
 * Inward + issues for one project as a single dated list, so a PM can find the
 * movement they need to reverse without knowing which table it lives in.
 *
 * Reads the rate-free v_material_inward: this screen never shows money, so it
 * works for every role that can see the project.
 */
export async function fetchMovements(
  projectId: string,
): Promise<MovementRow[]> {
  const [inward, issues, materials] = await Promise.all([
    supabase
      .from('v_material_inward')
      .select(
        'id, material_id, inward_date, qty, vendor_name, challan_no, remarks, grn_line_id, created_by, voided_at, voided_by, void_reason',
      )
      .eq('project_id', projectId)
      .order('inward_date', { ascending: false })
      .limit(300),
    supabase
      .from('material_issues')
      .select(
        'id, material_id, issue_date, qty, work_area, issued_to, remarks, created_by, voided_at, voided_by, void_reason',
      )
      .eq('project_id', projectId)
      .order('issue_date', { ascending: false })
      .limit(300),
    supabase.from('materials').select('id, name, unit'),
  ])

  if (inward.error) throw inward.error
  if (issues.error) throw issues.error

  const names = new Map(
    (materials.data ?? []).map((m) => [
      m.id as string,
      { name: m.name as string, unit: m.unit as string },
    ]),
  )
  const nameOf = (id: string) => names.get(id) ?? { name: 'Unknown', unit: '' }

  const rows: MovementRow[] = [
    ...(inward.data ?? []).map((r) => {
      const m = nameOf(r.material_id as string)
      return {
        id: r.id as string,
        kind: 'inward' as const,
        table: 'material_inward' as VoidableTable,
        material_id: r.material_id as string,
        material_name: m.name,
        material_unit: m.unit,
        move_date: r.inward_date as string,
        qty: Number(r.qty),
        party: (r.vendor_name as string | null) ?? null,
        note:
          [r.challan_no ? `Challan ${r.challan_no}` : null, r.remarks]
            .filter(Boolean)
            .join(' · ') || null,
        from_grn: r.grn_line_id !== null,
        created_by: (r.created_by as string | null) ?? null,
        voided_at: (r.voided_at as string | null) ?? null,
        voided_by: (r.voided_by as string | null) ?? null,
        void_reason: (r.void_reason as string | null) ?? null,
      }
    }),
    ...(issues.data ?? []).map((r) => {
      const m = nameOf(r.material_id as string)
      return {
        id: r.id as string,
        kind: 'issue' as const,
        table: 'material_issues' as VoidableTable,
        material_id: r.material_id as string,
        material_name: m.name,
        material_unit: m.unit,
        move_date: r.issue_date as string,
        qty: Number(r.qty),
        party: (r.work_area as string | null) ?? null,
        note:
          [r.issued_to ? `To ${r.issued_to}` : null, r.remarks]
            .filter(Boolean)
            .join(' · ') || null,
        from_grn: false,
        created_by: (r.created_by as string | null) ?? null,
        voided_at: (r.voided_at as string | null) ?? null,
        voided_by: (r.voided_by as string | null) ?? null,
        void_reason: (r.void_reason as string | null) ?? null,
      }
    }),
  ]

  // Newest first; ties broken so inward reads before the issue it supplied.
  return rows.sort((a, b) => {
    if (a.move_date !== b.move_date) return a.move_date < b.move_date ? 1 : -1
    return a.kind === b.kind ? 0 : a.kind === 'inward' ? -1 : 1
  })
}

/** Goods receipts logged against one PO, so they can be reviewed and voided. */
export async function fetchGoodsReceipts(
  poId: string,
): Promise<GoodsReceiptRow[]> {
  const { data, error } = await supabase
    .from('goods_receipts')
    .select(
      'id, po_id, received_date, note, voided_at, voided_by, void_reason, grn_lines(count)',
    )
    .eq('po_id', poId)
    .order('received_date', { ascending: false })

  if (error) throw error

  return (data ?? []).map((r) => {
    const counted = r.grn_lines as unknown as { count: number }[] | null
    return {
      id: r.id as string,
      po_id: r.po_id as string,
      received_date: r.received_date as string,
      note: (r.note as string | null) ?? null,
      line_count: counted?.[0]?.count ?? 0,
      voided_at: (r.voided_at as string | null) ?? null,
      voided_by: (r.voided_by as string | null) ?? null,
      void_reason: (r.void_reason as string | null) ?? null,
    }
  })
}

/** Display names for voided_by, so a void reads "by Waseem" not a uuid. */
export async function fetchUserNames(
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => Boolean(i)))]
  if (unique.length === 0) return new Map()

  const { data } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', unique)

  return new Map((data ?? []).map((p) => [p.id as string, p.full_name as string]))
}
