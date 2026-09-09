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
  So: **001–053 ALL APPLIED.**
  **054 APPLIED** (confirmed 2026-08-14) — B5 Contract Labour (`labour_trades`,
  `labour_contractors`, `labour_workers`, `labour_rates`, `labour_attendance`,
  `labour_postings`, `fn_labour_rate`, `v_labour_attendance`, `v_labour_cost`,
  `v_labour_project_cost`, `fn_muster_roll`, `fn_wage_register`,
  `fn_overtime_register`, `fn_void_attendance`, `fn_labour_licence_alert`,
  `fn_labour_headcount_check`, `fn_labour_reconcile`, `fn_post_labour_expense`).
  Verified on a real PostgreSQL: three clean runs, arithmetic checked by hand,
  all four guards confirmed firing.
  **055 APPLIED** (confirmed 2026-08-14) — `fn_labour_effort`, the no-money
  labour roll-up behind History -> Labour. One read-only function.
  So: **001–055 ALL APPLIED.**
  **056 WRITTEN, NOT YET APPLIED** — B7 MIS reports & KPI dashboard
  (`v_mis_projects`, `fn_mis_company`, `fn_mis_trend`, `fn_mis_by_category`,
  `fn_mis_exceptions`). Read-only: one view, four functions, no tables and no
  triggers. Verified on a real PostgreSQL — three clean runs, KPI totals hand
  checked, PM overhead gate and supervisor zero-rows both confirmed.
  **CORRECTED TWICE after failing on paste** — `pnl.project_name` (the view
  selects `p.name` unaliased) and `e.expense_date` on `company_expenses` (its
  column is `spend_date`). Both were bad sandbox stubs; see the lesson below.
  **057 WRITTEN, NOT YET APPLIED** — C1 Mason Learn (`learn_categories`,
  `learn_articles`, `learn_steps`, `learn_kind`/`learn_status`,
  `v_learn_articles`, `fn_learn_search`, `fn_learn_by_ref`,
  `fn_learn_normalise_ref`, `fn_learn_category_counts`, `fn_learn_set_status`,
  trigger-maintained tsvectors, and three storage policies for the `library/`
  prefix). Verified on a real PostgreSQL: three clean runs, search behaviour and
  all three guards exercised.
  **058 WRITTEN, NOT YET APPLIED** — `learn_articles.ai_drafted_at` +
  `ai_model`, provenance for the Gemini skeleton drafter. Two columns, no
  policies. Ships with the `learn-draft` Edge Function, which needs
  `supabase secrets set GEMINI_API_KEY=…` and
  `supabase functions deploy learn-draft` before the button works.
  **050 APPLIED** (confirmed 2026-08-12) — B3 rate comparison / comparative statement
  (`rate_comparisons`, `rc_items`, `rc_vendors`, `rc_quotes`, `rc_status`,
  `v_rc_matrix`, `v_rc_vendor_totals`, `v_rc_summary`, `rc_may_read`,
  `rc_may_write`, `fn_rc_from_pr`, `fn_rc_award_item`, `fn_rc_award`,
  `fn_rc_clear_award`, `fn_rc_to_po`, `fn_delete_comparison`, three
  BEFORE UPDATE guard triggers, audit triggers on all four tables).
  **051 APPLIED** (confirmed 2026-08-14) — B4 Bar Bending Schedule per IS 2502
  (`bbs_constants`, `bbs_shapes`, `bbs_members`, `bbs_bars`,
  `bbs_member_type`/`bbs_formula_kind`, `fn_bbs_cutting_length`,
  `fn_bbs_unit_weight`, `v_bbs_bars`, `v_bbs_member_totals`,
  `v_bbs_project_steel`, `fn_bbs_selftest`, `fn_audit_by_code`,
  `fn_bbs_touch_constant`).
  **052 APPLIED** (confirmed 2026-08-14) — callout expansion: member geometry on
  `bbs_members` (length/width/depth/cover/anchorage/circular/diameter +
  `callout_text`), `bbs_bars.from_callout`, `fn_bbs_parse_callouts` (pure),
  `fn_bbs_preview_callouts`, `fn_bbs_apply_callouts` (all-or-nothing),
  `fn_bbs_callout_selftest` (5/5). Run AFTER 051.
  **053 APPLIED** (confirmed 2026-08-14) — the firm's own BBS sheet layout
  (`stock_length_m`, `unit_weight_decimals`, `unit_weight_divisor` moved
  162 -> 162.2 guarded on the seeded value, `fn_bbs_unit_weight` re-emitted to
  round to the printed decimals, `v_bbs_bars`/`v_bbs_member_totals` recreated,
  `v_bbs_project_steel` gaining `total_tonnes` + `pieces_required`,
  `fn_bbs_mark_audit`). Run AFTER 052.
  **Verified against a real PostgreSQL before shipping** (pgserver in the
  sandbox, not just pglast): runs clean THREE times under `ON_ERROR_STOP=1`,
  and `fn_bbs_selftest()` returns 8/8 passing at 0.00 mm. That run found two
  bugs a read-through had missed — see the two lessons below.
  **059 APPLIED** (confirmed 2026-08-21) — C1 part 2, library documents
  (`learn_documents` with a NULLABLE `article_id` so one table serves both a
  standalone document and an article attachment, `doc_extract_status`,
  `fn_learn_doc_touch` + trigger tsvector, `v_learn_documents`,
  `v_learn_articles` rebuilt, `fn_learn_doc_search`, `fn_learn_retrieve`,
  `fn_learn_category_counts` and `fn_learn_by_ref` re-emitted, and
  `learn_articles.attachments` migrated in then DROPPED). Verified on a real
  PostgreSQL — three clean runs, fixtures built by RUNNING 057/058 rather than
  hand-typing them, all four guards confirmed firing.
  **060 APPLIED** (confirmed 2026-08-21) — C2 Client Approvals (`client_approvals`,
  `approval_subject`/`approval_method`/`approval_state`, `approval_no_seq`,
  `v_client_approvals`, `fn_set_approval_status`,
  `fn_project_approval_summary`, `fn_delete_approval`, `fn_ca_guard` +
  `fn_ca_touch` triggers, audit trigger). Independent of 059 — it touches
  projects/variation_orders/documents/materials only, all from 001-016.
  Verified on a real PostgreSQL with the ACTUAL 001-016 chain as fixtures, not
  stubs; three clean runs, all eight guards confirmed firing.
  So: **001-060 ALL APPLIED.**
  **061 APPLIED** (confirmed 2026-08-25) — D1 AI Photo Helper (`photo_analyses`,
  `photo_source`/`analysis_state`, `fn_pa_guard` + `fn_pa_touch` triggers,
  `fn_accept_photo_analysis`, `fn_dismiss_photo_analysis`,
  `fn_reanalyse_photo`, `fn_photo_analysis_summary`, audit trigger). Ships with
  the `photo-analyse` Edge Function, which REUSES the existing
  `GEMINI_API_KEY` — secrets are project-wide — and needs only
  `supabase functions deploy photo-analyse`. Verified on a real PostgreSQL with
  the whole 001-060 chain as fixtures; three clean runs, eleven guards
  confirmed firing.
  **062 APPLIED** (confirmed 2026-08-25) — D2 Clash register (`clashes`,
  `clash_severity`/`clash_status`, `clash_no_seq`, `v_clashes`,
  `fn_set_clash_status`, `fn_raise_rfi_from_clash`,
  `fn_project_clash_summary`, `fn_delete_clash`, `fn_clash_guard` +
  `fn_clash_touch` triggers, audit trigger). Independent of 061 — it touches
  projects/profiles/drawings/rfis only, all from 001-029. Verified on a real
  PostgreSQL with the actual 001-060 chain as fixtures; three clean runs,
  twelve guards confirmed firing.
  So: **001-062 ALL APPLIED.**
  **063 APPLIED** (confirmed 2026-08-28) — D3 Health signals
  (`project_health_snapshots` + nightly pg_cron job, `health_flag_acks`,
  `signal_category`/`signal_level`, `fn_capture_health_snapshot`,
  `fn_project_health_flags`, `fn_deadline_signals`, `fn_health_trend`,
  `fn_ack_health_flag`, `fn_unack_health_flag`, audit trigger on the acks).
  Verified on a real PostgreSQL with the actual 001-062 chain as fixtures;
  three clean runs, ten guards confirmed firing, arithmetic hand-checked.
  So: **001-063 ALL APPLIED. Groups A, B, C and D are complete.**
  **064 APPLIED** (confirmed 2026-08-28) — in-app AI assistant (`chat_threads`,
  `chat_messages`, `assistant_actions`, `assistant_usage`,
  `assistant_action_kind`/`assistant_action_state`/`chat_role`,
  `fn_assistant_quota`, `fn_assistant_propose`, `fn_assistant_execute`,
  `fn_assistant_cancel`, `fn_assistant_stats`, audit trigger on the actions).
  Ships with the `assistant` Edge Function, which REUSES the existing
  `GEMINI_API_KEY` and needs `supabase functions deploy assistant`. Verified on
  a real PostgreSQL with the whole 001-063 chain as fixtures; three clean runs,
  nine guards confirmed firing.
  So: **001-064 ALL APPLIED.**
  **065 APPLIED** (confirmed 2026-08-29) — CLIENT role + curated client data layer
  (`client_projects`, `client_photos`, `client_messages`, `is_client`,
  `is_internal`, `fn_client_project`, a HARDENED `is_member`, ten `v_client_*`
  views, `fn_client_decide`, `fn_record_invoice_payment`,
  `documents.client_visible`, `invoices.paid_on/paid_amount`, audit triggers).
  Verified on a real PostgreSQL with the whole 001-064 chain and TWO clients on
  TWO projects; three clean runs, every internal surface zero, cross-client
  isolation confirmed, and the defence-in-depth case (client wrongly added to
  project_members) confirmed still closed.
  Confirmed live 2026-08-29: a real client account signs in, is redirected to
  /portal, and sees its own project name through `v_client_project` — the whole
  chain (JWT -> is_client -> fn_client_project -> owner-run view) proven end to
  end through a real session.
  So: **001-065 ALL APPLIED.**
  **066 APPLIED** (confirmed 2026-08-29) — an aggregate must return ZERO ROWS
  to a client, never one row of zeros. Fifteen functions re-emitted with the
  same one-line wrapper, `v_portfolio_summary` rebuilt, `assistant_usage`'s
  select policy tightened, `fn_assistant_quota` made to raise for a client,
  and `fn_schedule_template` renamed to `_rows` + revoked with a filtered
  wrapper over it. Verified on a real PostgreSQL with the ACTUAL 001-065 chain
  as fixtures: three clean runs, founder/supervisor unchanged, all sixteen
  surfaces zero for a client. Then verified LIVE — the client sweep reports
  147/147 refused or empty.
  So: **001-066 ALL APPLIED.**
  **067 APPLIED** — the founder's client roster
  (`v_client_roster` with per-client EXPOSURE counts, `fn_set_client_active`,
  `fn_unlink_client`, `fn_link_client`, `fn_client_roster_summary`,
  `fn_projects_without_client`). Ships with a `client` branch in
  `admin-create-user` (needs `supabase functions deploy admin-create-user`) and
  the `/admin/clients` tab. Verified on a real PostgreSQL with the ACTUAL
  001-066 chain: three clean runs, founder/pm/accounts see the roster,
  supervisor and client get zero rows, all three guards confirmed firing.
  **068 APPLIED** — a client can DOWNLOAD what was shared
  (`site_photos_client_read`, `documents_client_read` on storage.objects).
  Ships with CP3 (the portal screens) and CP4 (the share toggles).
  **069 APPLIED** — `documents` had NO UPDATE policy, so every
  update to a document has always been refused. Adds `fn_set_document_shared`
  and `fn_set_document_subfolder` (repairing 031, broken since it shipped).
  **070 APPLIED** — 068's two storage policies could never
  have worked; they query `public.documents` / `public.client_photos` directly,
  and a policy's subquery inherits THAT table's RLS. Re-emitted against the
  owner-run `v_client_documents` / `v_client_photos` views.
  **071 APPLIED** — 065 clobbered 060's internal approvals
  register by reusing its view name. Restores it as `v_approval_register`.
  **072 APPLIED** — `fn_mark_client_messages_read`, so the
  team side of the client thread can clear `read_at`. Ships with
  `/tasks/messages` (the thread + reply box) and `queries/clientMessages.ts`.
  **073 APPLIED** — client attention signals
  (`client_approvals.team_seen_at` + partial index, `fn_mark_approvals_seen`,
  `fn_client_attention`). Ships with the "From your client" dashboard strip and
  seen-marking on the approvals register.
  **074 APPLIED** — `v_client_photos` becomes a union of
  published site-log photos and shared image documents, each row carrying its
  `bucket`. One gallery whichever way a picture was shared.
  **075 APPLIED** — client review fixes: revised contract in
  the portal (`v_client_spend_summary` gains contract / approved-variations /
  revised, returned separately), and document sharing that is opt-in BY KIND
  (`fn_doc_kind_shareable`, `fn_set_document_shared` refuses a non-shareable
  kind, `v_client_documents` enforces it too, plus a backfill that stamps
  existing RFI/SI/VO/PO documents and withdraws any already shared).
  **076 APPLIED** — `v_client_roster` gains `email`,
  `last_sign_in_at` and `has_signed_in` from auth.users, so the founder can send
  a password reset and can tell an unaccepted invite from a forgotten password.
  Ships with the "Send reset link" action on Admin -> Clients.
  **077 APPLIED** — `profiles.must_change_password` +
  `fn_clear_password_change`. Set by the DIRECT creation path so a
  founder-chosen password survives exactly one sign-in. Ships with an
  invite/direct mode picker on both Admin forms and an `inviteUserByEmail`
  branch in `admin-create-user` (needs redeploy).
  **So: 001-077 ALL APPLIED** (067-076 confirmed through the running app;
  077 confirmed 2026-09-06 — its verify block returned col = 1, fn = 1,
  flagged_now = 0, and that select is the last statement in the file).
  **078 APPLIED** (confirmed 2026-09-06) — "Deactivate" has to actually deactivate
  (`is_active_user()`, `my_role()` and `is_member()` hardened to return
  NULL/false for an inactive profile, the twelve own-row policies that grant on
  `auth.uid()` re-emitted with the active check, `fn_profile_active_guard` +
  BEFORE UPDATE trigger on profiles). Ships with `AccountClosed.tsx` and the
  RequireAuth branch. Verified on a real PostgreSQL with the ACTUAL 001-077
  chain as fixtures: three clean runs, and a live PM proven going from full
  access to zero rows on every table and refused on every own-row write, then
  back to EXACTLY the same access on reactivation; client suspension empties
  the portal; founder unaffected; both guards confirmed firing.
  **So: 001-078 ALL APPLIED.**
  **079 APPLIED** (confirmed 2026-09-06) — Supabase advisor cleanup. Converts
  `v_labour_cost`, `v_labour_project_cost` and `v_pnl_by_category` to
  `security_invoker` (proven row-identical for all five roles), and pins
  `search_path` on the six SECURITY INVOKER functions that lacked it
  (`is_founder`, `fn_storage_project`, `fn_doc_kind_shareable`,
  `fn_learn_normalise_ref`, `fn_compliance_series`,
  `fn_schedule_template_rows`). No behaviour change. Verified on a real
  PostgreSQL with the ACTUAL 001-078 chain: three clean runs, and the full
  22-view five-role sweep re-run afterwards unchanged. Confirmed live
  2026-09-06 — the verify block returned 19 / 0 / 0 / 0 / 0 exactly:
  19 owner-run views, no function with a mutable search_path, no table without
  RLS, no table with RLS and no policy, no policy open to anon.
  **So: 001-079 ALL APPLIED.**
  **080 APPLIED** (confirmed 2026-09-06) — `v_client_roster` narrowed from
  founder/pm/accounts to FOUNDER ONLY, and `fn_client_roster_summary` moved
  with it. Answers the advisor's "Exposed Auth Users": the view carries
  `auth.users.email` + `last_sign_in_at` since 076, and the only screen that
  reads it (Admin -> Clients) is `ADMIN_ROLES = ['founder']`. Verified on a
  real PostgreSQL: three clean runs, and the roster went 1/1/1/0/0 →
  **1/0/0/0/0** across founder/pm/accounts/supervisor/client, with the summary
  matching so a PM gets ZERO ROWS rather than a row of zeros. Confirmed live
  2026-09-06 — verify block returned view_exists = 1, gates_on_founder = 1,
  still_lists_pm_accounts = 0, summary_fn = 1.
  **081 APPLIED** (confirmed 2026-09-08 — verify block returned
  `1/1/1/1/0/0/t`, and the GRN list renders numbered receipts with a working
  PDF button in the running app) — a goods receipt gets a number of its own
  (`grn_no_seq`, `goods_receipts.grn_no` defaulting to `GRN-0001`, a
  chronological backfill of receipts already recorded, a guarded `setval`, then
  NOT NULL + a unique index). Needed because the GRN is now a printed document
  and "the receipt against PO-000042 on the 3rd" is a description, not a
  reference. **No guard trigger, deliberately**: `goods_receipts` has SELECT and
  INSERT policies and NO UPDATE POLICY (012), so a PATCH is refused by RLS
  before a trigger would fire — the 069 lesson inverted, where the absence of a
  policy IS the protection. `fn_receive_goods` needs no change; its insert never
  names the column, so the default supplies it.
  Verified on a real PostgreSQL with the ACTUAL 001-080 chain as fixtures:
  three clean runs under ON_ERROR_STOP=1, the verify block returning
  `1/1/1/1/0/0/t`, three pre-existing receipts inserted OUT of order and
  numbered chronologically, and — the point of the whole migration — the next
  receipt taking GRN-0004 without colliding with the backfill.
  **082 WRITTEN, NOT YET APPLIED** — M21 Petty Cash gets its screen, and the
  module gets the one thing the database could not already answer:
  `petty_cash_counts` (counted_on, counted_amount, **book_balance FROZEN at the
  moment of counting**, a GENERATED `variance`, a mandatory note once the two
  disagree, append-only — SELECT and INSERT policies only, no UPDATE and no
  DELETE, the 069 shape). RLS lifted verbatim from `pce_read` so the counts and
  the entries cannot drift about who may see them.
  **§0 REPAIRS A BUG LIVE SINCE 002.** `fn_pc_to_expense` mirrored a spend with
  `coalesce(new.category_id, 999)` — but `expense_categories.id` is a SERIAL and
  the 002 seed gives 'Misc' **id 18 with sort 999**. There has never been a
  category with id 999, so an uncategorised petty cash spend raised
  `expenses_category_id_fkey` and, because the trigger shares the transaction,
  THE ENTRY WAS REFUSED. Unreported for seven months because M21 had no screen
  — the 069 lesson exactly. Now resolves Misc BY NAME, and raises a sentence
  naming the fix if it is ever absent rather than inventing master data (050).
  Verified on a real PostgreSQL with the ACTUAL 001-081 chain as fixtures:
  three clean runs, verify block `1/0/1/1/2/0/1/1/1`, the uncategorised spend
  now accepted and filed under Misc, the note CHECK firing, and the RLS proven
  by query — holder 2 counts, founder 2, **a second supervisor 0**, their INSERT
  refused, `UPDATE 0` / `DELETE 0` for the founder. The frozen figure was proven
  by voiding an entry: the live balance moved 21750 → 24750 while both stored
  `book_balance` values stayed at 22000.
  **083 WRITTEN, NOT YET APPLIED** — M36 Client Communication Log.
  `client_comm_entries` (COM-0001 series, channel, occurred_on vs created_at,
  nullable FKs to approval/VO/document, **`is_commercial` defaulting TRUE**),
  plus `client_commitments` and `client_complaints` as SEPARATE registers with a
  NULLABLE `entry_id` — a commitment has a due date and a done state, a
  complaint has a resolution and an open state, and folding both behind a `kind`
  column would leave half the columns null on every row (the 060 explicit-beats-
  generic rule). `fn_client_comm_attention` with the 066 wrapper and the 073
  zero-rows behaviour.
  **THE COMMERCIAL FLAG IS THE MONEY RULE FOR FREE TEXT.** A client log is
  mostly commercial and a summary CANNOT be column-gated the way `po_lines.rate`
  is — there is no column to revoke. So the row carries the flag, `cce_read`
  hides those rows from supervisors, and the DEFAULT IS TRUE: a hurried entry is
  hidden rather than exposed, and a BEFORE trigger forces it true whenever a VO
  or approval is linked. Same family as 023's `has_cost_implication`.
  **THE 24-HOUR FREEZE** (`fn_comm_entry_freeze`) makes "append-only-feel" a
  property of the data rather than of the UI: editable while you are still
  typing it up, fixed by the time anyone would want to rewrite it, and the
  error names the remedy (log a new entry). Deliberately NOT applied to
  commitments and complaints — those describe an OPEN state that is meant to
  change. No DELETE policy on entries at all.
  Verified on a real PostgreSQL with the ACTUAL 001-082 chain: three clean runs,
  verify block `3/3/7/0/1/1/3/1/1`, and by query — founder sees 2 entries,
  **the supervisor sees only the non-commercial 1**, the client 0, a supervisor
  INSERT refused, a VO link forcing `is_commercial` true even when sent false,
  an edit inside the window accepted and one at 30 hours refused with the
  readable message, `DELETE 0`, and both closing CHECK constraints firing.
  **Run migration 083 before opening Client log.**
  **Run migrations 082 and 083 before testing.**
  **So: 001-081 ALL APPLIED.** Next migration = 084.
