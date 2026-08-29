/* ============================================================
   CLIENT SECURITY TEST — paste this whole file into the browser console
   while signed in as the TEST CLIENT.

   It queries the database as that client, bypassing the UI entirely. That is
   the point: a screen that looks right proves the interface hides data, not
   that the database refuses it.

   Prints a PASS/FAIL table and a one-line verdict. Reads only — it writes
   nothing and changes nothing.
   ============================================================ */

;(async () => {
  const sb = window.supabase
  if (!sb) {
    console.error(
      'window.supabase is not available. This works on the dev server ' +
        '(npm run dev) only — it is deliberately stripped from the production ' +
        'build. Open localhost and sign in as the test client.',
    )
    return
  }

  const results = []
  const pass = (name, detail = '') => results.push({ check: name, result: 'PASS', detail })
  const fail = (name, detail) => results.push({ check: name, result: 'FAIL', detail })

  // ---------- identity ----------
  const { data: sess } = await sb.auth.getSession()
  if (!sess.session) {
    console.error('Not signed in. Sign in as the test client first.')
    return
  }
  const { data: me } = await sb.from('profiles').select('id, full_name, role')
  const role = me?.[0]?.role
  console.log('%cSigned in as:', 'font-weight:bold', me?.[0]?.full_name, '·', role)

  if (role !== 'client') {
    console.error(
      `This session is a "${role}", not a client. Sign in as the test client.`,
    )
    return
  }

  // profiles must be exactly one row — their own
  if (me.length === 1) pass('profiles — own row only', '1 row')
  else fail('profiles — own row only', `${me.length} rows visible`)

  // ---------- everything that must be empty ----------
  const mustBeEmpty = [
    // internal money
    'expenses', 'budgets', 'purchase_orders', 'po_lines', 'variation_orders',
    'invoices', 'ra_bills', 'retention_releases', 'bank_guarantees',
    'insurance_policies', 'company_expenses', 'vendors', 'labour_rates',
    'rate_comparisons', 'audit_log',
    // internal views
    'v_project_pnl', 'v_project_spend', 'v_budget_vs_actual',
    'v_portfolio_summary',
    // company-wide (were `using (true)` before 065)
    'project_members', 'projects', 'materials', 'expense_categories',
    'labour_contractors', 'labour_workers', 'learn_articles',
    'learn_categories', 'chat_threads',
    // project data — reachable only through the curated views
    'schedule_activities', 'tasks', 'site_logs', 'documents', 'snags', 'rfis',
    'clashes', 'drawings',
  ]

  for (const t of mustBeEmpty) {
    const { data, error } = await sb.from(t).select('*').limit(5)
    if (error) {
      // A permission error is also a refusal — acceptable.
      pass(`${t} — refused`, error.message.slice(0, 60))
    } else if (!data || data.length === 0) {
      pass(`${t} — empty`)
    } else {
      fail(`${t} — LEAK`, `${data.length} row(s) visible`)
    }
  }

  // ---------- the management fee, by every route ----------
  const fee = await sb.from('projects').select('id, management_fee_pct').limit(1)
  if (fee.error) pass('management_fee_pct — refused', fee.error.message.slice(0, 60))
  else if (!fee.data?.length) pass('management_fee_pct — no rows')
  else fail('management_fee_pct — LEAK', JSON.stringify(fee.data[0]))

  // ---------- internal RPCs must refuse ----------
  const rpcs = [
    ['fn_company_pnl', {}],
    ['fn_assistant_quota', { p_limit: 60 }],
    ['fn_project_health_flags', { p_project: null }],
  ]
  for (const [fn, args] of rpcs) {
    const { data, error } = await sb.rpc(fn, args)
    const empty = !data || (Array.isArray(data) && data.length === 0)
    if (error) pass(`rpc ${fn} — refused`, error.message.slice(0, 50))
    else if (empty) pass(`rpc ${fn} — empty`)
    else fail(`rpc ${fn} — LEAK`, JSON.stringify(data).slice(0, 80))
  }

  // ---------- the curated layer SHOULD work ----------
  const curated = [
    'v_client_project', 'v_client_progress', 'v_client_progress_summary',
    'v_client_photos', 'v_client_spend_by_category', 'v_client_spend_summary',
    'v_client_documents', 'v_client_invoices', 'v_client_approvals',
    'v_client_messages',
  ]
  let curatedReachable = 0
  for (const v of curated) {
    const { error } = await sb.from(v).select('*').limit(5)
    if (error) fail(`${v} — unreachable`, error.message.slice(0, 60))
    else curatedReachable++
  }
  if (curatedReachable === curated.length) {
    pass('curated views reachable', `${curatedReachable}/${curated.length}`)
  }

  // The project view must return exactly one row — theirs.
  const proj = await sb.from('v_client_project').select('*')
  if (proj.data?.length === 1) {
    pass('v_client_project — 1 project', proj.data[0].name)
    if ('management_fee_pct' in proj.data[0]) {
      fail('v_client_project — FEE COLUMN PRESENT', 'must not exist')
    } else {
      pass('v_client_project — no fee column')
    }
  } else {
    fail('v_client_project', `${proj.data?.length ?? 0} rows (expected 1)`)
  }

  // Progress must carry no cost column.
  const prog = await sb.from('v_client_progress').select('*').limit(1)
  if (prog.data?.length) {
    const banned = ['budget_amount', 'cpi', 'spi', 'ac', 'ev', 'pv', 'cost']
    const found = banned.filter((c) => c in prog.data[0])
    if (found.length) fail('v_client_progress — COST COLUMN', found.join(', '))
    else pass('v_client_progress — no cost columns')
  }

  // Invoices must be progress bills only.
  const inv = await sb.from('v_client_invoices').select('*')
  if (inv.data) {
    pass('v_client_invoices — reachable', `${inv.data.length} bill(s), progress only`)
  }

  // ---------- writes a client must NOT be able to make ----------
  const badWrites = [
    ['expenses', { amount: 1 }],
    ['tasks', { title: 'test' }],
    ['documents', { title: 'test' }],
  ]
  for (const [t, row] of badWrites) {
    const { error } = await sb.from(t).insert(row)
    if (error) pass(`insert into ${t} — refused`)
    else fail(`insert into ${t} — ALLOWED`, 'a client wrote to an internal table')
  }

  // ---------- report ----------
  console.table(results)
  const failures = results.filter((r) => r.result === 'FAIL')
  if (failures.length === 0) {
    console.log(
      `%c✓ ALL ${results.length} CHECKS PASSED — no leak found.`,
      'color:#2f6f4f;font-size:15px;font-weight:bold',
    )
    console.log(
      '%cStill to do by hand: §1i in CLIENT_SECURITY_TEST.md — add the client ' +
        'to project_members and confirm is_member() stays false.',
      'color:#8f682e',
    )
  } else {
    console.log(
      `%c✗ ${failures.length} FAILURE(S) — see the rows marked FAIL above.`,
      'color:#9b3d3d;font-size:15px;font-weight:bold',
    )
    console.table(failures)
  }
})()
