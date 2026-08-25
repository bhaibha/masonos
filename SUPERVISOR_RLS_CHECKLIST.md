# Supervisor RLS verification checklist

**Mason OS — Groups A, B and C complete (migrations 001–060).**
Derived from the actual policies in `supabase/migrations/`, not from the spec.

Money-hiding is the #1 correctness rule. This checklist walks every screen a supervisor can reach
and states what they must and must not see. Run it end to end in an incognito window and record the
result of each line.

---

## 0 · Setup

1. In your normal window, sign in as founder → **Admin → Users**.
   Confirm there is an active user whose **access role is `supervisor`**. Note the email.
   If you have to create one, give them a job title that maps to supervisor (Site Engineer).
2. **Admin → Project membership.** Confirm that supervisor is a member of **exactly one** project.
   Note which. Call it **Project A**; every other project is **Project B**.
   *(This matters: several checks below are about Project B being invisible, not just its figures.)*
3. Open a **new incognito / private window**. Do not reuse the tab you were signed in on —
   Supabase keeps the session in local storage and you will silently test as yourself.
4. Sign in as the supervisor.
5. Confirm the identity before testing anything: the header shows the supervisor's name and
   **"Supervisor"** under it. If it says Founder or PM, you are in the wrong session — stop.

> **Two layers, and both matter.** Nearly every rule below is enforced twice: once in the UI
> (`canSeeMoney`, `canSeeEvm`, and so on) and once in Postgres RLS. The UI check is a courtesy; RLS
> is the boundary. If a screen looks right, it has passed the courtesy check — §12 is how you test
> the boundary underneath it.

---

## 1 · Navigation — what should even be reachable

| # | Check | Expected |
|---|---|---|
| 1.1 | Look at the bottom tab bar | **Dashboard · Tasks · Materials · Docs** — exactly four |
| 1.2 | Is there a **Money** tab? | **NO.** The Money tab is gated to founder/pm/accounts in `AppShell.tsx` |
| 1.3 | Type `/money` into the address bar and press enter | Refused — a "not available for your role" screen, not a ledger |
| 1.4 | Type `/admin` | Refused |
| 1.5 | Type `/money/pnl` | Refused |
| 1.6 | Type `/money/mis` | Refused |
| 1.7 | Type `/money/overheads` | Refused |
| 1.8 | Type `/money/compare` | Refused |
| 1.9 | Type `/money/bills` | Refused |
| 1.10 | Type `/money/retention` | Refused |
| 1.11 | Type `/money/insurance` | Refused |
| 1.12 | Type `/money/vendors` | Refused |
| 1.13 | Type `/money/compliance` | Refused |
| 1.14 | Type `/money/invoices` | Refused |
| 1.15 | Type `/money/variations` | Refused |
| 1.16 | Type `/money/labour` | Refused |
| 1.17 | Type `/money/orders` | Refused |

**If any of 1.3–1.17 renders a screen instead of refusing, stop and report it immediately.**
That is a route guard failure, and everything below it is untrustworthy.

---

## 2 · Dashboard

| # | Check | Expected |
|---|---|---|
| 2.1 | Project list | **Project A only.** Project B must not appear at all |
| 2.2 | Portfolio figures card | The words **"Portfolio figures are restricted for your role."** — no rupee amounts |
| 2.3 | Anywhere on the page, look for a `₹` symbol | **None.** Scroll the whole page |
| 2.4 | Any card showing spend, budget, contract value or margin | **None** |
| 2.5 | Compliance / insurance / bank-guarantee alert strips | **None** — those are founder/pm/accounts |

---

## 3 · Project detail (tap Project A)

