# MASON OS — Build Roadmap (authoritative order; overrides the spec)

Rule: build top-to-bottom, ONE module per Cowork session. Each module = schema migration → screen(s) →
test on real data → commit → tick here + update PROGRESS.md. Apply the CLAUDE.md design system to every module.
Verify the supervisor RLS test after any module that shows money.

Legend: [x] built AND tested end-to-end on real data · [~] partial or built-but-untested · [ ] pending

**A tick means you have used it and confirmed it works.** "Compiles" and "migration applied" are not
the same as tested — anything built but not yet exercised end-to-end stays [~] with a note saying
what's unverified. Audited honestly on 2026-07-28.

---

## PHASE 0 — Protect the work — CLOSED
- [x] Deployed live as installable PWA — masonos.muhamdwaseem.workers.dev (Cloudflare **Workers**, not Pages)
- [x] GitHub Actions: daily Supabase keep-alive ping (green)
- [x] GitHub Actions: weekly pg_dump backup → 90-day artifact (green)
- [x] Commercial-figure privacy closed at the DB level (migration 010) — no UI-only money gaps remain
- [x] Re-run supervisor incognito RLS test on the LIVE Project Detail — done 2026-08-01, clean
      (full checklist recorded under Roles & Permissions below)

## ALREADY BUILT (migrations 001–023)
- [x] M01 Command Dashboard + Project Detail
- [x] M06 Financial / Open Book (expenses, budgets, receipts) — void tested via the ledger
- [~] **M21 Petty Cash — BACKEND ONLY, NO SCREEN.** `petty_cash_accounts` / `petty_cash_entries`,
      the spend→expense mirror trigger, `v_petty_cash_balance` and the void path all exist and are
      correct. **There is no UI anywhere** — no page, no route, no query file. Nothing in the app
      can reach it. Was ticked in error. Decide: build the screen, or drop the module.
- [x] M03 Site Management / Daily Log
- [x] M16 Material Usage Tracker (inward/issue/stock) + Movements history
- [x] M09 Document Vault
- [x] **Roles & Permissions — full supervisor pass re-run 2026-08-06 and CLEAN**, this time covering
      every module including A10–A13, History with its CSV exports, the handover archive, the
      drawing register and the Send buttons. Specifically confirmed: all eleven /money routes and
      /admin bounce by direct URL; no compliance / bank-guarantee / insurance strips on the
      dashboard; no Handover archive card on Project Detail; Materials → Orders shows no value, no
      rate and no PO document block while raise-request and goods-receipt still work; the drawing
      register shows only the current IFC revision and a superseded sheet's signed URL refuses;
      History CSVs contain no money column; an SI's cost implication travels as a flag, never a
      figure, including in the WhatsApp text.
      *Earlier pass, 2026-08-01, covered the modules that existed then:*
      every /money route by direct URL (ledger, add, budget, vendors, orders, variations, invoices,
      compliance) plus /admin — all bounced; Dashboard and Project Detail showing "restricted" with
      no contract value, fee, spend or budget; **Materials → Orders**, the sharpest edge, showing
      status and quantities with no order value, rate or line total while raise-request and
      goods-receipt still worked; stock, movements and material master rate-free; confidential
      documents absent from the listing and unreachable by pasted URL; SI cost implication as a
      bare Yes; snags without the Verify action; project scope limited to assigned projects, with
      an unassigned project's detail URL refused.
- [x] Audit / Evidence log
- [x] M08 Vendors — superseded by A1 below (screen built and in use)
- [~] M02 Tasks — list + rollover done and in use; EVM/AI-schedule pending (Group B)
- [~] **Admin module (founder-only)** — projects create/edit tested; **creating a user through the
      `admin-create-user` Edge Function has never been run successfully end to end.**
- [x] **Record removal (migrations 020–022) — all three mechanisms tested.** Void (stock movements
      show VOID with reasons, and voiding an expense moves ledger, dashboard and project detail
      together); hard-delete refusals (materials blocked with a reference count, and the later
      refusals on verified snags, filed compliance, issued revisions and certified bills); and
      cancellation — confirmed 2026-08-06 on a VO, where the revised contract value on Project
      Detail corrected itself immediately.

---

## GROUP A — Straightforward workflow modules (build first) ~2–3 weeks
Order within group:
- [x] A1. M08 Vendor Management screen — list + search, add/edit/deactivate, inline "add new vendor"
       on the expense form. Full design system (brass primary, toasts, ListSkeleton, EmptyState,
       staggered reveal).
- [x] **A2. M04 Safety — built and TESTED 2026-08-06.** Daily checklist per site
       (PPE/scaffolding/edge/electrical/housekeeping/excavation, Pass/Fail/NA + remark + photo, one
       per site per day), incident & near-miss reports, safety summary on Project Detail.
       Migration 011 applied. **Tested 2026-08-06:** a checklist filed with a Fail plus remark and
       photo that survived a reload, an incident reported and closed, and the Project Detail safety
       card moving in response.
- [x] A3. M22 Procurement — full PR → PO → GRN → 3-way match. Backend migrations 012/013/015;
       raise/approve, PO PDF (full + delivery copy) auto-filed to Docs, GRN receipt (feeds stock),
       vendor invoice + 3-way match with variance flags, post-to-Open-Book. Rate privacy throughout.
