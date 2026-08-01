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
- [ ] Re-run supervisor incognito RLS test on the LIVE Project Detail (do after 010 is applied)

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
- [~] Roles & Permissions — RLS is correct by construction and was tested on 2026-07-25, but that
      predates A3 procurement, A5 variations, A6 instructions and the admin module. **The supervisor
      incognito pass has not been re-run since.**
- [x] Audit / Evidence log
- [x] M08 Vendors — superseded by A1 below (screen built and in use)
- [~] M02 Tasks — list + rollover done and in use; EVM/AI-schedule pending (Group B)
- [~] **Admin module (founder-only)** — projects create/edit tested; **creating a user through the
      `admin-create-user` Edge Function has never been run successfully end to end.**
- [~] **Record removal (migrations 020–022)** — void tested (stock movements show VOID with reasons)
      and hard-delete refusal tested (materials blocked with a reference count). **Cancel on a PO or
      an approved VO has not been exercised**, so the revised-contract-corrects-itself path is
      unverified.

---

## GROUP A — Straightforward workflow modules (build first) ~2–3 weeks
Order within group:
- [x] A1. M08 Vendor Management screen — list + search, add/edit/deactivate, inline "add new vendor"
       on the expense form. Full design system (brass primary, toasts, ListSkeleton, EmptyState,
       staggered reveal).
- [~] A2. M04 Safety — **built, never tested.** Daily checklist per site
       (PPE/scaffolding/edge/electrical/housekeeping/excavation, Pass/Fail/NA + remark + photo, one
       per site per day), incident & near-miss reports, safety summary on Project Detail.
       Migration 011 applied. No checklist or incident has ever been filed on real data.
- [x] A3. M22 Procurement — full PR → PO → GRN → 3-way match. Backend migrations 012/013/015;
       raise/approve, PO PDF (full + delivery copy) auto-filed to Docs, GRN receipt (feeds stock),
       vendor invoice + 3-way match with variance flags, post-to-Open-Book. Rate privacy throughout.
- [x] **A4. M15 Invoice Generator — built and TESTED** (migrations 024 + 025 applied).
      Three types with separate number series: progress bill (INV-P), management-fee invoice
      (INV-M), vendor payment voucher (INV-V). Every figure computed by `fn_issue_invoice` from
      expenses / project fee % / posted vendor invoices and stored as an immutable snapshot —
      nothing retyped, nothing recomputed on read. Letterhead PDF matching PO/VO/SI, GST breakup,
      total in words (Indian lakh/crore), VOID watermark when cancelled. Founder/accounts only.
      Progress bills tested across two consecutive bills including the previously-billed deduction.
      **GST treatment is a tax position — see the note in 024's header and confirm with your CA
      before the first real client bill.**
      *025 fixed the running-account structure: the deduction was landing inside the taxable
      subtotal, so the printed GST line couldn't be reconciled against the subtotal above it. The
      payable was always correct; the presentation wasn't.*
- [x] A5. M26 Variation Orders — register (raise/approve/reject, +/- cost impact, status), revised
       contract value on Project Detail, VO PDF on letterhead + file to Docs. Migration 016. PM raises,
       founder approves. Money-gated (supervisors excluded).
- [~] **A6. M56 Site Instruction (SI) — built, partially tested** (migration 023 applied). SI number
      series, addressed-to (linked vendor or free text), work area, instruction, photo attachments,
      cost-implication flag + optional VO link, required-by date,
      issued/acknowledged/complete/cancelled with a mandatory reason. Founder/PM issue; supervisors
      read their project (the table holds no figures, so no role gate on read). Open instructions
      surface on the Tasks list until marked complete.
      **Tested:** issuing, and the open-instructions strip appearing under Tasks.
      **Not yet tested:** the letterhead PDF, the CANCELLED watermark, the cancel path, the
      complete-cannot-be-cancelled guard, and the supervisor view.
- [~] **A7. M57 RFI Management — built, migration 026 APPLIED, not yet exercised.**
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
      proof upload, next-occurrence generation, reopen, and the dashboard strip.
- [ ] A10. M32 Design Management (drawing register: rev control, GFC status, issued-for dates)
- [ ] A11. M33 Bill Certification / RA Bills (measurement → certify → running-account bill)
- [ ] A12. M34 Retention & Bank Guarantee (retention held/released, BG expiry tracking)
- [ ] A13. M30 Insurance Management (CAR/WC/PI policies, expiry alerts)

## GROUP B — Complex logic (build second) ~3–4 weeks
- [ ] B1. M02 Schedule + EVM (Gantt, planned vs earned value, CPI/SPI/EAC — all math server-side)
- [ ] B2. M17 QA/QC (Inspection & Test Plans, hold points, NCR raise/close, checklists)
- [ ] B3. M05 Material Procurement full (indent → rate compare → order, ties into M22)
- [ ] B4. M13 Estimation / BOQ / BBS generator (BOQ, bar-bending schedule per IS-2502 — reinforcement math)
- [ ] B5. M24 Contract Labour (BOCW registers: Form XIII/XVI/XVII as data, gang attendance)
- [ ] B6. M29 Company P&L + Tally export (CSV first, XML later; per-project + company P&L rollup)
- [ ] B7. M37 MIS Reports & KPI Dashboard (cross-project KPIs, exportable reports)

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
