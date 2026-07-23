# PROGRESS — Mason OS
> Cowork: read CLAUDE.md + ROADMAP.md + this at session start; update at session end.

## Done (migrations 001–015 ALL APPLIED — confirmed 2026-07-23)
- [x] Day 1: Foundation — auth, roles/RLS, app shell, Dashboard
- [x] Day 2: Open Book — expenses, budgets, receipts, budget-vs-actual
- [x] Day 3: Tasks + rollover + Daily Site Log; Materials (inward/issue/stock)
- [x] Day 4: Document Vault; migrations 004–006 (filtered totals, project-scoped rollover, storage RLS, rate privacy)
- [x] Security: supervisor RLS test PASSED (money + confidential docs hidden)
- [x] UI: premium design system applied to Dashboard + Project Detail
- [x] Project Detail drill-down navigation

## GROUP A
- [~] **A3 Procurement (Module 22) — PART 1 of 2.** **Migration 012 written, NOT applied**
      (appended to `APPLY_pending.sql`). Full backend now exists:
      - `purchase_orders` (carries the PR→PO lifecycle: starts 'requested', becomes 'approved'
        when rates are set), `po_lines` (qty + rate, `line_total` generated), `goods_receipts`
        + `grn_lines`, `po_invoices` + `invoice_lines`.
      - **GRN → stock**: `fn_grn_to_inward` trigger posts a `material_inward` row per GRN line
        (single source of truth for stock), carrying the PO rate, security-definer so a
        rate-blind receiver can still write it.
      - **3-way match view** `v_po_match`: ordered vs received vs invoiced per line, with
        `match_status` (ok / qty_variance / rate_variance / both / pending), tolerances qty 0.5 /
        rate 2%. `v_po_totals` for PO value.
      - **Invoice → Open Book**: `fn_post_invoice` (founder/accounts only) approves an invoice and
        writes ONE expense row for the net, so procured cost hits the ledger + budgets. Money math
        server-side throughout (generated columns + views + fn).
      - **Rate privacy**: `po_lines.rate`/`line_total` revoked from `authenticated`; served via
        `v_po_lines_rated` gated to founder/pm/accounts. Supervisors see quantities only. Same
        pattern as 006/010.
      - RLS across all 6 tables; audit triggers on PO / GRN / invoice.
      - **Built this turn (Part 1):** raise request (qty-only, supervisor-friendly) +
        Orders list + inline approve-with-rates. Reachable from **both** the Materials tab
        (supervisors: /materials/orders) and the Money tab (money-roles: /money/orders) — the same
        `Orders` screen adapts by role, since supervisors have no Money tab and accounts no
        Materials tab.
      - **Migration 013 (fix):** 012 left `v_po_totals` and `v_po_match` as security_invoker reading
        the revoked `line_total`/`rate`, so the PO value never showed (all users share the
        `authenticated` role). Split: `v_po_totals` = counts only (security_invoker); `v_po_value` =
        ordered value, owner-run + gated to founder/pm/accounts; `v_po_match` rebuilt owner-run +
        gated. Query reads counts from the first, value from the second only for money-roles.
        Also added vendor selection to the approve step (a supervisor-raised request has no vendor).
      - **PO PDF** (`src/lib/poPdf.ts`, jsPDF client-side per stack rule) — on an approved PO,
        money-roles get a "Download PO" control with a GST% selector. Renders company letterhead
        (`src/lib/company.ts` — **placeholders to fill with real GSTIN/address**), vendor block with
        GSTIN, deliver-to (project + site address), line table, subtotal / GST / grand total,
        authorised-signatory footer. Line amounts are the Postgres `line_total`; subtotal/GST/total
        are a print-time roll-up for the document only (not stored — the invoice is the authoritative
        cost record). Warns via toast while company.ts still has placeholders.
      - **PO auto-filed to Docs** (migration 014): approving a PO files **two** copies to the vault's
        new **Purchase Orders** folder, both linked via `documents.po_id` and both showing the PO's
        **live status** pill (joined from `purchase_orders.status`, so it tracks requested → approved
        → receiving → received):
          1. **Full priced PO** — has rates/amounts/totals, `is_confidential=true`, so only
             founder/pm/accounts see it (and storage RLS 006 blocks the object for supervisors).
          2. **Delivery copy** — title "DELIVERY ORDER", quantities only, no rates/amounts/totals,
             `is_confidential=false`, so the **supervisor can open it and chase the vendor for
             delivery**. This is the fix for "PO not visible to supervisor for follow-up" while
             keeping the money-hiding rule intact.
        `poPdf.ts` gained a `variant: 'full' | 'delivery'` switch. Archive failure never blocks the
        approval. Migration 014 also adds `'purchase_orders'` to the `doc_folder` enum.
      - **A3 PART 2 built (migration 015):**
        - **GRN receipt** (`ReceiveForm.tsx`) — on an approved/receiving PO, founder/pm/supervisor
          record what arrived per line (ordered vs already-received vs outstanding). Saves via
          `fn_receive_goods` (migration 015, security-definer so supervisors can receive AND flip the
          PO status, which po_update otherwise reserves to founder/pm). Inserting grn_lines fires the
          012 trigger → `material_inward`, so **stock updates automatically**. Over-receipt warns but
          doesn't block. Status advances receiving → received when every line is fully received.
        - **Invoice + 3-way match** (`InvoiceMatch.tsx`, money-roles) — enter the vendor invoice
          (qty + rate per line, GST), then `v_po_match` shows ordered/received/invoiced with a
          per-line status pill (Matched / Qty variance / Rate variance / both, tolerances 0.5 qty /
          2% rate). "Post to Open Book" (founder/accounts) calls `fn_post_invoice` → writes one
          expense row → ledger + budgets. Variance warns before posting but posting overrides
          (the approved flag).
        - Both surfaces live inside the expanded PO card on the Orders screen, shown by status + role.
        - **A3 is now complete end to end.** Migration 015 appended to APPLY_pending.sql.
