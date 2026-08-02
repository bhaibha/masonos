# PROGRESS — Mason OS
> Cowork: read CLAUDE.md + ROADMAP.md + this at session start; update at session end.

## Done (migrations 001–018 ALL APPLIED — confirmed 2026-07-25)
- [x] Day 1: Foundation — auth, roles/RLS, app shell, Dashboard
- [x] Day 2: Open Book — expenses, budgets, receipts, budget-vs-actual
- [x] Day 3: Tasks + rollover + Daily Site Log; Materials (inward/issue/stock)
- [x] Day 4: Document Vault; migrations 004–006 (filtered totals, project-scoped rollover, storage RLS, rate privacy)
- [x] Security: supervisor RLS test PASSED (money + confidential docs hidden)
- [x] UI: premium design system applied to Dashboard + Project Detail
- [x] Project Detail drill-down navigation

## DESIGN-SYSTEM ROLLOUT COMPLETE (2026-07-25)
The paused rollout is done. **Visual/interaction layer only — no query, RLS or money-math changes.**
All 13 remaining screens + the 4 layout shells now match Dashboard/Project Detail.

- **Inline error banners → sonner toasts.** Every `{error && <p role="alert">}` block removed across
  Money, Tasks, Materials, Docs (and the 4 layouts, where a project-load failure now toasts). All
  failures route through `errText()` so Supabase errors show their real message instead of a generic
  line — the bug that masked three separate issues during procurement testing.
- **"Loading…" text → skeletons.** `ListSkeleton` on Ledger, BudgetVsActual, TaskList, StockRegister,
  MaterialMaster, FolderView, and all 4 layout shells.
- **Bare empty text → `EmptyState`** with icon, friendly line and a primary action: Ledger ("Add your
  first expense"), TaskList ("Add a task"), MaterialMaster ("Add your first material"). Filtered-empty
  states stay as plain text — a filter returning nothing isn't an empty state, it's a non-match.
- **Surfaces →`.paper`** (warm border, soft layered shadow, 20px padding) replacing
  `rounded-xl border border-border`; money figures → `.figure` (Fraunces, tabular-nums).
- **Staggered reveal** on the Ledger and Task lists, matching the Dashboard entrance.
- Validation messages that were inline errors are now toasts too (e.g. "Pick a category", "Work area
  is required"), and IssueForm's insufficient-stock message became a two-line toast with the
  available quantity.
- Structural fix: list items that moved inside `Stagger`/`RevealItem` wrappers changed `<li>` → `<div>`
  to keep the markup valid.
- `tsc -b --force` clean.

## CONSOLIDATION AUDIT (2026-07-23)
Verified four invariants. Two gaps found → **migration 018 written, NOT applied**.

- [x] **Money reconciles from one server-side source.** ✅ Grepped all of `src/` for money
      arithmetic: the only client-side math is bar-width ratios (`format.ts` spendRatio/barGeometry,
      never rendered as currency) and the PO PDF's print-time subtotal/GST roll-up (documented, not
      stored). Every figure traces to `v_project_spend`, `v_portfolio_summary`, `v_budget_vs_actual`,
      `v_project_contract`, `v_po_value`, `v_po_match`, `v_stock`, or `fn_expense_total`.
- [x] **Supervisor RLS hides money at API level (A1–A5).** ✅ `expenses`, `budgets`, `vendors`,
      `po_invoices`, `invoice_lines`, `variation_orders` all carry a role check in their SELECT
      policy. `po_lines` and `material_inward` are readable by members but their rate columns are
      revoked at column level (006/012) and served via gated views — verified correct.
- [~] **Audit trigger on every financial/material table — 6 WERE MISSING.** Fixed in 018:
      `po_lines` (rate, line_total), `invoice_lines` (rate_invoiced), `grn_lines` (qty → stock),
      `petty_cash_accounts` (imprest), `vendors` (payee master), `materials`. Previously a rate on
      an approved PO could be edited with no trail.
- [~] **`material_inward.vendor_name` was unreadable by anyone.** 006 revoked select + granted
      explicit columns; 017 added `vendor_name`, which wasn't in that grant. Fixed in 018 (granted +
      added to both material_inward views).
- [x] ~~Design-system rollout outstanding on Money / Tasks / Materials / Docs~~ — **DONE 2026-07-25,
      see the rollout section above.** Every screen in the app now uses toasts, skeletons and empty
      states.
- **Run migration 018 before testing.**