| # | Check | Expected | Enforced by |
|---|---|---|---|
| 3.1 | Contract value | **Not shown** | `projects.contract_value` revoked at column level (010) |
| 3.2 | Management fee % or amount | **Not shown** | `projects.management_fee_pct` revoked (010) |
| 3.3 | Budget card | **"Budget figures are restricted for your role."** | `budgets_read` excludes supervisor (002) |
| 3.4 | Spend / remaining / % used | **Not shown** | owner-run views with role in WHERE |
| 3.5 | Project name, client name, site address, status, dates | **Shown** — these are granted columns | 010 grant list |
| 3.6 | Floors / plot area | **Shown** | 042 column grant |
| 3.7 | DLP dates | **Shown** | 027 column grant |
| 3.8 | Tasks card | **Shown**, with counts | |
| 3.9 | Safety card | **Shown** | |
| 3.10 | Snags card | **Shown**, with severity counts | |
| 3.11 | Quality (QA) card | **Shown** | |
| 3.12 | **Client approvals card** | **Shown** — counts, oldest pending days, no-evidence count. **No amounts** | 060: the table carries no amount |
| 3.13 | Docs card | **Shown** | |
| 3.14 | Recent activity feed | **Shown** — but read every line: no rupee figures should appear in it | |
| 3.15 | "Download project archive" button | **Not shown** — founder only | `canAdminister` |

---

## 4 · Tasks tab — the highest-risk area

> **Read this before running §4.** The Tasks tab strip is **not role-gated** — a supervisor sees
> every tab including Schedule, Quality, Bar schedule and Labour. That is deliberate (they need
> those screens) but it means each screen has to hide its own money. These are the checks most
> likely to find something.

### 4a · Tasks / Add task / History / Site log / Safety / Incidents

| # | Check | Expected |
|---|---|---|
| 4.1 | **Tasks** — see today's tasks for Project A | **Shown.** Can create, edit, complete |
| 4.2 | **Add task** | **Works** |
| 4.3 | **History** — task history + CSV export | **Shown.** Open the CSV: no money columns |
| 4.4 | **Site log** — headcount, weather, notes, photos | **Shown.** Can create |
| 4.5 | **Safety** — checklists | **Shown.** Can complete items |
| 4.6 | **Incidents** — report and view | **Shown** |

### 4b · Schedule (EVM is the money surface here)

| # | Check | Expected |
|---|---|---|
| 4.7 | Open **Schedule** | Gantt / activity list **shown** |
| 4.8 | Activity names, dates, % complete, planned qty | **Shown** |
| 4.9 | **Budget amount on any activity** | **NOT shown** — `schedule_activities.budget_amount` is revoked (042) |
| 4.10 | **EVM card** (PV / EV / AC / CPI / SPI / BAC) | **NOT shown at all** — `canSeeEvm` excludes supervisor |
| 4.11 | Cost variance, cost performance index | **Not shown** |
| 4.12 | Schedule variance / SPI | **Not shown** (it ships inside the same EVM card) |
| 4.13 | Move the **progress slider** on an activity | **Works** — supervisors log progress by design (`fn_set_activity_progress`) |
| 4.14 | Export the schedule (Excel/CSV) | Open the file — **no budget or cost columns** |
| 4.15 | Export the Gantt PDF | **No cost figures** |

### 4c · Quality

| # | Check | Expected |
|---|---|---|
| 4.16 | Open **Quality** | **Shown** |
| 4.17 | QA checklists / inspection comments to perform | **Shown** — they can raise an inspection comment with a photo |
| 4.18 | NCRs | **Shown** — supervisors can see and raise |
| 4.19 | Any cost of rework / money on this screen | **None** |

### 4d · Bar schedule (BBS)

| # | Check | Expected |
|---|---|---|
| 4.20 | Open **Bar schedule** | **Shown** — this is quantities and weights, not money |
| 4.21 | Cutting lengths, diameters, weights, tonnage | **Shown** |
| 4.22 | Any rate per kg, steel cost, or total value | **None must appear.** BBS holds no rates by design — if a rupee figure appears anywhere here, report it |
| 4.23 | Export the BBS PDF | **No money column** |

### 4e · Labour (Tasks side — attendance)