- [x] **A4. M15 Invoice Generator — built and TESTED 2026-08-06** (migrations 024 + 025 applied).
      Three types with separate number series: progress bill (INV-P), management-fee invoice
      (INV-M), vendor payment voucher (INV-V). Every figure computed by `fn_issue_invoice` from
      expenses / project fee % / posted vendor invoices and stored as an immutable snapshot —
      nothing retyped, nothing recomputed on read. Letterhead PDF matching PO/VO/SI, GST breakup,
      total in words (Indian lakh/crore), VOID watermark when cancelled. Founder/accounts only.
      **Tested:** progress bills (INV-P) across two consecutive bills including the
      previously-billed deduction, which is where the 025 structural bug was found; and on
      2026-08-06 the management-fee invoice (fee derived from contract value x fee %, never typed),
      the vendor payment voucher, and cancellation with its VOID watermark.
      **GST treatment is a tax position — see the note in 024's header and confirm with your CA
      before the first real client bill.**
      *025 fixed the running-account structure: the deduction was landing inside the taxable
      subtotal, so the printed GST line couldn't be reconciled against the subtotal above it. The
      payable was always correct; the presentation wasn't.*
- [x] A5. M26 Variation Orders — register (raise/approve/reject, +/- cost impact, status), revised
       contract value on Project Detail, VO PDF on letterhead + file to Docs. Migration 016. PM raises,
       founder approves. Money-gated (supervisors excluded).
- [x] **A6. M56 Site Instruction (SI) — built and TESTED 2026-08-06** (migration 023 applied). SI number
      series, addressed-to (linked vendor or free text), work area, instruction, photo attachments,
      cost-implication flag + optional VO link, required-by date,
      issued/acknowledged/complete/cancelled with a mandatory reason. Founder/PM issue; supervisors
      read their project (the table holds no figures, so no role gate on read). Open instructions
      surface on the Tasks list until marked complete.
      **Tested:** issuing and the open-instructions strip under Tasks; then on 2026-08-06 the
      letterhead PDF, the cancel path with its CANCELLED watermark, the refusal to cancel an
      instruction already marked complete, and the supervisor view.
- [x] **A7. M57 RFI Management — built, migration 026 APPLIED, TESTED 2026-08-06.**
      RFI number series, addressed-to (linked vendor or free text), category
      (design/structural/MEP/finishes/other), question, photo attachments, required-by date,
      response text + date, open/answered/closed/cancelled with a mandatory cancel reason.
      Letterhead PDF matching SI/PO/VO/invoice, with a ruled empty response block when unanswered
      so the sheet can be handed to the consultant. Founder/PM raise and answer; supervisors read
      their project (no figures on the table). Shipped with `cancelled` + reason from day one as
      required.
- [x] **A8. M19 Snags + DLP — built, migration 027 APPLIED, exercised on real data 2026-08-01.**
      Snag number series (SNG-0001), work area + trade, severity (low/medium/high), defect photos,
      assign to a linked vendor or free text, status open → in progress → resolved → verified.
      Resolution needs evidence — a photo or a note — enforced by `fn_resolve_snag` and a CHECK
      constraint, not the form. Verification is founder/PM only (whoever fixed it doesn't sign it
      off). Reopening clears the old resolution. DLP start/end per project on Manage → Projects;
      `raised_during_dlp` is frozen at insert by a trigger, so moving the dates later never rewrites
      history. Snag card on Project Detail (open by severity, awaiting sign-off, DLP countdown),
      warning inside 30 days of expiry. Supervisors raise and resolve on their own project. Hard
      delete via `fn_delete_record`, refused once verified.
      **Tested 2026-08-01** by the founder on the live app: DLP dates save and read back (so the
      column grant landed), raising with photos, the evidence-free resolve refusal, verify, the
      reopen-clears-resolution behaviour, and the verified-snag delete refusal.
- [x] **A9. M31 Compliance / Statutory Calendar — built, migration 028 APPLIED, exercised 2026-08-01.**
      `compliance_items` with category (GST/TDS/PF/ESI/labour licence/building permit/insurance/
      other), company-wide **or** project-scoped (`project_id` nullable), due date, recurrence
      (one-time/monthly/quarterly/annual), responsible person, notes, and proof of filing in a new
      `compliance` storage bucket. Month-grouped calendar list under Money → Compliance, colour
      coded green/amber/red off `display_status`, filters by category and by company/project.
      Mark-as-filed uploads the proof and, for a recurring item, generates the next occurrence
      server-side in the same function — counted from the DUE date, not the filing date, and
      protected by a UNIQUE (series_id, due_date) index so a double click can't create two.
      Nightly pg_cron sweep flips past-due items to `overdue`; the calendar does **not** depend on
      it having run. Dashboard strip ("N overdue · N due this week") that renders only when
      something is actually due. Founder/PM/accounts; supervisors cannot reach /money at all.
      **Tested 2026-08-01** by the founder on the live app: adding a deadline, the filing flow with
      proof upload, next-occurrence generation, reopen, and the dashboard strip. pg_cron confirmed
      enabled and the sweep scheduled and active (`mason-compliance-sweep`, `30 22 * * *`).