## GROUP A
- [x] **Flexible vendor entry everywhere** — **migration 017 written, NOT yet applied**
      (appended to `APPLY_pending.sql`). Every vendor reference now keeps an optional `vendor_id`
      link PLUS a free-text `vendor_name`:
      - Columns added to `expenses`, `purchase_orders`, `material_inward` (po_invoices derives from
        the PO; `fn_post_invoice` updated to copy the PO's `vendor_name` onto the posted expense).
      - **`VendorField`** (`src/components/VendorField.tsx`) — reusable typeahead. Type to search
        registered vendors; pick one → id + registered name; type an unknown name → free text, id
        null; one-tap **"Save to vendor list"** registers it and back-links past records
        (`fn_register_vendor`). Replaces the old button-based `VendorPicker` (deleted). Wired into
        the Expense form, PR raise, PO approve, and Materials inward.
      - **Unregistered indicator** — a small amber dot next to free-text vendors in the ledger and
        on PO cards.
      - **Vendors screen → "Unregistered vendors"** section: distinct free-text names in use
        (`v_unregistered_vendors`, money-gated), each with **"Add to vendor list"** (registers +
        back-links via the same fn). Design system throughout (toasts, skeleton, empty states).
      - Spend-by-vendor display coalesces registered-name-else-free-text everywhere it shows.
      - **Run migration 017 before testing.**

- [x] **A5 Variation Orders (Module 26)** — **migration 016 written, NOT yet applied**
      (appended to `APPLY_pending.sql`). `variation_orders` table, money-gated RLS (founder/pm/accounts
      read; pm/founder raise; founder approve/reject; supervisors see NOTHING — whole table is money,
      so row-level RLS suffices, no column tricks). Audit trigger. `+/- cost_impact` (add or omit).
      - **`v_project_contract`** (owner-run, money-roles) computes original + approved variations =
        **revised contract value** — server-side, never in the browser.
      - **Variations screen** (`src/pages/money/Variations.tsx`) under Money tab: contract summary
        (original / approved VOs / revised / pending), raise form (title, description, +Add/−Omit
        toggle + amount), approve/reject (founder), per-VO status pill.
      - **VO PDF** (`src/lib/voPdf.ts`) on letterhead — VO number, description, cost impact,
        before/after contract value, client-acceptance + signatory lines. Download or File to Docs
        (Contracts folder, confidential).
      - **Project Detail header** now shows "Revised contract" with the original ± VOs breakdown when
        approved variations exist; plain "Contract" otherwise.
      - **Run migration 016 before testing.**

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

---

## Session — Admin module (founder-only): projects + users

**Built**

- [x] **Migration 019** `019_admin_designations.sql` — the only SQL this module needs.
      - `profiles.designation text` — a **display-only** job title.
      - audit trigger on `profiles` (role changes decide who sees money, so the
        table belongs in the log alongside vendors/materials from 018).
      - `profiles_admin_delete` policy (founder-only DELETE).
      - **No policy rewrite anywhere.** `projects_write`, `members_write` and
        `profiles_admin` in 001_core.sql already gate INSERT/UPDATE/DELETE to
        `is_founder()`, so creating projects and assigning members needed
        no new RLS at all — only UI. This is why the module carries near-zero
        risk of widening money access.
- [x] **Job title → access role mapping lives in TypeScript**, not the database.
      `DESIGNATIONS` in `src/lib/types.ts` maps each title (Site Engineer,
      Planning Engineer, Billing Engineer, Project Lead, Quantity Surveyor,
      Safety Officer, Store Keeper…) to one of the four enum roles. Adding a
      title is a TS-only change that cannot affect a single policy. Never make
      `designation` load-bearing in SQL.
- [x] **`admin-create-user` Edge Function** (`supabase/functions/admin-create-user/`)
      — the service-role key lives here and only here (CLAUDE.md rule 1).
      Verifies the caller's JWT, reads their profile *through an anon client so
      RLS applies*, and refuses anyone who isn't `founder` **before** the
      service-role client is constructed. Creates the auth user, updates the
      profile row the `handle_new_user` trigger already inserted, and upserts
      project_members. Rolls back the auth user if the profile update fails, so
      a half-created login can't be left behind.
- [x] **`/admin` (founder-only)** — `RequireRole allow={ADMIN_ROLES}`:
      - **Projects tab**: create + edit projects, incl. contract value and
        management fee %. Reads existing commercials back through the gated
        `v_project_commercials` view.
      - **Team tab**: add a person (name, job title, access level, email,
        temporary password, phone, project assignments); edit anyone's title,
        role, phone and assignments; deactivate/reactivate. Every access level
        shows a plain-English note of exactly what it grants, so the founder
        can see that "Site Engineer" means money is hidden.
      - Project assignment is a chip toggle writing `project_members` —
        the table every `is_member()` check reads.
- [x] Dashboard: founder-only **Manage** link beside "By project", and the empty
      state now offers "New project" to founders instead of a dead end.

**Deliberate decisions**

- Access is still the 4-role enum. A fifth role would have meant auditing every
  policy across 18 migrations for a purely cosmetic gain.
- `createProject`/`updateProject` select only 010-granted columns on the way
  back. PostgREST's default `return=representation` re-SELECTs every column
  after a write, which would hit 010's revoke on `contract_value` and 400 —
  the caveat recorded in migration 010 has now been honoured.
- `fetchMyProfile` requests `designation` and silently retries without it, so
  sign-in keeps working in the window between deploying code and running 019.

**Pending**

- [ ] Deploy the Edge Function: `supabase functions deploy admin-create-user`
      (until then, "Add person" fails; editing existing people works fine).
- [ ] Re-run the supervisor incognito test after 019 — expected unchanged, since
      no read policy moved.
- [ ] ROADMAP Group A: A6 Site Instructions, A7 RFI, A8 Snags + DLP,
      A9 Compliance calendar, A10–A13.
- [ ] Orphaned storage objects from before the data clear (receipts / site-photos
      / PO PDFs) — clear via the Supabase dashboard if wanted.

**Run migration 019 before testing.**

---

## Session — Record removal & reversal, part 1: void/reverse (migration 020)

Scope agreed up front: this session does the **correctness-critical half** — the full backend
(every column, every view and RPC rewrite) plus the void UI for money and stock. Hard delete and
cancel/reject are migration 021, next session.

**Built**

- [x] **Migration 020** `020_void_and_reverse.sql` — the whole void backend in one atomic file.
      - `voided_at` / `voided_by` / `void_reason` on **expenses, petty_cash_entries,
        material_inward, material_issues, goods_receipts, po_invoices**.
      - A CHECK constraint per table makes the reason a **database** rule: all three columns are
        null, or all three are set with a non-blank reason. The form can't be the only guard.
      - Partial indexes on `(… ) where voided_at is null` — every hot query now carries that filter.
- [x] **Two back-links added, because the cascade had nothing to follow.** This was a real hole:
      - `material_inward.grn_line_id` — `fn_grn_to_inward` used to write inward rows tagged only
        with the remark 'Auto from GRN'. There was **no way to reverse a goods receipt's own stock**.
      - `expenses.pc_entry_id` — `fn_pc_to_expense` mirrored petty-cash spends into the ledger with
        no link back, so voiding a petty cash entry would have left a **ghost expense** still
        counting against the budget.
      Both trigger functions now set the link. Nothing to back-fill (transaction data was cleared
      before real entry began) — noted in the migration.
- [x] **`fn_void_record(p_table, p_id, p_reason)`** — SECURITY DEFINER, and the *only* path to a
      void. Checks the role (money = founder/accounts, stock = founder/pm), refuses a blank reason,
      cascades, and logs. **No UPDATE policy on `voided_at` was added on purpose**, so the client
      physically cannot flip the flag itself.
      Guards it enforces, each with a message the UI shows verbatim:
      - voiding a delivery that a GRN created → "void the goods receipt instead"
      - voiding an expense a petty-cash entry created → "void the petty cash entry instead"
      - voiding an expense a vendor invoice posted → "void the invoice instead"
      - voiding stock that's already been issued → blocked, names the materials
      - voiding a GRN when an invoice is already posted → blocked, "void the invoice first"
      Cascades: GRN void → its inward rows + PO status walked back to what the *remaining live*
      receipts justify; petty cash void → the mirrored expense; invoice void → the posted expense.
- [x] **`fn_stock_on_hand(project, material)`** — one definition of live stock, used by both the
      void guard and `fn_check_stock`, so the two can never disagree.
- [x] **Every server-side total rewritten to exclude voided rows** — this is the part that makes
      voiding *mean* something (CLAUDE.md rule 2: the browser never filters money):
      `v_project_spend` (→ `v_portfolio_summary` via cascade) · `v_budget_vs_actual` ·
      `v_petty_cash_balance` · `v_stock` · `v_po_match` · `v_material_inward` ·
      `v_material_inward_rates` · `fn_expense_total` · `fn_check_stock` · `fn_receive_goods` ·
      `fn_post_invoice`.
- [x] **UI** — shared `VoidDialog` (danger-coloured, mandatory reason, states the consequence,
      Escape to close), `VoidBadge`, `voidRowClass` (dimmed + struck through), `VoidNote`
      ("Voided by X on date — reason"). Wired into:
      - **Ledger** — void an expense; the total above it comes from `fn_expense_total`, so it drops
        the moment the void lands.
      - **Materials → Movements** (new screen) — every delivery and issue for the project, newest
        first, filterable. Reads the rate-free `v_material_inward`, so supervisors can review it
        even though they can't void.
      - **Orders → invoice/match panel** — goods receipts are now listed (they never were) and can
        be voided there, which is the only correct place since voiding the GRN is what reverses its
        stock. Invoices can be voided posted or unposted.

**Deliberate decisions**

- Voiding is RPC-only. Adding an UPDATE policy would have been less code and a much bigger hole.
- Voided rows stay in lists rather than disappearing — that's the point of a reversal over a delete.
- `v_petty_cash_balance` filters voided entries in the **JOIN**, not the WHERE: in the WHERE, an
  account whose only entries were voided would vanish from the list entirely.
- The GRN stock guard aggregates per material before comparing. Checking row-by-row would pass two
  lines of the same material individually while the combined reversal still went negative.

**Verification**

- Migration parsed against the real PostgreSQL grammar (`pglast`/libpg_query): outer SQL clean,
  `fn_void_record` plpgsql body clean. Three trigger functions report a parser JSONDecodeError —
  **the same three fail identically in the already-applied 002/003/012**, so it's a pglast quirk,
  not a defect.
- No `create or replace view` anywhere in 020 — every view is drop-then-create (the rule that had
  been broken three times).
- All eight recreated views explicitly re-granted; `DROP VIEW` discards privileges.
- `tsc --noEmit` clean.

- [x] **`CLEAR_transactions.sql` delete order fixed** — the two new FKs broke it. `material_inward`
      must now precede `grn_lines`, and `expenses` must precede `petty_cash_entries`. The old order
      would have failed halfway.

**Pending / next session (migration 021)**

- [ ] Hard delete (founder/PM, confirm, blocked-if-referenced) for draft PRs, tasks, unsubmitted
      safety entries, documents, unused vendors/materials.
- [ ] `cancelled`/`rejected` + reason on PO and VO, excluded from active lists and value/match.
      Cancelling a PO with a live GRN blocked — void the GRN first.
- [ ] **Petty cash has no screen** — the tables and the void path exist and work, but there's no UI
      to reach them from. Either build the screen or drop the module.
- [ ] Re-run the supervisor incognito test: supervisors must still see no money on Movements.

**Migration 020 APPLIED** — confirmed 2026-07-27; the verify SELECT returned `fn_void_record` and
`fn_stock_on_hand`, both of which sit near the end of the script, so every statement above them ran.

---

## Fix — records raised by a supervisor "missing" for the founder

**Not a data or RLS problem.** `is_member()` already returns true for founders on every project, so
a founder can read every PO, task and movement. The records were there the whole time; the founder
was looking at a different project, and the UI gave no clue.

Three causes, all fixed:

- [x] **The selected project was stored under one shared localStorage key.** Signing out of one
      account and into another on the same browser inherited the previous person's selection. Now
      namespaced per user id (`masonos.selectedProjectId.<uid>`), with a one-time carry-over from
      the old shared key so nobody's choice resets.
- [x] **ProjectPicker rendered NOTHING when the user had a single project** — which is exactly the
      supervisor's case. They had no way to see which project they were logging against. The active
      project is now always named; only the ability to *change* it depends on having more than one.
- [x] **Empty lists were ambiguous.** "Nothing was raised" and "you're on the wrong project" looked
      identical. Added `OtherProjectsHint` under the empty states on Orders, Tasks and Movements:
      "Showing <Project> only. You have N projects — switch with the picker above."

Also: the store now tracks `autoSelected`, set when a stored selection is no longer valid and it
falls back to the first project — available for a future "we switched you" notice.

`tsc --noEmit` clean.

---

## Session — Record removal, part 2: cancel/reject + supervisor self-void (migration 021)

**The hole this closes.** An approved VO immediately moves `revised_contract_value` through
`v_project_contract`, and there was **no way back**: `vo_status` was submitted/approved/rejected,
and 'rejected' is only reachable while still submitted. A VO approved by mistake permanently
inflated the contract figure — on the one number that defines the job. Purchase orders had the same
shape of hole: an approved PO couldn't be cancelled.

**Built**

- [x] **Migration 021** `021_cancel_and_supervisor_void.sql`
      - `cancelled` added to `vo_status` (po_status already had it from 012).
      - `cancelled_at` / `cancelled_by` / `cancel_reason` on `purchase_orders` and
        `variation_orders`, with a CHECK: **status = 'cancelled' ⇒ all three present and the reason
        non-blank**. Scoped to cancelled rows, so existing rows can't violate it.
      - **Why the CHECK matters and the RPC alone didn't:** `purchase_orders` has a client-writable
        UPDATE policy (`po_update`) and the app calls `setPoStatus()` directly. A client could have
        flipped status to 'cancelled' with no reason. The constraint makes that impossible —
        `cancelled_by` can only be stamped honestly by the SECURITY DEFINER function.
      - **`fn_cancel_document(p_table, p_id, p_reason)`** — role check (PO = founder/pm, VO =
        founder, mirroring who approves), mandatory reason, audit row. Refuses to cancel a PO that
        still has live goods receipts or vendor invoices, naming the count: *"void the receipt(s)
        first, then cancel the order."* Refuses a closed order.
      - **`fn_reject_variation(p_id, p_reason)`** — rejection was a bare status flip with no
        explanation; now the reason is recorded and shown on the card.
      - **Cancelled documents drop out of the numbers, server-side:** `v_project_contract` (which
        also now returns `cancelled_value`), `v_po_value`, `v_po_match`. `fn_receive_goods` and
        `fn_post_invoice` refuse to act on a cancelled order.
- [x] **Supervisor self-void** — `fn_void_record` now accepts a supervisor voiding a
      `material_inward` / `material_issues` row **they created**. Goods receipts stay founder/pm
      (voiding one reverses a whole delivery). Every 020 guard still applies: can't void consumed
      stock, can't void a GRN-created inward row.
      Scope chosen: **own entries, any date** — the literal reading of the instruction. The
      migration documents the one-line change to tighten it to same-day only.
- [x] **UI** — `VoidDialog` refactored into a shared `DestructiveDialog` shell so void, cancel and
      reject read identically and can't drift. New `CancelDialog`, `RejectVoDialog`,
      `CancelledBadge`, `CancelNote`. Wired into:
      - **Variations** — "Cancel variation" on approved VOs (founder), Reject-with-reason on
        submitted ones, and the reason shown on cancelled/rejected cards.
      - **Orders** — "Cancel order" on any non-closed PO (founder/pm); the PO document is hidden
        once cancelled; the reason shows on the collapsed card.
      - **Movements** — supervisors now see Void on their own entries. On someone else's they get
        *"Logged by someone else. Ask a PM or the founder to void it."* rather than a blank space,
        which previously read as "corrections are impossible".

**Verification**

- Parsed against the real PostgreSQL grammar (pglast/libpg_query): outer SQL clean, all five
  function bodies clean — including the two rewritten from 020.
- **Enum/transaction trap avoided:** `alter type … add value` commits the label, but Postgres
  refuses to USE it elsewhere in the same transaction, and the Supabase editor runs a script as one.
  Every comparison against 'cancelled' outside a function body is written `status::text = '…'`.
  Recorded in CLAUDE.md as a standing rule.
- No `create or replace view` — all four views drop-then-create, and all are re-granted.
- `tsc --noEmit` clean.

**Still pending**

- [ ] Hard delete (mechanism 1): draft PRs, tasks, unsubmitted safety entries, documents, unused
      vendors/materials — founder/PM, confirm dialog, blocked with an explanation if referenced.
- [ ] Petty cash still has no screen.
- [ ] Supervisor incognito re-test after 021.

**Run migration 021 before testing.**

---

## Session — Record removal, part 3: hard delete (migration 022)

Asked for "delete/cancel on everything in the founder section". Built as: **a removal action on
every record type, with the mechanism chosen by what the record affects.** Money and stock still
can't be hard-deleted — that's void — and the RPC now says so explicitly instead of the button
simply being absent.

**Starting state was worse than it looked.** RLS is default-deny, and there were DELETE policies on
only three things (documents, project_members, profiles). Tasks, site logs, safety entries,
incidents, materials, vendors: none could be removed at all.

**Built**

- [x] **Migration 022** `022_hard_delete.sql` — `fn_delete_record(p_table, p_id)`.
      Deletable, each reference-checked server-side:
      - `tasks` — refused if another task was rolled over from it (the rollover chain is history)
      - `site_logs`, `incidents`, `safety_checklists` (items cascade), `documents`
      - `purchase_orders` **only while status = 'requested'** — anything approved has a number a
        vendor may hold, so it's cancelled instead, and the error says so
      - `materials` — refused with a count if any delivery, issue or PO line uses it
      - `vendors` — refused with a count if any expense, delivery or PO references it
      - `budgets` (founder/accounts, matching `budgets_write`)
      Explicitly refused, with the right instruction rather than a generic error:
      expenses / petty cash / inward / issues / GRNs / invoices → *"void it instead"*;
      variation_orders → *"cancel it instead"*; projects → *"set it to Completed or On hold"*;
      profiles → *"deactivate them"*.
- [x] **No DELETE policies added.** RLS default-deny means the client cannot delete these tables
      directly; `fn_delete_record` is SECURITY DEFINER and is the only route. Same shape as
      `fn_void_record` and `fn_cancel_document`.
- [x] Audit triggers added on `incidents`, `safety_checklists` and `budgets` — they were newly
      deletable and a delete must leave a trail. Plus a `DELETE_HARD` audit row so deletions are
      greppable alongside `VOID` and `CANCEL`.
- [x] **UI** — shared `DeleteButton` + confirm (`src/components/DeleteAction.tsx`). No reason field,
      unlike void/cancel: nothing moved, so what matters is that it's deliberate. The RPC's refusal
      message is surfaced verbatim, because it tells the user what to do next. Wired into Tasks,
      Materials, Vendors, Incidents, Documents, and draft requests on Orders.

**Decisions taken (confirmed with the user)**

- **Projects: archive, don't delete.** Every table cascades on project_id — one click would destroy
  a whole job's history including its audit log.
- **Users: deactivate, don't delete.** Their name is on `created_by` / `raised_by` / `approved_by`.
- **Money/stock: still void only.** Deleting an expense destroys the audit trail on a figure someone
  will later have to explain, and GST invoices carry a statutory retention requirement in India.

**Verification**

- Parsed against the real PostgreSQL grammar (pglast/libpg_query): outer SQL and the function body
  both clean.
- Caught during review: the top-level role gate was founder/pm, which would have made the
  founder/accounts budgets branch unreachable. Split into a coarse gate plus per-branch rules, with
  the not-deletable branches left reachable by accounts so they get *"void it instead"* rather than
  a role refusal.
- `tsc --noEmit` clean.

**Still pending**

- [ ] Petty cash still has no screen.
- [ ] Supervisor incognito re-test after 021 + 022.
- [ ] Orphaned storage objects: deleting a document row removes the listing, not the file in the
      bucket. Worth a cleanup pass or a storage delete in the same call.

**Run migration 021 then 022 before testing** — `APPLY_pending.sql` contains both, in order.

---

## Session — Design-system sweep, second pass (2026-07-28)

Migrations confirmed at session start: **001–022 ALL APPLIED**, next = 023. This session touched
**no queries, RLS or money math** — visual/interaction layer only.

**Important: the 2026-07-25 rollout had already done most of this.** Audited first rather than
redoing it. What was actually still on old patterns was a smaller, specific set — mostly the forms,
plus components added after that rollout.

**Fixed**

- [x] **Inline error banners → toasts.** Two survivors: `VendorForm` (kept a banner *and* a toast —
      duplicate messaging, and its validation path only set the banner) and `DocumentList`
      ("Could not open this file"). VendorForm's catch also used `err instanceof Error`, which is
      false for Supabase errors, so the real message was being swallowed — now `errText`.
      `Login.tsx` deliberately keeps its inline banner: it sits outside the app shell and a sign-in
      failure should stay visible next to the field, not fade.
- [x] **"Loading…" → skeletons** on BudgetEditor, SiteLog, ReceiveForm. (Button busy labels and
      input placeholders left alone — those aren't loading states.)
- [x] **Empty states with a primary action** added to BudgetVsActual, StockRegister, FolderView —
      all three were bare centred text with an underlined link. Each now carries an icon, a real
      sentence and a button, plus `OtherProjectsHint`. Search-with-no-match stays plain text: a
      non-match isn't an empty state.
- [x] **Old card pattern `rounded-xl border border-border` → `.paper`**, now zero occurrences
      outside `Toaster` (intentional there). Covered Folders' folder tiles (which also gained
      hover-lift + focus ring to match Dashboard cards), MaterialMaster's add form, DocumentList's
      container, UploadForm's confidential box (flattened to `bg-secondary/50` — it had become a
      card inside a card).
