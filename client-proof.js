/* ============================================================
   CLIENT PROOF — the focused test.

   Two halves, and both matter:
     PART 1  the client CAN see their own curated data (a test where
             everything is empty proves nothing — it cannot tell a working
             gate from an empty database)
     PART 2  the client CANNOT see nine named categories of internal data

   Paste into the browser console signed in as the TEST CLIENT.

   ONE THING TO FILL IN FIRST — see OTHER_PROJECT_ID below. Without it the
   cross-project half cannot run, and the script says so rather than reporting
   a pass it did not earn.

   Writes: none. Every call below is a read. (The 067 admin RPCs and
   fn_assistant_quota, which DO write, live in client-security-sweep.js.)
   ============================================================ */

// ---- FILL THIS IN ----------------------------------------------------------
// A project this client must NOT be able to see. Get it as the founder:
//     select id, name from public.projects order by name;
// Pick any id that is NOT this client's own project.
const OTHER_PROJECT_ID = '7642eea2-1525-4e1d-b4e1-3b6e2240c005'
// ---------------------------------------------------------------------------

;(async () => {
  const sb = window.supabase
  if (!sb) return console.error('window.supabase missing — run npm run dev.')

  const R = []
  const pass = (part, name, detail = '') =>
    R.push({ part, check: name, result: 'PASS', detail: String(detail).slice(0, 80) })
  const fail = (part, name, detail) =>
    R.push({ part, check: name, result: 'FAIL', detail: String(detail).slice(0, 140) })

  /* ========== 0 · identity ========== */
  const { data: me, error: meErr } = await sb
    .from('profiles')
    .select('id, full_name, role')
  if (meErr) return console.error('Could not read profile:', meErr.message)
  if (me?.[0]?.role !== 'client') {
    return console.error(`Signed in as "${me?.[0]?.role}", not a client. Sign in as the test client.`)
  }
  console.log('%cProving as:', 'font-weight:bold', me[0].full_name)

  // profiles must be exactly one row: their own. If your staff appear here,
  // the profiles_read policy did not get tightened in 065.
  if (me.length === 1) pass('0 identity', 'profiles — own row only', '1 row')
  else fail('0 identity', 'profiles — own row only', `${me.length} rows`)

  const { data: proj } = await sb.from('v_client_project').select('*')
  const PID = proj?.[0]?.project_id ?? proj?.[0]?.id ?? null
  console.log('Their project:', proj?.[0]?.name, PID)

  if (proj?.length === 1) pass('0 identity', 'v_client_project — exactly 1 project', proj[0].name)
  else fail('0 identity', 'v_client_project', `${proj?.length ?? 0} rows (expected 1)`)

  /* ==========================================================
     PART 1 — what the client SHOULD see
     ========================================================== */
  // Reachable means the view answered. Rows may legitimately be 0 if you have
  // not shared anything yet — that is flagged separately, because a test run
  // against an empty portal proves far less than it appears to.
  const CURATED = [
    ['v_client_project', 'their project'],
    ['v_client_progress', 'progress by activity'],
    ['v_client_progress_summary', 'progress summary'],
    ['v_client_spend_by_category', 'spend by category'],
    ['v_client_spend_summary', 'contract vs spent'],
    ['v_client_documents', 'documents shared with them'],
    ['v_client_photos', 'photos published to them'],
    ['v_client_invoices', 'their progress bills'],
    ['v_client_approvals', 'their approvals'],
    ['v_client_messages', 'their messages'],
  ]

  let emptyCurated = 0
  for (const [v, label] of CURATED) {
    const { data, error } = await sb.from(v).select('*')
    if (error) {
      fail('1 can see', `${v} — ${label}`, 'UNREACHABLE: ' + error.message.slice(0, 60))
      continue
    }
    if (!data.length) emptyCurated++
    pass('1 can see', `${v} — ${label}`, `${data.length} row(s)`)

    // Everything returned must belong to THEIR project. One stray row from
    // another job is the whole failure this layer exists to prevent.
    const stray = data.filter((r) => 'project_id' in r && r.project_id !== PID)
    if (stray.length) {
      fail('1 can see', `${v} — FOREIGN ROWS`, `${stray.length} row(s) from another project`)
    }
  }

  /* ==========================================================
     PART 2 — the nine categories that must be refused
     ========================================================== */
  const empty = async (part, label, table, cols = '*') => {
    const { data, error } = await sb.from(table).select(cols).limit(3)
    if (error) pass(part, label, 'refused: ' + error.message.slice(0, 45))
    else if (!data.length) pass(part, label, 'zero rows')
    else fail(part, label, `${data.length} row(s): ${JSON.stringify(data[0])}`)
  }
  const rpcEmpty = async (part, label, fn, args = {}) => {
    const { data, error } = await sb.rpc(fn, args)
    if (error) return pass(part, label, 'refused: ' + error.message.slice(0, 45))
    const rows = Array.isArray(data) ? data : data == null ? [] : [data]
    if (!rows.length) pass(part, label, 'zero rows')
    else fail(part, label, `${rows.length} row(s): ${JSON.stringify(rows[0])}`)
  }

  // --- 1. Management fee — by all four routes it could travel ---
  await empty('2.1 fee', 'projects.management_fee_pct', 'projects', 'id, management_fee_pct')
  await empty('2.2 fee', 'projects.management_fee_amount', 'projects', 'id, management_fee_amount')
  await empty('2.3 fee', 'v_project_commercials', 'v_project_commercials')
  await empty('2.4 fee', 'v_project_contract', 'v_project_contract')
  // The curated project view must not even have the column.
  if (proj?.[0]) {
    const leaked = ['management_fee_pct', 'management_fee_amount', 'contract_value'].filter(
      (c) => c in proj[0],
    )
    if (leaked.length) fail('2.5 fee', 'v_client_project columns', leaked.join(', '))
    else pass('2.5 fee', 'v_client_project has no fee column')
  }
  // A management_fee invoice must never appear among their bills.
  {
    const { data } = await sb.from('v_client_invoices').select('*')
    const bad = (data ?? []).filter(
      (r) => 'inv_type' in r && String(r.inv_type) !== 'progress',
    )
    if (bad.length) fail('2.6 fee', 'v_client_invoices — non-progress bill', JSON.stringify(bad[0]))
    else pass('2.6 fee', 'v_client_invoices — progress bills only')
  }

  // --- 2. Project margin / P&L ---
  await empty('3 margin', 'v_project_pnl', 'v_project_pnl')
  await empty('3 margin', 'v_pnl_by_category', 'v_pnl_by_category')
  await rpcEmpty('3 margin', 'fn_company_pnl', 'fn_company_pnl')
  await rpcEmpty('3 margin', 'fn_project_evm (own project id)', 'fn_project_evm', { p_project: PID })

  // --- 3. Company overheads ---
  await empty('4 overheads', 'company_expenses', 'company_expenses')
  await empty('4 overheads', 'overhead_categories', 'overhead_categories')
  await rpcEmpty('4 overheads', 'fn_overhead_summary', 'fn_overhead_summary', {
    p_from: '2000-01-01',
    p_to: '2099-12-31',
  })
  await rpcEmpty('4 overheads', 'fn_company_net', 'fn_company_net', {
    p_from: '2000-01-01',
    p_to: '2099-12-31',
  })

  // --- 4. Vendor rates ---
  await empty('5 vendor rates', 'vendors', 'vendors')
  await empty('5 vendor rates', 'labour_rates', 'labour_rates')
  await empty('5 vendor rates', 'rate_comparisons', 'rate_comparisons')
  await empty('5 vendor rates', 'rc_quotes', 'rc_quotes')
  await empty('5 vendor rates', 'v_rc_matrix', 'v_rc_matrix')
  await empty('5 vendor rates', 'v_material_inward_rates', 'v_material_inward_rates')

  // --- 5. PO / GRN rates ---
  await empty('6 po/grn', 'purchase_orders', 'purchase_orders')
  await empty('6 po/grn', 'po_lines', 'po_lines')
  await empty('6 po/grn', 'goods_receipts', 'goods_receipts')
  await empty('6 po/grn', 'grn_lines', 'grn_lines')
  await empty('6 po/grn', 'v_po_lines_rated', 'v_po_lines_rated')
  await empty('6 po/grn', 'v_po_value', 'v_po_value')
  await empty('6 po/grn', 'v_po_match', 'v_po_match')

  // --- 6. Other projects ---
  await empty('7 other projects', 'projects (raw)', 'projects')
  await empty('7 other projects', 'project_members', 'project_members')
  await empty('7 other projects', 'v_portfolio_summary', 'v_portfolio_summary')

  // --- 7. Other clients ---
  {
    const { data, error } = await sb.from('client_projects').select('*')
    if (error) pass('8 other clients', 'client_projects', 'refused')
    else if (data.length === 1 && data[0].user_id === me[0].id)
      pass('8 other clients', 'client_projects — own link only', '1 row')
    else fail('8 other clients', 'client_projects', `${data.length} row(s) visible`)
  }
  await empty('8 other clients', 'v_client_roster (067)', 'v_client_roster')
  await rpcEmpty('8 other clients', 'fn_client_roster_summary (067)', 'fn_client_roster_summary')
  await empty('8 other clients', 'client_approvals (raw)', 'client_approvals')

  // --- 8. Budgets, raw ---
  await empty('9 budgets', 'budgets', 'budgets')
  await empty('9 budgets', 'expenses', 'expenses')
  await empty('9 budgets', 'v_budget_vs_actual', 'v_budget_vs_actual')
  await empty('9 budgets', 'v_project_spend', 'v_project_spend')
  await empty('9 budgets', 'schedule_activities (carries budget_amount)', 'schedule_activities')

  // --- 9. MIS ---
  await empty('10 mis', 'v_mis_projects', 'v_mis_projects')
  await rpcEmpty('10 mis', 'fn_mis_company', 'fn_mis_company')
  await rpcEmpty('10 mis', 'fn_mis_trend', 'fn_mis_trend')
  await rpcEmpty('10 mis', 'fn_mis_by_category', 'fn_mis_by_category')
  await rpcEmpty('10 mis', 'fn_mis_exceptions', 'fn_mis_exceptions')

  /* ==========================================================
     PART 3 — cross-project isolation
     ========================================================== */
  // The curated views scope off fn_client_project(), so asking them for another
  // project must return nothing. This is the check that proves the scoping is
  // in the DATABASE and not in the screen.
  if (!OTHER_PROJECT_ID) {
    console.warn(
      '%cOTHER_PROJECT_ID is empty — the cross-project half did NOT run.',
      'color:#b8863b;font-weight:bold',
    )
    R.push({
      part: '11 cross-project',
      check: 'NOT RUN — fill in OTHER_PROJECT_ID',
      result: 'SKIP',
      detail: 'select id, name from public.projects; as the founder',
    })
  } else if (OTHER_PROJECT_ID === PID) {
    fail('11 cross-project', 'OTHER_PROJECT_ID', 'that is their OWN project — use a different one')
  } else {
    for (const [v] of CURATED) {
      const { data, error } = await sb
        .from(v)
        .select('*')
        .eq('project_id', OTHER_PROJECT_ID)
      if (error) pass('11 cross-project', `${v} @ other project`, 'refused')
      else if (!data.length) pass('11 cross-project', `${v} @ other project`, 'zero rows')
      else fail('11 cross-project', `${v} @ other project`, `${data.length} row(s) LEAKED`)
    }
    // And every project-scoped function, with the other project's id.
    for (const fn of [
      'fn_project_evm',
      'fn_expense_total',
      'fn_project_snag_summary',
      'fn_qa_summary',
      'fn_safety_summary',
      'fn_project_approval_summary',
      'fn_project_health_flags',
    ]) {
      await rpcEmpty('11 cross-project', `${fn} @ other project`, fn, {
        p_project: OTHER_PROJECT_ID,
      })
    }
  }

  /* ==========================================================
     PART 5 — storage: they can open what was shared, and nothing else
     ========================================================== */
  // Migration 068. Before it, a client could see a document's TITLE and never
  // open the file, because every bucket policy keyed on is_member() — which 065
  // made false for a client. The portal would have rendered a list of names and
  // broken images.
  {
    const docs = (await sb.from('v_client_documents').select('*')).data ?? []
    if (docs.length) {
      const { data, error } = await sb.storage
        .from('documents')
        .createSignedUrl(docs[0].file_path, 60)
      if (error || !data?.signedUrl)
        fail('12 storage', 'shared document — cannot open', error?.message ?? 'no url')
      else pass('12 storage', 'shared document opens', docs[0].title)
    } else {
      R.push({
        part: '12 storage',
        check: 'no shared document to test',
        result: 'SKIP',
        detail: 'share one from the vault first',
      })
    }

    // 074 — the gallery unions two buckets, so each photo is signed against
    // its OWN bucket. A photo shared from the vault lives in `documents`.
    const photos = (await sb.from('v_client_photos').select('*')).data ?? []
    for (const ph of photos.slice(0, 4)) {
      const { data, error } = await sb.storage
        .from(ph.bucket ?? 'site-photos')
        .createSignedUrl(ph.photo_path, 60)
      if (error || !data?.signedUrl)
        fail('12 storage', `photo (${ph.source}) — cannot open`, error?.message ?? 'no url')
      else pass('12 storage', `photo (${ph.source}) opens`, ph.caption ?? '')
    }
    if (!photos.length) {
      R.push({
        part: '12 storage',
        check: 'no photo to test',
        result: 'SKIP',
        detail: 'publish one from the site log or share an image from the vault',
      })
    }

    // And the negative: a bucket a client must never read at all.
    const rec = await sb.storage.from('receipts').list(PID ?? '', { limit: 1 })
    if (rec.error || !rec.data?.length)
      pass('12 storage', 'receipts bucket — refused or empty')
    else fail('12 storage', 'receipts bucket — LISTED', `${rec.data.length} object(s)`)

    const dwg = await sb.storage.from('drawings').list(PID ?? '', { limit: 1 })
    if (dwg.error || !dwg.data?.length)
      pass('12 storage', 'drawings bucket — refused or empty')
    else fail('12 storage', 'drawings bucket — LISTED', `${dwg.data.length} object(s)`)
  }

  /* ========== report ========== */
  console.table(R)
  const fails = R.filter((r) => r.result === 'FAIL')
  const skips = R.filter((r) => r.result === 'SKIP')

  console.log(
    `%cPART 1 — the client CAN see their own data: ${
      CURATED.length - emptyCurated
    }/${CURATED.length} curated views returned rows.`,
    'font-weight:bold',
  )
  if (emptyCurated > 0) {
    console.warn(
      `${emptyCurated} curated view(s) were empty. That is not a failure, but ` +
        `an empty portal cannot distinguish a working gate from an empty ` +
        `database — share a document and publish a photo, then re-run.`,
    )
  }

  if (fails.length === 0 && skips.length === 0) {
    console.log(
      `%c✓ PROVEN — ${R.length} checks. Own data visible, all nine internal categories refused, cross-project isolation confirmed.`,
      'color:#2f6f4f;font-size:15px;font-weight:bold',
    )
  } else if (fails.length === 0) {
    console.log(
      `%c✓ ${R.length - skips.length} checks passed, but ${skips.length} were SKIPPED — see the warning above.`,
      'color:#b8863b;font-size:15px;font-weight:bold',
    )
  } else {
    console.log(
      `%c✗ ${fails.length} FAILURE(S) of ${R.length}`,
      'color:#9b3d3d;font-size:15px;font-weight:bold',
    )
    console.table(fails)
    console.log(JSON.stringify(fails, null, 1))
  }
})()