- [x] **A10. M32 Design / Drawing Management — built, migrations 029+030 APPLIED, TESTED 2026-08-06.**
      Two tables: `drawings` is the identity (number unique per project, title, discipline —
      arch/structural/MEP/interior/landscape/other), `drawing_revisions` is what gets issued
      (revision, WIP/IFC/superseded, issued date, sheet file, what-changed notes).
      **A partial unique index — `unique (drawing_id) where status = 'ifc'` — makes two live
      revisions of one drawing impossible**, and `fn_issue_revision` supersedes the previous sheet
      and issues the new one in a single transaction, demoting before promoting. A CHECK refuses an
      IFC revision with no file or no date.
      Supervisors see IFC revisions **only** — enforced twice: RLS hides WIP and superseded rows,
      and the new `drawings` storage bucket asks `fn_drawing_file_is_current()` before serving a
      file to anyone below founder/pm/accounts, so a stale sheet cannot be opened even with the URL.
      Register under Docs → Drawings, current sheet given top billing, full revision history behind
      a toggle, superseded rows dimmed and struck. Sheets upload byte-for-byte, images included.
      Founder/PM manage. Delete refuses an issued or superseded revision, and any drawing that has
      revisions.
      **Not yet tested:** adding a drawing, the duplicate-number refusal, upload-and-issue, the
      supersede swap, withdraw, the delete refusals, and the supervisor view (IFC only, and a
      superseded sheet's URL must not open).
- [x] **A11. M33 Bill Certification / RA Bills — built, migration 032 APPLIED, reconciled 2026-08-06.**
      Verified in the reconciliation pass: a certified bill's arithmetic
      (gross − previously certified = value this bill; value − retention = net certified), the
      previously-certified deduction across two consecutive bills for the same contractor, and that
      cancelling a certified bill removes its contribution from the running account.
      `ra_bills` + `ra_bill_lines` with `RA-0001` numbering, contractor as a linked vendor or free
      text, period, their bill number, claimed amount, retention %, and
      submitted → under review → certified / rejected / cancelled.
      **Measurement lines carry quantity TO DATE, not this period** — that is how an RA bill is
      written, and it makes the account self-correcting: a later bill restating the true cumulative
      quantity fixes an earlier under-measurement on its own. `fn_certify_ra_bill` computes gross,
      less-previously-certified (summed from earlier certified bills for the same contractor),
      retention on **this bill's value only**, and net — then FREEZES all four on the row.
      `v_ra_bill_totals` previews those figures while a bill is in review and defers to the stored
      snapshot once certified, so editing a line later cannot restate a paid bill. CHECK constraints
      make "certified" impossible without all four figures and a signatory, and rejection impossible
      without a reason. Certification is founder/PM (accounts can prepare and record, not sign).
      Certificate PDF on letterhead with the running account laid out as it reads on paper, net in
      words, and a VOID watermark when rejected **or** cancelled. `v_ra_payables` rolls up certified
      value, retention held and net payable per contractor. Supervisors excluded entirely.
      **Deliberately not done:** certifying does not post to Open Book — vendor invoices already
      post there via procurement, and a contractor appearing in both paths would be double-counted.
      Retention **release** and bank guarantees are A12.
      **Not yet tested:** recording a bill, measurements, certifying, the previously-certified
      deduction across two consecutive bills, retention, rejection, cancel-after-certify, and the
      certificate PDF.
- [x] **A12. M34 Retention & Bank Guarantee — built, migration 033 APPLIED, TESTED 2026-08-06.**
      **Confirmed 2026-08-06:** retention held is derived correctly from certified RA bills, the
      ledger agrees with `sum(retention_amount)`, and the balance falls immediately when a
      certified bill is cancelled — the derived-not-stored design holds.
      **Still unexercised:** planning and releasing a tranche, the over-release refusal, and the BG
      register (adding a guarantee, the scan upload, the amber/red expiry states).
      **Retention held is never typed in** — `v_retention_ledger` sums `retention_amount` from
      CERTIFIED ra_bills per contractor, and the balance is held − released, computed on read, so a
      cancelled bill corrects it immediately. `retention_releases` is both the schedule and the
      record: "half on completion, half after DLP" is two PLANNED rows, and releasing one flips it
      to `released` with the actual amount, date and signatory. `fn_release_retention` refuses to
      release more than is held, and is founder/accounts only because it moves money out.
      **BG register** — type (advance/performance/retention/mobilisation/other), number unique per
      project, issuing bank, value, issue/expiry/claim-period dates, active → released/returned,
      scanned copy in the existing `compliance` bucket (already founder/pm/accounts gated).
      Expiry is derived in `v_bg_register` at query time — amber inside 30 days, red once past — so
      the register is right whether or not the nightly `mason-bg-sweep` pg_cron job ran; the job is
      bookkeeping, matching the 028 pattern. Dashboard strip that renders only when something is
      expiring or expired. Founder/PM/accounts throughout; supervisors cannot reach /money.
      **Not yet tested:** the ledger appearing after a bill is certified, planning and releasing a
      tranche, the over-release refusal, adding a guarantee with a scan, the amber/red expiry
      states, and the dashboard strip.
- [x] **A13. M30 Insurance Management — built, migration 034 APPLIED, TESTED 2026-08-06.**
      `insurance_policies` covering CAR, workmen's compensation, professional indemnity,
      third-party liability and contractor's plant; **company-wide or per project** (`project_id`
      nullable, same two-arm RLS as compliance), policy number unique per insurer, insurer, broker,
      sum insured, premium, start/expiry, policy document in the existing `compliance` bucket.
      Expiry derived in `v_insurance_register` at query time — amber inside 30 days, red once
      lapsed — with `mason-insurance-sweep` (04:20 IST) as bookkeeping only, the third module to use
      that split. **Renewals chain rather than overwrite:** renewing creates a new policy linked
      through `renewed_from` and marks the old one renewed, so what was covered last year survives
      for a late claim; delete refuses a policy another one renews. Dashboard strip alongside
      compliance and guarantees — all three now share one `AlertStrip` component that renders
      nothing when the count is zero. Founder/PM/accounts.
      **Not yet tested:** adding a policy company-wide and per project, the document upload, the
      amber/lapsed states, renewing (chain + delete refusal), and the dashboard strip.

