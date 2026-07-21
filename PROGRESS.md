# PROGRESS — Mason OS
> Cowork: read CLAUDE.md + ROADMAP.md + this at session start; update at session end.

## Done (migrations 001–006 applied)
- [x] Day 1: Foundation — auth, roles/RLS, app shell, Dashboard
- [x] Day 2: Open Book — expenses, budgets, receipts, budget-vs-actual
- [x] Day 3: Tasks + rollover + Daily Site Log; Materials (inward/issue/stock)
- [x] Day 4: Document Vault; migrations 004–006 (filtered totals, project-scoped rollover, storage RLS, rate privacy)
- [x] Security: supervisor RLS test PASSED (money + confidential docs hidden)
- [x] UI: premium design system applied to Dashboard + Project Detail
- [x] Project Detail drill-down navigation

## PHASE 0 (this session)
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

## Next (see ROADMAP.md)
- [ ] Deploy to Cloudflare Pages (steps in DEPLOY.md), add the 3 GitHub secrets, run both workflows once by hand
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
- `projects.contract_value`, `management_fee_pct` and `management_fee_amount` are readable by
  supervisors via PostgREST — the UI hides them but RLS can't restrict columns. Needs a migration in
  the shape of 006 (column grants + a gated view). Last hole of this kind.