- [x] **Forms onto `.paper`**: ExpenseForm, TaskForm, SiteLog, InwardForm, IssueForm, UploadForm,
      MaterialMaster's add form. They were bare `space-y-5` on the page background.
- [x] **Staggered fade-up** added to BudgetVsActual, StockRegister, MaterialMaster, Folders,
      DocumentList. Required converting `<li>` → `<div>`/`<RevealItem>` in those lists, since the
      wrapper isn't a `<ul>` any more.
- [x] **Touch targets fixed at the token, not per-button.** shadcn's defaults were h-8/h-7/h-9
      (32/28/36px) against CLAUDE.md's 48px minimum; 15 buttons rendered at 28px. Raised in
      `button.tsx`: default and sm → h-11, lg → h-12, icon/icon-lg → size-11, with padding nudged
      to match. Text sizes untouched, so nothing looks heavier — just tappable with gloves.

**Two things went wrong, both worth recording**

1. **A regex codemod mangled 13 files.** Matching `<Button ...>` with `[^>]*?>` stopped at the `>`
   inside `() =>`, producing `onClick={() = className="h-11"> setFoo()}`. Repaired, and the
   approach abandoned in favour of the one-line token change above — which is what should have been
   done first.
2. **`npx tsc --noEmit` NEVER CHECKED ANYTHING.** The root `tsconfig.json` has `"files": []` and
   only project references, so it compiles nothing and always exits 0. It reported "clean" on all
   13 mangled files. Every typecheck claimed in earlier sessions using that command was worthless.
   **The correct command is `npx tsc -b --force`**, which is what `package.json`'s build uses.
   Recorded as rule 10 in CLAUDE.md. Final state verified green under the real command.