## GROUP B — Complex logic (build second) ~3–4 weeks
- [~] **B1. M02 Schedule + EVM — migration 042 APPLIED and generating; supervisor pass outstanding.**
       `schedule_activities` (WBS code, planned dates, BAC, planned qty, % complete) and
       `activity_dependencies` (finish-to-start with lag, cycles refused by a trigger at write time
       rather than defended against at read time). `activity_id` added to tasks, expenses and
       ra_bills — all ON DELETE SET NULL, because removing a plan line must not take the work or the
       money with it. `fn_activity_float` runs a forward and backward CPM pass and returns total
       float per activity; float ≤ 0 is the critical path. `fn_activity_evm` computes PV (straight
       line across the planned dates), EV (% × BAC), AC (tagged expenses + certified RA bills up to
       the data date), SV, CV, SPI, CPI, EAC, ETC and VAC; `fn_project_evm` rolls up from the SUMS,
       never by averaging the per-activity indices. **Every ratio is NULL, never 0 or Infinity, when
       its denominator is zero** — an activity that has not started has no performance, which is not
       the same as bad performance.
       **The role split is a column grant, not a second table:** `budget_amount` is revoked from
       `authenticated`, so a supervisor reads dates, sequence and progress and cannot reach the
       money; both EVM functions gate on `my_role() in ('founder','pm','accounts')` in their WHERE
       clause and return a supervisor zero rows. Because a column grant is table-wide, the UPDATE
       policy is founder/PM only and a supervisor's progress update goes through
       `fn_set_activity_progress`, which writes exactly three columns.
       **The programme is GENERATED, not typed, and it is a MICRO schedule.**
       `fn_generate_schedule(project, start, end, floors, plot_area)` lays out the whole WBS at the
       level a site engineer works at — not "slab" but staging, shuttering, beam steel, slab steel,
       conduits, sleeves, pre-pour check, pour, cure, deshutter — with its finish-to-start chain.
       76 fixed activities plus 22 per floor: **~120 for a G+1, ~142 for a G+2.** A macro line
       reading "Superstructure — 90 days" cannot be marked 40% complete honestly, cannot say which
       trade is holding the job up, and cannot carry a meaningful budget; at this level each line is
       one crew doing one thing.
       Activities carry a `phase` label (Mobilisation, Substructure, Superstructure — Ground floor,
       …) used only for grouping on screen — every row is a LEAF, so nothing double-counts in EVM.
       Durations come from `fn_schedule_template`, scaled by sqrt(plot area ÷ 2400) for groundworks
       and structure and by sqrt(built-up ÷ 2400) for finishes and services (four times the plot is
       about twice the time, not four times), then by ONE factor that makes the chain land on the
       requested handover date. It returns `compression` = target ÷ natural; below 0.7 the screen
       warns that the dates demand a materially faster build than the method suggests, and generates
       anyway — that call is the founder's. Regenerating is refused outright if the project already
       has activities, and refused even with `replace` if any expense or certified bill is tagged to
       them. `projects.floors` and `plot_area_sqft` store what it was generated from.
       Entry points: the Admin project-creation form (all four fields or none), and a generator that
       IS the empty state on the Schedule tab for the four projects already running.
       Screen at /tasks/schedule: SPI/CPI as big serif figures with green/amber/red bands, a
       plain-English verdict, EAC against BAC, a scrollable Gantt with progress overlay, today line,
       data-date line and critical path picked out, plus per-activity cards with an inline progress
       input.
       **Tested:** 042 applied 2026-08-11 and the generator confirmed working end to end.
       **Still outstanding before this can be ticked [x]:** the supervisor incognito pass on
       /tasks/schedule (no budget, PV, EV, AC, CPI or EAC anywhere; progress still writable), the
       double-generate and money-tagged regenerate refusals, the dependency cycle refusal, an EVM
       reading checked against a hand calculation, and the Excel export opened in real Excel.
- [x] **B2. M17 QA/QC — 043–049 ALL APPLIED. Inspection comments, NCRs, QA plan docs.**
       **Built as a structured ITP (043–047), then replaced (048).** 043–047 shipped templates,
       hold points, 627 checklist questions and derived results. The founder looked at it against
       how the firm actually works and asked for a comment, a photo and a priority instead. 048
       deletes the machinery cleanly rather than keeping it "in case" — a site walk produces
       OBSERVATIONS, not thirty-question forms. Dropped: `itp_templates`, `itp_template_items`,
       `itp_items`, `itp_checks`, `itp_template_checks`, `inspections`, `inspection_checks`, nine
       functions, all seeded content, and the hold-point block on `fn_set_activity_progress`.
       **Inspection comments.** Somebody on a site walk — the team or the client — records what
       they saw: location, the observation, a priority (urgent / high / normal / low), photos, and
       who it is for. `fn_raise_inspection_comment` writes the comment AND its task in one
       transaction; `inspection_comments` has no insert policy at all, so a comment without a task
       cannot exist — a note nobody was told about is the exact failure the feature exists to fix.
       The comment carries no status of its own: the task holds it, and the list reads it through
       the join. One source of truth for "is it done".
       `tasks.priority` and `tasks.assigned_to` are new; the task list sorts urgent first, badges
       urgent/high, and puts a red edge on urgent.
       **NCRs stay** — the formal non-conformance with its NCR-0001 series, corrective action,
       close-out and letterhead PDF. That is what a client or consultant is shown; a comment is not.
       **QA plan docs** is the third tab: upload a PDF straight into Docs → QC Certificates. No new
       table — the folder already existed for exactly this, so a plan uploaded here is the same file
       the Docs module lists.
       **Migration 049 — `documents.doc_kind`.** A filed NCR lives in QC Certificates and belongs
       there, but it was also appearing in the QA plan list. `doc_kind` records what a row IS
       (`qa_plan` / `ncr`) instead of inferring it from the title: matching "NCR-%" breaks the
       moment a file is renamed or a plan is called "NCR response procedure". Open text, not an
       enum, because PO/SI/VO and the handover archive will want labelling later. `fn_qa_summary`
       counts plans only.
       **No fifth role.** The brief's "QA role" is the `pm` access role with a "Quality Engineer"
       job title: `profiles.role` is the four-value enum every policy checks and `designation` is
       display-only by rule.
       Access: every project member raises comments and NCRs (site people find the defects);
       supervisors record corrective actions; only founder/PM delete a comment, close or reject an
       NCR, cancel one, or upload a QA plan. All at RLS and inside the RPCs.
       QA card on Project Detail: open comments with urgent/high split, open NCRs by severity, total
       observations logged.
       **Not yet exercised in the app:** raising a comment end to end and seeing it land in Tasks
       with its priority, filing an NCR to Docs and confirming it stays out of the QA plan list, and
       the supervisor pass (no delete, no NCR close, no plan upload).