| # | Check | Expected |
|---|---|---|
| 4.24 | Open **Labour** under Tasks | **Shown** — gang attendance entry |
| 4.25 | Log attendance for a gang | **Works** — supervisors are the ones who count heads |
| 4.26 | **Any wage rate, day rate, or wage total** | **NOT shown.** `labour_rates` is a **row-level** policy — a supervisor gets zero rows (054) |
| 4.27 | Muster roll / wage register / overtime register buttons | Either **absent**, or present and returning **no money** |
| 4.28 | Labour cost roll-up | **Not shown** |

### 4f · Instructions / RFIs / Snags / Approvals

| # | Check | Expected |
|---|---|---|
| 4.29 | **Instructions** (SIs) — read the list | **Shown** |
| 4.30 | Open an SI that has a cost implication | Shows **"Cost implication: Yes"** and **no amount** (023) |
| 4.31 | The linked VO on that SI | VO number/value **not shown** — `variation_orders` RLS excludes supervisor (016) |
| 4.32 | **RFIs** — read, raise, see answers | **Shown** |
| 4.33 | RFI response attachments | **Openable** |
| 4.34 | **Snags** — raise, resolve, photos | **Shown.** Cannot *verify* — that is founder/PM |
| 4.35 | **Approvals** (C2) — read the register | **Shown** |
| 4.36 | An approval whose subject is **Variation order** | Row **visible**, but **"Refers to" is blank** — the VO's own RLS hides it (060) |
| 4.37 | Any rupee amount on an approval card | **None.** The table has no amount column at all |
| 4.38 | "Log a client approval" button | **Not shown** — founder/PM only |
| 4.39 | "Client approved" / "Rejected" buttons on a card | **Not shown** |

---

## 5 · Materials

| # | Check | Expected | Enforced by |
|---|---|---|---|
| 5.1 | Stock on hand per material | **Shown** — quantities | |
| 5.2 | Inward list — qty, date, challan no, challan photo, vendor name | **Shown** | 006 + 018 grants |
| 5.3 | **Rate or amount on any inward row** | **NOT shown** | `material_inward` rate/amount revoked (006) |
| 5.4 | Record a material inward | **Works** — and the form has **no rate field** |
| 5.5 | Record a material issue | **Works** |
| 5.6 | Stock value / inventory value anywhere | **None** |
| 5.7 | Void an inward *they created themselves* | **Works** (021) |
| 5.8 | Void an inward created by someone else | **Refused** |

---

## 6 · Docs

| # | Check | Expected | Enforced by |
|---|---|---|---|
| 6.1 | **Folders** — project document vault | **Shown** for Project A | `docs_read` (003) |
| 6.2 | A document marked **confidential** | **NOT in the list at all** | `docs_read`: `not is_confidential or role in (founder,pm,accounts)` |
| 6.3 | Open a non-confidential document | **Works** — signed URL resolves |
| 6.4 | Invoices folder contents | Invoice **documents** may be listed if not confidential — but see 6.5 |
| 6.5 | Any invoice **figures** (subtotal, GST, total) | **None** — `invoices` RLS is founder/accounts only (024) |
| 6.6 | Upload a document | **Not permitted** — `docs_write` is founder/pm/accounts |
| 6.7 | **Drawings** register | **Shown** |
| 6.8 | Which revisions are visible | **Only the current Issued-For-Construction revision.** Superseded and WIP revisions must not appear (029) |
| 6.9 | Open a drawing file | **Works** — but only for the current IFC revision (`fn_drawing_file_is_current`) |
| 6.10 | Try to issue / withdraw a revision | **Not permitted** |
| 6.11 | Create or rename a sub-folder | **Not permitted** — founder only (031) |

---

## 7 · Mason Learn

| # | Check | Expected | Enforced by |
|---|---|---|---|
| 7.1 | Open **Docs → Learn** | **Shown** | 057 |
| 7.2 | Browse shelves, search | **Works** |
| 7.3 | Published articles and method statements | **Shown** — with steps, safety notes, QA checkpoints |
| 7.4 | **Draft** articles | **NOT visible** — drafts are founder/pm only |
| 7.5 | **Archived** articles | **Not on the shelves** |
| 7.6 | Published library documents (PDFs) | **Shown**, openable |
| 7.7 | A document attached to a **draft** article | **NOT visible**, even if the document itself is published (059 composed policy) |
| 7.8 | "Write something" / "Upload" buttons | **Not shown** |
| 7.9 | "Draft the structure" (Gemini) | **Not reachable** — the editor refuses supervisors |
| 7.10 | Delete a document | **Not offered** |