**Not done / notes**

- oxlint and vite build can't run in the Linux sandbox (both ship Windows-only native bindings),
  so `npm run build` still needs running on the machine before deploy.
- Everything remains uncommitted — the live site is behind localhost.

---

## Session — A6 Site Instructions (Module 56), migration 023

Confirmed at start: **001–022 ALL APPLIED**, next = 023.

**Built**

- [x] **Migration 023** `023_site_instructions.sql` — `site_instructions` table, `si_status` enum
      (issued / acknowledged / complete / cancelled), `si_number_seq` → `SI-0001`.
      - Addressed-to uses the **flexible vendor pattern from 017**: optional `vendor_id` plus
        free-text `addressed_to`. A labour contractor usually isn't in the vendor master and
        forcing registration before issuing an instruction is friction nobody on a site accepts.
        A CHECK requires one of the two — an instruction with no recipient is meaningless.
      - Attachments are storage paths in the **site-photos** bucket, so every path starts
        `${projectId}/` and the existing storage RLS applies unchanged.
- [x] **The SI holds NO money, deliberately.** Cost is a boolean plus an optional FK to
      `variation_orders`. That's what lets `si_read` be plain `is_member(project_id)` with no role
      check — supervisors read every instruction on their project, because they're the ones acting
      on it, and there is no figure to hide. The rupee value stays on the VO, which is already
      money-gated. A supervisor sees "Carries a cost implication" and, because the VO fetch returns
      nothing for them, never the VO number or amount. **No column-level revoke needed.**
- [x] **Cancellation reuses 021's machinery** rather than inventing a fourth pattern:
      `fn_cancel_document` gains a `site_instructions` branch, so PO, VO and SI cancel through one
      function; a CHECK constraint makes the reason a database rule. Extra guard: an instruction
      already marked **complete cannot be cancelled** — the work was done, and cancelling would
      misrepresent the record.
      ROADMAP's note that A6 must ship with `cancelled` + reason from day one is satisfied.
- [x] **`fn_set_si_status`** for issued/acknowledged/complete — stamps `acknowledged_by/at` and
      `completed_at` in the same statement as the status, so the two can't drift the way two
      separate client updates would. Refuses to touch a cancelled instruction ("reissue instead").
- [x] **Not hard-deletable, by omission.** `site_instructions` has no DELETE policy and no branch
      in `fn_delete_record`, so RLS default-deny makes deletion impossible. Recorded in the
      migration so the absence reads as intent rather than oversight.