- [x] **B3. M05 Rate comparison / comparative statement — migration 050. Run it before testing.**
       The piece A3 left out: the step between the requisition and the order. Items as rows,
       vendors as columns, the cheapest quote per line flagged, a decision recorded with a reason,
       and a PO raised from it without retyping a single rate.
       **The whole record is money, so the gate is at the ROW.** A PO has a rate-free half site
       genuinely needs, which is why 012 revoked `po_lines.rate` column by column. A comparison has
       none — every row of it says what somebody would charge. RLS on all four tables is
       `is_member(project) and my_role() in (founder, pm, accounts)`, so a supervisor gets zero
       rows, not blanked cells. Nothing is column-revoked, so the views are `security_invoker` and
       RLS is the only access control in play — no owner-run WHERE clause to lose in a later edit.
       **Every figure is computed in Postgres.** `v_rc_matrix` flags the lowest rate per item with a
       window function and derives each line total; `v_rc_vendor_totals` gives subtotal, GST at each
       vendor's own rate, grand total, and how many items that vendor left unpriced;
       `v_rc_summary` gives the card figures. `is_lowest_total` counts only vendors who priced EVERY
       item — a total built from eight of ten lines is cheaper for the wrong reason.
       **A missing quote is a missing row**, not a zero: "did not quote" and "quoted nothing" are
       different facts and only the first should keep a vendor out of the comparison.
       **The award is always per item.** `rc_items.awarded_quote_id` is the only representation;
       "award all to Vendor B" writes one row per line rather than a second way of storing the same
       fact. Split awards are the normal case here, not the exception.
       **The reason is enforced in the database.** `fn_rc_award` / `fn_rc_award_item` refuse an
       award above the lowest quote without one, name the vendor and both figures in the message,
       and clear the field when it does not apply. That sentence prints on the statement — it is
       the Open Book justification, so a form-only check would not do.
       **Three BEFORE UPDATE guard triggers**, because an RLS update policy cannot restrict WHICH
       columns are written: `status`, the award columns and the generated-PO link are writable from
       the SECURITY DEFINER RPCs (`current_user` = owner) and refused from PostgREST
       (`current_user` = authenticated). The 021 hole, closed the same way.
       **Convert to PO reuses A3 untouched.** `fn_rc_to_po` raises one `purchase_orders` row per
       winning vendor at status `approved` with rated `po_lines`, so receiving, the 3-way match,
       the PO PDF and cancellation all work on them as usual. `rc_vendors.po_id` is what makes it
       idempotent — no separate "converted" flag to fall out of step. Free-text lines are refused
       BY NAME rather than having a material invented for them: `po_lines.material_id` is NOT NULL
       because a PO feeds stock.
       **It freezes once ordered.** Every write policy refuses on a comparison whose status is
       `ordered` — it is the evidence of how that order was decided, and evidence that can still be
       edited is not evidence. No cancel mechanism: delete while unconverted
       (`fn_delete_comparison`, refused once a PO exists), cancel the PO afterwards.
       **Comparative-statement PDF** on the letterhead, LANDSCAPE because the grid widens with the
       vendor count. Prints the losing quotes as prominently as the winner, ticks the awarded cell,
       bolds the cheapest, and prints every "why not the lowest" reason verbatim. Files to
       Docs → Purchase Orders marked confidential, `doc_kind = 'comparative_statement'`.
       Screen: `/money/compare` only — deliberately not mirrored under `/materials` the way Orders
       is. Two readings of the same server-computed numbers: Lines (one card per item, rates
       entered one-handed) and Statement (the real items × vendors grid, sticky first column).
       **Not yet exercised in the app:** building from a requisition, entering a full grid, the
       refusal when a whole-comparison award is aimed at a vendor with a missing line, the
       reason-required refusal, conversion producing two POs on a split award, the frozen state
       afterwards, and the supervisor pass (no Rate compare tab, zero rows if the URL is typed).
