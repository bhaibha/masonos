import { supabase } from '@/lib/supabase'
import type {
  NewPettyCashCount,
  NewPettyCashEntry,
  PettyCashAccount,
  PettyCashCount,
  PettyCashEntry,
} from '@/lib/types'

/**
 * M21 Petty Cash — the query layer the module has been missing since 002.
 *
 * Every figure here is read from Postgres, never computed in the browser
 * (CLAUDE.md rule 2). The one exception is the RUNNING balance beside each
 * entry, which is a presentation device: it is walked forward from
 * `v_petty_cash_balance`'s authoritative closing figure rather than summed
 * from scratch, so the column and the headline can never disagree. See
 * `withRunningBalance`.
 */

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Imprest accounts with their live balance.
 *
 * Two calls rather than one join: `v_petty_cash_balance` carries only
 * account_id / project_id / holder / balance (020), and the holder's NAME
 * lives on profiles. RLS scopes both the same way — a holder sees their own
 * row, founder/accounts see all — so the join is safe to do here.
 *
 * `projectId` is optional because the office screen shows every project's
 * accounts while the holder view is scoped to the one they are standing on.
 */
export async function fetchPettyCashAccounts(
  projectId?: string | null,
): Promise<PettyCashAccount[]> {
  let accountQuery = supabase
    .from('petty_cash_accounts')
    .select('id, project_id, holder, imprest_amount, projects(name), profiles(full_name)')
  if (projectId) accountQuery = accountQuery.eq('project_id', projectId)

  const [{ data: accounts, error }, balances] = await Promise.all([
    accountQuery,
    supabase.from('v_petty_cash_balance').select('account_id, balance'),
  ])

  if (error) throw error
  if (balances.error) throw balances.error

  const balanceOf = new Map(
    (balances.data ?? []).map((b) => [b.account_id as string, Number(b.balance)]),
  )

  // PostgREST returns an embedded row as an object or an array depending on
  // how it resolves the relationship; the repo hits this everywhere.
  const one = <T,>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v

  return (accounts ?? []).map((r) => {
    const project = one(r.projects as { name: string } | { name: string }[] | null)
    const holder = one(
      r.profiles as { full_name: string } | { full_name: string }[] | null,
    )
    return {
      id: r.id as string,
      project_id: r.project_id as string,
      project_name: project?.name ?? '—',
      holder: r.holder as string,
      holder_name: holder?.full_name ?? 'Unknown',
      imprest_amount: Number(r.imprest_amount),
      // A missing balance row would mean the view refused, not that the tin is
      // empty — surfaced as null so the screen can say so instead of printing
      // a confident ₹0.00 (the 056 zero-rows rule).
      balance: balanceOf.get(r.id as string) ?? null,
    }
  })
}

/**
 * Opens an imprest account. Founder/accounts only — `pca_write` is
 * `for all … using (my_role() in ('founder','accounts'))`.
 *
 * `imprest_amount` is the OPENING float and nothing else. Topping up is an
 * ENTRY (`top_up`), never an edit to this column: raising the imprest figure
 * would silently restate every historical balance, and the tin would appear to
 * have held more money last month than it did.
 */
