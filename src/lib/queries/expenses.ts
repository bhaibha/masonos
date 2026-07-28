import { supabase } from '@/lib/supabase'
import type {
  BudgetRow,
  BudgetVsActual,
  ExpenseCategory,
  ExpenseFilters,
  ExpenseRow,
  ExpenseTotal,
  NewExpense,
} from '@/lib/types'

export async function fetchCategories(): Promise<ExpenseCategory[]> {
  const { data, error } = await supabase
    .from('expense_categories')
    .select('id, name, sort')
    .order('sort')
    .order('name')

  if (error) throw error
  return (data ?? []) as ExpenseCategory[]
}

/** Ledger, newest first. Filters are applied in Postgres, not in the browser. */
export async function fetchExpenses(
  projectId: string,
  filters: ExpenseFilters = {},
): Promise<ExpenseRow[]> {
  let q = supabase
    .from('expenses')
    .select(
      'id, expense_date, amount, gst_amount, source, invoice_no, description, receipt_path, category_id, vendor_id, vendor_name, voided_at, voided_by, void_reason, pc_entry_id, expense_categories(name), vendors(name)',
    )
    .eq('project_id', projectId)
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500)

  if (filters.categoryId) q = q.eq('category_id', filters.categoryId)
  if (filters.from) q = q.gte('expense_date', filters.from)
  if (filters.to) q = q.lte('expense_date', filters.to)
  if (filters.source) q = q.eq('source', filters.source)

  const { data, error } = await q
  if (error) throw error

  type Joined = {
    expense_categories: { name: string } | { name: string }[] | null
    vendors: { name: string } | { name: string }[] | null
    vendor_name: string | null
  }
  const one = (v: Joined['vendors']) =>
    (Array.isArray(v) ? v[0]?.name : v?.name) ?? null

  return (data ?? []).map((r) => {
    const row = r as unknown as ExpenseRow & Joined
    const registeredName = one(row.vendors)
    return {
      id: row.id,
      expense_date: row.expense_date,
      amount: Number(row.amount),
      gst_amount: Number(row.gst_amount ?? 0),
      source: row.source,
      invoice_no: row.invoice_no,
      description: row.description,
      receipt_path: row.receipt_path,
      category_id: row.category_id,
      vendor_id: row.vendor_id,
      category_name: one(row.expense_categories),
      // Registered vendor name if linked, else the free-text name.
      vendor_display: row.vendor_id ? registeredName : (row.vendor_name ?? null),
      vendor_registered: row.vendor_id !== null,
      voided_at: row.voided_at ?? null,
      voided_by: row.voided_by ?? null,
      void_reason: row.void_reason ?? null,
    }
  })
}

export async function createExpense(input: NewExpense): Promise<void> {
  const { error } = await supabase.from('expenses').insert({
    project_id: input.project_id,
    expense_date: input.expense_date,
    category_id: input.category_id,
    vendor_id: input.vendor_id,
    vendor_name: input.vendor_name || null,
    description: input.description || null,
    amount: input.amount,
    gst_amount: input.gst_amount,
    source: input.source,
    invoice_no: input.invoice_no || null,
    receipt_path: input.receipt_path,
  })
  if (error) throw error
}

/**
 * Sums the ledger for the same filters the list is showing. The arithmetic
 * happens in fn_expense_total (migration 004), never here — CLAUDE.md rule 2.
 * Pass no filters to get the project's all-time total.
 */
export async function fetchExpenseTotal(
  projectId: string,
  filters: ExpenseFilters = {},
): Promise<ExpenseTotal> {
  const { data, error } = await supabase.rpc('fn_expense_total', {
    p_project: projectId,
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
    p_category: filters.categoryId ?? null,
    p_source: filters.source ?? null,
  })

  if (error) throw error

  // RETURNS TABLE → PostgREST hands back an array of one row.
  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined

  return {
    total_amount: Number(row?.total_amount ?? 0),
    total_gst: Number(row?.total_gst ?? 0),
    total_with_gst: Number(row?.total_with_gst ?? 0),
    entry_count: Number(row?.entry_count ?? 0),
  }
}

/**
 * Reads public.v_budget_vs_actual. budget / actual / remaining are all
 * calculated in Postgres (CLAUDE.md rule 2). Since migration 004 this also
 * returns categories that have spend but no budget row (has_budget false).
 */
export async function fetchBudgetVsActual(
  projectId: string,
): Promise<BudgetVsActual[]> {
  const { data, error } = await supabase
    .from('v_budget_vs_actual')
    .select('project_id, category, budget, actual, remaining, has_budget')
    .eq('project_id', projectId)
    .order('category')

  if (error) throw error

  return (data ?? []).map((r) => ({
    project_id: r.project_id as string,
    category: r.category as string,
    budget: Number(r.budget),
    actual: Number(r.actual),
    remaining: Number(r.remaining),
    has_budget: Boolean(r.has_budget),
  }))
}

export async function fetchBudgets(projectId: string): Promise<BudgetRow[]> {
  const { data, error } = await supabase
    .from('budgets')
    .select('id, project_id, category_id, amount')
    .eq('project_id', projectId)

  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    category_id: r.category_id as number,
    amount: Number(r.amount),
  }))
}

/** budgets has unique (project_id, category_id) — upsert on that pair. */
export async function upsertBudget(
  projectId: string,
  categoryId: number,
  amount: number,
): Promise<void> {
  const { error } = await supabase
    .from('budgets')
    .upsert(
      { project_id: projectId, category_id: categoryId, amount },
      { onConflict: 'project_id,category_id' },
    )
  if (error) throw error
}

export async function deleteBudget(
  projectId: string,
  categoryId: number,
): Promise<void> {
  const { error } = await supabase
    .from('budgets')
    .delete()
    .eq('project_id', projectId)
    .eq('category_id', categoryId)
  if (error) throw error
}
