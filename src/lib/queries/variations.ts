import { supabase } from '@/lib/supabase'
import type {
  NewVariationOrder,
  ProjectContract,
  VariationOrder,
} from '@/lib/types'

const COLUMNS =
  'id, vo_number, project_id, title, description, cost_impact, status, raised_by, approved_by, created_at'

export async function fetchVariations(
  projectId: string,
): Promise<VariationOrder[]> {
  const { data, error } = await supabase
    .from('variation_orders')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>
    return {
      id: row.id as string,
      vo_number: row.vo_number as string,
      project_id: row.project_id as string,
      title: row.title as string,
      description: (row.description as string | null) ?? null,
      cost_impact: Number(row.cost_impact),
      status: row.status as VariationOrder['status'],
      raised_by: row.raised_by as string,
      approved_by: (row.approved_by as string | null) ?? null,
      created_at: row.created_at as string,
    }
  })
}

export async function createVariation(
  input: NewVariationOrder,
): Promise<void> {
  const { error } = await supabase.from('variation_orders').insert({
    project_id: input.project_id,
    title: input.title,
    description: input.description || null,
    cost_impact: input.cost_impact,
  })
  if (error) throw error
}

export async function setVariationStatus(
  id: string,
  status: 'approved' | 'rejected',
): Promise<void> {
  const { error } = await supabase
    .from('variation_orders')
    .update({
      status,
      approved_by: (await supabase.auth.getUser()).data.user?.id ?? null,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) throw error
}

/**
 * Original + approved variations = revised contract value, from
 * v_project_contract (migration 016, money-roles). Returns null when the caller
 * isn't permitted or before 016 is applied.
 */
export async function fetchProjectContract(
  projectId: string,
): Promise<ProjectContract | null> {
  const { data, error } = await supabase
    .from('v_project_contract')
    .select('contract_value, variations_value, pending_value, revised_contract_value')
    .eq('project_id', projectId)
    .maybeSingle()

  if (error || !data) return null
  return {
    contract_value: Number(data.contract_value),
    variations_value: Number(data.variations_value),
    pending_value: Number(data.pending_value),
    revised_contract_value: Number(data.revised_contract_value),
  }
}
