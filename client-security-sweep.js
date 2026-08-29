/* ============================================================
   CLIENT SECURITY SWEEP — exhaustive version.

   The first script probed 3 RPCs and found 2 leaks. This one probes EVERY
   table, view and read-only function a client can reach: 84 RLS tables, 35
   internal views, ~40 functions.

   Paste into the browser console while signed in as the TEST CLIENT.

   NOT PURELY READ-ONLY, and saying so plainly because the first version of this
   script claimed it was and was wrong:
     * `fn_assistant_quota` INSERTS a usage row before it answers. Since 066 it
       refuses a client outright, so nothing is written — but the call is a
       write attempt, not a read. ("quota", "check", "summary" and "alert" all
       sound like reads. One of them was not.)
     * The three 067 admin RPCs at the end are writes. They are called ONLY with
       the client's own id, so the worst possible outcome of a failure is that
       the test client revokes its own access — visible immediately, and no
       consequence for the firm. Anything wider would make this a weapon rather
       than a test.

   Anything that returns a row is printed in full, because the dangerous case
   is not an error — it is a row of ZEROS that a reader mistakes for a fact.
   ============================================================ */

;(async () => {
  const sb = window.supabase
  if (!sb) return console.error('window.supabase missing — use npm run dev.')

  const { data: me } = await sb.from('profiles').select('id, full_name, role')
  if (me?.[0]?.role !== 'client') {
    return console.error(`Signed in as "${me?.[0]?.role}", not a client.`)
  }
  console.log('%cSweeping as:', 'font-weight:bold', me[0].full_name)

  // Their own project id — the one id a client legitimately knows, and so the
  // one an attacker would pass to every project-scoped function.
  const { data: proj } = await sb.from('v_client_project').select('*')
  const PID = proj?.[0]?.id ?? proj?.[0]?.project_id ?? null
  console.log('Their project id:', PID)

  const out = []
  const ok = (kind, name, detail = '') =>
    out.push({ kind, name, result: 'PASS', detail: String(detail).slice(0, 90) })
  const bad = (kind, name, detail) =>
    out.push({ kind, name, result: 'FAIL', detail: String(detail).slice(0, 160) })

  // ---------- 1 · every RLS table ----------
  const TABLES = `activity_dependencies assistant_actions assistant_usage audit_log
bank_guarantees bbs_bars bbs_constants bbs_members bbs_shapes budgets chat_messages
chat_threads clashes client_approvals company_expenses compliance_items doc_subfolders
documents drawing_revisions drawings expense_categories expenses goods_receipts grn_lines
health_flag_acks incidents inspection_comments insurance_policies invoice_items invoices
labour_attendance labour_contractors labour_postings labour_rates labour_trades
labour_workers learn_articles learn_categories learn_documents learn_steps material_inward
material_issues materials ncrs overhead_categories petty_cash_accounts petty_cash_entries
photo_analyses po_invoices po_lines project_health_snapshots project_members projects
purchase_orders push_subscriptions ra_bill_lines ra_bills rate_comparisons rc_items
rc_quotes rc_vendors retention_releases rfis safety_checklist_items safety_checklists
schedule_activities site_instructions site_logs snags tasks variation_orders vendors`
    .split(/\s+/)
    .filter(Boolean)

  for (const t of TABLES) {
    const { data, error } = await sb.from(t).select('*').limit(3)
    if (error) ok('table', t, 'refused')
    else if (!data?.length) ok('table', t, 'empty')
    else bad('table', t, `${data.length} row(s): ${JSON.stringify(data[0])}`)
  }

  // ---------- 2 · every internal view ----------
  const VIEWS = `v_bbs_bars v_bbs_member_totals v_bbs_project_steel v_bg_register
v_budget_vs_actual v_clashes v_compliance_calendar v_drawing_register v_insurance_register
v_labour_attendance v_labour_cost v_labour_project_cost v_learn_articles v_learn_documents
v_material_inward v_material_inward_rates v_mis_projects v_petty_cash_balance
v_pnl_by_category v_po_lines_rated v_po_match v_po_totals v_po_value v_portfolio_summary
v_project_commercials v_project_contract v_project_pnl v_project_spend v_ra_bill_totals
v_ra_payables v_rc_matrix v_rc_summary v_rc_vendor_totals v_retention_ledger v_stock
v_unregistered_vendors v_client_roster`
    .split(/\s+/)
    .filter(Boolean)

  for (const v of VIEWS) {
    const { data, error } = await sb.from(v).select('*').limit(3)
    if (error) ok('view', v, 'refused')
    else if (!data?.length) ok('view', v, 'empty')
    else bad('view', v, `${data.length} row(s): ${JSON.stringify(data[0])}`)
  }

  // ---------- 3 · every read-only RPC ----------
  const D1 = '2000-01-01'
  const D2 = '2099-12-31'

  // Company-wide: no argument needed, so nothing to guess.
  const COMPANY = [
    ['fn_company_pnl', {}],
    ['fn_company_net', { p_from: D1, p_to: D2 }],
    ['fn_overhead_summary', { p_from: D1, p_to: D2 }],
    ['fn_mis_company', {}],
    ['fn_mis_exceptions', {}],
    ['fn_mis_trend', {}],
    ['fn_mis_by_category', {}],
    ['fn_compliance_alert', {}],
    ['fn_bg_alert', {}],
    ['fn_insurance_alert', {}],
    ['fn_labour_licence_alert', {}],
    ['fn_deadline_signals', {}],
    ['fn_daily_task_digest', {}],
    ['fn_assistant_stats', {}],
    ['fn_assistant_quota', { p_limit: 60 }],
    ['fn_learn_category_counts', {}],
    ['fn_learn_search', { p_q: 'concrete' }],
    ['fn_learn_doc_search', { p_q: 'concrete' }],
    ['fn_learn_retrieve', { p_q: 'concrete' }],
    ['fn_learn_by_ref', { p_ref: 'IS 456' }],
    ['fn_schedule_template', { p_floors: 2 }],
    // 067 — the founder's client roster. A client must not be able to count
    // the firm's other clients, nor read their own exposure figures.
    ['fn_client_roster_summary', {}],
    ['fn_projects_without_client', {}],
  ]

  // Project-scoped — passed THEIR OWN project id, which they legitimately know.
  const SCOPED = PID
    ? [
        ['fn_project_evm', { p_project: PID }],
        ['fn_activity_evm', { p_project: PID }],
        ['fn_activity_float', { p_project: PID }],
        ['fn_expense_total', { p_project: PID }],
        ['fn_project_snag_summary', { p_project: PID }],
        ['fn_qa_summary', { p_project: PID }],
        ['fn_safety_summary', { p_project: PID }],
        ['fn_project_clash_summary', { p_project: PID }],
        ['fn_photo_analysis_summary', { p_project: PID }],
        ['fn_project_approval_summary', { p_project: PID }],
        ['fn_project_health_flags', { p_project: PID }],
        ['fn_health_trend', { p_project: PID }],
        ['fn_labour_effort', { p_project: PID, p_from: D1, p_to: D2 }],
        ['fn_labour_reconcile', { p_project: PID, p_from: D1, p_to: D2 }],
        ['fn_muster_roll', { p_project: PID, p_from: D1, p_to: D2 }],
        ['fn_wage_register', { p_project: PID, p_from: D1, p_to: D2 }],
        ['fn_overtime_register', { p_project: PID, p_from: D1, p_to: D2 }],
        ['fn_labour_headcount_check', { p_project: PID, p_date: '2026-08-01' }],
      ]
    : []

  for (const [fn, args] of [...COMPANY, ...SCOPED]) {
    const { data, error } = await sb.rpc(fn, args)
    if (error) {
      ok('rpc', fn, 'refused: ' + error.message.slice(0, 50))
      continue
    }
    const rows = Array.isArray(data) ? data : data == null ? [] : [data]
    if (rows.length === 0) ok('rpc', fn, 'zero rows')
    else bad('rpc', fn, `${rows.length} row(s): ${JSON.stringify(rows[0])}`)
  }

  // ---------- 067 · the client admin RPCs must refuse a client outright ----------
  // These WRITE, so they are called last and only with the client's own id —
  // if any of them succeeded, it would be revoking their own access, which is
  // harmless to the firm and instantly visible. Anything else would make this
  // script a weapon rather than a test.
  if (PID) {
    const me = (await sb.from('profiles').select('id')).data?.[0]?.id
    const guards = [
      ['fn_set_client_active', { p_user: me, p_active: true }],
      ['fn_link_client', { p_user: me, p_project: PID }],
      ['fn_unlink_client', { p_user: me }],
    ]
    for (const [fn, args] of guards) {
      const { error } = await sb.rpc(fn, args)
      if (error) ok('rpc', fn, 'refused: ' + error.message.slice(0, 50))
      else bad('rpc', fn, 'A CLIENT EXECUTED A FOUNDER-ONLY FUNCTION')
    }
  }

  // ---------- report ----------
  const fails = out.filter((r) => r.result === 'FAIL')
  console.table(out)
  if (!fails.length) {
    console.log(
      `%c✓ ${out.length} surfaces swept — every one refused or empty.`,
      'color:#2f6f4f;font-size:15px;font-weight:bold',
    )
  } else {
    console.log(
      `%c✗ ${fails.length} of ${out.length} surfaces RETURNED SOMETHING`,
      'color:#9b3d3d;font-size:15px;font-weight:bold',
    )
    console.table(fails)
    console.log('%cCopy the JSON below and send it:', 'font-weight:bold')
    console.log(JSON.stringify(fails, null, 1))
  }
})()