- [x] **`siPdf.ts`** — letterhead identical to the PO/VO templates (same margins, type scale, brass
      rule, signature block). Three-column meta strip (To / Work area / Required by), the
      instruction body, and a cost note that names the linked VO **without stating an amount**.
      A cancelled instruction prints a rotated **CANCELLED watermark at 14% opacity** — light enough
      that the document underneath stays legible, because a cancelled instruction is still a record
      of what was once instructed — plus the reason at full opacity above the signature block.
- [x] **Tasks → Instructions screen**: list with status pill, overdue flag against required-by,
      attachment thumbnails, acknowledge/complete actions, Download / File to Docs, and cancel via
      the shared dialog. Issue form with vendor typeahead, camera-first attachments (compressed),
      cost toggle that reveals a VO picker. Design system throughout — skeleton, empty state with
      primary action, `OtherProjectsHint`, staggered reveal, toasts on every action.
      Filed PDFs are **not** confidential, so supervisors can open them.

**Verification**

- Migration parsed against the real PostgreSQL grammar (pglast/libpg_query): outer SQL clean, both
  function bodies clean. No `create or replace view`.
- `si_status` is a brand-new type, so 021's "unsafe use of new value of enum type" trap does not
  apply — that only affects `ALTER TYPE … ADD VALUE`. Comparisons still use `::text` for consistency.