- [x] **A2 Safety (Module 04)** — **migration 011 written, NOT yet applied** (append is in
      `APPLY_pending.sql`). Tables: `safety_checklists` (one per project per day),
      `safety_checklist_items`, `incidents`. RLS mirrors tasks (members read; founder/pm/supervisor
      write; accounts read-only; incident close by founder/pm or raiser). Audit triggers on the two
      header tables. `fn_safety_summary(project)` returns days-since-incident, open count, and this
      week's checklist days — dates in Asia/Kolkata, security_invoker so RLS applies.
      - **Daily checklist** (`src/pages/tasks/SafetyChecklist.tsx`) under the Tasks tab — reuses the
        header date picker (checklist is per-day). 6 standard items, Pass/Fail/NA big buttons, remark +
        optional photo each. Upsert on (project_id, check_date) then items on (checklist_id, item_key).
      - **Incidents** (`src/pages/tasks/Incidents.tsx`) — list newest-first + inline raise form
        (type, datetime, description, people, immediate action, multiple photos), open/close toggle.
      - **Safety card on Project Detail** — days incident-free, checklist-this-week %, open count.
      - Photos reuse the `site-photos` bucket, so migration 006's storage policies already cover them.
      - Design system throughout: toasts on every save/close, ListSkeleton, EmptyState, staggered reveal.
      - **Note:** the Tasks header date picker also shows on the Incidents sub-route, where it's inert
        (incidents carry their own datetime). Acceptable; flag if it reads oddly.
- [x] **A1 Vendor Management** — upgraded to the full design system. `Vendors.tsx`
      now has search (name/category/phone/GSTIN), a brass primary "Add vendor",
      sonner toasts on every add/edit/deactivate/restore (no more inline
      banners), `ListSkeleton` while loading, an `EmptyState` with a primary
      action, and a staggered reveal on the list. `VendorForm` toasts on save
      failure (keeps inline validation for the empty-name case); the
      `VendorPicker` inline-add on the expense form toasts "added and selected".
      Functionality (list/add/edit/deactivate + inline add) was already built in
      the Vendors session; this pass brought it up to the design standard.
      Deactivate stays a soft delete (FK-safe), founder/pm/accounts only.

## PHASE 0 (earlier session)
- [x] PWA: `public/manifest.webmanifest`, brass-monogram icons (192/512/maskable/apple-touch), meta tags
- [x] Service worker `public/sw.js` — hand-written, no Workbox. Network-first navigations with cached
      shell fallback; cache-first for hashed `/assets/*`. **All cross-origin requests pass straight
      through**, i.e. every Supabase call — caching REST would serve stale money figures and caching
      storage would keep signed URLs alive past expiry. Installable shell, NOT offline mode.
      Registered from `src/lib/registerSW.ts`, production only.
- [x] `public/_redirects` — SPA fallback (without it, refreshing `/project/<id>` 404s on Pages)
- [x] `public/_headers` — `no-store` on `/sw.js`, 1-year immutable on `/assets/*`
- [x] `.github/workflows/supabase-keepalive.yml` — daily REST ping (free tier pauses after 7 days idle)
- [x] `.github/workflows/supabase-backup.yml` — weekly `pg_dump` in `postgres:17-alpine`, gzipped,
      90-day artifact. Artifact not a committed `backups/` folder: dumps hold every expense and vendor
      phone number, and git history is permanent and in every clone.
- [x] `DEPLOY.md` — Cloudflare Pages setup, env vars, auth redirect URLs, GitHub secrets, restore steps.
      Includes the IPv6 gotcha: `SUPABASE_DB_URL` must be the **Session pooler** URI — the direct host
      is IPv6-only and GitHub runners are IPv4-only.
- [ ] Re-run supervisor incognito RLS test on Project Detail (money + contract value hidden)

