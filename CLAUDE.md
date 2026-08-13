# MASON OS — Project Context (read this + PROGRESS.md + ROADMAP.md first, every session)

Internal construction-management app for **Your Masons** — luxury residential contractor, Bengaluru.
Max 4 active projects, ~15 internal users. Internal use only. NO public website, NO client portal.
Source spec: `YourMasons_MasterSpec_v1.docx`. ROADMAP.md is the authoritative build order — it overrides the spec.

## Session protocol
- Start: read CLAUDE.md + PROGRESS.md + ROADMAP.md, then continue the next unblocked item.
- Build ONE module per session. Never batch multiple modules.
- End: update PROGRESS.md (built / pending / known bugs) and tick the item in ROADMAP.md.
- User runs the app + migrations and pastes runtime errors verbatim. Fix errors before adding features.
- Every schema change = a new numbered migration in `supabase/migrations/`. Never edit schema ad-hoc.

## MIGRATION DISCIPLINE (mandatory — an unapplied migration cost 3 debug rounds once)
1. **At the START of every session**, list the files in `supabase/migrations/` and ASK the user to
   confirm the highest-numbered migration has been applied to the database. Wait for confirmation.
2. **Never build on an unapplied migration.** If new code reads a view/function/column from an
   unconfirmed migration, stop and confirm first. Symptom to watch for: "0 items", blank totals, or
   empty lists usually mean a view/function from a migration that never ran.
3. When a module needs SQL, deliver it BOTH ways: a numbered file in `supabase/migrations/0XX_*.sql`
   AND the full runnable block pasted in chat (users run it in the Supabase SQL editor).
4. Keep `supabase/APPLY_pending.sql` as the concatenation of all not-yet-confirmed migrations, in
   order. Every migration must be idempotent/re-runnable (enums `add value if not exists`, tables
   `if not exists`, functions/views `create or replace` or `drop … if exists` first, policies
   `drop policy if exists` before `create policy`). Cast enum assignments explicitly (`::po_status`).
5. **End every session that added SQL** with an explicit line: **"Run migration 0XX before testing."**
   (list every new migration number).