---

## 8 · Procurement surfaces reachable indirectly

A supervisor has no Money tab, so these are reached only via deep links or via a PO referenced
elsewhere. Test with the address bar.

| # | Check | Expected | Enforced by |
|---|---|---|---|
| 8.1 | `/money/orders` | Route refused | route guard |
| 8.2 | If any PO detail is reachable at all: **PO line rates** | **NOT shown** — `po_lines.rate` revoked (012) |
| 8.3 | PO total value | **Not shown** — `v_po_value` is role-gated |
| 8.4 | GRN values | **Not shown** |
| 8.5 | Three-way match screen | **Not reachable** |
| 8.6 | Vendor list / vendor rates | **Not reachable** — `vendors_read` excludes supervisor (002) |
| 8.7 | Rate comparison / comparative statement | **Not reachable.** `rc_may_read` excludes supervisor — a **whole-row** gate, so they get zero rows, not blanked cells (050) |

---

## 9 · Commercial registers — none of these should be reachable

| # | Surface | Expected | Enforced by |
|---|---|---|---|
| 9.1 | Variation orders (cost impact) | Zero rows | `vo_read` role check (016) |
| 9.2 | Invoices (subtotal / GST / total / less previously billed) | Zero rows | `inv_read` founder+accounts (024) |
| 9.3 | RA bills + certification amounts | Zero rows | `ra_read` (032) |
| 9.4 | Retention ledger (held / released / balance) | Zero rows | `ret_read` (033) |
| 9.5 | Bank guarantees (value, expiry) | Zero rows | `bg_read` (033) |
| 9.6 | Insurance policies (premium, sum insured) | Zero rows | `ins_read` (034) |
| 9.7 | Compliance calendar (financial filings) | Zero rows | `compliance_read` founder/pm/accounts (028) |
| 9.8 | Company overheads | Zero rows | `overhead_read` founder+accounts (040) |
| 9.9 | Overhead categories | Zero rows | (041) |
| 9.10 | Project P&L / margin | Not reachable | `v_project_pnl` role in WHERE (038) |
| 9.11 | Company P&L / net position | Not reachable | `fn_company_pnl`, `fn_company_net` |
| 9.12 | MIS / KPI dashboard | Not reachable; `fn_mis_company` returns **zero rows**, not a row of zeros (056) |
| 9.13 | Petty cash accounts and entries | Zero rows unless they are the named holder | `pca_read` / `pce_read` (002) |
| 9.14 | Expenses ledger | Zero rows | `exp_read` (002) |
| 9.15 | Budgets | Zero rows | `budgets_read` (002) |
| 9.16 | Audit log | Zero rows | `audit_read` is **founder only** (001) |

---

## 10 · Cross-project isolation

| # | Check | Expected |
|---|---|---|
| 10.1 | Dashboard project list | Project A only |
| 10.2 | Project picker on Tasks / Materials / Docs | Project A only |
| 10.3 | Paste a **Project B** detail URL (`/project/<B-id>`) | Refused or empty — **never** Project B's data |
| 10.4 | Any list on any screen | No Project B rows anywhere |

---

## 11 · Storage — the files themselves

Signed URLs bypass the UI entirely, so test the bucket policies directly.