- **A PASSWORD SIGN-IN SUCCEEDS EVEN WITH MFA ON — THE APP IS WHAT REFUSES
  (MFA, 2026-09-07).** `signInWithPassword` returns a real session for a user
  with a verified TOTP factor; it is simply at assurance level **aal1**.
  Nothing about the password is rejected. So the second factor is only worth
  anything if something refuses to proceed, and that something is
  `RequireAuth` — NOT the login form, because an aal1 session survives a reload
  and a form-only check is walked past by refreshing. Checked FIRST of the
  three branches there (before deactivation and before the password prompt),
  because "is this really them" is the question that has to be answered before
  any of the others make sense. Recorded plainly, like 077: this is a ROUTE.
  RLS could demand `auth.jwt()->>'aal' = 'aal2'`, but that would lock out
  everyone who has not enrolled, so it stays off until enrolment is universal.
- **Clean up the abandoned enrolment before starting a new one (MFA).**
  Supabase refuses a second factor with the same friendly name, so a founder
  who closed the tab half way through could never start again — and the error
  names a row they cannot see and have no way to delete from the UI.
  `startEnrolment` unenrols any UNVERIFIED factor first. An unverified factor
  also does not raise `nextLevel` to aal2, so a half-finished setup can never
  lock anybody out — worth knowing before writing a "repair" that is not needed.