### Applied-migration ledger (update at session end)
- **001–016 ALL APPLIED** (confirmed live 2026-07-23; 016 verified via revised-contract-value working).
  **017 + 018 APPLIED** (confirmed 2026-07-25: 017 via the unregistered-vendor flow working end to
  end; 018 via audit_log showing INSERT rows on `vendors`, which only the 018 trigger writes).
  So: **001–020 ALL APPLIED** (020 confirmed 2026-07-27 — the verify SELECT returned both
  `fn_void_record` and `fn_stock_on_hand`, and they sit near the end of the script, so everything
  above them ran too).
  **021 + 022 APPLIED** (confirmed 2026-07-28). 021 = cancel/reject on PO + VO
  (`fn_cancel_document`, `fn_reject_variation`) + supervisor self-void of own stock entries;
  022 = hard delete (`fn_delete_record`).
  **023 APPLIED** (confirmed 2026-07-28) — A6 Site Instructions (`site_instructions`, `si_status`,
  `fn_set_si_status`, plus a site_instructions branch added to `fn_cancel_document`).
  **024 APPLIED** (confirmed 2026-07-28) — A4 Invoices (`invoices`, `invoice_items`,
  `invoice_type`/`invoice_status`, `fn_issue_invoice`, plus an invoices branch on
  `fn_cancel_document`).
  **025 APPLIED** (confirmed 2026-07-28) — progress-bill running-account fix
  (`invoices.less_previously_billed`, `total` regenerated as
  subtotal + gst − less_previously_billed, corrected `fn_issue_invoice`).
  **026 APPLIED** (confirmed 2026-07-28) — A7 RFIs (`rfis`, `rfi_status`/`rfi_category`,
  `fn_answer_rfi`, `fn_set_rfi_status`, plus an rfis branch on `fn_cancel_document`).
  **027 APPLIED** (confirmed 2026-08-01) — A8 Snags + DLP (`snags`,
  `snag_severity`/`snag_status`, `fn_resolve_snag`, `fn_verify_snag`, `fn_set_snag_status`,
  `fn_project_snag_summary`, `projects.dlp_start_date`/`dlp_end_date` **+ the column grant**, plus a
  snags branch on `fn_delete_record`).
  **028 APPLIED** (confirmed 2026-08-01) — A9 Compliance calendar
  (`compliance_items`, `compliance_category`/`compliance_recurrence`/`compliance_status`,
  `v_compliance_calendar`, `fn_file_compliance`, `fn_unfile_compliance`, `fn_compliance_alert`,
  `fn_compliance_sweep` + a nightly pg_cron job, the `compliance` storage bucket, plus a
  compliance_items branch on `fn_delete_record`).
  Verified 2026-08-01 by `select … from cron.job` returning
  `mason-compliance-sweep | 30 22 * * * | active=true` — that call sits in §10, so §1–§10 all ran;
  §11 (the storage bucket) is confirmed separately by the proof upload working during testing.
  **pg_cron IS enabled on this project** — future scheduled jobs can rely on it existing.
  **029 APPLIED** (confirmed 2026-08-01) — A10 Drawing register
  (`drawings`, `drawing_revisions`, `drawing_discipline`/`drawing_status`, `v_drawing_register`,
  `fn_issue_revision`, `fn_withdraw_revision`, `fn_drawing_file_is_current`, the `drawings` storage
  bucket, plus drawings/drawing_revisions branches on `fn_delete_record`).
  Verified 2026-08-01 by `select indexname … = 'drawing_rev_one_ifc_uk'` returning the index —
  that query is the LAST statement in the file, so the whole script ran.
  **030 + 031 APPLIED** (confirmed 2026-08-01). 030 = founder-level delete on the drawing register
  (founder deletes a drawing with revisions cascading, or any single revision; a PM stays limited to
  a revision-free drawing and WIP revisions). 031 = founder-created sub-folders in the document
  vault (`doc_subfolders`, `documents.subfolder_id`, plus a doc_subfolders branch on
  `fn_delete_record`).
  **032 APPLIED** (confirmed 2026-08-01) — A11 RA bills
  (`ra_bills`, `ra_bill_lines`, `ra_status`, `v_ra_bill_totals`, `v_ra_payables`,
  `fn_certify_ra_bill`, `fn_reject_ra_bill`, `fn_set_ra_status`, plus ra_bills branches on
  `fn_cancel_document` and `fn_delete_record`).
  Verified 2026-08-01 by the views query returning both `v_ra_bill_totals` and `v_ra_payables` —
  that is the last statement in the file, so the whole script ran.
  **033 APPLIED** (confirmed 2026-08-01) — A12 Retention & bank guarantees (`retention_releases`, `bank_guarantees`, `retention_milestone`/`retention_state`/
  `bg_type`/`bg_status`, `v_retention_ledger`, `v_bg_register`, `fn_release_retention`,
  `fn_set_bg_status`, `fn_bg_alert`, `fn_bg_sweep` + a nightly pg_cron job, plus
  retention_releases/bank_guarantees branches on `fn_delete_record`).
  Verified 2026-08-01 by `select … from cron.job` returning **both** `mason-bg-sweep`
  (`40 22 * * *`) and `mason-compliance-sweep` — that is the last statement in the file, so the
  whole script ran.
  **034 APPLIED** (confirmed 2026-08-01) — A13 Insurance
  (`insurance_policies`, `insurance_type`/`insurance_status`, `v_insurance_register`,
  `fn_set_policy_status`, `fn_insurance_alert`, `fn_insurance_sweep` + a nightly pg_cron job, plus
  an insurance_policies branch on `fn_delete_record`).
  Verified 2026-08-01 by `cron.job` returning all three sweeps — `mason-compliance-sweep`,
  `mason-bg-sweep` and `mason-insurance-sweep`, all active. That is the last statement in the file,
  so the whole script ran.
  **035 + 036 APPLIED** (confirmed 2026-08-01). 035 = attachments on an RFI response
  (`rfis.response_attachments`, `fn_answer_rfi` now takes `p_files text[]`). 036 = web push
  (`push_subscriptions`, `fn_daily_task_digest`, `fn_schedule_daily_push`, pg_net) plus the
  `daily-task-push` Edge Function and the `mason-daily-task-push` cron job, scheduled separately
  with the founder's own URL and secret.
  **037 APPLIED** (confirmed 2026-08-01) — the daily digest scopes projects the way `is_member()`
  does, so a founder (who has no `project_members` rows) is included.
  **038 APPLIED** (confirmed 2026-08-06) — B6 P&L (`v_project_pnl`, `v_pnl_by_category`,
  `fn_company_pnl`). Views only, no new tables.
  **039 APPLIED** (confirmed 2026-08-06) — `fn_company_pnl` scopes to the caller instead of
  demanding the founder, so the dashboard shows a margin total for PM and accounts too.
  **040 APPLIED** (confirmed 2026-08-07) — M29 part 2, company overheads
  (`company_expenses`, `overhead_category`, `fn_void_company_expense`,
  `fn_duplicate_overheads`, `fn_overhead_summary`, `fn_company_net`, plus
  `receipts_company_read`/`receipts_company_insert` storage policies for the
  `company/` prefix).
  **041 APPLIED** (confirmed 2026-08-07) — overhead headings moved from the
  `overhead_category` enum to a founder-managed `overhead_categories` table
  (`company_expenses.category` → `category_id`, `fn_delete_overhead_category`,
  `fn_overhead_summary` re-created with a new return type,
  `fn_duplicate_overheads` carrying `category_id`).
  So: **001–041 ALL APPLIED.**
  **042 APPLIED** (confirmed 2026-08-11) — B1 Schedule + EVM
  (`schedule_activities` incl. `phase`, `activity_dependencies`, `activity_id`
  on tasks/expenses/ra_bills, `projects.floors`/`plot_area_sqft` **+ the column
  grant**, `v_ra_bill_totals` re-created carrying `activity_id`,
  `fn_activity_dep_check`, `fn_set_activity_progress`, `fn_activity_float`,
  `fn_activity_evm`, `fn_project_evm`, `fn_delete_activity`,
  `fn_schedule_template`, `fn_generate_schedule`, `fn_retag_expense`,
  `fn_retag_ra_bill`, plus the column grant that withholds
  `schedule_activities.budget_amount`).
  So: **001–042 ALL APPLIED.**
  **043 WRITTEN, NOT YET APPLIED** — B2 QA/QC (`itp_templates`,
  `itp_template_items`, `itp_items`, `inspections`, `ncrs`,
  `itp_type`/`itp_status`/`inspection_result`/`ncr_severity`/`ncr_status`,
  `fn_apply_itp_template`, `fn_save_itp_template`, `fn_request_inspection`,
  `fn_record_inspection`, `fn_set_ncr_status`, `fn_blocking_holds`,
  `fn_qa_summary`, `fn_delete_itp_item`, plus **`fn_set_activity_progress`
  re-emitted with the hold-point block**). Ask before building on it.
  **044 WRITTEN, NOT YET APPLIED** — five seeded IS-referenced ITP templates
  (structural/RCC, masonry and plaster, waterproofing, finishes, MEP), 52
  points. Run AFTER 043 — it seeds tables 043 creates.
  **045 WRITTEN, NOT YET APPLIED** — checklist depth (`itp_template_checks`,
  `itp_checks`, `inspection_checks`, `check_result`, `fn_inspection_checks`,
  plus `fn_apply_itp_template` / `fn_save_itp_template` re-emitted carrying
  checklists and **`fn_record_inspection` re-emitted with a new arity — the old
  one is dropped first**). Seeds 127 questions across 20 of 044's points.
  **043–047 ALL APPLIED** (confirmed 2026-08-12). 045 aborted first time at
  `fn_inspection_checks` — `create or replace` cannot widen a return type and
  046 adds a column to it — leaving TWO arities of `fn_record_inspection` and
  the 127 seeded questions unrun; **047 repaired both** and 045's file is
  corrected in the repo for future rebuilds.
  Verified 2026-08-12: one arity each of `fn_record_inspection` and
  `fn_inspection_checks`; 8 templates / 72 points / 627 questions (127 on the
  five IS plans, 500 on the firm's own twenty sheets).
  So: **001–047 ALL APPLIED.**
  **048 + 049 APPLIED** (confirmed 2026-08-12). 048 = the structured ITP is
  REPLACED by inspection comments: drops `itp_templates`/`itp_template_items`/
  `itp_items`/`itp_checks`/`inspections`/`inspection_checks` + nine functions +
  all seeded content, drops the hold-point block from
  `fn_set_activity_progress`, adds `tasks.priority`/`tasks.assigned_to`,
  `inspection_comments`, `fn_raise_inspection_comment` and a rebuilt
  `fn_qa_summary`. NCRs stay. 049 = `documents.doc_kind` so a filed NCR stays in
  QC Certificates without also showing in the QA plan docs list, plus
  `fn_qa_summary` re-emitted to count plans only.
  So: **001–050 ALL APPLIED.**
  **050 APPLIED** (confirmed 2026-08-12) — B3 rate comparison / comparative statement
  (`rate_comparisons`, `rc_items`, `rc_vendors`, `rc_quotes`, `rc_status`,
  `v_rc_matrix`, `v_rc_vendor_totals`, `v_rc_summary`, `rc_may_read`,
  `rc_may_write`, `fn_rc_from_pr`, `fn_rc_award_item`, `fn_rc_award`,
  `fn_rc_clear_award`, `fn_rc_to_po`, `fn_delete_comparison`, three
  BEFORE UPDATE guard triggers, audit triggers on all four tables).
  Next migration = 051.
  *(043/044/046, for the record:)*
  **046 APPLIED** — the firm's OWN twenty on-site checklists
  transcribed verbatim (500 questions, 3 discipline templates, 20 points),
  `section` on template/live/answer checks, `inspections.location`, plus
  `fn_apply_itp_template` / `fn_save_itp_template` / `fn_record_inspection` /
  `fn_inspection_checks` re-emitted. Next migration = 047.
- **Gate at the row when there is no innocent half (050).** 012 revoked `po_lines.rate` column by
  column because site genuinely needs the rest of a PO — quantities, delivery dates, the material
  list. A rate comparison has no such half: every row of it exists to say what somebody would
  charge. So the whole record is gated in the RLS policy and a supervisor gets zero rows rather
  than blanked cells. The reward is that none of the column-grant traps apply — no 027 invisible
  new column, no 042 "the create block is not the source of truth". Reach for column grants only
  when a shared row has ONE secret; reach for a row policy when the row itself is the secret.
- **An RLS UPDATE policy cannot say WHICH columns (050).** The policy that lets somebody fix a
  typo in a title also lets a PATCH stamp `awarded_quote_id` with no reason and no audit row —
  the same hole 021 found on `purchase_orders`, where a CHECK constraint had to stand behind the
  RPC. Here the discriminator is `current_user`: PostgREST is `authenticated`, every RPC is
  SECURITY DEFINER and runs as the owner, so a BEFORE UPDATE trigger can refuse the decision
  columns from the client and allow them from the functions. It RAISES rather than quietly
  restoring the old value — a PATCH only sends changed columns, so the trigger fires only when
  somebody meant it, and swallowing that would hide the bug.
- **The justification belongs in the database, not the form (050).** `fn_rc_award` refuses an
  award above the lowest quote unless a reason comes with it. A form-only check is a check that
  disappears the first time anything talks to the API directly, and this particular sentence is
  the one an Open Book client reads. Same family as 020's mandatory void reason, which is a CHECK
  constraint for exactly the same reason.
- **A convenience must write the same rows as the long way round (050).** "Award everything to
  Vendor B" does not get its own column on the comparison; it writes one `rc_items.awarded_quote_id`
  per line, exactly as the per-line path does. Two representations of one decision eventually
  disagree, and here the split award — steel from one vendor, cement from another — is the normal
  case, so the per-line shape had to exist anyway.
- **A total is only comparable if it priced everything (050).** A vendor who skips two of ten items
  has the cheapest subtotal for a reason that has nothing to do with being cheap.
  `v_rc_vendor_totals` therefore computes `is_lowest_total` only over vendors with
  `items_missing = 0`, and `fn_rc_award` refuses a whole-comparison award to anyone who left a line
  blank, pointing at the per-line award instead. A missing quote is also a DELETED row rather than
  a zero — "did not quote" and "quoted nothing" are different facts.
- **Evidence must freeze when it starts being cited (050).** Once a comparison has produced a PO,
  every write policy on it refuses. If the quotes could still be edited afterwards, the statement
  would restate itself and stop being evidence of how the order was decided. Same rule as the
  certified-bill snapshot (032) and the snapshotted question wording (045).
- **Don't invent master data to make a conversion work (050).** `po_lines.material_id` is NOT NULL
  because a PO feeds stock and stock is per material, so a free-text comparison line cannot become
  a PO line. `fn_rc_to_po` names the offending lines and stops, rather than silently creating
  material records nobody asked for. The refusal also draws a real distinction worth keeping:
  materials are things you stock, free text is things you only ever price.
- **Owner-run views cannot be verified from the SQL editor (038).** The dashboard connects as
  `postgres`, so `auth.uid()` is NULL, `my_role()` is NULL and `is_founder()` is false — every
  is_member/role-gated view returns ZERO rows there, and an aggregate over that empty set returns
  one row of NULLs with count 0. That is the gate working, not missing data. Verify these through
  the app with a real JWT, and sanity-check the arithmetic in the editor by querying the underlying
  tables directly.
- **Owner-run view pattern (010 → 038):** any view that reads
  `projects.contract_value` / `management_fee_pct` must NOT be security_invoker — those columns are
  revoked from `authenticated`, so an invoker-rights view returns a permission error for everyone
  including the founder. Run it as owner and put `is_member(...) and my_role() in (...)` in the
  WHERE clause, exactly as `v_project_commercials`, `v_project_contract`, `v_po_value` and now
  `v_project_pnl` do. The WHERE clause IS the access control in that pattern — losing it is a
  silent full-table leak, so it is the first thing to check when editing one.
- **Don't model a non-project cost as a pseudo-project (040).** Company overheads could have been an
  "Office" project with expenses hanging off it. Every existing view — portfolio spend, budget vs
  actual, `v_project_pnl`, the dashboard cards — would then have had to learn to exclude one magic
  row, and each of them would be one edit away from silently including it again. A separate table
  keeps `expenses` meaning exactly what it has always meant: money spent ON A SITE. Reach for a new
  table whenever a record would be a member of a set that every query already filters on.
- **Store what a row IS, don't infer it from the title (049).** A filed NCR and an uploaded QA plan
  share the QC Certificates folder, and the shortcut for telling them apart is hiding titles matching
  "NCR-%". That works until somebody renames a file, or writes a plan called "NCR response
  procedure" — then a document silently vanishes from a list with no way to work out why.
  `documents.doc_kind` records the source instead. Open text rather than an enum, because PO, SI and
  VO will all want labelling later and an enum means a migration each time.
- **Build the thing the site will actually use (048).** 043–047 built a full ITP: templates, hold
  points, 627 checklist questions, derived results. The founder looked at it against how the firm
  works and replaced it with a comment, a photo and a priority. That is not wasted work being
  admitted — it is the client seeing their own process clearly, and the right response is to delete
  cleanly rather than keep the machinery "in case". A site walk produces OBSERVATIONS, not
  thirty-question forms.
- **`create or replace function` cannot widen a return type (045→046, found in production).** It
  fails with 42P13 "cannot change return type of existing function", and in a multi-statement script
  that abort leaves everything AFTER it unrun — in this case the seed data — while everything before
  it stands. Any function a later migration might extend must be written `drop function if exists`
  then `create`, not `create or replace`. The verify block that counts arities is what caught it;
  keep writing that check.
- **Take the client's own form, do not improve it (046).** The founder's twenty site checklists went
  in verbatim — their wording, their spellings, their section headings, their order. An app that
  quietly tidies the phrasing leaves the paper copy and the phone copy saying different things, and
  the site trusts the paper. Same rule for labels: their sheet reads YES / NO / N/A, so the screen
  does, while the stored enum stays pass/fail/na. Relabelling is a screen decision; re-cutting an
  enum that already has answers stored against it is not.
- **A summary must not be able to contradict its own evidence (045).** An inspection's headline
  result is DERIVED from the checklist answers inside `fn_record_inspection`, and an inspector who
  fails a check and then selects "pass" is overruled. The sub-answers are what somebody points at in
  two years; the headline is a convenience. Anywhere a record has both a detail level and a summary,
  compute the summary — do not accept it as input.
- **Snapshot the question, not just the answer (045).** `inspection_checks.question` stores the
  wording AS ASKED alongside the FK to the live check. Edit or delete the question next month and
  every completed inspection still reads correctly. Same family as 032's certified-bill snapshot: a
  record that restates itself when its source is edited is not a record.
- **Cite a standard, never transcribe it (044).** IS codes are copyrighted and sold by BIS. The
  seeded ITP templates carry each standard's NUMBER and TITLE — facts, and the normal way an ITP
  states its basis — plus acceptance criteria written from scratch, phrased "as specified" or "per
  drawing" wherever the real limit lives in the code or the project spec. That is not a workaround;
  it is how a working ITP reads, because the binding number is on the drawing. Any future seeded
  content follows the same line, and anything unverified is left BLANK rather than guessed.
- **Don't add a fifth role to solve one module (043).** B2 asked for "founder/PM or a QA role".
  `profiles.role` is the four-value enum EVERY policy since 001 checks, and `designation` is
  display-only by rule — a fifth value would mean re-auditing every policy in the database for one
  feature. A quality engineer gets the `pm` access role with the "Quality Engineer" job title, which
  is exactly what the designation→role mapping exists for. Reach for the existing mapping before
  reaching for the enum; if QA ever genuinely needs separating, that is its own migration with its
  own audit, not a side effect.
- **A hold point with an override is a checklist (043).** `fn_set_activity_progress` refuses to
  raise progress on an activity whose predecessor carries an unsigned hold, names the point, and has
  no bypass — the difference between a hold point and a checklist is precisely that you cannot walk
  past it. What it blocks is RECORDING, not the work: the app cannot stop a pour, but it can refuse
  to accept a claim of progress past an unsigned hold. Reducing progress stays allowed, or the block
  would prevent correcting a mistake.
- **One act, one transaction, one code path (043).** `fn_record_inspection` writes the inspection,
  moves the ITP status AND raises the NCR on a fail. `inspections` deliberately has NO insert policy
  at all, so that function is the only way an inspection can exist — two paths would eventually
  produce a failed inspection whose NCR was never raised, which is exactly how a defect gets
  forgotten.
- **`create table if not exists` does NOT add a column you added later (042, found in testing).** A
  migration that is edited after someone has already run it will silently skip the new column, and
  the first statement that names it — a column grant, an insert, a view — aborts the whole script.
  Every column added to a table AFTER that table's `create` first shipped needs its own
  `alter table … add column if not exists`, even when the create statement above it already lists
  the column. Same family as the 027 column-grant trap: the create block is not the source of truth
  once the table exists anywhere.
- **Measure the natural length by dry-running the real layout (042).** `fn_generate_schedule` scales
  every duration so the chain lands on the requested handover date. Summing the non-parallel base
  durations to get that "natural length" was wrong by about a week: a parallel branch outlasting the
  activity it runs beside pushes the cursor on, and a plain sum can't see it. Walking the same
  algorithm at scale 1 measures what actually gets laid out. Whole-day rounding still leaves a few
  days either way, so the final handover activity is stretched to end exactly on the target — a
  programme that claims one date and draws a bar to another is not trusted twice.
- **A generator must report its own compression (042).** The template's durations say how long a
  build of that size takes; the founder's dates say how long they have. When the second is much
  smaller the function still generates — that is the founder's call, not the database's — but it
  returns `compression` (target ÷ natural) and the screen warns below 0.7. Silently squashing 18
  months into 10 and presenting it as a plan would be the most damaging thing that module could do.
- **One table can serve two audiences if the SECRET is a column (042).** The schedule is for
  everyone; its budget is not. Rather than two tables kept in step, `budget_amount` is revoked from
  `authenticated` and granted back nowhere — every figure derived from it lives behind an owner-run
  function gated on role. The corollary caught us in the same migration: a column grant is table-wide
  for the role, so ANY update policy loose enough to let a supervisor set `pct_complete` also lets
  them set the budget. Hence `fn_set_activity_progress` — a controlled write is the answer whenever
  the row is shared but one column isn't.
- **A SQL function's RETURNS TABLE names are in scope in its body (042).** `fn_activity_evm` returns
  columns called `pv`, `ev`, `ac`, `bac`, `code`, `name` — all of which are also CTE column names, so
  a bare mention is ambiguous between the output parameter and the column. Qualify EVERY reference
  (`e.pv`, `sum(a.bac)`) in any function whose output names could collide, or it fails at create time
  with an ambiguity error that reads like a typo.
- **Nest recursion at the top level, not inside a CTE (042).** A `with recursive` buried inside an
  ordinary CTE is legal and fragile. `WITH RECURSIVE` lets recursive and non-recursive CTEs sit side
  by side in one flat list — use that, and both CPM passes stay readable.
- **A configurable list needs one editor, not none (041).** 040 kept overhead headings as an enum to
  stop the list fragmenting. The real risk was never that the list changes — it is that TWO people
  change it and "Internet" and "Office utilities" become two series nobody can compare. So the table
  is founder-write / accounts-read, with a unique index on `lower(btrim(name))` (case and a trailing
  space are how duplicates actually get created), rename-by-id so a spelling fix corrects history
  instead of forking it, and **retire, not delete**, for anything with entries behind it. Reach for
  this shape — single editor + normalised uniqueness + retire — before reaching for an enum.
- **Two spans in one figure must be labelled (040).** `fn_company_net` subtracts overheads for the
  CHOSEN PERIOD from project margin that is LIFETIME to date. That is the right comparison for a
  financial year and a misleading one for a single month, so the card names both spans on screen.
  Any figure combining two different time windows says so, or it is a trap.
- **Retention is not a margin deduction (038):** the retained slice of a certified RA bill is
  already inside total cost — the work was done and is owed. Subtracting "retention held" from
  margin as well would double-count it, flattering any project holding retention and worsening the
  figure as tranches are released. P&L therefore reports margin = revenue − cost, and carries
  retention alongside as a cash memo.
- **is_member() semantics lesson (037):** `is_member()` returns TRUE for a founder on every project
  *without any `project_members` row*, so founders have none. Any query that asks "which projects
  does this person work on" by joining `project_members` directly will silently return nothing for
  the founder — which is exactly how `fn_daily_task_digest` claimed there was nothing due while a
  pending task sat on screen. Scope the same way RLS scopes, or the two disagree precisely when it
  matters.
- **SQL-editor caller lesson (036):** the dashboard SQL editor connects as `postgres`, so
  `auth.uid()` is NULL and `my_role()` returns NULL. Any function meant to be run from there must
  gate as `if auth.uid() is not null and my_role() <> 'founder'` — a bare `my_role() <> 'founder'`
  locks the founder out of their own setup step. The sweep functions in 028/033/034 already had
  this shape; `fn_schedule_daily_push` didn't, and failed on first use.
- **Push is a nudge, never a record (036).** A phone that is off or has revoked permission misses
  it, so nothing in the app may depend on a notification having arrived — the task list stays the
  truth. Subscriptions are per DEVICE (the browser issues one endpoint per install), and a 404/410
  from the push service marks the row `disabled_at` rather than deleting it, so "why did Ravi stop
  getting these" stays answerable.
- **Function-signature lesson (035):** adding a defaulted parameter to an existing function creates
  an OVERLOAD, not a replacement — the old arity survives and later calls become ambiguous.
  `drop function if exists fn_x(old, arg, types);` FIRST, then create. The verify block should count
  the rows in `pg_proc` for that name: two means the drop was missed.
- **Expiry-register pattern (028 → 033 → 034):** compliance deadlines, bank guarantees and
  insurance policies are now three instances of one shape — nullable-or-scoped project, a view that
  derives `display_status` from a date in Asia/Kolkata at query time, a nightly pg_cron sweep that
  only persists the status, an invoker-rights `fn_*_alert()` returning counts, and a dashboard strip
  that renders nothing when the count is zero. A fourth one should reuse this shape rather than
  invent a new one.
- **Derived-balance lesson (033):** retention *held* is never a stored number — it is summed from
  certified `ra_bills` inside `v_retention_ledger`, and the balance is held − released, computed on
  read. A stored balance drifts the first moment a bill is cancelled. The general rule: if a figure
  is a consequence of other rows, do not give anyone a field to type it into.
- **Snapshot-vs-view lesson (032):** a figure that authorises a payment is FROZEN in columns when it
  is approved, never recomputed from its lines on read. `v_ra_bill_totals` previews the arithmetic
  while a bill is in review, then `coalesce(stored, live)` makes the stored snapshot win the moment
  it exists — otherwise editing a measurement months later would silently restate a bill that has
  already been paid. Same rule as `fn_issue_invoice` (024).
- **Container-delete lesson (031):** a sub-folder's FK from `documents` is **ON DELETE SET NULL**,
  never cascade. Deleting a container must not take the contents with it — the files reappear at the
  parent folder's root. Reach for SET NULL any time the child can meaningfully exist without the
  parent.
- **Partial-unique-index lesson (029):** "at most one current version" is expressible as
  `create unique index … (parent_id) where status = 'x'`. That is a far stronger guarantee than an
  RPC that remembers to demote the old row, and it costs one line. When a module has a "there can
  only be one live X" rule, reach for this before writing procedural code to maintain it. The RPC
  still does the swap — but it demotes the old row BEFORE promoting the new one, or the index
  rejects it mid-transaction.
- **Background-job lesson (028):** the nightly sweep writes `status = 'overdue'`, but nothing in the
  UI reads that column — `v_compliance_calendar` derives overdue/due-soon from `due_date` in
  Asia/Kolkata at query time. pg_cron is not guaranteed to be enabled, and a deadline screen whose
  correctness depends on a background job having run is a screen you cannot trust. Any future
  scheduled job should follow the same split: the job is bookkeeping, the view is truth.
- **Column-grant lesson (027):** migration 010 revoked SELECT on `projects` and granted an explicit
  column list. Any column added to `projects` afterwards is therefore invisible to every user until
  it is named in a new `grant select (col) on public.projects to authenticated`. Same trap as 020's
  grant on `material_inward`. Adding a column to a column-granted table is two statements, never one.
- **Enum lesson (021):** `alter type … add value` commits the label, but the new label CANNOT be
  used elsewhere in the same transaction — and the Supabase SQL editor runs a script as one. Write
  every comparison against a newly added label as `status::text = 'x'`, never the enum literal.
  Inside plpgsql bodies it's safe (resolved at call time), but outside it isn't.
- Re-run lessons baked into APPLY_pending.sql: drop dependent views with CASCADE (v_project_spend →
  v_portfolio_summary); cast enum assignments explicitly (`::po_status`).
- **NEVER use `create or replace view` when redefining an existing view.** It cannot add a column
  mid-list, reorder, rename or drop one — Postgres reports it as "cannot change name of view column
  X to Y" or "cannot drop columns from view". ALWAYS `drop view if exists <name> cascade;` then
  `create view`. This has now bitten three times (013 v_po_match/v_po_totals, 018
  v_material_inward). Default to drop-then-create for every view redefinition, no exceptions.
- **pglast/libpg_query CANNOT parse `returns trigger` functions** — it throws JSONDecodeError on
  every one, including a three-line trivial case and `fn_audit` from 001, which has run in
  production since day one. When pre-flighting a migration, a FAIL on a trigger function is the
  tool, not the SQL. Non-trigger functions parse fine and are worth checking. (Confirmed 2026-07-28
  by parsing a minimal trigger fn and an already-applied one.)
- Views/functions that break silently if their migration is skipped (watch for "0 items"/blank totals):
  007 (`v_project_spend.remaining/pct_used`), 009 (`v_portfolio_summary`),
  013 (`v_po_totals`/`v_po_value`/`v_po_match`), 015 (`fn_receive_goods`).

## Stack (fixed — never substitute)
- Frontend: Vite + React 18 + TypeScript + Tailwind v4 + shadcn/ui (Base UI / Nova preset) + Zustand + React Router
- Motion: framer-motion. Toasts: sonner. Icons: lucide-react.
- Backend: Supabase — Postgres, Auth, Storage, RLS, Edge Functions, pg_cron
- PDF: client-side (jsPDF) — no server rendering
- Deploy: Cloudflare Pages. Repo: GitHub. No Firebase, no AWS, no Express, no paid APIs.

## Non-negotiable engineering rules
1. **RLS on every table. No exceptions.** Never use the service-role key in frontend code.
2. **All money/quantity math in Postgres** (generated columns, views, RPC, triggers). The browser only displays computed numbers — never totals, balances, fees, EVM indices, stock.
3. **Storage:** every file path starts `${projectId}/${uuid}`. Storage RLS keys off the leading project_id segment via `is_member()`. Confidential docs also gated by role.
4. **Images compressed client-side ≤300KB** before upload. NEVER compress PDFs/DWG/other binaries — upload byte-for-byte.
5. **Audit log**: trigger-based, append-only, on every financial + material + approval table.
6. Amounts `numeric(14,2)`, INR only. Dates `Asia/Kolkata`. Quantities `numeric(12,2)`.
7. Resolve the selected project from the Zustand project store (`useProjects(s => s.selectedId)`) — NOT useOutletContext (it crashed once between RequireRole and the provider).
8. Mobile-first. Primary device = phone on a construction site. Min 48px touch targets, camera-first inputs, minimal typing.
9. Queries in `src/lib/queries/` — one file per module. Keep components small.
10. **TYPECHECK WITH `npx tsc -b --force`, NEVER `npx tsc --noEmit`.** The root `tsconfig.json` has
    `"files": []` and only project references, so `--noEmit` compiles nothing and **always exits 0**
    — it will happily report "clean" on a file with broken JSX. `package.json`'s build script uses
    `tsc -b` correctly. Anything else is a false pass. (Found 2026-07-28 after a bad codemod left
    13 files with mangled JSX and `--noEmit` reported success.)

## Roles → access matrix (RLS enforces; verify on EVERY new module)
| Role | Sees | Cannot |
|---|---|---|
| founder | everything, all projects | — |
| pm | all modules, assigned projects only | approve records they raised |
| supervisor | tasks, site log, materials, petty-cash entry, safety, snags — assigned project only | any money/budget/vendor-rate/financial figure; confidential docs |
| accounts | all money modules, all projects, documents(invoices) | write tasks/site logs/materials |

**Money-hiding is the #1 correctness rule.** Any new screen that shows figures must hide them from supervisors exactly like the dashboard card does ("restricted for your role"). Re-run the supervisor incognito test after any module that touches money.

## DESIGN SYSTEM (apply to every screen — this is a premium/luxury brand)
Aesthetic: restrained luxury — architect's studio, not consumer app. Refined, calm, expensive. Precision over decoration.

**Typography**
- Display/headings/big numbers: serif — "Fraunces" or "Playfair Display" (project names, money figures, stats, section titles).
- Body/UI/forms/tables: clean sans — "Geist" or "Satoshi".
- Load via @fontsource. Money & key stats use tabular-nums, large, serif — make numbers feel important.

**Color tokens (CSS variables, light theme)**
- `--bg` warm off-white `#FAF8F5`
- `--surface` `#FFFFFF`, `--border` warm `#EDE9E3`
- `--ink` charcoal `#1A1A18`, `--muted` `#6B6560`
- `--accent` brass/bronze `#A67C52` (used SPARINGLY: primary actions, active tab, key figures)
- `--positive` `#2F6F4F` · `--warning` `#B8863B` · `--danger` `#9B3D3D`
- Most of every screen is ink-on-off-white; accent appears rarely.

**Components**
- Cards: 24px+ padding, 12–16px radius, soft layered shadow, thin warm border. Feel like a printed report card.
- Bottom tab bar: lucide icons, active tab brass with subtle indicator + smooth transition.
- Forms: ≥48px inputs, clear labels, comfortable spacing.
- Tables/ledgers: airy rows, subtle hover, right-aligned tabular-nums amounts.
- Progress/over-budget: bar clearly shows ratio and expresses overflow past 100% in danger.

**Motion & feedback (mandatory on every module)**
- Page-load: ONE orchestrated staggered fade-up of cards (framer-motion, animation-delay).
- Buttons: subtle press/scale.
- **sonner toast on every save/error/success** — no silent actions, ever.
- **Loading skeletons** while data fetches — never a blank screen.
- **Empty states**: friendly line + primary action (e.g. "No expenses yet — Add your first").

**Never**: Inter/Roboto/Arial/system fonts, purple gradients, generic AI card layouts, harsh shadows.

## Navigation pattern
- Dashboard cards → tap → `/project/:id` detail → sets selectedId in store → all bottom tabs stay scoped to that project.
- "View ledger / tasks / stock / documents" buttons open the relevant tab already filtered to the project.

## What is BUILT (do not rebuild)
Dashboard + Project Detail · Open Book (expenses/budgets/receipts) · Petty Cash · Tasks + rollover + Daily Site Log · Materials (inward/issue/stock) · Document Vault · Vendors (data only, screen pending) · Roles/RLS (tested) · Audit log · Storage security (migrations 001–006 applied) · Safety (A2) · Procurement PR→PO→GRN→3-way match (A3) · Variation Orders (A5) · **Admin (founder-only): create projects, create users with job titles + access roles, assign project membership.**

## Record removal — the rule (don't add hard delete to money or stock)
Three different mechanisms, chosen by what the record affects:
1. **Hard delete** — only for records with no downstream effect: tasks, site logs, safety
   checklists, incidents, documents, **draft (still `requested`) PRs**, unreferenced
   vendors/materials, budget lines. Founder/PM (budgets: founder/accounts), confirm dialog, and
   **blocked with a message naming what's in the way** if anything references it. The only path is
   `fn_delete_record(p_table, p_id)`; no DELETE policies exist on these tables, so RLS default-deny
   means the RPC cannot be bypassed. *(migration 022)*
   **Projects and users are NOT deletable** — a project cascades to every record hanging off it,
   and a person's name is stamped on what they raised. Archive the project (status) and deactivate
   the user instead; both are already on the Admin screen.
2. **Void/reverse** — for anything financial or stock-bearing. The row stays, marked VOID, and is
   excluded from every total by the **server-side view/RPC**, never by a client filter. Reason is
   mandatory (a CHECK constraint enforces it). Money = founder/accounts, stock = founder/pm —
   **plus a supervisor voiding an inward/issue they created themselves** (021: they log the stock,
   so they make the typos). The ONLY path is `fn_void_record(p_table, p_id, p_reason)`; there is
   deliberately no UPDATE policy on `voided_at`, so the client cannot flip it directly.
   *(migrations 020, 021)*
3. **Cancel/reject status** — for workflow documents (PO, VO, and SI/RFI when A6/A7 ship). Excluded
   from active lists and from value/match calculations. Cancelling a PO that still has a live GRN or
   invoice is blocked — void those first. PO = founder/pm, VO = founder (mirrors who approves).
   The only path is `fn_cancel_document(p_table, p_id, p_reason)`, and a CHECK constraint requiring
   `cancelled_at`+`cancelled_by`+reason is what stops a direct client UPDATE reaching `cancelled`
   (purchase_orders has a writable UPDATE policy, so the RPC alone wasn't enough). *(migration 021)*

Voiding cascades, and the cascade is why the back-links exist: a GRN void reverses the
`material_inward` rows it created (`grn_line_id`), a petty-cash void reverses the mirrored expense
(`pc_entry_id`), an invoice void reverses the expense it posted (`po_invoices.expense_id`). Guards
refuse a void that would push stock below zero or strand a posted invoice.

## Admin module — how roles work (don't redesign this)
`profiles.designation` is a **display-only job title** (Site Engineer, Billing Engineer, Planning
Engineer, Project Lead…). `profiles.role` stays the 4-value enum RLS checks. `DESIGNATIONS` in
`src/lib/types.ts` maps each title → one access role. Adding a new job title is a TS-only change and
can never widen anyone's data access. Never make `designation` load-bearing in a policy.
User creation goes through the `admin-create-user` Edge Function, which holds the service-role key
server-side and re-verifies the caller is a founder.

## What is CUT (never build — not software or out of scope)
360°/Matterport(20), Payroll(23), CRM/website(25), Drone(40), IoT(41), Time-lapse(42), Digital Twin(43), WhatsApp(44), AR(45), Aadhaar OTP(49), Health Check(53), Carbon(54), Memory Book(55).

Everything else = ROADMAP.md, built in order, one per session.