- [x] **B4. M13-C Bar Bending Schedule per IS 2502 — migration 051. Run it before testing.**
       Cutting lengths and steel weights from what the structural drawing says. Arranged around
       being CHECKABLE rather than merely correct, because a short bar is a defect nobody sees
       again once the concrete is poured.
       **The constants are a TABLE, not code.** `bbs_constants` holds one labelled row per IS
       figure — 45°=1d, 90°=2d, 135°=3d, standard hook 9d, stirrup hook max(10d, 75 mm), crank
       0.42, weight divisor 162 — each with its IS reference, its units and a note. A structural
       engineer can audit the whole engine by reading that table. Founder-only write, audited,
       and `on conflict do nothing` on re-run so a deliberate change is never reset.
       **The shapes are DATA too.** `bbs_shapes` carries leg multipliers (a rectangular stirrup is
       simply mult_a = mult_b = 2) plus the count of 45°/90°/135° bends and of each hook type, so
       one row is the whole formula. Eight seeded: straight, hooked, L-bend, U-bar, crank,
       rectangular stirrup, circular tie, spiral. Four formula kinds cover them; anything genuinely
       new gets a kind, not an if-branch.
       **One implementation, answer and working together.** `fn_bbs_cutting_length` returns
       `{cutting_length_mm, straight_mm, hooks_mm, deductions_mm, working, warning}` in one jsonb,
       so the arithmetic printed under each bar is a by-product of the calculation, not a second
       one that could drift. The live preview in the form is a server round trip on a debounce for
       the same reason — a TypeScript copy is the copy nobody re-checks after a constant changes.
       **An impossible input is reported, never clamped.** A stirrup whose deductions exceed its
       perimeter returns a negative length with a warning; the row goes red on screen and prints
       red on the PDF. A schedule that quietly drops a bad line is worse than one that shows it.
       **Self-test in the database.** `fn_bbs_selftest()` re-derives eight worked examples with
       known IS-2502 answers, using the same function the schedule uses, and reports pass/fail with
       the hand working alongside so the EXPECTATION can be checked as well as the result. Exposed
       on the IS rules tab. It earned its place immediately: changing the stirrup hook to 12d
       flipped three cases to FAIL.
       **VERIFIED AGAINST A REAL POSTGRES before shipping** — 8/8 at 0.00 mm difference, roll-ups
       checked against an independent hand calculation, and the script run three times under
       `ON_ERROR_STOP=1`. That found two bugs pglast could not: `fn_audit` assumes an `id` column
       and ABORTS the write on a code-keyed table, and a view must be dropped before the function
       it calls or every re-run fails while leaving the old function in place.
       **Deliberately not done:** it does not decide how many bars a member needs, their diameter,
       or where the cranks go. That is design, it comes off a drawing, and software guessing at it
       would be doing engineering it is not qualified to do.
       Access: founder/PM author, EVERY project member reads including supervisors — the bar bender
       is the audience and there are no rates on a BBS. The brief's "site engineer creates" is met
       by adding a `Structural Engineer` job title mapped to the `pm` access role, a TS-only change
       that cannot widen data access (the 043 decision, unchanged).
       Screen `/tasks/bbs`: member cards with expandable bar marks and a per-bar "show working",
       steel-by-diameter table, IS rules tab with the constants and the self-test, and a landscape
       printable BBS on the letterhead that states in its footer which constants it was cut to.
       **Migration 052 — callout expansion.** Record the member's geometry once, then type what the
       section says (`4-Y16 BOTTOM` / `Y8 @150 STIRRUP` / `2-Y16 CRANK`) and get bar marks with
       dimensions, counts, cutting lengths and weights. The machine does the counting and the
       geometry only — stirrup count from the spacing, stirrup size from the section minus cover,
       crank rise from depth minus cover minus the bar. NOT "read the drawing": a vision model
       would be confidently wrong sometimes, and a plausible schedule nobody checks is invisible
       once the concrete is poured. Anchorage defaults to ZERO because development length is the
       designer's, not the app's. One unreadable line refuses the WHOLE expansion by name; a re-run
       replaces only rows flagged `from_callout`, so a bar added by hand at a support survives.
       `fn_bbs_callout_selftest()` 5/5 — and it caught a real bug on its first run, `(\d+)\s*CRANK`
       matching the DIAMETER in "2-Y16 CRANK" and producing a bar 1810 mm too long.
       **Not yet exercised in the app:** entering a real beam and column off a drawing, the negative
       -length warning appearing on screen, the founder editing a constant and the self-test
       catching it, the callout panel end to end, and the supervisor pass (schedule readable, no Add
       member, no callout panel, no constant edit).
       **Open question for next session:** whether the firm's drawings carry beam/column SCHEDULE
       TABLES. If they do, importing that table from a CAD PDF is deterministic and is the next
       reliable step — no vision model needed.