- **Name the switch, do not pass through the error (MFA).** The most likely
  first failure is that TOTP is not enabled on the Supabase project, and the
  raw message ("MFA enrollment is disabled") reads like an app bug rather than
  a setting somebody has to flip. The screen matches on it and says where to go.
  Same family as 058's 404 handler naming the likely cause.
- **The remedy has to exist before the feature ships (MFA).** Losing the phone
  locks the account out permanently unless somebody can reach
  `auth.mfa_factors`. That DELETE is written down in PROGRESS.md as the
  break-glass, because a security feature with no recovery path is one the firm
  will be too frightened to turn on — and the day they need it is not the day
  to work it out.
- **`email_confirm: true` was already there (2026-09-07).** "Make direct-created
  users auto-confirmed" needed no code: `admin-create-user` has always passed
  that flag to `createUser`, and it confirms the address regardless of the
  project's "Confirm email" setting. The invite branch deliberately does NOT
  set it — an invitation exists precisely to prove the address, and clicking it
  is the proof. **Read the function before changing it** — second time in this
  repo (the 077 lesson), and the honest answer to "make it do X" is sometimes
  "it does, here is the line".
- **A VIEW'S AUDIENCE IS A DECISION ABOUT ITS WIDEST COLUMN, AND ADDING A
  COLUMN CAN INVALIDATE IT (080).** 067 gated `v_client_roster` at
  founder/pm/accounts when it carried names and exposure counts, and a PM
  seeing their own project's client was reasonable. 076 then added
  `auth.users.email` and `last_sign_in_at` for the reset-link feature — which
  is founder-only — and nobody re-asked who should see the view. The gate was
  wider than EVERY consumer for two migrations. **Re-ask the audience question
  whenever a view gains a field, not only when it is created**, and check the
  answer against the app's route guard: `ADMIN_ROLES` had said `['founder']`
  the whole time.
- **The linter can be right about the wrong thing (080).** "Exposed Auth Users"
  fires because the view JOINS auth.users and is granted to `authenticated`;
  it cannot see the WHERE clause, so it would have fired just as loudly at a
  perfectly gated view. It was still worth acting on — not because the door was
  open, but because reading it forced the audience question above. **And it
  will keep firing after 080**: the join is still there. Clearing the lint
  itself would mean moving `email` behind a SECURITY DEFINER function, which is
  more machinery for an exposure that is now one role wide. Recorded as a
  known, accepted error rather than left to look unexamined.
- **AUDIT THE 22, DO NOT TRUST THE LINTER OR THE COMMENT (079).** Supabase's
  Security Advisor reports every non-`security_invoker` view as an ERROR
  ("Security Definer View"), because such a view reads its base tables as the
  OWNER and skips RLS. It cannot see that the WHERE clause IS the access
  control in this app (the 010 -> 038 pattern), so all 22 were flagged and none
  was actually leaking. The way to answer that is not to read the definitions —
  it is to QUERY every one as founder / pm / accounts / supervisor / client on
  a database carrying real rows. Result: every money view returned 0 to the
  supervisor and 0 to the client; every `v_client_*` view returned 0 to all
  four internal roles. **A linter that cannot read intent produces errors that
  are neither true nor false until somebody measures.**
- **A view with no gate in its own text can still be gated (079).**
  `v_labour_project_cost` was the one view whose definition contained no
  role predicate at all — it aggregates `v_labour_cost`, which is owner-run and
  gated, so the filter is inherited. And because it uses GROUP BY rather than a
  bare aggregate, an unauthorised caller gets ZERO ROWS, not the row of zeros
  the 066 rule exists to prevent. Both facts were confirmed by query. When
  auditing, follow the view's SOURCE before calling it ungated.
- **An invoker function used by a POLICY still wants a fixed search_path
  (079).** The usual reasoning — "search_path only matters for SECURITY
  DEFINER, because an invoker function runs with the caller's own rights" — has
  an exception: `is_founder()` is SECURITY INVOKER and calls `my_role()`
  unqualified, and it is read by RLS policies across the database. Anyone able
  to point search_path at their own schema would redirect that call and decide
  their own role. PostgREST offers no way to do that today, so it is defence in
  depth rather than a live hole; but a security predicate should not rest on a
  client-side setting staying locked. Same for `fn_storage_project()`, which
  the storage policies call.
- **Say no to the big lint, with the number that justifies it (079).** ~152
  policies call `auth.uid()` unwrapped instead of `(select auth.uid())`, so the
  call is re-evaluated per row. That is a real optimisation at a hundred
  thousand rows and worth nothing at four projects and fifteen users, where the
  largest table is the audit log. Rewriting 152 security predicates to save
  microseconds is a large diff across a correctness surface that is currently
  proven. Recorded as a deliberate decision with the trigger for revisiting it
  (a table past ~50k rows plus a screen that feels slow), so the next person
  does not either re-litigate it or "fix" it blindly.
- **A CONTROL THAT REPORTS SUCCESS AND DOES NOTHING IS A LIE THE APP TELLS ITS
  OWNER (078).** `profiles.is_active` has existed since 001 and Admin has
  offered a Deactivate button for months. NOT ONE POLICY OR HELPER READ THAT
  COLUMN. A deactivated staff member could still sign in and see every expense,
  every vendor rate and every document their role allowed; the button removed
  them from assignee dropdowns and the push digest, and that was all. Worse
  than no button, because the founder believed the account was closed and so
  nobody reset a password. Same family as 069 (no UPDATE policy, refuses
  silently) and 072 (a column nothing writes) — this one pointed the other way:
  the write happened, the read never did. **When a screen offers to change
  state, grep for something that READS that state before believing it works.**
- **Harden the function, not the two hundred policies (078, the 065 lesson
  again).** `my_role()` returning NULL for an inactive profile closes almost
  everything at once — is_founder(), is_internal(), is_client() and every
  role-named policy go false together, and `fn_client_project()` returns null so
  every curated client view empties. One function, nothing to keep in step.
- **The fall-through is what a role check cannot reach (078).** `is_member()`
  ends in `exists (select 1 from project_members where user_id = auth.uid())`,
  which stays TRUE for a deactivated PM — their assignment row does not vanish,
  and it must not, or reactivation could not restore what they had. So the
  active check goes at the TOP of is_member(), exactly where 065 put the client
  check. Any function whose last arm is a membership table needs the same.
- **ASK pg_policies, DO NOT GREP (078, and a grep did miss two).** Twelve
  policies grant on `auth.uid()` without asking what role the caller is, so
  my_role() going null never touches them — including a DELETE on `documents`.
  A line-based grep found ten; the two petty-cash ones reach the holder through
  a SUBQUERY spanning several lines and were invisible to it. The catalogue
  query is in 078's header and in its verify block, so a policy added later
  that needs the same treatment shows up as a number that changed. The 066
  rule, restated: enumerate the surface from the schema, never from memory.
- **Say which guard actually fires (078).** The trigger refuses deactivating
  yourself AND deactivating the last active founder. Both were confirmed
  firing — but only the first is reachable through the app, because to
  deactivate the last founder you would have to be a founder, and then there
  are two. The second only triggers from the SQL editor or a service-role
  script. Written down that way in the header rather than implying both are
  live protections.
- **A closed account must be TOLD, not shown zeros (078).** A deactivated user
  still signs in — Supabase issues a JWT whatever `is_active` says — and would
  land on a dashboard where every card reads zero. That is the 056/063/066
  failure exactly: a row of zeros reads as a fact about the company rather than
  a refusal. `AccountClosed.tsx` says it in a sentence. And `profile === null`
  deliberately does NOT route there — that is a failed fetch, and treating it
  as deactivation would lock the whole firm out on one bad request.
