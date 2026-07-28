# MASON OS — Build Roadmap (authoritative order; overrides the spec)

Rule: build top-to-bottom, ONE module per Cowork session. Each module = schema migration → screen(s) →
test on real data → commit → tick here + update PROGRESS.md. Apply the CLAUDE.md design system to every module.
Verify the supervisor RLS test after any module that shows money.

Legend: [x] done · [ ] pending · [~] partial

---

## PHASE 0 — Protect the work — CLOSED
- [x] Deployed live as installable PWA — masonos.muhamdwaseem.workers.dev (Cloudflare **Workers**, not Pages)
- [x] GitHub Actions: daily Supabase keep-alive ping (green)
- [x] GitHub Actions: weekly pg_dump backup → 90-day artifact (green)
- [x] Commercial-figure privacy closed at the DB level (migration 010) — no UI-only money gaps remain
- [ ] Re-run supervisor incognito RLS test on the LIVE Project Detail (do after 010 is applied)

## ALREADY BUILT (migrations 001–010)
- [x] M01 Command Dashboard + Project Detail
- [x] M06 Financial / Open Book (expenses, budgets, receipts)
- [x] M21 Petty Cash
- [x] M03 Site Management / Daily Log
- [x] M16 Material Usage Tracker (inward/issue/stock)
- [x] M09 Document Vault
- [x] Roles & Permissions (RLS, tested)
- [x] Audit / Evidence log
- [~] M08 Vendors — data + RLS done, SCREEN pending (first item Group A)
- [~] M02 Tasks — list + rollover done; EVM/AI-schedule pending (Group B)

---

## GROUP A — Straightforward workflow modules (build first) ~2–3 weeks
Order within group:
- [x] A1. M08 Vendor Management screen — list + search, add/edit/deactivate, inline "add new vendor"
       on the expense form. Full design system (brass primary, toasts, ListSkeleton, EmptyState,
       staggered reveal).
- [x] A2. M04 Safety — daily checklist per site (PPE/scaffolding/edge/electrical/housekeeping/excavation,
       Pass/Fail/NA + remark + photo, one per site per day), incident & near-miss reports (type, people,
       action, photos, open/close), safety summary on Project Detail (days incident-free, checklist %).
       Migration 011 (tables + RLS + audit + fn_safety_summary). Full design system.
- [x] A3. M22 Procurement — full PR → PO → GRN → 3-way match. Backend migrations 012/013/015;
       raise/approve, PO PDF (full + delivery copy) auto-filed to Docs, GRN receipt (feeds stock),
       vendor invoice + 3-way match with variance flags, post-to-Open-Book. Rate privacy throughout.
- [ ] A4. M15 Invoice Generator (client-side PDF: progress bill, management-fee invoice, vendor payment voucher)
- [x] A5. M26 Variation Orders — register (raise/approve/reject, +/- cost impact, status), revised
       contract value on Project Detail, VO PDF on letterhead + file to Docs. Migration 016. PM raises,
       founder approves. Money-gated (supervisors excluded).
- [ ] A6. M56 Site Instruction (SI) — issue instruction to contractor/labour, status, PDF
      **Ship with `cancelled` + cancel_reason in the status enum from day one** (migration 020's
      removal/reversal pass covered PO and VO; SI didn't exist yet).
- [ ] A7. M57 RFI Management — raise to design consultant, categories, response tracking, status
      **Ship with `cancelled`/`rejected` + reason in the status enum from day one** — same reason.
- [ ] A8. M19 Snags + DLP (snag list per area, assign, resolve, defect-liability-period tracking)
- [ ] A9. M31 Compliance / Statutory Calendar (dated reminders: TDS, GST, labour, permits; alert via pg_cron)
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

## Global reminders per module
1. New tables → numbered migration + RLS + audit trigger where financial/material.
2. Money/qty math server-side only.
3. Design system + toasts + skeletons + empty states.
4. Supervisor RLS test if money is shown.
5. Commit git after each module: `git commit -m "MXX: <module> done"`.
