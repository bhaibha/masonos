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
  So: **001–018 ALL APPLIED.** Next migration = 019.
- Re-run lessons baked into APPLY_pending.sql: drop dependent views with CASCADE (v_project_spend →
  v_portfolio_summary); cast enum assignments explicitly (`::po_status`).
- **NEVER use `create or replace view` when redefining an existing view.** It cannot add a column
  mid-list, reorder, rename or drop one — Postgres reports it as "cannot change name of view column
  X to Y" or "cannot drop columns from view". ALWAYS `drop view if exists <name> cascade;` then
  `create view`. This has now bitten three times (013 v_po_match/v_po_totals, 018
  v_material_inward). Default to drop-then-create for every view redefinition, no exceptions.
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
Dashboard + Project Detail · Open Book (expenses/budgets/receipts) · Petty Cash · Tasks + rollover + Daily Site Log · Materials (inward/issue/stock) · Document Vault · Vendors (data only, screen pending) · Roles/RLS (tested) · Audit log · Storage security (migrations 001–006 applied).

## What is CUT (never build — not software or out of scope)
360°/Matterport(20), Payroll(23), CRM/website(25), Drone(40), IoT(41), Time-lapse(42), Digital Twin(43), WhatsApp(44), AR(45), Aadhaar OTP(49), Health Check(53), Carbon(54), Memory Book(55).

Everything else = ROADMAP.md, built in order, one per session.