- **`npx tsc -b --force` clean** — the correct command per CLAUDE.md rule 10. It caught two real
  errors during this build (PostgREST's inferred type breaking on the embedded `vendors(name)` join,
  and `VendorValue`'s fields being `vendorId`/`vendorName` rather than `id`/`name`). The old
  `--noEmit` would have reported both as clean.

**Open question for you**

- **Who marks an instruction acknowledged?** Right now founder/PM do, because the spec said
  supervisors view only. In practice the site supervisor is the one who'd hear the contractor
  acknowledge it. If you want supervisors to be able to tick acknowledge (but nothing else), that's
  a small change to `fn_set_si_status` and `si_update`.

**Migration 023 APPLIED** — confirmed 2026-07-28.

**Follow-up, same day (no migration):**

- [x] **Open instructions now surface on the Tasks list.** An SI has no planned date and doesn't
      roll over, so it can't be merged into the day's tasks — but leaving it on its own tab meant a
      supervisor working through their day would never see it. `OpenInstructions` renders a strip
      above the day's work listing every instruction that is `issued` or `acknowledged`, on **every
      date**, because an open instruction is outstanding regardless of which day you're viewing. It
      disappears the moment the instruction is marked complete (or cancelled), and renders nothing
      at all when there are none. Overdue ones are counted in the header and flagged in red.
      Backed by `fetchOpenSis` — a lean query with no vendor join, issuer lookup or VO resolution,
      since this feeds a summary strip rather than the full screen. A failure there returns an empty
      list rather than throwing, so a problem with instructions can never take down the task list.
- [x] **`OtherProjectsHint` added to Variations and Incidents** — both were still showing a bare
      "nothing here" when the founder was simply on a different project than the PM. Third time this
      confusion has surfaced; these were the screens the earlier pass missed. Vendors is deliberately
      excluded (the vendor master is global, not project-scoped).

---

## Session — A4 Invoice Generator (Module 15), migration 024

Confirmed at start: **001–023 ALL APPLIED**, next = 024. A4 had been skipped — A5 and A6 were built
out of roadmap order — so this closes the gap.

**Built**

- [x] **Migration 024** `024_invoices.sql` — `invoices` + `invoice_items`, `invoice_type`
      (progress / management_fee / vendor_voucher), `invoice_status`, three number sequences
      (INV-P / INV-M / INV-V, a separate series per type as required).
- [x] **`fn_issue_invoice` derives every figure; nothing is retyped.**
      - *Progress bill* — cost-plus running account: reimbursable cost for the period (gross spend
        from `fn_expense_total`, which already excludes voided expenses), plus the management fee at
        the project's own percentage, **less everything already billed on earlier live progress
        invoices**. That deduction is why a cancelled bill matters: it stops counting immediately.
      - *Management fee* — fee % × certified net spend for the period. Refuses outright if the
        project has no fee percentage set, naming the screen to go fix it.
      - *Vendor voucher* — one line per posted, un-voided vendor invoice in the period, pulled from
        `po_invoices` + `purchase_orders`. If there are none it deletes the shell and errors rather
        than burning a number on an empty voucher.
- [x] **Amounts are a SNAPSHOT, not a live view.** This is the one place the app deliberately breaks
      its own "always compute live" rule: every other figure comes from a view because it should
      track current data, but a bill sent to a client must never change as later expenses land. So
      the RPC computes once, at issue time, and writes the numbers down. The browser still computes
      nothing — it prints what Postgres stored, and the header subtotal is summed from the stored
      line amounts so the two can never disagree.
- [x] **No write policy on `invoices` or `invoice_items`.** Read is founder/accounts; insert and
      update happen only inside SECURITY DEFINER RPCs. RLS default-deny means a client cannot forge
      an invoice or edit an issued one's figures.
- [x] **Cancellation joins the shared path** — `fn_cancel_document` gains an `invoices` branch, so
      PO, VO, SI and invoices now all cancel through one function with one CHECK-enforced reason.
- [x] **`amountInWords.ts`** — Indian lakh/crore grouping, paise only when non-zero, "Minus" prefix
      for negatives. **Unit-tested: 12 cases pass**, including ₹5,24,00,000 → "Five Crore Twenty
      Four Lakh" and paise handling. Western thousand/million grouping would be immediately wrong on
      an Indian invoice, so this was worth testing rather than eyeballing.
- [x] **`invoicePdf.ts`** — letterhead identical to PO/VO/SI, billed-to + project block, line items,
      GST breakup, total, amount in words, VOID watermark at 14% opacity when cancelled with the
      reason at full opacity. Filed to Docs → Invoices marked **confidential**, so supervisors never
      see it.
- [x] **Money → Invoices screen** — expandable cards showing the stored lines and totals, Download /
      File to Docs / Cancel, raise form with type, period, vendor picker (voucher only) and GST rate.
      Tab hidden for a PM so they don't hit an empty screen. Full design system.

**Flagged for you — this one is not a technical decision**

The progress bill is modelled as cost-plus: reimbursable cost billed **gross** with no further GST
(the tax was already borne on those purchases), and GST applied to the **management fee only**. That
avoids charging tax on tax and is a common structure, but it is a **tax position**. Have your CA
confirm it before the first real client bill. Changing it later means a new migration, not a code
edit, because issued invoices are immutable by design.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean, both function bodies clean.
- `amountInWords` unit-tested via compiled JS — 12/12.
- `npx tsc -b --force` clean (the correct command per rule 10).

**Not tested** — no invoice has been raised on real data yet. Untested: all three types, the PDF,
the words line, the VOID watermark, and the previously-billed deduction on a second progress bill.

**Migration 024 APPLIED** — confirmed 2026-07-28. A4 tested working end to end.

**Bug found and fixed while reviewing a delete request (no migration):**

- [x] **`canCancel` gave invoices the wrong roles.** It was written as "variation_orders → founder,
      everything else → founder/pm", so `invoices` inherited founder/**pm** — but
      `fn_cancel_document` requires founder/**accounts**. Net effect: an **accounts user could not
      see the Cancel button on an invoice they were entitled to cancel**, and a PM saw one the RPC
      would have rejected. Replaced the catch-all with an explicit per-table map that mirrors the
      four RPC branches one-to-one, so it can't drift again.

**Deliberately NOT added: a delete button on invoices.** An invoice carries a GST number from a
statutory series; deleting one leaves a gap in that series, which is itself a finding in an audit.
Cancel is the correct mechanism and already exists — the row stays, the number stays, the PDF prints
VOID, and a cancelled progress bill immediately stops counting as "previously billed" on the next
one. Recorded here so the decision isn't re-litigated later.


---

## Fix — progress-bill running-account structure (migration 025, APPLIED)

Caught by the user on a real second progress bill. Worth recording precisely, because the instinct
("it's double-charging GST") was right that something was wrong but wrong about what.

**What was NOT wrong.** No double taxation. Bill 2's GST minus bill 1's GST equalled exactly 18% of
the incremental fee, and the ₹8,23,900 payable was correct — verified by recomputing both ways.

**What WAS wrong.** 024 put "Less: previously billed" in with the LINE ITEMS, so a gross figure
(previous total, tax included) was deducted from the pre-tax `subtotal`. The printed invoice then
read:

    Subtotal      2,63,110
    GST @ 18%     5,60,790

18% of 2,63,110 is 47,360. Those two lines sit on top of each other and don't reconcile — and on a
GST invoice that is exactly what an assessing officer reads. Indefensible as printed.

**Fixed in 025.** `less_previously_billed` moved to a header column; `total` regenerated as
`subtotal + gst_amount - less_previously_billed`. The bill now states the cumulative position, taxes
it, then deducts:

    Reimbursable cost to date · Management fee to date
    Subtotal (cumulative taxable) · GST on the fee · Cumulative gross
    Less: previously billed (gross against gross) · Net payable

Same payable, every line defensible on its own.

**Second bug found while fixing it.** The user's bill 2 used an overlapping period (Jul 1 – Aug 30)
and worked by luck. Had they picked *August only*, the cost would have been one month's while the
deduction was the whole project's — a large negative bill. Progress bills now always compute
cumulatively to the chosen date, ignore any start date, store `period_from` as NULL to say so, and
a guard refuses to issue a negative bill.

Verified: migration parses clean, payable recomputed identical (₹8,23,900), GST is 18% of the fee
line on both bills, `tsc -b --force` clean. **Confirmed working by the user 2026-07-28.**

---

## Session — A7 RFI Management (Module 57), migration 026

Confirmed at start: **001–025 ALL APPLIED**, next = 026.

**Built**

- [x] **Migration 026** `026_rfis.sql` — `rfis` table, `rfi_status` (open/answered/closed/cancelled)
      and `rfi_category` (design/structural/MEP/finishes/other), `rfi_number_seq` → `RFI-0001`.
- [x] **Shape deliberately mirrors A6.** Same addressed-to pattern (linked vendor or free text — an
      architect is rarely in the vendor master, and blocking the question on registering one means
      the question doesn't get asked), same site-photos attachments, same cancellation contract.
      They're the same kind of object travelling opposite ways: an SI tells a contractor what to do,
      an RFI asks a consultant what to do.
- [x] **No money, so supervisors read it.** `rfi_read` is plain `is_member()` with no role check —
      supervisors are usually the ones who hit the clash and need to know whether an answer has
      landed before proceeding. If an answer turns out to carry cost, that goes on a VO and then an
      SI; this table never holds an amount.
- [x] **Three CHECK constraints doing real work**, not just documentation:
      - cancel requires `cancelled_at` + `cancelled_by` + a non-blank reason (the 021 contract);
      - an RFI must have someone to ask (linked vendor OR free text);
      - **`answered`/`closed` require the response text AND date to actually be present** — the
        status can never claim something the record doesn't contain.
- [x] **`fn_answer_rfi`** writes response text, date, who logged it and the status move in ONE
      statement, so those can't drift apart. **`fn_set_rfi_status`** handles close/reopen and
      **refuses to close an unanswered RFI** — that would quietly lose the question, which is what
      cancel is for. Cancelling a *closed* RFI is refused too (it was answered and acted on).
- [x] **`rfiPdf.ts`** — letterhead matching SI/PO/VO/invoice. Two-part document: question, then
      response. **An unanswered RFI prints ruled empty lines** rather than a blank gap, so the sheet
      can be handed or emailed to the consultant to write into. CANCELLED watermark at 14% opacity
      with the reason at full opacity, same as A6.
- [x] **Tasks → RFIs screen** — a count strip at the top ("N awaiting an answer · M past the
      required-by date"), because the clock is the entire point of the module. Inline
      record-response form, close/reopen, Download / File to Docs (→ Drawings, not confidential),
      cancel via the shared dialog. Full design system: skeleton, empty state with primary action,
      `OtherProjectsHint`, staggered reveal, toasts throughout.
- [x] `canCancel` map extended with `rfis: ['founder','pm']`, matching the new RPC branch. That map
      is now the single place the five cancellable document types are declared.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean, all three function bodies
  clean (`fn_answer_rfi`, `fn_set_rfi_status`, `fn_cancel_document`).
- `npx tsc -b --force` clean.

**Not tested** — no RFI has been raised on real data. Untested: raising, recording a response, the
close guard on an unanswered RFI, the PDF in both answered and unanswered states, the CANCELLED
watermark, and the supervisor view.

**Migration 026 APPLIED** — confirmed 2026-07-28. Not yet exercised on real data.

---

## Session — A8 Snags + Defect Liability Period (Module 19), migration 027

Confirmed at start: **001–026 ALL APPLIED**, next = 027.

**Built**

- [x] **Migration 027** `027_snags_dlp.sql` — `snags` table, `snag_severity` (low/medium/high),
      `snag_status` (open/in_progress/resolved/verified), `snag_number_seq` → `SNG-0001`.
      `projects.dlp_start_date` / `dlp_end_date`, **plus the `grant select` on both** — 010 revoked
      column-level SELECT on `projects`, so a new column is invisible to everyone until granted.
      That grant is the single line this module would have silently failed without.
- [x] **Evidence is enforced by the database, not the form.** `fn_resolve_snag` refuses a resolution
      with neither a photo nor a note, and `snags_resolution_ck` backs it up — a snag closed with no
      evidence is worth nothing, and a form check alone can be bypassed by any client.
- [x] **Separation of fix and sign-off.** `fn_verify_snag` is founder/PM only: whoever fixed a defect
      shouldn't be the one certifying it. That separation is the whole reason a snag list exists, so
      it lives in the RPC rather than in `canVerifySnag`, which is only the UI's echo of it.
- [x] **Reopening clears the old resolution.** `fn_set_snag_status(id,'open')` wipes the note, photos,
      resolved_at/by. Evidence for a fix that didn't hold no longer stands, and leaving it would let
      a snag show a fix photo while sitting open.
- [x] **`raised_during_dlp` is frozen at insert** by the `fn_snag_dlp_flag` trigger, comparing the
      raised date against the project's window at that moment. Deliberately *not* computed on read:
      if the DLP dates are edited later, history must not silently rewrite itself — whether a defect
      fell inside the liability period is a contractual fact about the day it was raised.
- [x] **`fn_project_snag_summary`** returns every count plus the DLP position (`dlp_active`,
      `dlp_days_left`) computed in Postgres. Nothing is tallied in the browser, including the
      countdown.
- [x] **Supervisors raise and resolve.** `snag_read`/`snag_insert` are plain `is_member()` — no
      figures on this table, and supervisors are the ones walking the site finding defects. Verify is
      the only gated action.
- [x] **Tasks → Snags screen** — Outstanding / In DLP / All filters, summary strip with open counts
      by severity and the DLP line, inline resolve form (camera-first, multiple photos, compressed
      client-side), start / resolve / verify / reopen, defect and fix photos shown side by side via
      signed URLs. Full design system: skeleton, empty state with primary action,
      `OtherProjectsHint`, staggered reveal, toasts throughout.
- [x] **Snag card on Project Detail** — open + in-progress, awaiting sign-off, severity chips, and
      the DLP countdown, going danger-coloured inside 30 days (`DLP_WARN_DAYS`). That warning is the
      one that costs money if it's missed: after the end date, defects stop being ours to fix under
      the contract.
- [x] **DLP dates on Manage → Projects**, written through `setProjectDlp` with an end-before-start
      guard. Read back through `fn_project_snag_summary`, which already returns the window — no new
      query, and no widening of `PROJECT_COLUMNS` (which would 400 for every screen if 027 hadn't
      been run yet).
- [x] **Hard delete, not cancel.** A snag has no downstream effect, so it belongs in mechanism 1;
      `fn_delete_record` gains a `snags` branch that **refuses to delete a verified snag** — that row
      is the record that a defect was fixed and signed off. Reopen it instead.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean, all four non-trigger
  functions clean. `fn_snag_dlp_flag` fails the parser only because **pglast cannot parse any
  `returns trigger` function** — proven against a trivial three-line case and against `fn_audit`
  from 001, which has run in production since day one. Recorded in CLAUDE.md.
- `npx tsc -b --force` clean.

**Migration 027 APPLIED** — confirmed 2026-08-01.

**Tested 2026-08-01** on the live app, founder + supervisor: DLP dates save and read back (the
column grant landed), raising a snag with photos, the evidence-free resolve refusal, verify, the
reopen-clears-resolution behaviour, and the verified-snag delete refusal. **A8 is done.**

Still worth watching on real use: whether the 30-day DLP warning is early enough for a 12-month
liability period, and whether supervisors want an "assigned to me" filter once more than a handful
of snags are open at once.

---

## Session — A9 Compliance / Statutory Calendar (Module 31), migration 028

Confirmed at start: **001–027 ALL APPLIED**, next = 028.

**Built**

- [x] **Migration 028** `028_compliance_calendar.sql` — `compliance_items`, three enums
      (`compliance_category`, `compliance_recurrence`, `compliance_status`),
      `v_compliance_calendar`, `fn_file_compliance`, `fn_unfile_compliance`,
      `fn_compliance_alert`, `fn_compliance_sweep`, a nightly pg_cron job, and the `compliance`
      storage bucket with its own policies.
- [x] **The cron job is bookkeeping, not truth.** `fn_compliance_sweep` writes
      `status = 'overdue'` nightly, but nothing in the UI reads that column — the screen reads
      `display_status` from `v_compliance_calendar`, which derives overdue / due-soon from
      `due_date` in Asia/Kolkata **at query time**. pg_cron isn't guaranteed to be enabled, and a
      deadline module whose correctness depends on a background job having run is exactly the
      module you can't trust. Every pg_cron statement is wrapped in an exception handler for the
      same reason: the migration cannot fail because an extension is unavailable.
- [x] **`project_id` is nullable and that's the feature.** A GST return is filed by the company, a
      building permit belongs to one site. RLS has two arms — company-wide rows are visible to any
      founder/pm/accounts user, project rows additionally require `is_member()`.
- [x] **Recurrence is generated server-side, inside the filing function**, so the two can never
      diverge. Next due date is computed from the **due** date, not the filing date — a return filed
      three days late must not push next month's deadline three days later. A UNIQUE
      `(series_id, due_date)` index plus `on conflict do nothing` makes a double click or a retry
      incapable of creating a duplicate; that guard is in the database, not in the form.
- [x] **A filed item must carry evidence of when.** `compliance_filed_ck` requires `filed_date` and
      `filed_by` whenever status is `filed`, so a client cannot claim a filing the row can't
      support. Reopening (founder/accounts only) clears the proof along with the status — a document
      proving a filing that's no longer claimed is worse than none.
- [x] **New `compliance` storage bucket.** Migration 006's policies key access off a leading
      `<project_id>/` path segment, which a company-wide item can't have. Company objects live under
      the literal `company/` prefix; project ones keep the project-id prefix and are membership-
      checked. PDFs upload byte-for-byte — a re-encoded acknowledgement isn't proof of anything.
- [x] **Money → Compliance screen** — month-grouped list (reads as a calendar, not a queue), a
      coloured rail per row, Outstanding / Filed / All, filters by category and by
      company/this-project. Inline mark-as-filed with date, proof upload and notes; edit; reopen;
      delete. Full design system: skeleton, empty state with primary action, staggered reveal,
      toasts throughout.
- [x] **Dashboard strip** — "Compliance — N overdue · N due this week", linking straight to the
      screen, and **rendering nothing when the calendar is clear**. A banner that's always there
      stops being read.
- [x] **Delete follows the existing rule.** An unfiled item has no downstream effect, so it's
      mechanism 1 via `fn_delete_record`; a **filed** one is refused, because it holds the proof of
      a statutory filing. `canDelete` extended so accounts (not just founder/pm) can delete these.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean; `fn_file_compliance`,
  `fn_unfile_compliance`, `fn_compliance_sweep` and `fn_delete_record` all clean.
  `fn_compliance_series` fails the parser only because it is a `returns trigger` function — the
  known pglast limitation recorded in CLAUDE.md.
- `npx tsc -b --force` clean (exit 0). One real error caught and fixed on the way: PostgREST widens
  an unknown view to `GenericStringError`, so `fetchCompliance` asserts through `unknown` once, the
  same pattern the other query files use.

**Migration 028 APPLIED** — confirmed 2026-08-01.

**Tested 2026-08-01** on the live app: adding a deadline, the filing flow with proof upload,
next-occurrence generation, reopen, and the dashboard strip. **A9 is done.**

Open question for real use: nothing yet reads `compliance_items.responsible` other than the card —
no "assigned to me" view and no per-person nudge. If deadlines start slipping, that's the gap to
close, not more colour on the calendar.

---

## Supervisor RLS pass — re-run 2026-08-01, CLEAN

The previous pass was 2026-07-25 and predated procurement, variations, instructions, RFIs, snags,
compliance and the admin module. Re-run in an incognito window on the live app against a supervisor
assigned to some but not all projects. **Nothing leaked.**

What was checked, and why each one mattered:

- **Every /money route entered by direct URL**, not by looking for a missing tab — a hidden tab
  proves nothing. Ledger, add expense, budget, vendors, orders, variations, invoices, compliance,
  plus /admin and /admin/team: all bounced.
- **Dashboard and Project Detail** — portfolio and per-project cards read "restricted"; no contract
  value, revised contract, management fee or spend; no compliance strip; recent activity carried no
  expense amounts.
- **Materials → Orders**, the sharpest edge in the app: supervisors legitimately raise purchase
  requests and receive deliveries there, so the screen is reachable by design. It showed status,
  item counts and need-by dates with **no order value, no rate, no line total**, while raise-request
  and goods-receipt both still worked. That is migration 012's column revoke on `po_lines` plus
  013's role-gated `v_po_value` doing exactly their job.
- **Stock, movements, material master** — quantities and challans, no rates (006's column grants).
- **Documents** — confidential files absent from the listing entirely, and a confidential URL copied
  out of the founder session refused (006's `fn_doc_is_confidential`, which has to be SECURITY
  DEFINER or it would invert).
- **Site instructions** — cost implication renders as a bare "Yes" with no amount, which is the
  whole reason 023 stored it as a boolean with the money on the linked VO.
- **Snags** — raise and resolve available, Verify absent.
- **Scope** — only assigned projects listed, and an unassigned project's detail URL refused.

Roles & Permissions is now ticked in ROADMAP with this coverage recorded. Re-run this pass after any
future module that shows a figure.

---

## Session — A10 Design / Drawing Management (Module 32), migration 029

Confirmed at start: **001–028 ALL APPLIED**, next = 029.

**Built**

- [x] **Migration 029** `029_drawing_register.sql` — `drawings` + `drawing_revisions`,
      `drawing_discipline` / `drawing_status`, `v_drawing_register`, `fn_issue_revision`,
      `fn_withdraw_revision`, `fn_drawing_file_is_current`, the `drawings` storage bucket, and two
      new branches on `fn_delete_record`.
- [x] **Two tables, because a revision is not a drawing.** `drawings` holds identity (number unique
      per project — two villas both having an SD-101 is normal), `drawing_revisions` holds what is
      actually issued. Folding them together would make "the current sheet" a client-side max() over
      rows, which is right until the day it isn't.
- [x] **The module is one index.** `create unique index drawing_rev_one_ifc_uk on
      drawing_revisions (drawing_id) where status = 'ifc'` makes two live revisions of a drawing
      impossible rather than merely unlikely. `fn_issue_revision` does the swap in one transaction
      and **demotes the old row before promoting the new one** — the other order violates the index
      mid-flight. A CHECK separately refuses an IFC revision with no file or no issued date:
      "issued for construction" with nothing to build from is a lie the row would otherwise tell.
- [x] **Supervisors are fenced twice, because the risk is physical.** `drawing_rev_read` hides WIP
      and superseded rows outright, so the wrong sheet doesn't exist for them; and the `drawings`
      bucket's read policy calls `fn_drawing_file_is_current()`, so a stale sheet can't be opened
      even with a copied URL. A uuid path is effectively unguessable, but "they can't guess it" is
      not an access rule. `fn_drawing_file_is_current` is SECURITY DEFINER for the same reason
      `fn_doc_is_confidential` is — run as the caller, RLS would hide the WIP row, the EXISTS would
      return false, and the policy would draw the opposite conclusion.
- [x] **A separate bucket rather than extending `documents`.** 006's vault policies are
      load-bearing across every existing file; teaching them about revision status would put every
      document behind a more complicated predicate. New bucket, blast radius zero.
- [x] **`v_drawing_register`** — one row per drawing carrying its IFC sheet, security_invoker so a
      supervisor's row policy applies inside it, and a final WHERE that hides never-issued drawings
      from them: a bare drawing number with nothing behind it is noise on a phone at site.
- [x] **Docs → Drawings screen** — current sheet given top billing in its own panel ("Build from
      this sheet"), history behind a toggle, superseded rows dimmed and struck through, discipline
      filter, WIP/superseded counts for founder/PM only, and a warning strip counting drawings with
      nothing issued. Upload-and-issue in one action, or save as WIP. Revision numbers auto-suggest
      (R0 → R1, A → B). Full design system: skeleton, empty state with primary action,
      `OtherProjectsHint`, staggered reveal, toasts throughout.
- [x] **Delete follows the rule.** A WIP revision that was never issued can go; an issued or
      superseded one is refused because it is the record of what site was told to build. A drawing
      with any revisions is refused too.

**Verification**

- Migration parsed against the real PostgreSQL grammar: outer SQL clean; `fn_issue_revision`,
  `fn_withdraw_revision` and `fn_delete_record` all clean. `fn_drawing_rev_project` fails the parser
  only because it is a `returns trigger` function — the known pglast limitation.
- `npx tsc -b --force` clean (exit 0).

**Not tested** — no drawing has been entered. Untested: adding a drawing, the duplicate-number
refusal, uploading and issuing, the supersede swap, withdraw, the delete refusals, and — most
importantly — **the supervisor view: they must see only the IFC revision, and a superseded sheet's
URL must not open for them.**

**Migration 029 APPLIED** — confirmed 2026-08-01 by the `drawing_rev_one_ifc_uk` verify query
returning the index. That query is the last statement in the file, so the whole script ran,
including the storage bucket in §8 and `fn_delete_record` in §9. Not yet exercised on real data.

**Two fixes during first use (same session):**

1. **The form leaked the data model.** "Add drawing" created only the identity, so the first sheet
   needed a second, non-obvious step — a user added a drawing, saw History (0), and reasonably
   concluded the upload had failed. Worse, they typed the revision into the drawing-number field.
   The New Drawing form now takes the sheet in the same submit: number, title, discipline, then
   revision (pre-filled R0), file, date and "issue now", chained create → upload → issue. Two tables
   underneath is right; making the user feel them was not.
2. **Migration 030 — delete was too strict.** 029 refused to delete a drawing with any revisions,
   which made a mistyped drawing number permanent the moment a sheet was attached. A founder can now
   delete a drawing (revisions cascade) or any single revision; a PM stays limited to revision-free
   drawings and WIP revisions. The delete still writes to audit_log with the actor, which is what
   makes relaxing it safe — the record moves to the log rather than vanishing. The Delete button is
   now always rendered and the RPC explains any refusal, instead of the button silently not existing.

3. **Route collision — the register was mounted at `/docs/drawings`.** The document vault has a
   folder whose value is literally `drawings`, and its cards link to `/docs/${folder}`. A static
   route segment outranks `:folder` in React Router, so clicking the Drawings folder (5 files)
   rendered the empty register instead of the folder — the files were never gone, just unreachable.
   Register moved to **`/docs/register`**. Lesson worth keeping: adding a static child route under a
   path that also has a `:param` sibling silently steals every value that matches it.

4. **Restructured into three levels, at the user's request.** The single flat list didn't match how
   they navigate: Docs → **Drawings** now shows a folder per discipline (Architectural, Structural,
   MEP, Interior, Landscape, Other) → tap one for the drawings filed under it → tap a drawing for
   its own page listing every revision, which is where issuing, withdrawing, re-issuing and delete
   live. `Drawings.tsx` replaced by `DrawingFolders.tsx` / `DrawingList.tsx` / `DrawingDetail.tsx`
   at `/docs/register`, `/docs/register/:discipline`, `/docs/register/:discipline/:drawingId`.
   Added `fetchDrawing(id)` for the detail page.
5. **Upload tab removed from Docs.** Uploading now happens inside the folder you're filing into —
   a button on the folder screen, and the empty-state action, both linking to
   `/docs/upload?folder=<folder>` which prefills the folder. The capability stayed; only the
   redundant top-level tab went, since a top-level Upload made you pick the folder again after
   you'd already navigated to it.

---

## Session — document sub-folders (migration 031)

Founder can now create one level of sub-folder inside any of the eight vault folders
("Permits → BBMP", "Contracts → Subcontractors").

- [x] **A table, not a text column.** `doc_subfolders` (project, parent folder, name) with a
      case-insensitive unique index — "BBMP" and "bbmp" in one folder is a filing mistake, not two
      folders. A `subfolder text` column on documents would mean a folder only exists while a file
      sits in it: create it, upload nothing, refresh, gone. The founder creates these ahead of the
      files, so they need somewhere to live.
- [x] **`documents.subfolder_id` is nullable and ON DELETE SET NULL.** Null means the file sits at
      the folder root, which is where every existing row stays — no backfill. Deleting a sub-folder
      returns its files to the parent folder rather than taking them with it; a cascade here would
      destroy documents to remove a container.
- [x] **Founder-only writes** (`subfolder_insert`/`update` check `is_founder()`); everyone who can
      read the vault sees the structure, and anyone who can upload can file into one. Sub-folders
      carry no access rules of their own — confidentiality still lives on the document row where
      `docs_read` enforces it.
- [x] **Folder screen** shows sub-folder cards with file counts at the folder root, drills in via
      `?sub=<id>` (a query param, not a route segment — static-vs-param ranking has already bitten
      this file once), and each document gains a small "move to sub-folder" picker so existing files
      can be filed after the fact.
- [x] Upload carries `?folder=&sub=` through and prefills both; changing the folder clears the
      sub-folder, since it belonged to the old one.

`npx tsc -b --force` clean. Migration parses clean.

**Migrations 030 + 031 APPLIED** — confirmed 2026-08-01, and sub-folders exercised on the live app
the same day.