- [x] **Production build verified on Windows** — builds in ~1.7s, `vite preview` serves it.
      The earlier "bundle has no app code" finding was specific to the Cowork Linux sandbox and does
      NOT reproduce on Windows. Tell: the sandbox bundle was 441KB with no chunk-size warning; the
      real build exceeds Vite's 500KB threshold and warns, which is the app code being present.
      No action needed. (If a chunk-size warning ever matters, the fix is route-level `lazy()`
      splitting — not urgent for ~15 internal users on a fast connection.)

- [x] Pushed to GitHub — `github.com/bhaibha/masonos`, private, `main`
- [x] `.gitattributes` added (LF normalisation; CRLF in `.yml` breaks Actions runners)
- [x] `.gitignore` hardened with `.env` / `.env.*` — `*.local` alone missed `.env.local.txt`

## Next (see ROADMAP.md)
- [x] Repo connected to Cloudflare — landed in the **Workers** flow, not Pages
- [x] First deploy failed on `_redirects` ("infinite loop"); fixed by deleting
      `public/_redirects` and adding `wrangler.jsonc` with
      `assets.not_found_handling: single-page-application` (the Workers-native
      SPA fallback). Re-push to redeploy.
- [x] **LIVE and login working** — masonos.muhamdwaseem.workers.dev
- [x] Env delivered via committed `.env` (public anon key + URL — safe to commit,
      ships in the bundle anyway; `.env.local` stays gitignored)
- [x] `src/lib/supabase.ts` normalises the URL — strips a trailing `/rest/v1`,
      `/auth/v1` etc. and any trailing slash. The Project URL had `/rest/v1/` on
      it, which doubled every request path → "Invalid path specified in request
      URL". Now bulletproof regardless of where the value is set.
- [x] **Migration 010 written** (`supabase/migrations/010_project_commercials_privacy.sql`)
      + coordinated frontend change — closes the last UI-only money gap.
      - SQL: `revoke select on projects from authenticated`, re-grant the safe
        columns (id/name/client_name/site_address/status/dates/created_at), and
        expose `contract_value` / `management_fee_pct` / `management_fee_amount`
        through owner-run `v_project_commercials`, whose WHERE clause is the
        access control (is_member AND founder/pm/accounts). Same shape as 006.
      - Frontend: `fetchProjects` / `fetchProject` now select ONLY safe columns
        (requesting the revoked ones would 400 for everyone since all app users
        share the `authenticated` role). New `fetchProjectCommercials()` reads
        the gated view, called only for money-roles; ProjectDetail passes the
        result to the header. Order-independent: the fetch falls back to a
        direct table read before 010 is applied, so nothing breaks in the gap
        between deploying code and running the migration.
      - Appended to `supabase/APPLY_pending.sql` (now 004–010).
      - Caveat recorded in the migration: a future project-edit screen must use
        `Prefer: return=minimal` on UPDATE, or PostgREST re-SELECTs the revoked
        columns and 400s.
- Deploy gotchas hit and recorded (see Known bugs): Workers not Pages flow;
  `_redirects` catch-all invalid on Workers (use wrangler `not_found_handling`);
  Cloudflare dashboard build vars override committed `.env`; service worker
  caches old bundle → hard-refresh after deploy.
- [x] **GitHub Actions live and green** — `supabase-keepalive.yml` (daily REST
      ping) and `supabase-backup.yml` (weekly `pg_dump` → `postgres:17-alpine`
      → gzipped 90-day artifact). 3 secrets added; both ran green by hand.
      `SUPABASE_DB_URL` = Session pooler URI (IPv4; Direct is IPv6-only).
- [ ] Set Supabase Site URL / redirect URLs to the Pages domain
- [ ] Re-run supervisor incognito RLS test on Project Detail
- [ ] Roll design system across remaining tabs (Money/Tasks/Materials/Docs)
- [ ] GROUP A → A1 Vendors screen

## Known bugs / notes
- **Migrations 007, 008, 009 are written but NOT applied** — 007 adds `remaining`/`pct_used` to
  `v_project_spend`, 008 adds the `management_fee_amount` generated column, 009 adds
  `v_portfolio_summary` for the all-projects roll-up. Run 007 before 009 (009 depends on it).
  Queries fall back gracefully, so those figures stay hidden until applied.
- A1 Vendors screen is in fact BUILT (`src/pages/money/Vendors.tsx` + inline add on the expense form) —
  ROADMAP line is stale.
- Projects added via SQL currently; admin screen parked
- "View ledger/tasks/stock/documents" buttons verified: `ProjectDetail` calls `select(id)` on mount and
  each layout keeps a still-valid selection, so the tabs open already scoped
- ~~`projects` commercial columns readable by supervisors~~ — **closed by migration 010, APPLIED.**
  No UI-only money gaps remain.
- **Migrations 004–010 are all APPLIED to production** (via APPLY_pending.sql). Delta lines,
  portfolio roll-up, scoped rollover, storage RLS, rate + commercial privacy all live.
- 006 made idempotent (drop-policy-if-exists before each create) so the batch re-runs cleanly.