- **The dashboard does not read config.toml, and the error says nothing about
  it (077, found in production).** `verify_jwt = false` for admin-create-user
  has been in `supabase/config.toml` since 058, with a comment explaining
  exactly why. Redeploying the function FROM THE SUPABASE DASHBOARD ignores that
  file and defaults the gateway check back ON — so the CORS preflight was
  answered 401 with no CORS headers, the browser blocked the POST, and creating
  a client failed with "Failed to send a request to the Edge Function": the
  same sentence as a function that was never deployed, and pointing nowhere
  near the cause. **Deploy Edge Functions with `supabase functions deploy`,
  never the dashboard** — the CLI applies config.toml, the dashboard cannot.
  Written down as a setting is not the same as enforced at deploy time.
- **The thing that was already built was most of the ask (077).** "Add a create
  directly option" — both Admin forms had ALWAYS created directly with a
  founder-typed password; there was no invite path at all. Roles, project
  linking and the Team/Clients separation were already correct and verified.
  The real gaps were the invite option and the fact that nothing enforced the
  Team form's own instruction to "ask them to change it". **Read the screen
  before building what it says it needs** — three of the four numbered
  requirements were already satisfied, and rebuilding them would have been
  churn presented as progress.
- **A password somebody else chose must survive exactly one sign-in (077).**
  Direct creation stays, because no email can leave the project until custom
  SMTP exists and a firm cannot stop onboarding while it waits on DNS. But the
  founder knowing every staff and client password indefinitely is the actual
  risk, so `must_change_password` is set on that path and `RequireAuth` routes
  them to /set-password until they pick their own. Said plainly in the migration
  header: this is a ROUTE, not a security boundary — RLS cannot refuse a query
  because somebody skipped a prompt, and it protects against a shared secret
  living for a year, not against the account's own owner.
- **Not in auth metadata, because the user can write that (077).**
  `raw_user_meta_data` is editable by the user through `updateUser({ data })`,
  so a flag stored there could be cleared from the browser console by the very
  person it constrains. On `profiles` it sits behind `profiles_admin`
  (founder-only UPDATE) — which then needs `fn_clear_password_change`, because
  otherwise the person changing their password could never clear their own flag
  and would be locked in the prompt forever. Verified: clearing it as the
  supervisor left the client's flag untouched.
- **Existing accounts are NOT flagged (077).** Everyone who exists was created
  the only way that existed, so flagging them all would lock the whole firm out
  at their next sign-in until they chose new passwords. A migration should not
  do that to a working business without being asked; the header gives the
  one-line UPDATE for forcing a specific person.
- **Offer the working path first (077).** The mode picker puts "Set a password"
  first and defaults to it, because Supabase will not deliver mail to anybody
  outside the project team until custom SMTP is configured — leading with the
  invite would be leading with the one that silently fails. The Edge Function
  also detects that specific failure and says what to do instead, rather than
  passing through a raw SMTP error.
- **"Never signed in" and "forgot the password" are different problems (076).**
  A reset link sent to somebody who never accepted their invitation is the wrong
  email: they have no password to reset and end up exactly as stuck, while the
  founder believes they have helped. `has_signed_in` is what separates the two,
  and the card shows a sentence instead of a button in the case a button cannot
  fix. **Before offering a remedy, check the state actually admits it.**
- **A view built for one screen will be asked a second question (076).** 067's
  roster carried names and exposure counts because that was all the screen
  needed. Recovery then needed an email address, which meant a migration to add
  a column that was always one join away. Not a mistake worth avoiding by
  selecting everything — the discipline of taking only what the screen needs is
  right — but worth knowing that the follow-up migration is normal, not a sign
  the first cut was careless.
- **A function reading a view by name is not a tracked dependency (076).**
  `drop view` warns when a VIEW depends on it, and says nothing about a FUNCTION
  that reads it — `fn_client_roster_summary` would have kept existing and failed
  at call time against a view that no longer matched. 076 asserts the function
  still resolves after the rebuild, which is the check 071 wishes it had had.
- **A percentage needs a baseline the reader recognises (075).** The portal
  measured spend against `projects.contract_value` — the ORIGINAL contract — so
  a client who had approved three variations saw "112% of contract" and would
  reasonably conclude the job was over budget. The three components are now
  returned SEPARATELY and shown as arithmetic (original + approved variations =
  revised), because one number the client has to trust is worse than three they
  can check. Only APPROVED variations: a submitted VO is a proposal, and
  including it would inflate the denominator to flatter the spend figure.
- **A folder is not a type (075).** RFIs file into `drawings`, site
  instructions into `other`, VOs into `contracts` — and none of the five filing
  screens stamped `doc_kind`, so an RFI to a consultant was indistinguishable
  from an architectural drawing. Sharing could not be gated on something the
  data did not record. Stamp the kind AT CREATION; a classification derived
  from a title or a folder is a guess that breaks the first time somebody
  renames a file (the 049 lesson, again).
- **An allow-list belongs in a function, not a settings table (075).** Which
  document kinds may reach a client is a policy, and `comparative_statement` —
  every vendor's quote — must never be on it. A settings screen would make that
  one mis-click away. `fn_doc_kind_shareable` is IMMUTABLE, read by both the
  RPC and the vault UI, so the button and the database cannot disagree.
- **A new rule has to apply to what is already shared (075).** The backfill
  stamps existing documents from their generated title prefix AND withdraws any
  non-shareable kind that was already client-visible. Leaving an RFI visible
  because it was shared before the rule existed would make the rule advisory.
- **Do not make the user learn where to put things (074).** A founder uploaded
  eleven images to a vault folder literally called "Photos", ticked share, and
  found them in the portal's DOCUMENTS tab while the Photos tab said "No photos
  yet". Both statements were true and the combination was nonsense. The fix is
  the view learning about both routes, not a rule the firm has to remember.
- **Filtering for PRESENTATION belongs in the app; filtering for ACCESS belongs
  in the view (074).** Images are hidden from the portal's Documents tab in the
  query file, NOT by removing them from `v_client_documents` — because 070's
  storage policy grants a client read on a file precisely BECAUSE a row exists
  in that view. Tightening the view to de-duplicate a list would have silently
  refused every image in the gallery.
- **Carry the bucket, do not infer it (074).** A gallery row now says which
  bucket its file is in, because the two routes land in different buckets and
  deriving it from the path in the browser would be a guess that breaks the
  first time a path convention changes.
- **A flag that is true for everything carries no information (073).** The ask
  was "mark client messages and approvals as important". Stored literally that
  is a permanent badge on every client-originated row, and a permanent badge is
  one people stop seeing — the 063 snooze lesson in a different costume. So
  nothing is flagged: the alert is DERIVED from state that already means
  something (unread, undecided, unseen) and clears itself when somebody looks.
- **Separate the signal that needs action from the one that does not (073).**
  `unseen_rejections` is counted apart from `unseen_approvals` and is the only
  thing that makes the strip urgent. A strip that turns red for good news
  teaches people to ignore red.
- **An index predicate must be IMMUTABLE, and `enum::text` is only STABLE
  (073).** `where status::text <> 'pending'` — the form used safely everywhere
  else in this repo because of the 021 enum trap — is refused in a partial
  index with "functions in index predicate must be marked IMMUTABLE". Use the
  enum literal (`status <> 'pending'::approval_state`) there. Safe whenever the
  enum value was created in an EARLIER migration; 021 only bites a value added
  in the same transaction.
- **`having`/filtered-empty is right when "nothing" is the empty case (073).**
  066 banned hiding an empty aggregate because a legitimate zero (nothing spent)
  had to stay visible. Here the opposite holds: "nothing is waiting" IS the
  empty case, so `fn_client_attention` returns ZERO ROWS and the strip vanishes.
  An alert rendering "0 unread" is noise, and noise is how a real one gets
  missed.
- **Half a feature is worse than none, because only one side can see it (072).**
  065 built `client_messages` with policies for BOTH audiences, CP3 built the
  client's screen, and no internal screen existed — so a client could write
  "the gate colour looks wrong" into a table nobody in the firm could open. 067
  then added an `unread_from_client` count to the Admin roster, which would have
  reported a waiting message with no way to read it: the worst state, because it
  LOOKS handled. When a table has two audiences, both screens ship together or
  neither does.
- **A column nothing writes is a bug with a delay fuse (072).** `read_at` was
  created in 065 and nothing ever set it, because no UPDATE policy exists (by
  design — a sent message stays sent). The 067 unread count read that column, so
  it would have counted every message forever. Marking read had to be a
  SECURITY DEFINER function touching one column on rows the client sent, exactly
  the 069 shape.
- **`drop view … cascade` on a name you did not create is a CLOBBER, not an
  idempotency helper (071).** 065 wrote that line ten times for its ten
  `v_client_*` views without checking whether any name was taken. One was:
  migration 060 had already created `v_client_approvals` as the INTERNAL
  register — approvals GIVEN BY a client, with project_name, method, evidence
  and the raiser. 065 replaced it with the PORTAL view — approvals shown TO a
  client, deliberately stripped of all of that. Same name, opposite meanings.
  The founder's Approvals screen broke the moment 065 was applied and stayed
  broken for three sessions, because nobody opened it: it reported
  `column v_client_approvals.project_name does not exist` and rendered an empty
  register. The approvals themselves were fine the whole time — raised, sent,
  decided — only the internal LIST was blind.
  **Before `create view`, grep the repo for the name.** A naming CONVENTION
  (`v_client_*`) does not reserve the namespace, and a prefix that reads as
  "for clients" also reads as "about clients".
- **A screen nobody opens during a session is a screen nobody tests (071).**
  065, 066, 067 and the whole CP3/CP4 build all touched approvals and none of
  them loaded Tasks -> Approvals. After a migration that drops or replaces a
  view, open every screen that reads it — the list is `grep -rn "<viewname>"
  src/`, which takes ten seconds.
- **AN RLS POLICY'S SUBQUERY IS ITSELF SUBJECT TO RLS (070).** 068 granted a
  client read on a storage object with
  `exists (select 1 from public.documents d where d.file_path = objects.name …)`.
  Every condition was right and it returned nothing: the subquery runs with the
  caller's privileges, so `documents_read` applied, and that requires
  `is_member()` — which 065 made false for a client. The client could see the
  row through the owner-run VIEW and not through the base table, and the policy
  asked the base table. **If a policy must see a row the caller cannot, it goes
  through a SECURITY DEFINER function or an owner-run view.** The fix asks
  `v_client_documents` — the same view the list is built from — so the storage
  grant and the listing cannot disagree by construction.