- [ ] B4b. M13-A/B Estimation / BOQ generator (quantity take-off — the other half of Module 13)
- [x] **B5. M24 Contract Labour — migration 054. Run it before testing.**
       Contractor register, daily gang attendance, the statutory registers as data, and a labour
       cost figure that reaches the P&L exactly once.
       **THE THING THAT WOULD HAVE BROKEN THE P&L.** Attendance × rate is an ACCRUAL — what the
       labour on site is worth. `v_project_pnl` (038) computes cost from expenses and certified RA
       bills — what was PAID. Adding the accrual on top would count every rupee of labour TWICE and
       get the biggest line on most jobs wrong. So attendance never feeds the P&L. It produces a
       figure shown alongside, plus `fn_labour_reconcile` ("attendance says ₹X, ₹Y is booked") and
       `fn_post_labour_expense`, which the founder or accounts runs deliberately to turn a period
       into ordinary expenses. Overlapping periods are REFUSED, so there is still exactly one
       source of cost. Same family as the 038 retention rule.
       Posting writes ONE EXPENSE PER SCHEDULE ACTIVITY in the period, so the `activity_id` tagging
       earned value depends on survives the trip through the ledger.
       **Money is split at the table, not the column.** `labour_attendance` is headcount and a work
       area — every project member reads it, supervisors log it. `labour_rates` is founder/PM/
       accounts only, and the cost views are owner-run with `is_member + my_role` in the WHERE
       clause, so a supervisor gets ZERO ROWS rather than blanked columns (the 050 distinction:
       a row policy when the row itself is the secret).
       **Rate resolution, four scopes**: project + contractor, then project, then contractor, then
       the firm standard — most specific in force on the day wins. `fn_labour_rate` returns zero
       rows for a supervisor rather than raising, because it is called from inside views.
       **Overtime** is `ot_hours × (daily_rate ÷ normal_hours) × ot_multiplier`, with the multiplier
       (2, per the Minimum Wages Act) and the working day (8 h) as columns on the rate so they can
       be seen and changed — the same reasoning as bbs_constants.
       **The registers are named honestly.** A muster roll built from gang counts is NOT the named
       statutory Form XVI. `fn_muster_roll` / `fn_wage_register` / `fn_overtime_register` are
       labelled EQUIVALENT and GANG LEVEL on screen and on paper, and `labour_workers` (Form XIII)
       exists for contractors who supply a roster. A document that looks statutory and is not is
       worse than none — the 044 reasoning about citing an IS code rather than transcribing it.
       Gang counts, not names, because that is what somebody can enter one-handed at a gate (the
       048 lesson).
       **It overlaps with the site log, and says so.** `site_logs` has carried a headcount since
       001. `fn_labour_headcount_check` returns both numbers and the variance and the screen shows
       it, rather than letting whichever was typed last quietly win. The site log is deliberately
       unchanged — that is its own session.
       Attendance is VOIDED, never deleted (it drives wages), with supervisor self-void of their own
       entry; a unique index refuses the same gang twice on one day and area, because a double tap
       on a slow connection would otherwise double that day's wage bill silently. Licence expiry
       follows the 028/033/034 register shape. Over-licence headcount is FLAGGED, never blocked —
       the app cannot send anyone home.
       **VERIFIED ON A REAL POSTGRES**: three clean runs under `ON_ERROR_STOP=1`; rate resolution,
       wages and overtime checked against an independent hand calculation to the rupee; and all four
       guards confirmed firing — duplicate gang, missing rate, overlapping post, void after post.
       Screens: `/tasks/labour` (supervisor quick entry, no figures anywhere) and `/money/labour`
       (wage register, overtime register, rates, contractors, reconcile and post).
       **Not yet exercised in the app:** logging a gang on a phone, the site-log variance banner,
       posting a month and watching it land in the ledger and the P&L, the overlap refusal on a
       second post, and the supervisor pass (attendance visible, /money/labour blocked, zero rows
       if the URL is typed).
- [x] **B6. M29 Company P&L & Project Profitability — 038–041 ALL APPLIED and working.**
       `v_project_pnl` per project: revenue (contract + APPROVED variations only — pending shown
       separately), cost (expenses excluding voids, plus certified RA bills, which deliberately never
       post to Open Book), gross margin and %, cost breakdown by category ranked by overspend, and a
       projected final margin from actual + unspent budget + open commitments (null without a budget
       — a forecast needs something to forecast against).
       **Retention is NOT deducted from margin**: it is already inside cost, so subtracting it again
       would double-count. It appears as a cash memo — "of this cost, ₹X is owed but unpaid".
       `fn_company_pnl` gives the founder-only roll-up: revenue, cost, blended margin, retention,
       commitments, and how many projects are in profit versus losing money. CSV export for the CA.
       Views are owner-run with `is_member + role` in the WHERE clause, because they read
       `contract_value` which 010 revoked; supervisors match no arm and see nothing.
       Tally XML remains deferred — CSV first, as planned.
       **Part 2 (migration 040) — company overheads.** `company_expenses`: a DEDICATED table, not a
       pseudo-project, because an "Office" project would have poisoned portfolio spend, budget vs
       actual, the dashboard cards and `v_project_pnl` — every one of them would have needed to
       learn to exclude one magic row. 12 overhead categories as an enum, manual entry only
       (`fn_duplicate_overheads` copies a month forward on request and REFUSES if the target month
       already has rows), void-not-delete with its own `fn_void_company_expense` (no project, no
       stock, nothing to cascade, so a `fn_void_record` branch would route nowhere), audit trigger,
       and explicit `receipts/company/…` storage policies rather than relying on `is_member()`
       happening to return true for a founder.
       `fn_overhead_summary` gives spend by category for a period; `fn_company_net` returns the three
       layers in one row so the screen cannot present them inconsistently. **The period governs
       overheads only** — project margins stay lifetime-to-date, and the card says so, because
       silently comparing one month's rent against lifetime margin is the easiest way to mislead
       yourself on this screen. Founder/accounts at RLS; a PM gets `sees_overheads = false`, a null
       net, and no Overheads tab; supervisors match no arm anywhere.
       **Tested:** 038/039 verified against raw tables (AADHYA loss ₹25,17,520 / −13.4%; company
       margin ₹4,98,92,480 / 70.1%), dashboard margin lines and portfolio total confirmed live.
       **041** made the headings a founder-managed table rather than an enum: founder writes /
       accounts reads, a unique index on `lower(btrim(name))` so case and a trailing space cannot
       fork a series, rename-by-id so a spelling fix corrects history, and **retire, not delete**
       for anything with entries behind it (`fn_delete_overhead_category` allows a true delete only
       where nothing has ever pointed at the heading).
       **Tested:** overheads entered, headings added and managed, the net position reading through
       on the P&L. Still unexercised: copy-last-month's double-copy refusal and the PM/supervisor
       gates on the new screens.
