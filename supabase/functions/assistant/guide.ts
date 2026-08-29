// ============================================================
// The app guide — how to do things in Mason OS.
//
// Deliberately hand-written and short. The alternative was letting the model
// infer the app from tool names, which produces confident directions to screens
// that do not exist — the most annoying possible failure for somebody standing
// on site trying to find a button.
//
// Keep it updated when a module moves. It is prose, not data, and it is cheaper
// to maintain than it looks: one line per screen.
// ============================================================

export const APP_GUIDE = `
NAVIGATION
Five tabs at the bottom: Dashboard, Tasks, Money, Materials, Docs. Money is
hidden from supervisors. Tap a project card on the Dashboard to open it; that
sets the project for every other screen.

DASHBOARD
Portfolio and per-project cards. Supervisors see projects but no figures.

TASKS (tabs across the top)
- Tasks — today's work. Add task; mark done with quantity, or not-done with a
  reason, which rolls it to tomorrow.
- History — past tasks with a date range and CSV export.
- Schedule — the programme, Gantt and progress sliders. Earned value (CPI/SPI)
  is founder/PM/accounts only.
- Quality — inspection observations with photos, and NCRs.
- Bar schedule — bar bending schedules to IS 2502. Quantities and weights, no
  rates.
- Labour — gang attendance. Supervisors log it; wage rates live under Money.
- Site log — the daily record: weather, headcount, work done, issues, photos.
- Safety — checklists. Incidents — reportable events.
- Instructions — site instructions issued to contractors.
- RFIs — questions to consultants and their answers.
- Snags — defects, with photos, resolution and verification.
- Approvals — the client approval register (what the client agreed, when, how).
- Clashes — coordination clashes and the drawing overlay tool.

MONEY (founder, PM, accounts only)
- Ledger — expenses. Add expense with a receipt photo.
- MIS — cross-project KPIs. Signals — early-warning flags.
- P&L — revenue, cost, margin. Overheads — company costs (founder/accounts).
- Budget — budget against actual by category. Set budgets is founder/accounts.
- Orders — purchase requests, POs, GRNs, three-way match.
- Rate compare — comparative statements across vendors.
- Labour — wage rates, muster roll, wage register, posting labour to the ledger.
- Variations — variation orders. Invoices — client invoicing.
- RA bills — contractor running-account bills and certification.
- Retention & BG — retention held and released, bank guarantees.
- Insurance, Compliance — registers with expiry and due-date tracking.
- Vendors — the vendor master.

MATERIALS
Stock on hand, record inward against a challan, issue to work. Quantities only;
rates are hidden from supervisors.

DOCS
- Folders — the project document vault. Confidential documents are hidden from
  supervisors.
- Drawings — the drawing register. Site sees only the current Issued For
  Construction revision.
- Learn — the reference library: method statements, articles, uploaded
  documents, all full-text searchable.

ADMIN (founder only)
Create projects, create users with a job title and access role, assign project
membership.

COMMON THINGS PEOPLE ASK FOR
- "Where do I mark a task done?" Tasks tab, tap the task, Done with quantity.
- "How do I record material arriving?" Materials, Record inward, photograph the
  challan.
- "How do I raise a defect?" Tasks → Snags → Raise, with a photo.
- "How do I void an expense?" Money → Ledger, open it, Void with a reason.
  Founder or accounts only. Voiding keeps the row and stops it counting.
- "How do I delete something?" Only records with no downstream effect can be
  deleted, and only from their own screen. Anything financial is voided, not
  deleted; workflow documents are cancelled.
- "Why can't I see the money?" Supervisors see no financial figures anywhere.
  That is deliberate and enforced in the database, not just hidden on screen.
`.trim()