| # | Check | Expected |
|---|---|---|
| 11.1 | Open a site photo on Project A | **Works** |
| 11.2 | Open a **receipt** image (expense proof) | **Refused** — `receipts_read` is money-role gated (006) |
| 11.3 | Open a **company/** overhead proof | **Refused** (040) |
| 11.4 | Open a **compliance/** proof | **Refused** (028) |
| 11.5 | Open a **library/** document that is published | **Works** (057) |
| 11.6 | Open a drawing file for a **superseded** revision | **Refused** (029) |
| 11.7 | If you still have a signed URL copied from your founder session, paste it | It **will** open — signed URLs are time-limited bearer tokens by design. This is not a bug; note it as a known property and do not share signed URLs |

---

## 12 · The boundary test — RLS itself, not the UI

Everything above tests the UI *and* RLS together. This tests RLS alone, which is what actually
protects the data. **Do this one — a UI-only pass is not a pass.**

1. While signed in as the supervisor in incognito, open **DevTools → Console** (F12).
2. Paste and run each line below, one at a time.

```js
// Expenses — must be an empty array
(await window.supabase.from('expenses').select('*').limit(5)).data

// Budgets — empty
(await window.supabase.from('budgets').select('*').limit(5)).data

// Variation orders — empty
(await window.supabase.from('variation_orders').select('*').limit(5)).data

// Invoices — empty
(await window.supabase.from('invoices').select('*').limit(5)).data

// RA bills — empty
(await window.supabase.from('ra_bills').select('*').limit(5)).data

// Retention + bank guarantees — empty
(await window.supabase.from('retention_releases').select('*').limit(5)).data
(await window.supabase.from('bank_guarantees').select('*').limit(5)).data

// Insurance — empty
(await window.supabase.from('insurance_policies').select('*').limit(5)).data

// Company overheads — empty
(await window.supabase.from('company_expenses').select('*').limit(5)).data

// Vendors — empty
(await window.supabase.from('vendors').select('*').limit(5)).data

// Wage rates — empty (row-level, not column-level)
(await window.supabase.from('labour_rates').select('*').limit(5)).data

// Rate comparisons — empty
(await window.supabase.from('rate_comparisons').select('*').limit(5)).data

// Audit log — empty (founder only)
(await window.supabase.from('audit_log').select('*').limit(5)).data

// Compliance — empty
(await window.supabase.from('compliance_items').select('*').limit(5)).data

// ---- COLUMN-LEVEL: these must ERROR, not return nulls ----
// projects.contract_value — expect a permission error
(await window.supabase.from('projects').select('id, contract_value').limit(1))

// material_inward.rate — expect a permission error
(await window.supabase.from('material_inward').select('id, rate').limit(1))

// po_lines.rate — expect a permission error
(await window.supabase.from('po_lines').select('id, rate').limit(1))

// schedule_activities.budget_amount — expect a permission error
(await window.supabase.from('schedule_activities').select('id, budget_amount').limit(1))

// ---- FUNCTIONS ----
// MIS: must be [] — zero rows, NOT a row of zeros
(await window.supabase.rpc('fn_mis_company', { p_from: '2026-01-01', p_to: '2026-12-31' })).data
```

**How to read the results**

- `[]` — correct. RLS refused and returned nothing.
- `{ error: { message: "permission denied for ..." } }` — correct for the column-level checks.
- **Any array containing rows, or any object with a rupee figure — that is a leak. Report it with
  the exact line you ran.**

> If `window.supabase` is undefined, the client isn't exposed on `window` in the production build.
> Say so and I'll add a dev-only global, or we do this half with a REST call using the session token
> from local storage instead.

---

## 13 · Things that are *supposed* to work — regression side

A checklist that only looks for leaks will happily pass on a supervisor account that can't do its
job. Confirm all of these still work:

- [ ] Sees Project A on the dashboard and can open it
- [ ] Creates, edits and completes a task
- [ ] Writes a daily site log with headcount, weather and photos
- [ ] Completes a safety checklist
- [ ] Reports an incident
- [ ] Records material inward (with challan photo) and material issue
- [ ] Sees current stock quantities
- [ ] Voids their **own** stock entry with a reason
- [ ] Logs gang labour attendance
- [ ] Moves an activity's progress slider on the Schedule
- [ ] Raises a snag with a photo and resolves one
- [ ] Raises an RFI and reads the answer
- [ ] Reads a site instruction issued to them
- [ ] Reads the client approval register
- [ ] Opens the current IFC drawing for their project
- [ ] Reads a published method statement in Mason Learn, including safety notes and QA checkpoints
- [ ] Searches Mason Learn and gets hits from inside uploaded PDFs
- [ ] Performs a QA inspection and raises an inspection comment with a photo
- [ ] Receives the daily task push notification

---

## 14 · Reporting template

For each finding, give me these five lines. One block per issue.

```
SCREEN:     e.g. Tasks → Schedule
CHECK:      e.g. 4.10
EXPECTED:   EVM card not shown
SAW:        CPI 0.94 / SPI 1.02 displayed under the Gantt
SEVERITY:   LEAK (money visible) | BLOCKED (should work, doesn't) | COSMETIC
```

Attach a screenshot for anything marked **LEAK**.

If a whole section passes, one line is enough: `§5 Materials — all pass.`

---

## 15 · Known properties — not bugs, don't report these

- **Signed URLs work regardless of role once issued.** They are time-limited bearer tokens (5
  minutes). A URL copied out of a founder session will open in the supervisor's browser. The
  protection is that a supervisor cannot *obtain* one for a restricted object.
- **A supervisor sees the Schedule, Quality, Bar schedule and Labour tabs.** That is intended — they
  need those screens. Each hides its own money internally, which is what §4b–§4e test.
- **`vo_number` blank on a client approval is the design, not missing data.** The register left-joins
  `variation_orders` and that table's own RLS refuses; the approval row itself is correct.
- **The audit log is founder-only, not founder/PM.** A PM also gets zero rows there.
- **Mason Learn and materials master are not project-scoped.** An IS code and a material definition
  are the same on every job, so there is no Project B leak in seeing them.

---

## 16 · Coverage map — every module in Groups A, B, C

Use this to confirm nothing was skipped.

| Module | Section | Supervisor position |
|---|---|---|
| Dashboard | §2 | Sees projects, no figures |
| Project detail | §3 | Sees operational cards, no commercials |
| Tasks + rollover | §4a | Full use |
| Daily site log | §4a | Full use |
| Task history / CSV | §4a | Full use, no money columns |
| Open Book expenses | §9.14 | Zero rows |
| Budgets | §3.3, §9.15 | Restricted message |
| Petty cash | §9.13 | Zero rows |
| Materials (A1) | §5 | Quantities yes, rates no |
| Safety (A2) | §4a | Full use |
| Procurement PR→PO→GRN (A3) | §8 | Not reachable |
| Invoices (A4) | §6.5, §9.2 | Zero rows |
| Variation orders (A5) | §4.31, §9.1 | Zero rows |
| Site instructions (A6) | §4.29–4.31 | Reads; cost is a Yes/No |
| RFIs (A7) | §4.32 | Full use |
| Snags + DLP (A8) | §4.34 | Raises and resolves |
| Compliance (A9) | §9.7 | Zero rows |
| Drawing register (A10) | §6.7–6.10 | Current IFC only |
| RA bills (A11) | §9.3 | Zero rows |
| Retention + BG (A12) | §9.4–9.5 | Zero rows |
| Insurance (A13) | §9.6 | Zero rows |
| Schedule + EVM (B1) | §4b | Schedule yes, EVM no, budget no |
| QA/QC (B2) | §4c | Full use |
| Rate comparison (B3) | §8.7 | Zero rows |
| Bar bending schedule (B4) | §4d | Full use, no rates |
| Contract labour (B5) | §4e | Attendance yes, wages no |
| P&L (B6) | §9.10–9.11 | Not reachable |
| MIS / KPI (B7) | §9.12 | Zero rows, not zeros |
| Company overheads (M29) | §9.8–9.9 | Zero rows |
| Document vault | §6.1–6.6 | Non-confidential only |
| Mason Learn (C1) | §7 | Published only |
| Client approvals (C2) | §4.35–4.39 | Reads, cannot log |
| Admin | §1.4 | Not reachable |
| Audit log | §9.16 | Zero rows |
| Storage buckets | §11 | Site photos + library only |