- [x] **B7. M37 MIS Reports & KPI Dashboard — migration 056. Run it before testing.**
       The cross-project command view at `/money/mis`, first tab after the ledger. Read-only: one
       view and four functions, no tables, no columns, no triggers.
       **THE ACCESS MODEL IS INHERITED, NOT RESTATED.** `v_project_pnl` already carries
       `is_member(p.id) and my_role() in ('founder','pm','accounts')`, so every MIS view is
       `security_invoker` on top of it: founder and accounts get every project, a PM gets assigned
       ones, a supervisor matches nothing and gets ZERO ROWS from all five calls. A second copy of
       the rule would drift, and a reporting screen that drifts leaks the whole company at once.
       **No audit trigger, because nothing writes.** The brief asked for one; there is no table and
       no write here. "Who changed this figure" is answered on `expenses`, `ra_bills` and `budgets`,
       where the audit triggers already are.
       **"Cash position" is not called cash.** There is no bank balance, no receipts against issued
       invoices and no payment run in this app, so a cash figure cannot be computed — only guessed.
       The card says **Net position**, prints that it is margin LIFETIME TO DATE less overheads for
       the CHOSEN PERIOD (the 040 two-spans rule), and states in words that it is not cash.
       **No "margin earned this month" either.** The app does not recognise revenue monthly, so that
       series would be fiction. The chart shows margin TO DATE at each month end, which is
       defensible line by line, and the caption says which one it is.
       `v_mis_projects` joins the P&L to the EVM engine and the open-item counts, and computes ONE
       health verdict per project (critical / watch / ok) server-side, so the screen, the CSV and the
       board PDF cannot disagree about which jobs are in trouble. Thresholds are the conventional
       index bands already used in `format.ts`, and are documented as a convention rather than a
       truth.
       `fn_mis_exceptions` returns eight sources — over budget, negative margin, CPI, SPI, critical
       NCRs, compliance, bank guarantees, insurance, contractor bills waiting, purchase requests
       waiting — in ONE shape, sorted critical first. Eight separate warning boxes is a dashboard
       where the eighth is never read.
       **Charts are hand-built SVG** (`components/MiniChart.tsx`), not recharts: three charts did
       not justify ~400–500 KB of chart library on a PWA that loads on a site phone, and the app
       already draws its Gantt and spend rails this way. Bar charts anchor at zero always; the
       percentage line does not and prints its range so the slope cannot be misread.
       **Exports:** letterhead PDF board report (portrait — it is read in a room) and a projects CSV.
       The PDF's total row comes from `fn_mis_company`, NOT from adding the table it just drew.
       **VERIFIED ON A REAL POSTGRES:** three clean runs under `ON_ERROR_STOP=1`; KPI totals checked
       against an independent hand calculation (₹25,000,000 revenue / ₹19,200,000 cost / 23.2%
       blended margin / net position ₹5,525,000); category percentages summing to 100.0; a PM
       confirmed getting `overheads = null, sees_overheads = false` with margin still visible; and a
       supervisor confirmed getting zero rows from all five sources.
       **Not yet exercised in the app:** the screen against real project data, the board PDF read on
       paper, the CSV opened in Excel, and the supervisor pass (`/money/mis` blocked by the
       MONEY_ROLES guard, and zero rows if the guard were removed).

## GROUP C — Content & internal workflow (build third) ~2–3 weeks
- [ ] C1. M11 Mason Learn (IS codes, 115 method statements, 11-F Bengaluru regulatory bylaws, 11-G materials)
        → mostly structured content as markdown/seed data in Document Vault; light UI to browse/search
- [ ] C2. M07 Client Approvals (INTERNAL record version — log client verbal/WhatsApp approvals with evidence; no portal)

## GROUP D — AI / hard / needs data (build LAST; basic versions only) — reconsider each
- [ ] D1. M39 AI Photo Defect — v1 = photo upload + Claude-vision tagging/notes, NOT trained defect model
- [ ] D2. M38 Drawing Intelligence & Clash Detection — v1 = manual clash checklist + drawing overlay notes
- [ ] D3. M47 Predictive Project Intelligence — v1 = simple trend flags from existing data (cost/schedule slope)
        NOTE: true ML versions need historical project data you don't have yet + specialist work. Defer real AI.

---

## Parked (decide later, not in active roadmap)
- ~~Add-Project + team-assignment admin screen (currently done via SQL)~~ — **BUILT.**
  Founder-only `/admin`: create/edit projects, create users with a job title mapped to an access
  role, assign project membership. Migration 019 + `admin-create-user` Edge Function.
- ~~Project handover archive (zip of all data + files)~~ — **BUILT.** Founder-only card on Project
  Detail: CSVs of every record type, every file grouped by what it belongs to, and an offline index
  page. Downloads to the computer; put it in Drive or anywhere else from there. Direct-to-Drive was
  deliberately skipped — it needs Google OAuth, which breaks the no-extra-services rule for what a
  ten-second drag already does.
- Orphaned-storage cleanup job (removing a photo leaves the object in the bucket)
- pg_cron nightly auto-rollover wrapper (needs owner-invoked function; current rollover is button-triggered)
- Aadhaar e-sign, WhatsApp API — deferred paid integrations if ever needed

## Design system — status
Rolled out in two passes: 2026-07-25 across Money / Tasks / Materials / Docs, and 2026-07-28 for the
gaps that pass missed plus the screens built after it.
**Code-complete and verified by inspection**: zero `rounded-xl border border-border` remain outside
the Toaster; the only inline error banner left is Login's, deliberately; every list has a skeleton,
an empty state with a primary action, and a staggered reveal; touch targets fixed at the button
token (28px → 44px on 15 buttons). `tsc -b --force` clean.
**Not visually reviewed by you** — worth a pass on a phone before it matters.

## Global reminders per module
1. New tables → numbered migration + RLS + audit trigger where financial/material.
2. Money/qty math server-side only.
3. Design system + toasts + skeletons + empty states.
4. Supervisor RLS test if money is shown.
5. Commit git after each module: `git commit -m "MXX: <module> done"`.