- **Supabase storage returns "Object not found" for an RLS refusal (070).** It
  is indistinguishable from a genuinely missing file, which is what made this
  take three rounds. When a storage read fails, prove the object exists with a
  `left join storage.objects on o.name = <path>` as `postgres` BEFORE theorising
  about paths — same lesson as 058's "probe the endpoint".
- **A swallowed error costs more than a bad error (070).** `signedDocumentUrl`
  returned `string | null`, so the screen invented a cause ("your team may have
  unshared it") that was confidently wrong and sent the founder looking in the
  wrong place. It now returns `{ url, error }` and the toast prints what storage
  actually said. Any helper that can fail for more than one reason returns the
  reason.
- **A table with no UPDATE policy refuses every update, silently (069).**
  `documents` had SELECT, INSERT and DELETE policies and no UPDATE one, so
  migration 031's sub-folder move has never worked in production — the PATCH
  was refused, the toast was dismissed, and nobody noticed because filing a
  document into a sub-folder is rare. **A capability nobody exercises is a
  capability nobody discovers is missing.** When adding a write to an existing
  table, check `pg_policies` for that CMD before assuming the table is writable.
- **Do not fix it with an UPDATE policy (069).** An RLS UPDATE policy cannot say
  WHICH columns, and on `documents` three columns ARE the security model:
  `is_confidential` (hides from supervisors and clients), `project_id` (what
  every is_member() reads) and `file_path` (what the 068 storage policy matches).
  A policy loose enough to allow a sub-folder move is loose enough for a PATCH
  to flip any of them. So the table keeps no UPDATE policy and two narrow
  SECURITY DEFINER functions do the work — the same shape as `fn_void_record`,
  where the ABSENCE of a policy is what makes the RPC unbypassable. Verified on
  a real PostgreSQL with production-equivalent grants: the direct PATCH returns
  0 rows.
- **`String(err)` on a Supabase error prints "[object Object]" (069).** A
  PostgrestError is a plain object, not an Error, so a hand-written
  `err instanceof Error ? err.message : String(err)` hides the real cause — it
  cost a whole debugging round here. The repo has `errText()` for exactly this;
  every catch block uses it.
- **Exposing a row is not exposing its FILE (068, found while building CP3).**
  065 gave a client `v_client_documents` and `v_client_photos` — titles and
  paths — but never touched storage, whose policies all read
  `is_member(fn_storage_project(name))`, and 065 had just made `is_member()`
  false for a client. So the portal would have listed documents nobody could
  open and rendered every photo broken. Whenever a new audience gets a view over
  something with a file behind it, the bucket policy is a SECOND migration, not
  an afterthought.
- **Grant the OBJECT, never the prefix (068).** The easy fix was
  `or project_id = fn_client_project()`, which hands a client every object under
  their project's prefix — receipts, drawings, confidential documents,
  unpublished photos. Instead each policy requires a matching PUBLISHED ROW for
  that exact path, so the storage grant is derived from the act of publishing
  and the two cannot drift: unshare the document and the file is refused in the
  same instant, so an old signed URL stops working rather than quietly
  continuing to serve.
- **Publishing belongs on the thing being published (CP4).** The share toggle is
  on the document in the vault and on the photo in the site log — never on the
  Admin screen, which only REPORTS the counts. Two places to manage visibility
  means the two eventually disagree, and the disagreement is silent.
- **Never offer a control the database will refuse.** The share toggle is hidden
  on a confidential document, because `v_client_documents` and the 068 policy
  both test `is_confidential` independently of `client_visible`. Showing the
  toggle would promise something Postgres then declines.
- **`is_internal()` is the wrapper for a surface EVERY internal role can read —
  not for a restricted one (067, caught by its own test).**
  `fn_client_roster_summary` sums `v_client_roster`, which supervisors cannot
  see. With the plain 066 wrapper a SUPERVISOR got the row of zeros the wrapper
  exists to prevent: they are internal, so it let them through, and the roster
  underneath returned nothing. The wrapper must restate the restriction of the
  thing being summed — here `and my_role() in ('founder','pm','accounts')`.
  Rule: match the aggregate's guard to its SOURCE's audience, not merely to
  "not a client".
- **Two audiences, two forms — never one picker (067).** Creating a client is a
  separate tab, a separate type (`NewClientInput`) and a separate Edge Function
  branch from creating staff. A shared role dropdown makes "outsider created as
  a pm" one mis-click away, and that mistake hands over the company's money.
  The asymmetry is the point: staff wrongly marked `client` merely see less.
- **Report exposure, don't build impersonation (067).** "View as this client"
  would need a client session, i.e. an impersonation path into the one area
  whose entire story is that the database refuses. The roster instead counts
  what has actually been shared — documents, photos, bills, pending approvals —
  which answers the real question ("what have I shown this person?") without
  opening that door. Related: NO permission-toggle grid, because the curated
  views ARE the permission model and a toggle would be a lie the first time
  somebody edits a view.
- **A picker's type should not invent the columns it refused to select (067).**
  Padding `fn_projects_without_client` into the full `Project` type meant
  writing `contract_value: null` and `management_fee_amount: null` — a shape
  that claims to know the fee and reports it absent. A narrow `ProjectOption`
  says instead that money was never in scope.
- **An aggregate answers a question it just refused — third time (056, 064,
  066).** `count(*)` over zero permitted rows is a legitimate 0, and
  `coalesce(sum(x), 0)` is a legitimate 0, so a correctly-refused caller gets
  ONE ROW OF ZEROS rather than nothing. RLS was never wrong: `is_member()`
  returned false exactly as designed. The fix is uniform and belongs in every
  future aggregate from the start:
  `select * from ( <the aggregate> ) q where public.is_internal();`
  Chosen over `having count(*) > 0`, which would also hide a legitimately empty
  result from an internal user, and over per-body role checks, which would have
  to be written fifteen different ways and would drift. **Any new function
  returning a scalar roll-up gets this line on the day it is written.**
- **A test proves only what it thought to ask (066).** The first client security
  script probed 3 of ~115 functions, passed 46 of 49 checks, and read like a
  clean bill of health. The exhaustive version — 84 tables, 35 views, 39
  read-only RPCs, every project-scoped one called with the client's OWN project
  id, which is the single id they legitimately know — found 18. A security test
  is only worth its COVERAGE, so enumerate the surface from the schema
  (`grant execute … to authenticated`, `grant select on public.…`) rather than
  from memory of what seemed risky.
- **A "read-only" script that writes (066).** The sweep called
  `fn_assistant_quota`, which INSERTS before it answers, and then reported the
  row it had just created as a finding. Before calling a function a test
  describes as read-only, check its body for a write — "quota", "check",
  "summary" and "alert" all sound like reads and one of them was not.
- **Rename and wrap; never copy the seed data (066).** Filtering
  `fn_schedule_template` meant re-emitting 9KB of the firm's build sequence.
  Instead: `alter function … rename to fn_schedule_template_rows`, revoke it
  from the API, and make the public name a `security definer` wrapper that
  filters. Two copies of how the firm builds would eventually disagree about
  how long a slab takes to cure. The rename is guarded on the `_rows` function
  not already existing, so the migration stays re-runnable.
- **A pure function has no RLS, and that is easy to forget (066).**
  `fn_schedule_template` was `immutable`, so no policy ever applied and it
  handed a client 120 rows of activities, durations and parallelism. Adding a
  session-dependent filter also means it can no longer be IMMUTABLE — it drops
  to STABLE. Audit `immutable`/pure functions separately whenever a new
  audience is added: they are invisible to every RLS review.
  *(043/044/046, for the record:)*
  **046 APPLIED** — the firm's OWN twenty on-site checklists
  transcribed verbatim (500 questions, 3 discipline templates, 20 points),
  `section` on template/live/answer checks, `inspections.location`, plus
  `fn_apply_itp_template` / `fn_save_itp_template` / `fn_record_inspection` /
  `fn_inspection_checks` re-emitted. Next migration = 047.
- **An accurate message with no action is a dead end (054, 057 — shipped twice).** The labour screen
  told a founder to go to Money -> Labour to add a contractor; the Learn screen said a method
  statement had no steps while the drafting button sat two scrolls away in the editor. Both were
  true and both stopped somebody. Any empty state saying "there is nothing here yet" must carry the
  action for the roles that can act, on the screen where they landed — and a button that will
  certainly be refused should be disabled with the reason, not left to fail.
- **A preview model is not a foundation (064).** `gemini-3.1-pro-preview` gave 429 then 503
  "high demand" on consecutive attempts — the 503 being Google's capacity rather than our quota.
  Preview tiers have a tiny free allowance and get overloaded. Retry only what is TRANSIENT (503,
  short 429) and only a few times: a 400 or 404 means the request itself is wrong, and an assistant
  that takes thirty seconds to fail is worse than one that fails in three and says why.
- **Never reconstruct a model part — echo back exactly what arrived (064).** Gemini 2.5+ attaches a
  `thoughtSignature` to every `functionCall` part and REQUIRES it returned unchanged on the next
  turn. Rebuilding the part as `{ functionCall: part.functionCall }` drops it and the following
  request fails with `400 Function call is missing a thought_signature`, which reads like a
  malformed request rather than a lost field. The same loop taught the second half: a thinking model
  emits reasoning as parts flagged `thought: true`, which carry text and MUST be kept for the next
  turn but must never be displayed — streaming them puts the model's private working-out in front of
  the user as if it were the answer.
- **A multi-file Edge Function cannot be deployed from the dashboard's new-function flow (064).**
  It creates one `index.ts`, so `import './tools.ts'` fails to bundle with "Module not found" and a
  path under /tmp that looks like an internal error rather than a missing file. Either add each file
  with **+ Add File** using the exact name, or use `supabase functions deploy <name>`, which walks
  the directory. Prefer the CLI for anything past a single file.
- **`using (true)` means "anyone with a login", and a new role makes that a leak (065).** Fourteen
  policies granted read to `authenticated` with no condition — fine while every account belonged to
  the firm. Adding a CLIENT role turned each into an open door: staff names, the labour supply
  chain, the materials master, Mason Learn, and worst, `project_members`, which maps every project
  in the company and hands out other clients' project ids. Whenever a role is added, the first job
  is to grep `using (true)` — those policies were written under an assumption that no longer holds.
- **A new outside role needs enforcement, not just convention (065).** The rule "a client is never in
  project_members" is a convention somebody breaks in three years. So `is_member()` itself now
  returns FALSE for a client before it looks at the table at all. Verified by deliberately inserting
  the bad row: `is_member` stayed false and expenses/tasks/documents/POs all stayed at zero. When a
  single function is the key to thirty tables, harden the function.
- **A curated outside surface is a SEPARATE layer, never a filtered internal one (065).** Ten
  `v_client_*` views, each owner-run with `where project_id = fn_client_project()` as the access
  control. Reusing internal views with an extra WHERE would have meant every future edit to an
  internal view was a potential client leak; a separate layer means a reviewer checks one line per
  view. Same owner-run pattern as 010/038, and the same warning: losing that WHERE is a total leak.
- **The secret hides in the enum (065).** `invoice_type` has a `management_fee` value, so "show the
  client their invoices" would have told them the fee in rupees. The view filters to `progress`
  only. Before exposing any table to a new audience, read its ENUMS — a type column is often where
  the confidential case lives.
- **Say when the brief contradicts itself, in the migration and to the founder (065).** Open-book
  spend plus contract value lets a client derive margin by subtraction, while the same brief says
  never show margin. Both cannot hold. It is implemented as asked, the contradiction is stated in
  the file header and at the end of the security test, and the one-line fix is named. A commercial
  decision made silently inside a migration is the worst place for it to live.
- **RLS is necessary but NOT sufficient for an assistant, and this nearly shipped wrong (064).**
  `v_project_spend` is security_invoker over `expenses`, whose RLS excludes supervisors. A supervisor
  selecting from it does not get an error and does not get zero rows — they get ONE ROW OF ZEROS,
  because `sum()` over no visible rows is null and the view coalesces it. Verified against a real
  database. A human sees "restricted for your role" because the dashboard checks first; a MODEL sees
  `total_spent: 0` and answers "nothing has been spent on Villa 12", which is a confident lie and
  worse than a refusal. So every tool declares which roles may call it, on top of RLS. Whenever a
  machine reads a view a human only reaches through a guarded screen, check what the view returns to
  someone unauthorised — zeros are the dangerous case, not errors.
- **The model gets a name from a list, never SQL (064).** `runTool` maps a whitelisted name to one
  hard-coded query; an unrecognised name is refused before anything runs. Text-to-SQL against a
  database with this much RLS would be one prompt injection away from a very bad afternoon, and the
  whitelist costs nothing — there are only about fifteen useful questions.
- **Make the forbidden thing unreachable, not forbidden (064).** `fn_assistant_execute` has five
  branches: task, snag, site log note, RFI, document note. There is no branch for expenses, budgets,
  POs, invoices, VOs, RA bills or overheads — not a branch that raises, NO BRANCH. The prompt also
  says it cannot touch money, but the prompt is the courtesy and the missing code is the protection.
  Third time this pattern has earned its place (058 schema, 061 severity, now this).
- **SECURITY INVOKER is the whole safety story for an assistant write (064).** `fn_assistant_execute`
  is invoker, so its INSERTs obey the caller's own policies exactly as if they had typed the form.
  A supervisor confirming an RFI proposal is refused by `rfi_insert` itself — confirmed in testing —
  not by a role check written in the function that could drift from it. Reach for SECURITY DEFINER
  only when the function must do something the caller genuinely cannot.
- **Propose, then execute — and keep the declines (064).** The confirmation card renders the SAME
  jsonb payload that `fn_assistant_propose` stored, so what is shown and what gets inserted cannot
  disagree. Proposals are kept whether confirmed or not: "the assistant suggested this and somebody
  said no" is the only number that says whether the feature earns its API calls (the 061 rule).
- **Rate-limit before the model call, and put the counter out of reach (064).** `assistant_usage`
  has a SELECT policy and no write policy, so only the SECURITY DEFINER function increments it — the
  thing being counted cannot reset its own counter. Verified: a direct UPDATE returns `UPDATE 0`.
- **If the history does not exist, start recording — do not backfill a fiction (063).**
  `schedule_activities.pct_complete` holds one current value, so "spend rising faster than progress"
  and "CPI trending down" cannot be computed backwards; there is no historical progress figure in
  this database. So those flags ship as POINT-IN-TIME with `basis` printed on the card, and
  `project_health_snapshots` starts capturing nightly so the same flags can be trended from tomorrow.
  Inventing a back-history from today's numbers would have made every early trend a straight line
  through one point. Same shape as 059's extract-at-upload: derive it at write time, because
  deriving it later means it never existed.
- **A trend needs a sample size, and the card must print it (063).** Every flag carries `basis`
  ('point_in_time' or 'trend') and `sample_n`, and the trend arms refuse to fire below three
  observations. A slope from two points is a line through two points. The rollover flag also
  requires ten tasks in the window — one rollover out of two is 50% and means nothing.
- **Show the number the threshold was applied to (063).** Every signal prints its raw metric in the
  serif face next to the sentence, so a reader who thinks 10 points is the wrong gap argues with the
  threshold rather than with the app. A warning whose basis is invisible gets ignored on the second
  occurrence.
- **Weight progress by budget, never average the percentages (063).** A plain average treats site
  clearance and superstructure as equals and calls a job half done when the expensive half has not
  started. The snapshot's `progress_pct` is Σ(pct × budget) / Σ(budget) — in testing that was 30%
  where a plain average said 25%.
- **A snooze must expire (063).** `fn_ack_health_flag` refuses anything over 90 days and there is no
  permanent dismissal. A signal that can be silenced forever will be, and the condition it describes
  does not go away because somebody clicked. The ack is also the ONE human act in a read-only
  module, which is why it is the only thing here with an audit trigger — auditing a nightly
  bookkeeping sweep would be auditing a log.
- **An empty health panel must not say "healthy" (063).** The empty state says these particular
  checks found nothing on the data entered, not that the job is fine. And a supervisor gets ZERO
  ROWS rather than zeros, for the same reason as `fn_mis_company` (056): a row of zeros on a health
  screen reads as an all-clear.
- **Name the tool after what it is, not what it resembles (062).** This is a hand-kept clash
  REGISTER, not BIM clash detection: no geometry, no models, no coordinates. So there is no
  tolerance field, no auto-detection, and the register footer says in words that an empty list means
  nobody has looked rather than that there are no clashes. The drawing overlay carries a permanent
  banner — not a tooltip — saying it cannot prove a clearance. A tool that looks like Navisworks and
  is not is worse than no tool, because somebody will trust it. Same family as naming the MIS card
  "net position" rather than cash (056).
- **Manual controls are the honest signal (062).** The overlay ships nudge and scale sliders
  BECAUSE the two sheets are not registered to a common origin. Auto-aligning them would imply a
  dimensional relationship that does not exist; making the user line them up by eye means they know
  exactly how much the result is worth.
- **Reuse the enum that already means this (062).** Clash disciplines are `drawing_discipline` from
  029, not a new `clash_discipline`. Two enums meaning the same six things drift the moment somebody
  adds to one — the same judgement as 043's refusal to add a fifth role for one module. Severity DID
  get its own type, because a clash severity and a snag severity describe different things and
  should be able to diverge without a data migration on the other.
- **Create the linked record in the same transaction as the link (062).** `fn_raise_rfi_from_clash`
  writes the RFI and stamps `rfi_id` together, and the guard trigger refuses `rfi_id` from the
  client. Two steps would eventually produce a clash marked "sent to the consultant" with no RFI
  behind it — the same failure mode `fn_record_inspection` was written to prevent in 043.
- **Append the context the other party will ask for (062).** The RFI question gets the clash number,
  both systems, the location and every drawing number appended server-side. The consultant's first
  reply is otherwise "which drawings?", and that round trip costs a week on a live job.
- **Give the model no field for the thing it must not say (061).** A vision model cannot measure a
  crack from a photograph, so `photo_analyses` has NO severity column, the response schema has no
  severity/measurement/verdict field, the prompt forbids them, and a regex scrub strips any
  dimension that survives. The column is `concerns`, not `defects`, and every concern must carry
  `what_to_check` — which forces the output into the grammar of a question for a person rather than
  a finding. Structure beats instruction: a field that does not exist cannot be filled in.
- **A suggestion must become somebody's assertion before it is a record (061).** Accepting writes a
  snag or NCR whose `raised_by` is the ACTING USER, with the text editable on the way in. A defect
  report that belongs to nobody is one nobody will defend, and the model does not get to be the
  author of a construction record.
- **Fetch the input as the caller, never with the service key (061).** `photo-analyse` downloads the
  image using a Supabase client built from the caller's own Authorization header, so the bucket
  policy decides whether that person may see that photo. The service-role key would have worked and
  would have turned the endpoint into "analyse any photo in the company". The same client writes the
  row, which is what makes the `model` column a fact rather than a claim.
- **Opt-in per item keeps an AI feature honest AND cheap (061).** Nothing fires on upload. Somebody
  taps the button, which keeps usage inside the free tier and makes the analysis a thing a person
  chose rather than a thing that happened to them. A unique index on `photo_path` stops a double tap
  buying a second opinion nobody asked for — two analyses of one picture is a disagreement no one
  can resolve.
- **Keep the dismissals (061).** A dismissed suggestion is not deleted, and
  `fn_photo_analysis_summary` reports the accept rate over decided rows. An AI feature nobody can
  evaluate is one that quietly stays switched on forever; this is the number that says whether the
  API calls buy anything.
- **Do not model people who will never log in (060).** The client approval register stores
  `approved_by_name` as plain text. Giving the client a row in `profiles`, or a `client_users`
  table, would imply an account nobody will ever issue. Model the RECORD of what an outsider said,
  not the outsider as a user.
- **When an integrity rule cannot apply, say so and compensate (060).** A PM normally cannot approve
  what they raised. Here the decision is the CLIENT's, made outside the system, and the PM is a
  witness — applying the rule would stop the person who took the phone call from logging it. So the
  rule is dropped ON PURPOSE and the residual weakness is exposed instead of hidden: `method` is
  mandatory so verbal never looks like signed, and the summary counts DECIDED approvals with NO
  evidence attached. A register that shows a phone call and a countersigned sheet identically looks
  authoritative about something it cannot support.
- **Explicit nullable FKs beat a (table_name, record_id) pair (060).** A generic link cannot be
  enforced: nothing stops it pointing at a row since cancelled, deleted or never created, and no
  database check will catch it. Three nullable FKs cost one column each and get referential
  integrity free. ON DELETE SET NULL, never cascade — deleting the document must not delete the
  record that the client approved something.
- **Let the existing policy hide the money; do not restate it (060).** An approval that concerns
  money holds NO amount and links to the VO. The register view LEFT JOINs `variation_orders`, so a
  supervisor gets the approval with the VO half blank purely because that table's own RLS refused —
  no column grant, no role check, nothing here to drift. Same move as 023's `has_cost_implication`.
  Reach for it whenever a screen supervisors need shows a record that merely REFERS to money.
- **Record when it happened, not when it was typed (060).** `decided_on` is the day the client
  decided; `created_at` is the day somebody got round to entering it. They are routinely weeks
  apart, and the first is the one that matters when a sequence of events is reconstructed. Any log
  of an out-of-band event needs both dates and a form that asks for the real one.
- **An age beats a count on a dashboard card (060).** Three approvals awaiting the client is normal;
  one of them waiting nine weeks is what stalls a job. `oldest_pending_days` is what the card leads
  with.
- **Extract the text at upload, not when the AI arrives (059).** A file in a bucket is opaque, and
  every question anybody could ask of it needs its text. Pulling it out at upload makes the document
  searchable IMMEDIATELY through the box that already exists — no assistant involved — and turns the
  later assistant into a column read rather than a batch job that re-downloads and re-parses the
  whole library. The general rule: when a feature will obviously need a derived form of some data,
  derive it at write time; deriving it later means reprocessing everything ever stored.
- **Build the seam, not the feature (059).** `fn_learn_retrieve` returns ranked passages with their
  source across articles, steps and documents. Nothing calls it yet. It is the shape an assistant
  needs — text to read plus a citation to show — so when the assistant is built it is a function
  call, and swapping FTS for vector retrieval later changes no caller. Embeddings were deliberately
  NOT built: the retrieval design is far easier to get right against a real corpus and real
  questions than against an imagined one.
- **A tsvector has a hard 1 MB limit (059).** Indexing a large document raises "string is too long
  for tsvector" and would refuse the upload of exactly the big reference documents the feature
  exists for. The index input is capped at 500k characters while `extracted_text` is stored whole —
  the cap costs deep-page search on a very long document; refusing the upload would cost the
  document. And WEIGHT THE BULK TEXT LOWEST (D): a 200-page standard says "concrete" four hundred
  times and would otherwise outrank the one-page article actually titled "Concrete".
- **A nullable owner beats a second table (059).** A standalone library document and an attachment
  on an article are the same object with a different owner, so `article_id` is nullable rather than
  there being two tables. Two tables would have meant two search indexes, two extraction paths and
  two places for the assistant to look — which is precisely how "the bot could not find it" happens
  to a document that is plainly in the library.
- **Compose the visibility rule; the second half is not redundant (059).** A document is readable if
  its own status allows it AND, when it hangs off an article, that article is readable too. Without
  the second clause, publishing a document attached to a DRAFT method statement leaks the draft
  through its own evidence. Any child row that can be published independently of its parent needs
  both halves.
- **Say when something is stored but not searchable (059).** pdf.js correctly returns nothing for a
  scan, because a scan is a picture of a page. That is recorded as `no_text` with a sentence and
  shown on the card, rather than stored as an empty string that looks like a successful extraction.
  A library that quietly contains documents nobody can search is worse than one that names them —
  same family as naming the one BBS figure that still does not reconcile (053).
- **A best-effort step must never lose the main act (059).** Extraction NEVER throws: a file that
  could not be parsed is still filed, with the reason recorded. Failing the upload because a
  convenience failed would trade away the thing the user actually asked for.
- **ts_headline output is untrusted once it comes from an upload (059).** The snippet now originates
  inside a PDF somebody sent the firm. It is split on the `<b>` markers and re-emitted as React
  elements, never `dangerouslySetInnerHTML`. The highlight survives and nothing in a document can
  inject markup into the app.
- **A model name is a perishable constant — put it in config (058).** `gemini-2.0-flash` was
  retired by Google on 1 June 2026 and answered `generateContent` with a bare 404, which reads
  exactly like a broken URL. The name now lives in `GEMINI_MODEL` (default `gemini-3.5-flash`), so
  the next retirement is `supabase secrets set` rather than a code change and a deploy — a vendor's
  schedule has nothing to do with our release cycle. Not `gemini-2.5-flash`: it already has a
  shutdown date of 16 October 2026, and moving onto a model that dies in two months is not a
  migration. The 404 handler names the likely cause, because the previous message sent somebody
  looking at their API key.
- **`verify_jwt` at the gateway breaks every browser-called Edge Function (058).** The gateway
  demands an Authorization header before invoking the function; a CORS preflight is sent WITHOUT one
  by specification, so OPTIONS is answered 401 with no CORS headers and the browser blocks the POST.
  The function's own OPTIONS handler never runs. Any function the app calls sets
  `verify_jwt = false` in `supabase/config.toml` and authenticates INSIDE itself — Bearer token,
  `auth.getUser()`, then `profiles.role` — which is what `learn-draft` and `admin-create-user`
  already did, making the gateway check purely redundant. Put it in `config.toml`, never a
  `--no-verify-jwt` flag: a later deploy that forgets the flag reinstates the bug, and the bug
  reports itself as a missing endpoint.
- **PROBE THE ENDPOINT BEFORE THEORISING (058).** Two rounds went into reasoning about a message
  that structurally cannot distinguish its own causes. Opening
  `https://<ref>.supabase.co/functions/v1/<name>` in a browser tab settled it in ten seconds:
  `UNAUTHORIZED_NO_AUTH_HEADER` = deployed and the gateway is refusing; `404` = not deployed. When
  an error message is known to be ambiguous, the next action is a measurement, not a hypothesis.
- **A CORS preflight failure is indistinguishable from a missing endpoint (058).** The Gemini
  drafting button reported "Failed to send a request to the Edge Function" with the function
  deployed and the key set. `functions.invoke()` sends `apikey`, `x-client-info` and
  `x-supabase-api-version` as well as `authorization`/`content-type`; the function's
  `Access-Control-Allow-Headers` named only the last two, so the browser blocked the POST before it
  left. supabase-js reports a fetch that never happened with the same sentence it would use for a
  dead URL. **Read the error CLASS, not the text** — `FunctionsHttpError` means the function
  answered and refused, `FunctionsFetchError` means the browser never reached it (CORS, wrong URL,
  offline). Every Edge Function uses the full canonical allow-list; `admin-create-user` had the same
  two-header list and would have failed identically on first use.
- **Let a model draft the SHAPE, never the values (058).** Gemini is good at the order of work in a
  procedure and confidently wrong about cover, curing days and tolerances — and the numbers are the
  part that reaches a bar bender. So `learn-draft` returns a skeleton with `___` where every value
  belongs, the response SCHEMA has no field for a requirement (structural, not just prompted), a
  regex scrub replaces anything that still looks like one, and IS refs are filtered to bare standard
  numbers. Reproducing BIS clause text would also be theft; refusing the numbers happens to solve
  both problems at once.
- **A skeleton reads like a document (058).** Nobody can tell six weeks later whether a draft was
  written by the Planning Engineer or generated in four seconds, so `ai_drafted_at` records it and
  the editor keeps the reminder on screen. The existing machinery did the rest with no changes:
  everything lands as `draft`, drafts are invisible to supervisors at RLS, and publishing is the
  deliberate human act. An AI feature that plugs into an existing safety gate needs no new one.
- **A suggestion must never overwrite typed work (058).** The drafter fills summary/scope/PPE/tags
  only where they are still empty, and asks before replacing steps somebody has written. The one
  thing worse than a bad suggestion is a bad suggestion that ate the good version.
- **A generated column must be IMMUTABLE, and array_to_string is not (057).** A weighted tsvector
  over `is_refs`/`tags` was refused at create time with "generation expression is not immutable":
  `to_tsvector(regconfig, text)` and `setweight` are immutable, but `array_to_string` and
  `text[]::text` are STABLE. Isolating each subexpression against a real Postgres found it in a
  minute; guessing would have taken longer. The fix is the pre-PG12 shape — a plain tsvector column
  maintained by a BEFORE INSERT OR UPDATE trigger, which fires on every write and so cannot drift
  any more than a generated column could.
- **A RETURNS TABLE type mismatch creates clean and fails at CALL time (057).** `ts_rank_cd` returns
  real, but `ts_rank_cd(...) * 0.5` in a UNION arm promotes to double precision, and the function —
  declared `rank real` — was accepted by `create function` and then raised "structure of query does
  not match function result type" the first time anyone searched. Cast every arm of a UNION
  explicitly to the declared type; a migration that runs clean has not been tested.
- **Match on a reference instead of adding a link table (057).** C1 was asked to link method
  statements to QA ITP items, which 048 had deleted. Rather than invent a join to whatever survived,
  articles carry `is_refs` and `ncrs` already carries `standard_ref`, and `fn_learn_by_ref`
  normalises case, spaces and a trailing year so "IS 456", "is456" and "IS 456:2000" all resolve to
  the same article. Nothing to maintain, nothing to re-attach when a schedule is regenerated, and it
  reaches every module that records a reference rather than the one that got the FK.
- **Ship the structure, not the content (057).** 044 seeded 627 checklist questions and 048 deleted
  them. Mason Learn ships with five category labels and an empty library. Content nobody in the firm
  wrote is content nobody in the firm trusts.
- **A STUB THAT DOES NOT MATCH PRODUCTION PROVES NOTHING (056, shipped broken TWICE).** 056 ran
  clean three times in the sandbox and still failed on the founder's first paste, then failed again
  on the second, both times for the same underlying reason — a hand-written fixture that did not
  match the real object:
    1. `column pnl.project_name does not exist` — the stub gave `v_project_pnl` a `project_name`
       column; the real view selects `p.name` UNALIASED.
    2. `column e.expense_date does not exist` — the stub gave `company_expenses` an `expense_date`;
       its real column is `spend_date`. (`expense_date` belongs to `expenses`, a different table.)
  Those runs verified the arithmetic and the role gates — everything the stubs modelled correctly —
  and verified nothing at all about the joins, because the stubs WERE the things being joined to.
  **Generate fixtures from the migrations, do not type them.** Parse the real create-table /
  create-view out of the earlier migration and build the stub from that column list, or run the
  earlier migration itself. Cross-check every `alias.column` in the new file against the repo's real
  create statements before shipping. And "verified on a real Postgres" is only worth what the
  fixtures are worth — any claim of verification should say WHICH parts they could actually
  exercise.
- **Do not reuse a one-letter alias for two tables in one file (056).** `e` meant `expenses` in
  three places and `company_expenses` in a fourth, which is precisely how the wrong date column got
  typed and why a checking script could not tell them apart. `ce` costs one character.
- **One failed panel should not blank a dashboard (056).** `Promise.all` rejects on the first
  failure, so a single bad query left the MIS reporting "No projects visible" — a different and far
  more alarming claim than "one panel could not load". `Promise.allSettled`, each result standing on
  its own, with the failures named in the toast.
- **Inherit the gate; never restate it (056).** The MIS needed founder/accounts = all projects,
  PM = assigned, supervisor = nothing. `v_project_pnl` already carries exactly that
  (`is_member(...) and my_role() in (...)`), so every MIS view is `security_invoker` on top of it and
  the rule exists in ONE place. A second copy would drift, and a reporting screen that drifts leaks
  the whole company at once rather than one row.
- **A dashboard total must come from the same call as its rows (056).** `fn_mis_company` sums
  `v_mis_projects`, and the board PDF prints that total rather than adding the table it just drew.
  The fastest way for a dashboard to lose its reader is a headline that does not match the list
  underneath it.
- **Don't name a figure something it isn't (056).** The brief asked for a cash position. There is no
  bank balance, no receipts against invoices and no payment run in this app, so cash cannot be
  computed — only guessed. The card says "Net position", prints that it is margin lifetime-to-date
  less overheads for the chosen period, and states in words that it is not cash. Same rule as the
  gang-level muster roll (054) and citing an IS code rather than transcribing it (044).
- **Refuse to invent a series the data cannot support (056).** "Margin trend" normally means margin
  earned per month. This app does not recognise revenue monthly, so that series would be fiction.
  The chart shows margin TO DATE at each month end — defensible line by line — and the caption says
  which one it is.
- **Zero rows and a row of zeros are different answers (056).** `fn_mis_company` returns NOTHING for
  a supervisor rather than a row of zeros, because zeros read as "the company has no projects". The
  screen turns the empty result into a sentence.
- **Three charts did not justify a chart library (056).** recharts plus its d3 dependencies is
  ~400-500 KB on a PWA that loads on a site phone, and it arrives styled like a consumer product.
  The app already hand-draws its Gantt and spend rails; `MiniChart.tsx` does the same and gets the
  brand for free. Bar charts anchor at zero ALWAYS; the percentage line does not, and prints its
  range so nobody misreads the slope.
- **An accrual must never be added to a total built from payments (054).** Attendance × rate is what
  the labour on site is WORTH; `v_project_pnl` computes cost from expenses and certified RA bills,
  which is what was PAID. Adding the accrual on top would count every rupee of labour twice and get
  the biggest line on most jobs wrong. So attendance never reaches the P&L on its own:
  `fn_labour_reconcile` shows both figures side by side, and `fn_post_labour_expense` is a
  deliberate act that turns a period into ordinary expenses — refusing an overlapping period, so
  there is still exactly one source of cost. Same family as the 038 retention rule.
- **Post one expense per activity, not one lump (054).** A single lumped expense would flatten the
  `activity_id` tagging that earned value depends on, and somebody would have to re-tag by hand
  afterwards. Grouping the posting by activity keeps the link for free.
- **Say when you are duplicating an existing fact (054).** `site_logs` has carried a labour
  headcount since 001. Gang attendance records the same thing in more detail, so the two WILL
  disagree and the one people trust will be whichever was typed last.
  `fn_labour_headcount_check` returns both numbers and the variance, and the screen shows it. The
  site log was deliberately not changed inside a labour migration — that is its own session.
- **Name the register honestly (054).** A muster roll built from gang counts is NOT the named
  statutory Form XVI. The registers are labelled "equivalent, gang level" on screen and on paper,
  and `labour_workers` exists for contractors who supply a roster. A document that looks statutory
  and is not is worse than no document — the same reasoning as citing an IS code rather than
  transcribing it (044).
- **A unique index is the cheapest protection against a double tap (054).** Without
  `labour_att_uk`, one slow connection and a second tap doubles that day's wage bill with nothing
  on screen to say so. Any table where a duplicate row means duplicated MONEY wants one.
- **A regex that "looks right" is why the self-test exists (052).** `(\d+)\s*CRANK` reads the crank
  count out of "2-Y16 CRANK" — and matches the DIAMETER, giving 16 cranks and a bar 1810 mm too
  long. It survived writing and re-reading; `fn_bbs_callout_selftest()` caught it on the first run.
  Any count parsed out of free text needs a form that cannot collide with the other numbers on the
  line (`CRANK x2`, `CRANK(2)`), and any text parser ships with cases.
- **Expand what was written; never infer what wasn't (052).** The founder asked for "upload a
  drawing and it reads it". A vision model would be confidently wrong sometimes, and a plausible
  bar schedule nobody checks is invisible from the moment the concrete is poured. Callout expansion
  does only the counting and the geometry — stirrups from a spacing, stirrup size from the section
  minus cover, crank rise from depth minus cover minus the bar. Anchorage length defaults to ZERO
  rather than something sensible, because a sensible default would be the app designing the joint.
- **All-or-nothing, and only replace what you generated (052).** One unreadable callout refuses the
  WHOLE expansion, naming the line: a partial apply leaves the schedule short of steel with nothing
  on screen to say which bar is missing. And a re-run deletes only rows flagged `from_callout`, so
  the extra bar somebody added at a support survives a correction to an unrelated line.
- **The printed factor and the computed total must reconcile (053).** The firm's sheet prints
  φ8 = 0.395 and multiplies by it. The app was printing 0.395 and multiplying by 0.3951, so a
  checker adding a column up by hand would get a different answer and would be right to distrust
  the app. `unit_weight_decimals` rounds the factor to what actually appears in the heading. Any
  figure shown as a multiplier must BE the multiplier.
- **The client's own sheet is the authority on the client's own constants (053).** Their BBS is
  printed to d²/162.2; 051 seeded the textbook 162. 162.2 is also the exact value. Changed —
  guarded on the seeded number so a deliberate choice is never overwritten, audited, reversible in
  one tap. Same rule as taking their twenty site checklists verbatim in 046.
- **Say which figure still doesn't match (053).** Four of the five unit weights on their sheet come
  from 162.2; φ16 does not (they print 1.579, it computes 1.578). Rather than quietly pick the
  divisor that fits best and imply an exact match, the migration header names the gap, sizes it
  (0.06%), and says what a per-diameter override table would cost. A reconciliation that hides its
  one mismatch is worse than none.
- **RUN THE MIGRATION BEFORE SHIPPING IT — pglast is not enough (051).** `pip install pgserver`
  gives a real PostgreSQL inside the sandbox with no root needed; stub `auth.uid()`, `my_role()`,
  `is_member()`, `is_founder()`, `fn_audit()` and the four core tables, then execute the migration
  with `psql -v ON_ERROR_STOP=1 -f` **three times**. 051 parsed clean under pglast and still had two
  real bugs (below), both of which would have reached production. Do this for anything with
  arithmetic in it, and for anything that adds a view over a function.
- **`fn_audit` assumes an `id` column (051).** It does `coalesce(new.id::text, old.id::text)`, so
  attaching it to a table keyed by anything else raises `record "new" has no field "id"` — and
  because the trigger is in the same transaction, the WRITE IS ABORTED. The symptom is vile: the
  edit looks like it succeeded and the value is unchanged. `fn_audit_by_code()` is the version for
  code-keyed tables. Check the PK before adding an audit trigger.
- **Drop a view BEFORE the function it calls (051).** `drop function` is refused while a view
  depends on it, and the `create function` that follows then fails with "already exists" — leaving
  the OLD function in place while the script reports an error. The migration works once and is
  broken on every re-run, which is exactly when nobody is watching. View drops go above the
  function drops, not next to the view creates.
- **Put the constants in a table, and ship a self-test (051).** A cutting-length engine whose
  numbers are buried in a function body cannot be audited by the structural engineer who is
  actually responsible for it. `bbs_constants` is one labelled row per IS figure, and
  `fn_bbs_selftest()` re-derives eight worked examples with known answers. Editing a constant
  restates every schedule in the database — the self-test is what makes that safe, and it earned
  its place immediately: changing the stirrup hook to 12d flipped three cases to FAIL.
- **Compute the working in the same call as the answer (051).** `fn_bbs_cutting_length` returns
  `{cutting_length_mm, working}` together, so the explanation on screen is a by-product of the
  calculation rather than a second one. An explanation assembled separately eventually describes
  arithmetic the system is no longer doing — which is worse than showing nothing.
- **Report an impossible input, never clamp it (051).** A stirrup whose deductions exceed its
  perimeter returns a negative length WITH a warning, and the PDF prints the row in red. Silently
  clamping to zero, or dropping the line, produces a schedule that looks fine and is missing a bar.
- **Don't reimplement a safety-critical formula in the browser (051).** The live preview in the bar
  form is a server round trip on a 250 ms debounce. A TypeScript copy would be faster and would be
  the copy nobody re-checks after a constant changes.
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
- PDF: client-side (jsPDF) to write, pdfjs-dist to READ (059, dynamic import only — it is ~400KB
  plus a 1.26MB worker and must never enter the main bundle)
- Deploy: Cloudflare Pages. Repo: GitHub. No Firebase, no AWS, no Express.
- **Per-function model variables.** `ASSISTANT_MODEL` (assistant), `GEMINI_VISION_MODEL`
  (photo-analyse), `GEMINI_MODEL` (learn-draft and the fallback for both). Supabase secrets are
  PROJECT-WIDE, so one shared name means re-pointing one feature silently re-points the others —
  a reasoning model for the chat assistant would drag the Learn drafter onto it too.
- **One paid-API exception, added deliberately at 058: Google Gemini**, reached ONLY through the
  `learn-draft` Edge Function (key in `GEMINI_API_KEY`, never in the bundle), and ONLY to draft the
  STRUCTURE of a Mason Learn method statement. It is not allowed to state a value or reproduce a
  standard — see 058's header. Anything else wanting an AI call is a new decision, not a precedent.

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