export async function createPettyCashAccount(input: {
  project_id: string
  holder: string
  imprest_amount: number
}): Promise<string> {
  const { data, error } = await supabase
    .from('petty_cash_accounts')
    .insert(input)
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

/**
 * Every entry on one account, oldest first, each carrying the balance AS IT
 * STOOD after it.
 *
 * The running figure is walked BACKWARDS from `v_petty_cash_balance`: the
 * closing balance is the authority, and each earlier row is derived by undoing
 * the movement after it. Summing forwards from `imprest_amount` would be a
 * second implementation of the view's arithmetic in TypeScript, and the two
 * would eventually disagree about a voided row — which is exactly the bug
 * class the money-math-in-Postgres rule exists to prevent.
 *
 * A VOIDED entry contributes nothing to the running balance (the 020 view
 * excludes it in the JOIN) but is still listed, because a void is a record.
 */
export async function fetchPettyCashEntries(
  accountId: string,
): Promise<PettyCashEntry[]> {
  const [{ data, error }, balance] = await Promise.all([
    supabase
      .from('petty_cash_entries')
      .select(
        'id, account_id, entry_date, entry_type, amount, category_id, description, receipt_path, created_by, created_at, voided_at, voided_by, void_reason, expense_categories(name), profiles!petty_cash_entries_created_by_fkey(full_name)',
      )
      .eq('account_id', accountId)
      .order('entry_date', { ascending: true })
      .order('created_at', { ascending: true }),
    supabase
      .from('v_petty_cash_balance')
      .select('balance')
      .eq('account_id', accountId)
      .maybeSingle(),
  ])

  if (error) throw error
  if (balance.error) throw balance.error

  const one = <T,>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v

  const rows = (data ?? []).map((r) => ({
    id: r.id as string,
    account_id: r.account_id as string,
    entry_date: r.entry_date as string,
    entry_type: r.entry_type as PettyCashEntry['entry_type'],
    amount: Number(r.amount),
    category_id: (r.category_id as number | null) ?? null,
    category_name:
      one(r.expense_categories as { name: string } | { name: string }[] | null)
        ?.name ?? null,
    description: (r.description as string | null) ?? null,
    receipt_path: (r.receipt_path as string | null) ?? null,
    created_by: r.created_by as string,
    created_by_name:
      one(r.profiles as { full_name: string } | { full_name: string }[] | null)
        ?.full_name ?? null,
    created_at: r.created_at as string,
    voided_at: (r.voided_at as string | null) ?? null,
    voided_by: (r.voided_by as string | null) ?? null,
    void_reason: (r.void_reason as string | null) ?? null,
    running_balance: null as number | null,
  }))

  return withRunningBalance(rows, Number(balance.data?.balance ?? 0))
}

/** Signed movement of one entry on the balance. A void moves nothing. */
export function entryDelta(e: {
  entry_type: PettyCashEntry['entry_type']
  amount: number
  voided_at: string | null
}): number {
  if (e.voided_at) return 0
  return e.entry_type === 'top_up' ? e.amount : -e.amount
}

/**
 * Fills `running_balance` by walking back from the closing figure the database
 * computed. Exported so the reconciliation screen can reuse it rather than
 * write its own.
 */
export function withRunningBalance(
  rows: PettyCashEntry[],
  closingBalance: number,
): PettyCashEntry[] {
  let after = closingBalance
  const out = [...rows]
  for (let i = out.length - 1; i >= 0; i--) {
    const row = out[i]
    if (!row) continue
    row.running_balance = after
    after = Number((after - entryDelta(row)).toFixed(2))
  }
  return out
}

/**
 * Logs a movement. `pce_insert` (002 → 078) allows the account's holder OR
 * founder/accounts, and requires an active profile.
 *
 * A `spend` fires `fn_pc_to_expense`, which mirrors it into the ledger in the
 * SAME transaction — so a refused expense refuses the entry too. Since
 * migration 082 an uncategorised spend falls back to the Misc category by
 * name; before that it raised a foreign key violation on a category id that
 * has never existed.
 */
export async function createPettyCashEntry(
  input: NewPettyCashEntry,
): Promise<string> {
  const { data, error } = await supabase
    .from('petty_cash_entries')
    .insert({
      account_id: input.account_id,
      entry_date: input.entry_date,
      entry_type: input.entry_type,
      amount: input.amount,
      // Only a spend reaches the ledger, so only a spend carries a category.
      category_id: input.entry_type === 'spend' ? input.category_id : null,
      description: input.description || null,
      receipt_path: input.receipt_path,
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

/**
 * Voids an entry. There is deliberately NO update policy on
 * `petty_cash_entries`, so this RPC is the only path — and it cascades to the
 * mirrored expense, which is why voiding the expense directly is refused with
 * "void the petty cash entry instead" (020/021).
 *
 * Founder/accounts only, enforced inside the function.
 */
export async function voidPettyCashEntry(
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('fn_void_record', {
    p_table: 'petty_cash_entries',
    p_id: id,
    p_reason: reason,
  })
  if (error) throw error
}

/* ------------------------------------------------------------------ */
/* Reconciliation (migration 082)                                      */
/* ------------------------------------------------------------------ */

/** Counts against one account, newest first. */
export async function fetchPettyCashCounts(
  accountId: string,
): Promise<PettyCashCount[]> {
  const { data, error } = await supabase
    .from('petty_cash_counts')
    .select(
      'id, account_id, counted_on, counted_amount, book_balance, variance, note, counted_by, created_at, profiles(full_name)',
    )
    .eq('account_id', accountId)
    .order('counted_on', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw error

  const one = <T,>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : v

  return (data ?? []).map((r) => ({
    id: r.id as string,
    account_id: r.account_id as string,
    counted_on: r.counted_on as string,
    counted_amount: Number(r.counted_amount),
    book_balance: Number(r.book_balance),
    variance: Number(r.variance),
    note: (r.note as string | null) ?? null,
    counted_by: r.counted_by as string,
    counted_by_name:
      one(r.profiles as { full_name: string } | { full_name: string }[] | null)
        ?.full_name ?? null,
    created_at: r.created_at as string,
  }))
}

/**
 * Records a physical count.
 *
 * `book_balance` is passed in and STORED rather than derived on read — a
 * reconciliation is evidence about a moment, and voiding an old entry must not
 * silently restate what last month's count was checked against (082's header;
 * same rule as the certified RA bill snapshot in 032).
 *
 * The caller must pass the balance it actually displayed, so what the person
 * saw and what is filed are the same number.
 *
 * A variance with no note is refused by a CHECK constraint, not only by the
 * form — the rule survives anything talking to the API directly.
 */
export async function recordPettyCashCount(
  input: NewPettyCashCount,
): Promise<void> {
  const { error } = await supabase.from('petty_cash_counts').insert({
    account_id: input.account_id,
    counted_on: input.counted_on,
    counted_amount: input.counted_amount,
    book_balance: input.book_balance,
    note: input.note || null,
  })
  if (error) throw error
}
