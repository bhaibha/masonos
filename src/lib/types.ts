/**
 * `client` is an OUTSIDE role (065): one project, a curated read-only surface,
 * and none of the internal app. It is in this union so TypeScript forces every
 * exhaustive Record below to say what a client sees — but it is deliberately
 * absent from every internal capability check, and `is_member()` in the
 * database returns false for it unconditionally.
 */
export type UserRole = 'founder' | 'pm' | 'supervisor' | 'accounts' | 'client'

/** The four roles that belong to the firm. Use this for internal role pickers. */
export const INTERNAL_ROLES: UserRole[] = [
  'founder',
  'pm',
  'supervisor',
  'accounts',
]

export function isClientRole(role: UserRole | null): boolean {
  return role === 'client'
}

export type ProjectStatus = 'active' | 'on_hold' | 'completed'

export interface Profile {
  id: string
  full_name: string
  phone: string | null
  role: UserRole
  is_active: boolean
  /** Job title, display only (migration 019). Permissions come from `role`. */
  designation: string | null
}

// ---------- Admin (founder only) ----------

/**
 * Job titles the business actually uses, each mapped to one of the four access
 * roles the RLS policies understand.
 *
 * The title is cosmetic. `role` is the only thing Postgres checks — adding a
 * title here can never widen anyone's access, which is why this lives in TS
 * rather than as a database enum.
 */
export const DESIGNATIONS: {
  title: string
  role: UserRole
  note: string
}[] = [
  { title: 'Founder', role: 'founder', note: 'Everything, all projects' },
  { title: 'Project Lead', role: 'pm', note: 'All modules, assigned projects' },
  { title: 'Project Manager', role: 'pm', note: 'All modules, assigned projects' },
  { title: 'Planning Engineer', role: 'pm', note: 'All modules, assigned projects' },
  { title: 'Quantity Surveyor', role: 'pm', note: 'All modules, assigned projects' },
  { title: 'Billing Engineer', role: 'accounts', note: 'Money modules, all projects' },
  { title: 'Accountant', role: 'accounts', note: 'Money modules, all projects' },
  // Authors bar bending schedules, so it needs the pm access role. Exactly
  // what the designation→role mapping exists for: a new job title is a TS-only
  // change and can never widen anyone's data access (the 043 decision).
  { title: 'Structural Engineer', role: 'pm', note: 'All modules, assigned projects' },
  { title: 'Site Engineer', role: 'supervisor', note: 'Site work only — no money' },
  { title: 'Site Supervisor', role: 'supervisor', note: 'Site work only — no money' },
  { title: 'Safety Officer', role: 'supervisor', note: 'Site work only — no money' },
  { title: 'Store Keeper', role: 'supervisor', note: 'Site work only — no money' },
]

export const ROLE_LABEL: Record<UserRole, string> = {
  founder: 'Founder',
  pm: 'Project manager',
  supervisor: 'Site (no money)',
  accounts: 'Accounts',
  client: 'Client (portal only)',
}

/** What each access role can reach — shown next to the picker so the founder
 *  understands exactly what they're granting. */
export const ROLE_ACCESS_NOTE: Record<UserRole, string> = {
  founder: 'Full access to every project, every module, all figures.',
  pm: 'All modules on assigned projects, including budgets and rates.',
  supervisor:
    'Tasks, site log, materials, safety, snags on assigned projects. All money, rates and confidential documents are hidden by the database.',
  accounts: 'All money modules across every project. Cannot write site data.',
  client:
    'Outside the firm. Their own project only, through a separate curated ' +
    'portal — progress, shared photos and documents, their own invoices and ' +
    'approvals. Never the internal app, never another project, never the ' +
    'management fee or margin. Enforced in the database, not the interface.',
}

export function designationRole(title: string): UserRole | null {
  return DESIGNATIONS.find((d) => d.title === title)?.role ?? null
}

/** Only founders reach the admin module. RLS agrees: projects_write,
 *  members_write and profiles_admin all check is_founder(). */
export const ADMIN_ROLES: UserRole[] = ['founder']

export function canAdminister(role: UserRole | null): boolean {
  return role === 'founder'
}

export interface TeamMember extends Profile {
  /** ids of projects this person is assigned to */
  project_ids: string[]
}

export interface NewProjectInput {
  name: string
  client_name: string
  site_address: string
  status: ProjectStatus
  contract_value: number | null
  management_fee_pct: number | null
  /**
   * Build parameters (042). Present here so a founder can set out the whole
   * programme while creating the project, which is when they actually know
   * these numbers — going back to fill them in later is how a project ends up
   * with no schedule at all.
   */
  start_date: string | null
  target_end_date: string | null
  floors: number | null
  plot_area_sqft: number | null
}

export interface NewUserInput {
  email: string
  password: string
  full_name: string
  phone: string
  designation: string
  role: UserRole
  project_ids: string[]
}

/**
 * A CLIENT account. Deliberately a SEPARATE type from NewUserInput, and reached
 * from a separate form on a separate tab — never a `client` option in the team
 * role picker.
 *
 * The reason is the direction of the mistake. A staff member wrongly created as
 * a client merely sees less. An outsider wrongly created as a `pm` sees the
 * company's money. One dropdown containing both makes the second mistake one
 * mis-click away, so the two paths do not share a control.
 *
 * No `designation`: a client is not a job title, and DESIGNATIONS maps titles to
 * access roles for staff only (019). No `project_ids`: a client is never a
 * project member — `is_member()` returns false for them whatever that table
 * says (065) — so it is one project id, matching the UNIQUE constraint on
 * client_projects.user_id.
 */
export interface NewClientInput {
  email: string
  password: string
  full_name: string
  phone: string
  project_id: string
}

/** Row shape of public.v_client_roster (067). Carries no money, by design. */
export interface ClientRosterRow {
  link_id: string
  user_id: string
  full_name: string
  is_active: boolean
  project_id: string
  project_name: string
  project_status: ProjectStatus
  granted_at: string
  granted_by_name: string | null
  shared_documents: number
  published_photos: number
  visible_invoices: number
  pending_approvals: number
  unread_from_client: number
  last_message_at: string | null
}

export interface ClientRosterSummary {
  client_count: number
  active_count: number
  suspended_count: number
  projects_with_client: number
  pending_approvals: number
  unread_from_clients: number
}

/** Row shape of public.v_project_spend (security_invoker view). */
export interface ProjectSpend {
  project_id: string
  name: string
  total_spent: number
  total_budget: number
  /**
   * budget − spent, computed in Postgres (migration 007). Positive = under
   * budget, negative = overspent. null until 007 is applied.
   */
  remaining: number | null
  /** spent ÷ budget × 100, from Postgres. null when no budget, or pre-007. */
  pct_used: number | null
}

/**
 * Row shape of public.v_portfolio_summary (migration 009). Every money figure
 * is summed in Postgres; the browser only prints them.
 */
export interface PortfolioSummary {
  project_count: number
  active_count: number
  over_budget_count: number
  total_spent: number
  total_budget: number
  remaining: number
  pct_used: number | null
}

/** Non-money per-project counters for the dashboard stats row. */
export interface ProjectPulse {
  project_id: string
  tasks_total: number
  tasks_done: number
  /** null when no tasks are planned this week */
  task_pct: number | null
  low_stock_count: number
}

export interface Project {
  id: string
  name: string
  client_name: string | null
  site_address: string | null
  status: ProjectStatus
  /**
   * Commercial figures. RLS `projects_read` exposes these to any project
   * member, supervisors included — the UI hides them behind canSeeMoney().
   * See PROGRESS.md → Open questions.
   */
  contract_value: number | null
  management_fee_pct: number | null
  /**
   * Generated column from migration 008 (contract x pct / 100), computed by
   * Postgres. null until 008 is applied, or when either input is null.
   */
  management_fee_amount: number | null
}

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
}

/** Per-project counters for the detail screen. Counts, not money. */
export interface ProjectSummary {
  tasks_week_total: number
  tasks_week_done: number
  task_pct: number | null
  tasks_open: number
  tasks_overdue: number
  low_stock_count: number
  doc_counts: Record<string, number>
  doc_total: number
}

export type ActivityKind = 'expense' | 'task' | 'site_log'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  at: string
  title: string
  subtitle: string | null
  /** present only on expense rows, printed verbatim */
  amount: number | null
}

/** Roles permitted to see money. Mirrors the RLS policies in 002_money.sql. */
export const MONEY_ROLES: UserRole[] = ['founder', 'pm', 'accounts']

export function canSeeMoney(role: UserRole | null): boolean {
  return role !== null && MONEY_ROLES.includes(role)
}

/** budgets_write in 002_money.sql is founder/accounts only. */
export const BUDGET_WRITE_ROLES: UserRole[] = ['founder', 'accounts']

export function canEditBudgets(role: UserRole | null): boolean {
  return role !== null && BUDGET_WRITE_ROLES.includes(role)
}

// ---------- Void / reverse (migration 020) ----------

/**
 * Tables fn_void_record accepts. Financial and stock rows are never deleted —
 * they're voided, stay visible marked VOID, and drop out of every server-side
 * total. The exclusion happens in Postgres (v_project_spend, v_stock,
 * fn_expense_total, v_po_match …), never here.
 */
export type VoidableTable =
  | 'expenses'
  | 'petty_cash_entries'
  | 'material_inward'
  | 'material_issues'
  | 'goods_receipts'
  | 'po_invoices'

/** Fields every voidable row carries. */
export interface VoidFields {
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
}

export function isVoid(row: { voided_at: string | null }): boolean {
  return row.voided_at !== null
}

/** Money records: founder/accounts. Mirrors fn_void_record's own check. */
export const VOID_MONEY_ROLES: UserRole[] = ['founder', 'accounts']

/** Stock records: founder/pm — plus a supervisor's own entries, see below. */
export const VOID_STOCK_ROLES: UserRole[] = ['founder', 'pm']

function isStockTable(table: VoidableTable): boolean {
  return (
    table === 'material_inward' ||
    table === 'material_issues' ||
    table === 'goods_receipts'
  )
}

/**
 * Mirrors fn_void_record exactly. The database is the boundary — this only
 * decides whether to render the button.
 *
 * Migration 021: a **supervisor may void a delivery or issue they created
 * themselves**. They're the ones logging stock at site, so they're the ones who
 * mistype it; before 021 the register stayed wrong until a PM acted. Goods
 * receipts stay founder/pm — voiding one reverses a whole delivery.
 *
 * Pass `createdBy` (and the caller's own id) for the self-void case.
 */
export function canVoid(
  role: UserRole | null,
  table: VoidableTable,
  opts?: { createdBy?: string | null; myId?: string | null },
): boolean {
  if (role === null) return false

  if (!isStockTable(table)) return VOID_MONEY_ROLES.includes(role)
  if (VOID_STOCK_ROLES.includes(role)) return true

  // Supervisor self-void — inward and issues only, never goods receipts.
  if (
    role === 'supervisor' &&
    (table === 'material_inward' || table === 'material_issues') &&
    opts?.createdBy &&
    opts.myId &&
    opts.createdBy === opts.myId
  ) {
    return true
  }

  return false
}

// ---------- Cancel / reject (migration 021) ----------

/** Workflow documents get cancelled, not voided. */
export type CancellableTable =
  | 'purchase_orders'
  | 'variation_orders'
  | 'site_instructions'
  | 'invoices'
  | 'rfis'
  | 'ra_bills'

export const CANCELLABLE_LABEL: Record<CancellableTable, string> = {
  ra_bills: 'bill',
  rfis: 'RFI',
  invoices: 'invoice',
  site_instructions: 'site instruction',
  purchase_orders: 'purchase order',
  variation_orders: 'variation order',
}

export interface CancelFields {
  cancelled_at: string | null
  cancelled_by: string | null
  cancel_reason: string | null
}

/**
 * Who may cancel each document type — mirrors fn_cancel_document exactly.
 * POs and SIs: founder/pm (same roles that raise them).
 * VOs: founder only, because only the founder approves them.
 */
/**
 * Spelled out per table rather than "X else everything-else", because the
 * catch-all silently gave `invoices` founder/pm — which is wrong, they're
 * founder/accounts — and hid the Cancel button from the exact role that
 * should have it. An explicit map can't drift from fn_cancel_document.
 */
const CANCEL_ROLES: Record<CancellableTable, UserRole[]> = {
  purchase_orders: ['founder', 'pm'],
  site_instructions: ['founder', 'pm'],
  variation_orders: ['founder'], // only the founder approves them
  invoices: ['founder', 'accounts'], // same roles that issue them
  rfis: ['founder', 'pm'], // same roles that raise them
  ra_bills: ['founder', 'pm'], // same roles that certify them
}

export function canCancel(
  role: UserRole | null,
  table: CancellableTable,
): boolean {
  return role !== null && CANCEL_ROLES[table].includes(role)
}

// ---------- Hard delete (migration 022) ----------

/**
 * Records with no downstream effect. Anything carrying money or stock is
 * VOIDED, and workflow documents are CANCELLED — fn_delete_record refuses
 * those outright and says which mechanism to use instead.
 *
 * Projects and users are absent on purpose: a project cascades to every record
 * hanging off it, and a person's name is stamped on what they raised. Archive
 * and deactivate respectively (both already on the Manage screen).
 */
export type DeletableTable =
  | 'tasks'
  | 'site_logs'
  | 'safety_checklists'
  | 'incidents'
  | 'documents'
  | 'purchase_orders'
  | 'materials'
  | 'vendors'
  | 'budgets'
  | 'snags'
  | 'compliance_items'
  | 'drawings'
  | 'drawing_revisions'
  | 'doc_subfolders'
  | 'ra_bills'
  | 'retention_releases'
  | 'bank_guarantees'
  | 'insurance_policies'

export const DELETABLE_LABEL: Record<DeletableTable, string> = {
  ra_bills: 'bill',
  retention_releases: 'retention tranche',
  bank_guarantees: 'guarantee',
  insurance_policies: 'policy',
  compliance_items: 'compliance item',
  drawings: 'drawing',
  drawing_revisions: 'revision',
  doc_subfolders: 'sub-folder',
  tasks: 'task',
  site_logs: 'site log',
  safety_checklists: 'safety checklist',
  incidents: 'incident',
  snags: 'snag',
  documents: 'document',
  purchase_orders: 'request',
  materials: 'material',
  vendors: 'vendor',
  budgets: 'budget line',
}

/**
 * Mirrors fn_delete_record's role gate: budgets are founder/accounts,
 * compliance items are founder/pm/accounts (the three roles that own that
 * module), everything else founder/pm.
 */
export function canDelete(
  role: UserRole | null,
  table: DeletableTable,
): boolean {
  if (role === null) return false
  if (table === 'budgets') return role === 'founder' || role === 'accounts'
  if (table === 'compliance_items') return canManageCompliance(role)
  if (table === 'doc_subfolders') return role === 'founder'
  if (table === 'ra_bills') return canManageRaBills(role)
  if (
    table === 'retention_releases' ||
    table === 'bank_guarantees' ||
    table === 'insurance_policies'
  )
    return canManageRetention(role)
  return role === 'founder' || role === 'pm'
}

/** What each record type is called in confirm dialogs and toasts. */
export const VOIDABLE_LABEL: Record<VoidableTable, string> = {
  expenses: 'expense',
  petty_cash_entries: 'petty cash entry',
  material_inward: 'delivery',
  material_issues: 'issue',
  goods_receipts: 'goods receipt',
  po_invoices: 'vendor invoice',
}

/** A stock movement row for the Movements list (inward and issues combined). */
export interface MovementRow extends VoidFields {
  id: string
  kind: 'inward' | 'issue'
  table: VoidableTable
  material_id: string
  material_name: string
  material_unit: string
  move_date: string
  qty: number
  /** vendor for inward, work area for issue */
  party: string | null
  note: string | null
  /** inward rows created by a GRN can't be voided directly */
  from_grn: boolean
  /** who logged it — decides whether a supervisor may void it (021) */
  created_by: string | null
}

export interface GoodsReceiptRow extends VoidFields {
  id: string
  po_id: string
  received_date: string
  note: string | null
  line_count: number
}

// ---------- Tasks & site log ----------

export type TaskStatus = 'pending' | 'done' | 'partial' | 'not_done'

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  done: 'Done',
  partial: 'Partial',
  not_done: 'Not done',
}

/** tasks_write / tasks_update in 001_core.sql. `accounts` is read-only. */
export const TASK_WRITE_ROLES: UserRole[] = ['founder', 'pm', 'supervisor']

export function canWriteTasks(role: UserRole | null): boolean {
  return role !== null && TASK_WRITE_ROLES.includes(role)
}

export interface TaskRow {
  id: string
  project_id: string
  title: string
  trade: string | null
  work_area: string | null
  planned_date: string
  target_qty: number | null
  qty_unit: string | null
  status: TaskStatus
  done_qty: number | null
  not_done_reason: string | null
  rolled_from: string | null
  /** planned_date of the task this one was rolled from, when known */
  rolled_from_date: string | null
  /** 048 — set from an inspection comment, or by hand on the task form */
  priority: TaskPriority
  assigned_to: string | null
}

export interface NewTask {
  project_id: string
  title: string
  trade: string
  work_area: string
  planned_date: string
  target_qty: number | null
  qty_unit: string
}

/** Common trades — free text is still allowed. */
export const TRADES = [
  'Mason',
  'Electrician',
  'Plumber',
  'Carpenter',
  'Painter',
  'Tiler',
  'Fabricator',
  'Helper',
  'Other',
]

export const QTY_UNITS = ['sqft', 'rmt', 'nos', 'cum', 'kg', 'bags', 'days']

export interface SiteLogRow {
  id: string
  project_id: string
  log_date: string
  weather: string | null
  labour_mason: number
  labour_helper: number
  labour_other: number
  work_summary: string | null
  issues: string | null
  photos: string[]
  created_by: string
}

export interface NewSiteLog {
  project_id: string
  log_date: string
  weather: string
  labour_mason: number
  labour_helper: number
  labour_other: number
  work_summary: string
  issues: string
  photos: string[]
  created_by: string
}

export const WEATHER_OPTIONS = ['Clear', 'Cloudy', 'Light rain', 'Heavy rain', 'Very hot']

// ---------- Documents ----------

export type DocFolder =
  | 'contracts'
  | 'drawings'
  | 'permits'
  | 'invoices'
  | 'purchase_orders'
  | 'qc_certificates'
  | 'photos'
  | 'other'

export const DOC_FOLDERS: { value: DocFolder; label: string }[] = [
  { value: 'contracts', label: 'Contracts' },
  { value: 'drawings', label: 'Drawings' },
  { value: 'permits', label: 'Permits' },
  { value: 'invoices', label: 'Invoices' },
  { value: 'purchase_orders', label: 'Purchase Orders' },
  { value: 'qc_certificates', label: 'QC Certificates' },
  { value: 'photos', label: 'Photos' },
  { value: 'other', label: 'Other' },
]

export const DOC_FOLDER_LABEL = Object.fromEntries(
  DOC_FOLDERS.map((f) => [f.value, f.label]),
) as Record<DocFolder, string>

/** docs_write in 003_materials_docs.sql — supervisors may read but not upload. */
export const DOC_UPLOAD_ROLES: UserRole[] = ['founder', 'pm', 'accounts']

export function canUploadDocs(role: UserRole | null): boolean {
  return role !== null && DOC_UPLOAD_ROLES.includes(role)
}

/**
 * Roles for whom docs_read returns confidential rows. Used ONLY to decide
 * whether to render the confidential toggle — never to filter results.
 * The hiding itself is done by RLS in Postgres.
 */
export const DOC_CONFIDENTIAL_ROLES: UserRole[] = ['founder', 'pm', 'accounts']

export function canSeeConfidentialDocs(role: UserRole | null): boolean {
  return role !== null && DOC_CONFIDENTIAL_ROLES.includes(role)
}

export interface DocumentRow {
  id: string
  project_id: string
  folder: DocFolder
  title: string
  file_path: string
  file_type: string | null
  is_confidential: boolean
  uploaded_by: string
  uploaded_by_name: string | null
  created_at: string
  po_id: string | null
  /** live PO status, resolved for documents in the Purchase Orders folder */
  po_status: PoStatus | null
  /** null = filed at the top level of its folder (migration 031) */
  subfolder_id: string | null
}

// ---------- Document sub-folders (migration 031) ----------

/**
 * One optional level under the eight fixed folders. A table rather than a text
 * column so a founder can create "Permits → BBMP" before any file exists.
 */
export interface DocSubfolder {
  id: string
  project_id: string
  folder: DocFolder
  name: string
  created_at: string
}

/** Founder only — `subfolder_insert` checks is_founder(). */
export function canManageSubfolders(role: UserRole | null): boolean {
  return role === 'founder'
}

export interface NewDocument {
  project_id: string
  folder: DocFolder
  title: string
  file_path: string
  file_type: string | null
  is_confidential: boolean
  po_id?: string | null
  subfolder_id?: string | null
  /**
   * What produced this document (049): 'qa_plan', 'ncr', and later po / si /
   * vo. Omitted means somebody uploaded it by hand. Lets a folder be filtered
   * by source without matching on the title, which breaks the moment a file
   * is renamed.
   */
  doc_kind?: string | null
}

// ---------- Procurement ----------

export type PoStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'receiving'
  | 'received'
  | 'closed'
  | 'cancelled'

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  receiving: 'Receiving',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

/** Who may raise a purchase request. */
export function canRaisePR(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'supervisor'].includes(role)
}

/** Who may approve a PR into a PO (add rates). PM can approve too, per setup. */
export function canApprovePO(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/** Who may post a matched invoice to Open Book. */
export function canPostInvoice(role: UserRole | null): boolean {
  return role !== null && ['founder', 'accounts'].includes(role)
}

export interface PoLine {
  id: string
  po_id: string
  material_id: string
  qty_ordered: number
  /** null for supervisors (rate revoked) and until approved */
  rate: number | null
  line_total: number | null
  material_name?: string
  material_unit?: string
}

export interface PurchaseOrder extends CancelFields {
  id: string
  po_number: string
  project_id: string
  vendor_id: string | null
  status: PoStatus
  need_by: string | null
  notes: string | null
  raised_by: string
  approved_by: string | null
  created_at: string
  /** display name: registered vendor if linked, else free-text */
  vendor_display: string | null
  vendor_registered: boolean
  line_count: number
  /** ordered value — null for supervisors (rates hidden) */
  ordered_value: number | null
}

export interface NewPoLine {
  material_id: string
  qty_ordered: number
}

export interface NewPurchaseOrder {
  project_id: string
  vendor_id: string | null
  vendor_name: string
  need_by: string | null
  notes: string
  lines: NewPoLine[]
}

export type MatchStatus =
  | 'pending'
  | 'ok'
  | 'qty_variance'
  | 'rate_variance'
  | 'both'

export const MATCH_STATUS_LABEL: Record<MatchStatus, string> = {
  pending: 'Awaiting invoice',
  ok: 'Matched',
  qty_variance: 'Qty variance',
  rate_variance: 'Rate variance',
  both: 'Qty + rate variance',
}

/** Row of public.v_po_match (gated to money-roles). */
export interface MatchRow {
  po_line_id: string
  po_id: string
  material_id: string
  qty_ordered: number
  rate_ordered: number | null
  qty_received: number
  qty_invoiced: number
  rate_invoiced: number | null
  match_status: MatchStatus
  material_name?: string
  material_unit?: string
}

export interface InvoiceLineInput {
  po_line_id: string
  qty_invoiced: number
  rate_invoiced: number
}

export interface PoInvoiceRow extends VoidFields {
  id: string
  invoice_no: string | null
  invoice_date: string
  gst_amount: number
  approved: boolean
}

// ---------- Rate comparison / comparative statement (B3, migration 050) ----------

export type RcStatus = 'draft' | 'decided' | 'ordered'

export const RC_STATUS_LABEL: Record<RcStatus, string> = {
  draft: 'Collecting quotes',
  decided: 'Awarded',
  ordered: 'Ordered',
}

/**
 * A comparison is entirely made of rates, so there is no supervisor half of it
 * the way a PO has one. RLS returns them zero rows; this is the matching guard
 * on the screen so they get an explanation rather than an empty list.
 */
export function canSeeComparisons(role: UserRole | null): boolean {
  return role !== null && MONEY_ROLES.includes(role)
}

/**
 * Awarding is the same decision as approving a PO's rates, so it is founder/PM
 * — accounts build comparisons and chase quotes, but do not choose. Mirrors
 * the role check inside fn_rc_award.
 */
export function canAwardComparison(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/** Row of v_rc_summary. */
export interface ComparisonSummary {
  comparison_id: string
  project_id: string
  comparison_no: string
  title: string
  status: RcStatus
  need_by: string | null
  source_po_id: string | null
  created_at: string
  item_count: number
  vendor_count: number
  items_awarded: number
  /** cheapest vendor who priced EVERY item; null until one has */
  lowest_total: number | null
  highest_total: number | null
  awarded_subtotal: number
  /** lines that went to somebody other than the cheapest quote */
  awarded_off_lowest: number
}

export interface ComparisonItem {
  id: string
  comparison_id: string
  material_id: string | null
  description: string
  unit: string
  qty: number
  spec: string | null
  awarded_quote_id: string | null
  award_reason: string | null
  sort_order: number
}

export interface ComparisonVendor {
  id: string
  comparison_id: string
  vendor_id: string | null
  vendor_display: string
  quote_ref: string | null
  quote_date: string | null
  terms: string | null
  payment_terms: string | null
  delivery_days: number | null
  gst_pct: number
  /** set once fn_rc_to_po has raised this vendor's order */
  po_id: string | null
  sort_order: number
}

/** One cell of v_rc_matrix. `rate` null means the vendor did not quote. */
export interface ComparisonCell {
  item_id: string
  vendor_col_id: string
  quote_id: string | null
  rate: number | null
  line_total: number | null
  remark: string | null
  /** computed by a window function in Postgres, never in the browser */
  is_lowest: boolean
  is_awarded: boolean
}

/** Row of v_rc_vendor_totals. */
export interface ComparisonVendorTotal {
  comparison_id: string
  vendor_col_id: string
  vendor_display: string
  vendor_id: string | null
  gst_pct: number
  delivery_days: number | null
  terms: string | null
  payment_terms: string | null
  quote_ref: string | null
  items_quoted: number
  /** items this vendor left unpriced — a total built on these isn't comparable */
  items_missing: number
  subtotal: number
  gst_amount: number
  grand_total: number
  awarded_value: number
  is_lowest_total: boolean
}

export interface NewComparisonItem {
  material_id: string | null
  description: string
  unit: string
  qty: number
  spec: string | null
}

export interface NewComparison {
  project_id: string
  title: string
  need_by: string | null
  notes: string
  items: NewComparisonItem[]
}

// ---------- Bar Bending Schedule, IS 2502 (B4, migration 051) ----------

export type BbsMemberType =
  | 'footing'
  | 'pile_cap'
  | 'column'
  | 'beam'
  | 'slab'
  | 'wall'
  | 'staircase'
  | 'lintel'
  | 'other'

export const BBS_MEMBER_TYPES: { value: BbsMemberType; label: string }[] = [
  { value: 'footing', label: 'Footing' },
  { value: 'pile_cap', label: 'Pile cap' },
  { value: 'column', label: 'Column' },
  { value: 'beam', label: 'Beam' },
  { value: 'slab', label: 'Slab' },
  { value: 'wall', label: 'Wall' },
  { value: 'staircase', label: 'Staircase' },
  { value: 'lintel', label: 'Lintel' },
  { value: 'other', label: 'Other' },
]

export const BBS_MEMBER_LABEL = Object.fromEntries(
  BBS_MEMBER_TYPES.map((m) => [m.value, m.label]),
) as Record<BbsMemberType, string>

/** The rolled sizes. Matches the CHECK constraint on bbs_bars.dia_mm. */
export const BAR_DIAMETERS = [6, 8, 10, 12, 16, 20, 25, 28, 32, 36, 40] as const

/**
 * Founder/PM author a schedule; every project member reads it — the person
 * cutting the steel is the whole audience, and there are no rates on it.
 * Mirrors bbs_member_write / bbs_member_read.
 */
export function canEditBbs(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/** Only the founder may edit an IS constant — it restates every schedule. */
export function canEditBbsConstants(role: UserRole | null): boolean {
  return role === 'founder'
}

export interface BbsConstant {
  code: string
  label: string
  value: number
  unit: string
  is_ref: string | null
  note: string | null
  updated_at: string
}

export interface BbsShape {
  code: string
  name: string
  formula_kind: 'linear' | 'crank' | 'circular' | 'spiral'
  label_a: string | null
  label_b: string | null
  label_c: string | null
  label_d: string | null
  formula: string
  sort_order: number
}

/** Row of v_bbs_bars — every figure computed in Postgres. */
export interface BbsBar {
  bar_id: string
  member_id: string
  bar_mark: string
  dia_mm: number
  shape_code: string
  shape_name: string
  a_mm: number
  b_mm: number
  c_mm: number
  d_mm: number
  n_cranks: number
  qty_per_member: number
  total_qty: number
  cutting_length_mm: number
  cutting_length_m: number
  total_length_m: number
  unit_weight_kg_m: number
  total_weight_kg: number
  /** the arithmetic, produced by the same call that produced the answer */
  working: string | null
  /** set when the inputs give an impossible length — shown, never hidden */
  warning: string | null
  remarks: string | null
  sort_order: number
}

/** Row of v_bbs_member_totals. */
export interface BbsMember {
  member_id: string
  project_id: string
  member_type: BbsMemberType
  mark: string
  description: string | null
  level: string | null
  drawing_ref: string | null
  member_count: number
  bar_marks: number
  total_bars: number
  total_length_m: number
  total_weight_kg: number
  warnings: number
  created_at: string
}

/** Row of v_bbs_project_steel — what actually gets ordered. */
export interface BbsSteelByDia {
  dia_mm: number
  bar_marks: number
  total_bars: number
  total_length_m: number
  /** the SAME rounded figure the weights were computed from (053) */
  unit_weight_kg_m: number
  total_weight_kg: number
  total_tonnes: number
  /** ceil(total length / stock length). Not a cutting optimisation. */
  pieces_required: number
}

/** fn_bbs_mark_audit — the two boxes at the head of the firm's sheet. */
export interface BbsMarkAudit {
  numeric_marks: number
  total_marks: number
  /** null when bar marks aren't plain numbers — there is no sequence to audit */
  last_mark: string | null
  omitted: string | null
}

/** One row of fn_bbs_selftest(). */
export interface BbsTestCase {
  case_no: number
  case_name: string
  hand_working: string
  expected_mm: number
  computed_mm: number
  diff_mm: number
  passed: boolean
}

export interface NewBbsMember {
  project_id: string
  member_type: BbsMemberType
  mark: string
  description: string
  level: string
  drawing_ref: string
  member_count: number
  notes: string
  /** geometry, migration 052 — what the callout expander measures from */
  length_mm: number | null
  width_mm: number | null
  depth_mm: number | null
  cover_mm: number
  /** per end, from the drawing. Defaults to 0 — the app does not design this. */
  anchorage_mm: number
  is_circular: boolean
  diameter_mm: number | null
}

export interface BbsGeometry {
  length_mm: number | null
  width_mm: number | null
  depth_mm: number | null
  cover_mm: number | null
  anchorage_mm: number | null
  is_circular: boolean
  diameter_mm: number | null
  callout_text: string | null
}

/**
 * One line of fn_bbs_preview_callouts. `ok` false means the line was REFUSED,
 * with `problem` saying why — never a best-effort row.
 */
export interface BbsCalloutLine {
  line_no: number
  source_line: string
  ok: boolean
  problem: string | null
  bar_mark: string
  dia_mm: number | null
  shape_code: string
  a_mm: number
  b_mm: number
  n_cranks: number
  qty: number | null
  remarks: string | null
  cutting_length_mm: number | null
  working: string | null
  warning: string | null
}

export interface NewBbsBar {
  member_id: string
  bar_mark: string
  dia_mm: number
  shape_code: string
  a_mm: number
  b_mm: number
  c_mm: number
  d_mm: number
  n_cranks: number
  qty_per_member: number
  remarks: string
  sort_order: number
}

// ---------- Variation Orders ----------

export type VoStatus = 'submitted' | 'approved' | 'rejected' | 'cancelled'

export const VO_STATUS_LABEL: Record<VoStatus, string> = {
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}

/** vo_insert — PM or founder raise. */
export function canRaiseVO(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/** vo_update approval — founder only. */
export function canApproveVO(role: UserRole | null): boolean {
  return role === 'founder'
}

export interface VariationOrder extends CancelFields {
  id: string
  vo_number: string
  project_id: string
  title: string
  description: string | null
  cost_impact: number
  status: VoStatus
  raised_by: string
  approved_by: string | null
  created_at: string
}

export interface NewVariationOrder {
  project_id: string
  title: string
  description: string
  cost_impact: number
}

/** Row of v_project_contract (owner-run, money-roles). */
export interface ProjectContract {
  contract_value: number
  variations_value: number
  pending_value: number
  revised_contract_value: number
}

// ---------- Snags + DLP (A8, migration 027) ----------

export type SnagSeverity = 'low' | 'medium' | 'high'
export type SnagStatus = 'open' | 'in_progress' | 'resolved' | 'verified'

export const SNAG_SEVERITIES: { value: SnagSeverity; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

export const SNAG_SEVERITY_LABEL = Object.fromEntries(
  SNAG_SEVERITIES.map((s) => [s.value, s.label]),
) as Record<SnagSeverity, string>

export const SNAG_STATUS_LABEL: Record<SnagStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  verified: 'Verified',
}

/** Supervisors walk the site and find defects, so they raise and resolve. */
export function canRaiseSnag(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'supervisor'].includes(role)
}

/**
 * Verification is founder/PM only. Whoever fixed a defect shouldn't be the one
 * signing it off — that separation is the point of a snag list, and
 * fn_verify_snag enforces it rather than trusting this.
 */
export function canVerifySnag(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

export interface SnagRow {
  id: string
  snag_number: string
  project_id: string
  raised_date: string
  work_area: string
  trade: string | null
  description: string
  severity: SnagSeverity
  photos: string[]
  assigned_vendor_id: string | null
  /** registered vendor name if linked, else the free-text name */
  assigned_display: string | null
  assigned_registered: boolean
  status: SnagStatus
  resolution_note: string | null
  resolution_photos: string[]
  resolved_at: string | null
  resolved_by: string | null
  verified_at: string | null
  verified_by: string | null
  /** frozen at insert — whether it fell inside the liability window */
  raised_during_dlp: boolean
  raised_by: string
  raised_by_name: string | null
  created_at: string
}

export interface NewSnagInput {
  project_id: string
  raised_date: string
  work_area: string
  trade: string
  description: string
  severity: SnagSeverity
  photos: string[]
  assigned_vendor_id: string | null
  assigned_to: string
}

/** Return shape of fn_project_snag_summary — every count computed in Postgres. */
export interface SnagSummary {
  open_count: number
  in_progress_count: number
  resolved_count: number
  verified_count: number
  open_low: number
  open_medium: number
  open_high: number
  dlp_snag_count: number
  dlp_start: string | null
  dlp_end: string | null
  dlp_active: boolean
  dlp_days_left: number | null
}

/** DLP ending within this many days is worth warning about. */
export const DLP_WARN_DAYS = 30

// ---------- Compliance calendar (A9, migration 028) ----------

export type ComplianceCategory =
  | 'gst'
  | 'tds'
  | 'pf'
  | 'esi'
  | 'labour_licence'
  | 'building_permit'
  | 'insurance_renewal'
  | 'other'

export type ComplianceRecurrence =
  | 'one_time'
  | 'monthly'
  | 'quarterly'
  | 'annual'

export type ComplianceStatus = 'pending' | 'filed' | 'overdue'

/**
 * What the UI colours by. Derived in v_compliance_calendar from due_date at
 * query time, NOT read off the status column — the nightly sweep is
 * bookkeeping, and a deadline screen that needs a cron job to have run is a
 * deadline screen you can't trust.
 */
export type ComplianceDisplayStatus =
  | 'filed'
  | 'overdue'
  | 'due_soon'
  | 'upcoming'

export const COMPLIANCE_CATEGORIES: {
  value: ComplianceCategory
  label: string
}[] = [
  { value: 'gst', label: 'GST' },
  { value: 'tds', label: 'TDS' },
  { value: 'pf', label: 'PF' },
  { value: 'esi', label: 'ESI' },
  { value: 'labour_licence', label: 'Labour licence' },
  { value: 'building_permit', label: 'Building permit' },
  { value: 'insurance_renewal', label: 'Insurance renewal' },
  { value: 'other', label: 'Other' },
]

export const COMPLIANCE_CATEGORY_LABEL = Object.fromEntries(
  COMPLIANCE_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<ComplianceCategory, string>

export const COMPLIANCE_RECURRENCES: {
  value: ComplianceRecurrence
  label: string
}[] = [
  { value: 'one_time', label: 'One-time' },
  { value: 'monthly', label: 'Every month' },
  { value: 'quarterly', label: 'Every quarter' },
  { value: 'annual', label: 'Every year' },
]

export const COMPLIANCE_RECURRENCE_LABEL = Object.fromEntries(
  COMPLIANCE_RECURRENCES.map((r) => [r.value, r.label]),
) as Record<ComplianceRecurrence, string>

export const COMPLIANCE_DISPLAY_LABEL: Record<ComplianceDisplayStatus, string> =
  {
    filed: 'Filed',
    overdue: 'Overdue',
    due_soon: 'Due soon',
    upcoming: 'Upcoming',
  }

/**
 * Founder, PM and accounts. Supervisors are absent from every policy on
 * compliance_items, and the screen lives behind /money, which they cannot
 * reach at all.
 */
export function canManageCompliance(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'accounts'].includes(role)
}

/** Reopening a filing is founder/accounts — it unwinds a statutory record. */
export function canUnfileCompliance(role: UserRole | null): boolean {
  return role !== null && ['founder', 'accounts'].includes(role)
}

export interface ComplianceRow {
  id: string
  title: string
  category: ComplianceCategory
  /** null = company-wide, not tied to any one site */
  project_id: string | null
  project_name: string | null
  due_date: string
  recurrence: ComplianceRecurrence
  responsible: string | null
  responsible_name: string | null
  status: ComplianceStatus
  notes: string | null
  proof_path: string | null
  filed_date: string | null
  filed_by: string | null
  filed_at: string | null
  series_id: string | null
  /** negative once the date has passed */
  days_until: number
  display_status: ComplianceDisplayStatus
  created_at: string
}

export interface NewComplianceInput {
  title: string
  category: ComplianceCategory
  project_id: string | null
  due_date: string
  recurrence: ComplianceRecurrence
  responsible: string | null
  notes: string
}

/** fn_compliance_alert — the dashboard strip. Zeroes for a supervisor. */
export interface ComplianceAlert {
  overdue_count: number
  due_week_count: number
  next_due_date: string | null
  next_title: string | null
}

/** Anything due within this many days reads as "due soon" (matches the view). */
export const COMPLIANCE_SOON_DAYS = 7

// ---------- Drawing register (A10, migration 029) ----------

export type DrawingDiscipline =
  | 'architectural'
  | 'structural'
  | 'mep'
  | 'interior'
  | 'landscape'
  | 'other'

/**
 * wip        — being drawn or reviewed; invisible to supervisors (RLS).
 * ifc        — Issued For Construction. At most one per drawing, enforced by a
 *              partial unique index, not by the UI.
 * superseded — was on site once, replaced. Kept forever.
 */
export type DrawingStatus = 'wip' | 'ifc' | 'superseded'

export const DRAWING_DISCIPLINES: {
  value: DrawingDiscipline
  label: string
}[] = [
  { value: 'architectural', label: 'Architectural' },
  { value: 'structural', label: 'Structural' },
  { value: 'mep', label: 'MEP' },
  { value: 'interior', label: 'Interior' },
  { value: 'landscape', label: 'Landscape' },
  { value: 'other', label: 'Other' },
]

export const DRAWING_DISCIPLINE_LABEL = Object.fromEntries(
  DRAWING_DISCIPLINES.map((d) => [d.value, d.label]),
) as Record<DrawingDiscipline, string>

export const DRAWING_STATUS_LABEL: Record<DrawingStatus, string> = {
  wip: 'WIP',
  ifc: 'Issued for construction',
  superseded: 'Superseded',
}

/** Founder/PM maintain the register. Supervisors read current sheets only. */
export function canManageDrawings(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/** A row of v_drawing_register — one per drawing, carrying its current sheet. */
export interface DrawingRow {
  id: string
  project_id: string
  drawing_no: string
  title: string
  discipline: DrawingDiscipline
  created_at: string
  current_revision_id: string | null
  current_revision: string | null
  current_issued_date: string | null
  current_file_path: string | null
  current_file_type: string | null
  current_notes: string | null
  /** newest revision of any status — founder/PM only see WIP here */
  latest_revision: string | null
  latest_status: DrawingStatus | null
  wip_count: number
  superseded_count: number
  revision_count: number
}

export interface DrawingRevisionRow {
  id: string
  drawing_id: string
  project_id: string
  revision: string
  status: DrawingStatus
  issued_date: string | null
  file_path: string | null
  file_type: string | null
  notes: string | null
  issued_by: string | null
  issued_at: string | null
  superseded_at: string | null
  created_at: string
}

export interface NewDrawingInput {
  project_id: string
  drawing_no: string
  title: string
  discipline: DrawingDiscipline
}

// ---------- RA bills / certification (A11, migration 032) ----------

export type RaStatus =
  | 'submitted'
  | 'under_review'
  | 'certified'
  | 'rejected'
  | 'cancelled'

export const RA_STATUS_LABEL: Record<RaStatus, string> = {
  submitted: 'Submitted',
  under_review: 'Under review',
  certified: 'Certified',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}

/** Founder/PM/accounts reach the module; RLS says the same. */
export function canManageRaBills(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'accounts'].includes(role)
}

/**
 * Certification is founder/PM only. Accounts prepare and record a bill, but the
 * signature that authorises payment isn't theirs — `fn_certify_ra_bill`
 * enforces it, this only decides whether to render the button.
 */
export function canCertifyRaBill(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/** A row of v_ra_bill_totals. Every figure computed in Postgres. */
export interface RaBillRow {
  id: string
  bill_no: string
  project_id: string
  vendor_id: string | null
  vendor_name: string | null
  contractor_name: string | null
  contractor_bill_no: string | null
  period_from: string | null
  period_to: string
  claimed_amount: number | null
  retention_pct: number
  status: RaStatus
  notes: string | null
  line_count: number
  /** cumulative value of work measured to date */
  gross_work_value: number
  less_previously_certified: number
  value_this_bill: number
  retention_amount: number
  net_certified: number
  /** true once the figures are the stored snapshot rather than a preview */
  is_frozen: boolean
  certified_at: string | null
  certified_by: string | null
  rejected_at: string | null
  reject_reason: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  created_at: string
  /** schedule activity this bill is measured against (042), or null */
  activity_id: string | null
}

export interface RaBillLine {
  id: string
  bill_id: string
  description: string
  unit: string | null
  /** CUMULATIVE quantity to date, not this period */
  qty_to_date: number
  rate: number
  amount: number
  category_id: number | null
  sort: number
}

export interface NewRaBillInput {
  project_id: string
  vendor_id: string | null
  contractor_name: string
  contractor_bill_no: string
  period_from: string | null
  period_to: string
  claimed_amount: number | null
  retention_pct: number
  notes: string
  /** Optional schedule activity (042) — what earned value counts this against. */
  activity_id?: string | null
}

export interface NewRaLineInput {
  bill_id: string
  description: string
  unit: string
  qty_to_date: number
  rate: number
  sort: number
}

/** Per-contractor rollup from v_ra_payables. */
export interface RaPayable {
  project_id: string
  vendor_id: string | null
  contractor: string
  certified_bills: number
  gross_certified: number
  retention_held: number
  net_certified: number
  last_certified_at: string | null
}

// ---------- Retention & bank guarantees (A12, migration 033) ----------

export type RetentionMilestone =
  | 'on_completion'
  | 'after_dlp'
  | 'interim'
  | 'other'

export type RetentionState = 'planned' | 'released' | 'cancelled'

export const RETENTION_MILESTONES: {
  value: RetentionMilestone
  label: string
}[] = [
  { value: 'on_completion', label: 'On completion' },
  { value: 'after_dlp', label: 'After DLP' },
  { value: 'interim', label: 'Interim' },
  { value: 'other', label: 'Other' },
]

export const RETENTION_MILESTONE_LABEL = Object.fromEntries(
  RETENTION_MILESTONES.map((m) => [m.value, m.label]),
) as Record<RetentionMilestone, string>

export type BgType =
  | 'advance'
  | 'performance'
  | 'retention'
  | 'mobilisation'
  | 'other'

export type BgStatus = 'active' | 'expired' | 'released' | 'returned'

/** Derived in v_bg_register from expiry_date, not read off the column. */
export type BgDisplayStatus =
  | 'active'
  | 'expiring'
  | 'expired'
  | 'released'
  | 'returned'

export const BG_TYPES: { value: BgType; label: string }[] = [
  { value: 'performance', label: 'Performance' },
  { value: 'advance', label: 'Advance' },
  { value: 'retention', label: 'Retention' },
  { value: 'mobilisation', label: 'Mobilisation' },
  { value: 'other', label: 'Other' },
]

export const BG_TYPE_LABEL = Object.fromEntries(
  BG_TYPES.map((b) => [b.value, b.label]),
) as Record<BgType, string>

export const BG_DISPLAY_LABEL: Record<BgDisplayStatus, string> = {
  active: 'Active',
  expiring: 'Expiring',
  expired: 'Expired',
  released: 'Released',
  returned: 'Returned',
}

/** A guarantee inside this many days of expiry needs chasing. */
export const BG_WARN_DAYS = 30

/** Founder/PM/accounts, same as every money module. */
export function canManageRetention(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'accounts'].includes(role)
}

/** Releasing retention moves money out — founder/accounts only, per the RPC. */
export function canReleaseRetention(role: UserRole | null): boolean {
  return role !== null && ['founder', 'accounts'].includes(role)
}

/** A row of v_retention_ledger. `retention_held` is summed from certified bills. */
export interface RetentionLedgerRow {
  project_id: string
  party_key: string
  vendor_id: string | null
  contractor: string
  certified_bills: number
  retention_held: number
  released: number
  planned: number
  balance_held: number
  next_due: string | null
}

export interface RetentionTranche {
  id: string
  project_id: string
  vendor_id: string | null
  contractor_name: string | null
  milestone: RetentionMilestone
  status: RetentionState
  amount: number
  due_date: string | null
  released_date: string | null
  notes: string | null
  created_at: string
}

export interface NewTrancheInput {
  project_id: string
  vendor_id: string | null
  contractor_name: string
  milestone: RetentionMilestone
  amount: number
  due_date: string | null
  notes: string
}

export interface BgRow {
  id: string
  project_id: string
  vendor_id: string | null
  counterparty_name: string
  bg_type: BgType
  bg_number: string
  issuing_bank: string
  amount: number
  issue_date: string | null
  expiry_date: string
  claim_expiry_date: string | null
  status: BgStatus
  file_path: string | null
  notes: string | null
  released_at: string | null
  /** negative once expired */
  days_to_expiry: number
  display_status: BgDisplayStatus
  created_at: string
}

export interface NewBgInput {
  project_id: string
  vendor_id: string | null
  counterparty: string
  bg_type: BgType
  bg_number: string
  issuing_bank: string
  amount: number
  issue_date: string | null
  expiry_date: string
  claim_expiry_date: string | null
  file_path: string | null
  notes: string
}

/** fn_bg_alert — the dashboard strip. Zeroes for a supervisor. */
export interface BgAlert {
  expiring_count: number
  expired_count: number
  next_expiry: string | null
  next_bg_number: string | null
}

// ---------- Insurance (A13, migration 034) ----------

export type InsuranceType =
  | 'car'
  | 'workmen_comp'
  | 'professional_indemnity'
  | 'third_party_liability'
  | 'contractors_plant'
  | 'other'

export type InsuranceStatus = 'active' | 'expired' | 'renewed' | 'cancelled'

/** Derived in v_insurance_register from expiry_date, not read off the column. */
export type InsuranceDisplayStatus =
  | 'active'
  | 'expiring'
  | 'expired'
  | 'renewed'
  | 'cancelled'

export const INSURANCE_TYPES: { value: InsuranceType; label: string }[] = [
  { value: 'car', label: "Contractor's all-risk" },
  { value: 'workmen_comp', label: "Workmen's compensation" },
  { value: 'professional_indemnity', label: 'Professional indemnity' },
  { value: 'third_party_liability', label: 'Third-party liability' },
  { value: 'contractors_plant', label: "Contractor's plant" },
  { value: 'other', label: 'Other' },
]

export const INSURANCE_TYPE_LABEL = Object.fromEntries(
  INSURANCE_TYPES.map((t) => [t.value, t.label]),
) as Record<InsuranceType, string>

export const INSURANCE_DISPLAY_LABEL: Record<InsuranceDisplayStatus, string> = {
  active: 'Active',
  expiring: 'Expiring',
  expired: 'Expired',
  renewed: 'Renewed',
  cancelled: 'Cancelled',
}

/** Cover inside this many days of expiry needs renewing. */
export const INSURANCE_WARN_DAYS = 30

/** Founder/PM/accounts, same as every money module. */
export function canManageInsurance(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'accounts'].includes(role)
}

export interface PolicyRow {
  id: string
  /** null = company-wide cover */
  project_id: string | null
  project_name: string | null
  policy_type: InsuranceType
  policy_number: string
  insurer: string
  broker: string | null
  sum_insured: number | null
  premium: number | null
  start_date: string | null
  expiry_date: string
  status: InsuranceStatus
  file_path: string | null
  notes: string | null
  /** the policy this one replaces */
  renewed_from: string | null
  /** true when a later policy already renews this one */
  has_successor: boolean
  days_to_expiry: number
  display_status: InsuranceDisplayStatus
  created_at: string
}

export interface NewPolicyInput {
  project_id: string | null
  policy_type: InsuranceType
  policy_number: string
  insurer: string
  broker: string
  sum_insured: number | null
  premium: number | null
  start_date: string | null
  expiry_date: string
  file_path: string | null
  notes: string
  renewed_from: string | null
}

/** fn_insurance_alert — the dashboard strip. Zeroes for a supervisor. */
export interface InsuranceAlert {
  expiring_count: number
  expired_count: number
  next_expiry: string | null
  next_policy: string | null
}

// ---------- P&L / profitability (B6, migration 038) ----------

/**
 * A row of v_project_pnl. Every figure is computed in Postgres.
 *
 * `retention_held` is a CASH memo, not a margin deduction — the retained money
 * is already inside `total_cost`, because the work was done and we owe it.
 * Subtracting it again would flatter a project holding retention.
 */
export interface ProjectPnl {
  project_id: string
  name: string
  project_status: ProjectStatus
  contract_value: number
  variations_value: number
  /** submitted but not approved — never counted as revenue */
  pending_variations: number
  revenue: number
  expense_cost: number
  /** certified RA bills, which deliberately never post to Open Book */
  contractor_cost: number
  total_cost: number
  gross_margin: number
  margin_pct: number | null
  retention_held: number
  budget_total: number
  budget_remaining: number
  /** approved POs with nothing invoiced against them yet */
  committed_open: number
  /** null when the project has no budget — a forecast needs one */
  projected_cost: number | null
  projected_margin: number | null
}

export interface PnlCategoryRow {
  project_id: string
  category: string
  budget: number
  actual: number
  variance: number
  pct_used: number | null
  over_budget: boolean
}

/** fn_company_pnl — founder only; zero rows for anyone else. */
export interface CompanyPnl {
  project_count: number
  active_count: number
  revenue: number
  total_cost: number
  gross_margin: number
  blended_margin_pct: number | null
  retention_held: number
  committed_open: number
  profitable_count: number
  bleeding_count: number
}

/** Same three roles as every money module; supervisors see nothing. */
export function canSeePnl(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'accounts'].includes(role)
}

// ---------- QA/QC — inspection comments + NCRs (M17, migration 048) ----------

/**
 * Four levels, not five.
 *
 * A scale people can hold in their head is a scale they use; "medium-high" is
 * where a priority field starts meaning nothing.
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

export const TASK_PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
]

export const PRIORITY_LABEL = Object.fromEntries(
  TASK_PRIORITIES.map((p) => [p.value, p.label]),
) as Record<TaskPriority, string>

/** Urgent and high are the only two that shout. Normal is the default and silent. */
export const PRIORITY_TONE: Record<TaskPriority, string> = {
  urgent: 'bg-destructive text-white',
  high: 'bg-destructive/10 text-destructive',
  normal: 'bg-secondary text-muted-foreground',
  low: 'bg-secondary text-muted-foreground',
}

export type NcrSeverity = 'minor' | 'major' | 'critical'
export type NcrStatus =
  | 'open'
  | 'corrected'
  | 'closed'
  | 'rejected'
  | 'cancelled'

export const NCR_SEVERITIES: { value: NcrSeverity; label: string }[] = [
  { value: 'minor', label: 'Minor' },
  { value: 'major', label: 'Major' },
  { value: 'critical', label: 'Critical' },
]

export const NCR_SEVERITY_LABEL = Object.fromEntries(
  NCR_SEVERITIES.map((s) => [s.value, s.label]),
) as Record<NcrSeverity, string>

export const NCR_STATUS_LABEL: Record<NcrStatus, string> = {
  open: 'Open',
  corrected: 'Corrected — awaiting re-inspection',
  closed: 'Closed',
  rejected: 'Correction rejected',
  cancelled: 'Cancelled',
}

/**
 * One thing somebody saw on a walk.
 *
 * It has NO status of its own: the task it created is the status, and closing
 * that task is the closure. Two competing status fields on one observation is
 * how a list stops being believed.
 */
export interface InspectionComment {
  id: string
  project_id: string
  observed_on: string
  location: string
  comment: string
  priority: TaskPriority
  photos: string[]
  /** free text — a client walking their own house is not a user of this app */
  raised_for: string | null
  task_id: string | null
  /** from the linked task; null when the task was deleted */
  task_status: string | null
  task_done: boolean
  raised_by: string
  raised_by_name: string | null
  created_at: string
}

export interface NewInspectionComment {
  location: string
  comment: string
  priority: TaskPriority
  photos: string[]
  raised_for: string
  assigned_to: string | null
  due_date: string | null
  trade: string
}

export interface NcrRow {
  id: string
  ncr_no: string
  project_id: string
  area: string
  description: string
  severity: NcrSeverity
  standard_ref: string | null
  photos: string[]
  status: NcrStatus
  assigned_to: string | null
  corrective_action: string | null
  corrected_at: string | null
  closed_at: string | null
  reject_reason: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  raised_by: string
  created_at: string
}

export interface NewNcrInput {
  area: string
  description: string
  severity: NcrSeverity
  standard_ref: string
  photos: string[]
  assigned_to: string | null
}

export interface QaSummary {
  open_comments: number
  urgent_comments: number
  high_comments: number
  total_comments: number
  open_ncrs: number
  ncr_minor: number
  ncr_major: number
  ncr_critical: number
  corrected_ncrs: number
  closed_ncrs: number
  /** PDFs filed in Docs → QC Certificates */
  qa_docs: number
}

/** Who closes an NCR. Nobody closes their own. */
export function canSignOffInspection(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/** Everyone on the project raises observations — site people see the most. */
export function canRaiseNcr(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'supervisor'].includes(role)
}

// ---------- Schedule + earned value (B1 / M02, migration 042) ----------

export interface ScheduleActivity {
  id: string
  project_id: string
  code: string
  name: string
  planned_start: string
  planned_end: string
  planned_qty: number | null
  qty_unit: string | null
  pct_complete: number
  actual_start: string | null
  actual_end: string | null
  notes: string | null
  sort_order: number
  /** grouping label for the screen only — never a parent row */
  phase: string | null
}

export interface NewActivityInput {
  code: string
  name: string
  planned_start: string
  planned_end: string
  /** BAC. Write-only for everyone but founder/PM — 042 revoked the column. */
  budget_amount: number
  planned_qty: number | null
  qty_unit: string
  notes: string
  /** which group it appears under; blank lands it in "Other activities" */
  phase: string
}

export interface ActivityDependency {
  id: string
  predecessor_id: string
  successor_id: string
  lag_days: number
}

/** Dates and float, no money — a supervisor is entitled to all of it. */
export interface ActivityFloat {
  activity_id: string
  early_start: string
  early_finish: string
  late_start: string
  late_finish: string
  total_float: number
  is_critical: boolean
}

/**
 * Every ratio is nullable on purpose. PV = 0 (not started), AC = 0 (nothing
 * spent) and EV = 0 with money spent are all real states with no defined
 * index — 042 returns null rather than zero or infinity, and the UI prints
 * "n/a".
 */
export interface ActivityEvm {
  activity_id: string
  code: string
  name: string
  planned_start: string
  planned_end: string
  pct_complete: number
  bac: number
  planned_pct: number
  pv: number
  ev: number
  ac: number
  sv: number
  cv: number
  spi: number | null
  cpi: number | null
  eac: number | null
  etc: number | null
  vac: number | null
}

export interface ProjectEvm {
  data_date: string
  activity_count: number
  bac: number
  pv: number
  ev: number
  ac: number
  sv: number
  cv: number
  spi: number | null
  cpi: number | null
  eac: number | null
  etc: number | null
  vac: number | null
  /** EV / BAC — physical progress weighted by budget, not an average of % */
  pct_complete: number | null
}

/** The four inputs the whole programme is generated from. */
export interface GenerateScheduleInput {
  start: string
  end: string
  floors: number
  plot_area_sqft: number
  /** true wipes an existing programme — refused if money is tagged to it */
  replace?: boolean
}

export interface GenerateScheduleResult {
  activities_created: number
  links_created: number
  /** how long the method says this build takes at this size */
  natural_days: number
  /** how long the requested dates allow */
  target_days: number
  /** target ÷ natural. Below ~0.7 the programme is aggressive. */
  compression: number
}

/**
 * Below this, the requested end date demands a build materially faster than
 * the template's durations. The schedule still generates — it is the founder's
 * call — but the screen says so plainly first.
 */
export const SCHEDULE_TIGHT_BELOW = 0.7

/** Cost performance is a money surface. Supervisors see the schedule only. */
export function canSeeEvm(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'accounts'].includes(role)
}

/** Who may add activities, set budgets and draw dependencies. */
export function canEditSchedule(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/**
 * Who may move the progress slider. Supervisors included — they are the ones
 * standing in front of the slab. `fn_set_activity_progress` writes three
 * columns and cannot reach the budget.
 */
export function canLogProgress(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'supervisor'].includes(role)
}

// ---------- Company overheads (M29 part 2, migrations 040 + 041) ----------

/**
 * An overhead heading. 041 moved these from an enum to a founder-managed
 * table — the list is data now, so nothing here hard-codes it.
 */
export interface OverheadCategoryRow {
  id: string
  name: string
  /** set only on the 12 seeded headings; null on anything the founder added */
  slug: string | null
  /** retired headings stay for history and vanish from new entries */
  active: boolean
  sort_order: number
}

/**
 * Overheads are the firm's cost base. A PM runs sites; the rent is not their
 * business. Enforced by RLS on company_expenses — this only decides whether to
 * render the screen.
 */
export function canSeeOverheads(role: UserRole | null): boolean {
  return role !== null && ['founder', 'accounts'].includes(role)
}

/**
 * Who may change the chart of headings. Accounts records money against them;
 * only the founder decides what they are, so two people can't invent
 * "Internet" and "Office utilities" for the same bill.
 */
export function canEditOverheadCategories(role: UserRole | null): boolean {
  return role === 'founder'
}

export interface OverheadRow {
  id: string
  spend_date: string
  category_id: string
  category_name: string
  amount: number
  gst_amount: number
  total: number
  vendor_id: string | null
  /** linked vendor's name when set, else the free-text payee */
  vendor_display: string | null
  description: string | null
  proof_path: string | null
  voided_at: string | null
  void_reason: string | null
  created_at: string
}

export interface NewOverheadInput {
  spend_date: string
  category_id: string
  amount: number
  gst_amount: number
  vendor_id: string | null
  vendor_name: string
  description: string
  proof_path: string | null
}

export interface OverheadSummaryRow {
  category_id: string
  category_name: string
  entry_count: number
  amount: number
  gst_amount: number
  total: number
}

/**
 * The three layers of the net position. `project_margin` is LIFETIME to date;
 * `overheads` covers the chosen period only — the screen says so, because
 * mixing the two silently would be the easiest way to mislead yourself here.
 */
export interface CompanyNet {
  project_margin: number
  overheads: number | null
  net_position: number | null
  overhead_count: number
  sees_overheads: boolean
}

/** Period presets for the P&L. FY is India's April–March. */
export type PnlPeriod = 'month' | 'quarter' | 'fy' | 'all'

export const PNL_PERIODS: { value: PnlPeriod; label: string }[] = [
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'fy', label: 'This FY' },
  { value: 'all', label: 'All time' },
]

export interface NewRevisionInput {
  drawing_id: string
  revision: string
  issued_date: string | null
  file_path: string | null
  file_type: string | null
  notes: string
}

// ---------- RFIs (A7, migration 026) ----------

export type RfiStatus = 'open' | 'answered' | 'closed' | 'cancelled'
export type RfiCategory =
  | 'design'
  | 'structural'
  | 'mep'
  | 'finishes'
  | 'other'

export const RFI_STATUS_LABEL: Record<RfiStatus, string> = {
  open: 'Awaiting answer',
  answered: 'Answered',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

export const RFI_CATEGORIES: { value: RfiCategory; label: string }[] = [
  { value: 'design', label: 'Design' },
  { value: 'structural', label: 'Structural' },
  { value: 'mep', label: 'MEP' },
  { value: 'finishes', label: 'Finishes' },
  { value: 'other', label: 'Other' },
]

export const RFI_CATEGORY_LABEL = Object.fromEntries(
  RFI_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<RfiCategory, string>

/** Founder/PM raise and answer. Supervisors read their project. */
export function canRaiseRFI(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/**
 * A question to the design consultant that's blocking work. Carries no money —
 * that's what lets supervisors read the whole table. If an answer turns out to
 * have a cost, it goes on a VO and then an SI; this never holds an amount.
 */
export interface RfiRow extends CancelFields {
  id: string
  rfi_number: string
  project_id: string
  raised_date: string
  vendor_id: string | null
  /** registered vendor name if linked, else the free-text consultant */
  addressed_display: string | null
  addressed_registered: boolean
  /** the linked vendor's phone, for the share sheet. null for free text. */
  addressed_phone: string | null
  category: RfiCategory
  question: string
  attachments: string[]
  required_by: string | null
  response: string | null
  response_date: string | null
  responded_by: string | null
  /** what came back — paths in the `documents` bucket, not site-photos (035) */
  response_attachments: string[]
  status: RfiStatus
  raised_by: string
  raised_by_name: string | null
  closed_at: string | null
  created_at: string
}

export interface NewRfiInput {
  project_id: string
  raised_date: string
  vendor_id: string | null
  addressed_to: string
  category: RfiCategory
  question: string
  attachments: string[]
  required_by: string | null
}

/**
 * Overdue = past its required-by date with no answer yet.
 * An answered-but-not-closed RFI is not overdue — the question was resolved,
 * the housekeeping just hasn't been done.
 */
export function rfiIsOverdue(rfi: RfiRow, today: string): boolean {
  if (!rfi.required_by) return false
  if (rfi.status !== 'open') return false
  return rfi.required_by < today
}

// ---------- Invoices (A4, migration 024) ----------

export type InvoiceType = 'progress' | 'management_fee' | 'vendor_voucher'
export type InvoiceStatus = 'issued' | 'cancelled'

export const INVOICE_TYPE_LABEL: Record<InvoiceType, string> = {
  progress: 'Progress bill',
  management_fee: 'Management fee invoice',
  vendor_voucher: 'Vendor payment voucher',
}

/** What each type is addressed to — shown on the card and printed on the PDF. */
export const INVOICE_TYPE_PARTY: Record<InvoiceType, string> = {
  progress: 'Client',
  management_fee: 'Client',
  vendor_voucher: 'Vendor',
}

/** Issuing and cancelling are both founder/accounts. Mirrors the RPCs. */
export function canIssueInvoice(role: UserRole | null): boolean {
  return role !== null && ['founder', 'accounts'].includes(role)
}

export interface InvoiceItem {
  id: string
  sort: number
  description: string
  qty: number
  unit: string | null
  rate: number
  amount: number
}

/**
 * An issued invoice. Every figure is a SNAPSHOT written by fn_issue_invoice at
 * issue time — deliberately not recomputed on read, because a bill sent to a
 * client must not change when later expenses land.
 */
export interface InvoiceRow extends CancelFields {
  id: string
  invoice_number: string
  project_id: string
  inv_type: InvoiceType
  status: InvoiceStatus
  invoice_date: string
  period_from: string | null
  period_to: string | null
  vendor_id: string | null
  vendor_name: string | null
  subtotal: number
  gst_pct: number
  gst_amount: number
  /**
   * Gross already billed on earlier live progress invoices. Deducted AFTER
   * tax, because it is itself a gross figure — putting it inside `subtotal`
   * made the GST line indefensible against the taxable value shown (fixed in
   * migration 025). Zero for every other invoice type.
   */
  less_previously_billed: number
  total: number
  notes: string | null
  created_at: string
  items: InvoiceItem[]
}

export interface NewInvoiceInput {
  project_id: string
  inv_type: InvoiceType
  period_from: string
  period_to: string
  vendor_id: string | null
  gst_pct: number
  notes: string
}

// ---------- Site Instructions (A6, migration 023) ----------

export type SiStatus = 'issued' | 'acknowledged' | 'complete' | 'cancelled'

export const SI_STATUS_LABEL: Record<SiStatus, string> = {
  issued: 'Issued',
  acknowledged: 'Acknowledged',
  complete: 'Complete',
  cancelled: 'Cancelled',
}

/** Founder/PM issue and progress instructions. Supervisors read only. */
export function canIssueSI(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/**
 * A site instruction. Deliberately carries NO money — cost is a boolean plus an
 * optional link to the variation order that holds the figure. That's what lets
 * supervisors read the whole table (they're the ones acting on the instruction)
 * without breaching the money-hiding rule.
 */
export interface SiRow extends CancelFields {
  id: string
  si_number: string
  project_id: string
  issued_date: string
  vendor_id: string | null
  /** registered vendor name if linked, else the free-text name */
  addressed_display: string | null
  addressed_registered: boolean
  /** the linked vendor's phone, for the share sheet. null for free text. */
  addressed_phone: string | null
  work_area: string | null
  instruction: string
  attachments: string[]
  has_cost_implication: boolean
  variation_id: string | null
  /** VO number, resolved only for money-roles; null for supervisors */
  variation_number: string | null
  required_by: string | null
  status: SiStatus
  issued_by: string
  issued_by_name: string | null
  acknowledged_at: string | null
  completed_at: string | null
  created_at: string
}

export interface NewSiInput {
  project_id: string
  issued_date: string
  vendor_id: string | null
  addressed_to: string
  work_area: string
  instruction: string
  attachments: string[]
  has_cost_implication: boolean
  variation_id: string | null
  required_by: string | null
}

/** Overdue = past its required-by date and not yet complete or cancelled. */
export function siIsOverdue(si: SiRow, today: string): boolean {
  if (!si.required_by) return false
  if (si.status === 'complete' || si.status === 'cancelled') return false
  return si.required_by < today
}

// ---------- Safety ----------

/** Same write set as tasks — founder/pm/supervisor. accounts is read-only. */
export function canManageSafety(role: UserRole | null): boolean {
  return canWriteTasks(role)
}

export type SafetyResult = 'pass' | 'fail' | 'na'

export const SAFETY_RESULTS: { value: SafetyResult; label: string }[] = [
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
  { value: 'na', label: 'N/A' },
]

/** The standard daily checks. item_key is what's stored; label is display. */
export const SAFETY_ITEMS: { key: string; label: string; hint: string }[] = [
  { key: 'ppe', label: 'PPE compliance', hint: 'Helmets, boots, harnesses, gloves' },
  { key: 'scaffolding', label: 'Scaffolding', hint: 'Erection, ties, boards, tags' },
  { key: 'edge_protection', label: 'Edge protection', hint: 'Guardrails, barricades, openings covered' },
  { key: 'electrical', label: 'Electrical', hint: 'Cables, ELCB, temporary boards' },
  { key: 'housekeeping', label: 'Housekeeping', hint: 'Access routes, debris, storage' },
  { key: 'excavation', label: 'Excavation', hint: 'Shoring, barricading, spoil distance' },
]

export interface ChecklistItemState {
  result: SafetyResult
  remark: string
  photo_path: string | null
}

export interface SafetyChecklistMeta {
  id: string
  check_date: string
  created_by: string
  updated_at: string
}

export type IncidentType =
  | 'near_miss'
  | 'first_aid'
  | 'injury'
  | 'property_damage'

export const INCIDENT_TYPES: { value: IncidentType; label: string }[] = [
  { value: 'near_miss', label: 'Near miss' },
  { value: 'first_aid', label: 'First aid' },
  { value: 'injury', label: 'Injury' },
  { value: 'property_damage', label: 'Property damage' },
]

export const INCIDENT_TYPE_LABEL = Object.fromEntries(
  INCIDENT_TYPES.map((t) => [t.value, t.label]),
) as Record<IncidentType, string>

export type IncidentStatus = 'open' | 'closed'

export interface IncidentRow {
  id: string
  project_id: string
  occurred_at: string
  incident_type: IncidentType
  description: string
  people_involved: string | null
  immediate_action: string | null
  photos: string[]
  status: IncidentStatus
  created_by: string
}

export interface NewIncident {
  project_id: string
  occurred_at: string
  incident_type: IncidentType
  description: string
  people_involved: string
  immediate_action: string
  photos: string[]
}

/** Return shape of fn_safety_summary. */
export interface SafetySummary {
  last_incident_at: string | null
  days_since_incident: number | null
  open_incidents: number
  week_checklist_days: number
  week_days_elapsed: number
}

// ---------- Materials ----------

/** mat_write in 003_materials_docs.sql — the material master is founder/pm. */
export const MATERIAL_MASTER_ROLES: UserRole[] = ['founder', 'pm']

export function canEditMaterialMaster(role: UserRole | null): boolean {
  return role !== null && MATERIAL_MASTER_ROLES.includes(role)
}

/** inward_write / issue_write — supervisors log movements, that's their job. */
export const MATERIAL_LOG_ROLES: UserRole[] = ['founder', 'pm', 'supervisor']

export function canLogMaterials(role: UserRole | null): boolean {
  return role !== null && MATERIAL_LOG_ROLES.includes(role)
}

/**
 * Who sees purchase rates and vendors on the inward form.
 * Since migration 006 this is backed by the database: `rate` and `vendor_id`
 * are revoked at column level on material_inward, and the rate-bearing read
 * goes through v_material_inward_rates, which checks the same three roles.
 */
export const MATERIAL_RATE_ROLES: UserRole[] = ['founder', 'pm', 'accounts']

export function canSeeMaterialRates(role: UserRole | null): boolean {
  return role !== null && MATERIAL_RATE_ROLES.includes(role)
}

export interface Material {
  id: string
  name: string
  unit: string
  category_id: number | null
  low_stock_level: number
  is_active: boolean
}

export interface NewMaterial {
  name: string
  unit: string
  category_id: number | null
  low_stock_level: number
}

/** Row shape of public.v_stock (security_invoker). */
export interface StockRow {
  material_id: string
  name: string
  unit: string
  low_stock_level: number
  project_id: string
  total_in: number
  total_out: number
  in_stock: number
  low_stock: boolean
}

export interface NewInward {
  project_id: string
  material_id: string
  inward_date: string
  qty: number
  vendor_id: string | null
  vendor_name: string
  challan_no: string
  rate: number | null
  challan_photo: string | null
  remarks: string
}

export interface NewIssue {
  project_id: string
  material_id: string
  issue_date: string
  qty: number
  work_area: string
  issued_to: string
  remarks: string
}

export const MATERIAL_UNITS = [
  'bag',
  'kg',
  'cum',
  'sqft',
  'rmt',
  'nos',
  'ltr',
  'ton',
]

// ---------- Expenses ----------

export type ExpenseSource = 'bank' | 'upi' | 'petty_cash' | 'credit'

export const EXPENSE_SOURCES: { value: ExpenseSource; label: string }[] = [
  { value: 'bank', label: 'Bank' },
  { value: 'upi', label: 'UPI' },
  { value: 'petty_cash', label: 'Petty cash' },
  { value: 'credit', label: 'Credit' },
]

export interface ExpenseCategory {
  id: number
  name: string
  sort: number | null
}

export interface Vendor {
  id: string
  name: string
  phone: string | null
  gstin: string | null
  category: string | null
  is_active: boolean | null
}

export interface NewVendor {
  name: string
  phone: string
  gstin: string
  category: string
}

/** vendors_read / vendors_write — same three roles as MONEY_ROLES. */
export const VENDOR_ROLES: UserRole[] = ['founder', 'pm', 'accounts']

export function canManageVendors(role: UserRole | null): boolean {
  return role !== null && VENDOR_ROLES.includes(role)
}

export interface ExpenseRow extends VoidFields {
  id: string
  expense_date: string
  amount: number
  gst_amount: number
  source: ExpenseSource
  invoice_no: string | null
  description: string | null
  receipt_path: string | null
  category_id: number
  vendor_id: string | null
  category_name: string | null
  /** display name: registered vendor if linked, else the free-text name */
  vendor_display: string | null
  /** false = free-text vendor (vendor_id null but a name was typed) */
  vendor_registered: boolean
  /** schedule activity this cost is measured against (042), or null */
  activity_id: string | null
}

export interface NewExpense {
  project_id: string
  expense_date: string
  category_id: number
  vendor_id: string | null
  vendor_name: string
  description: string
  amount: number
  gst_amount: number
  source: ExpenseSource
  invoice_no: string
  receipt_path: string | null
  /**
   * Optional schedule activity (042). Untagged spend still hits the ledger and
   * the P&L — it just doesn't reach earned value, because AC has to be the cost
   * of a specific piece of work to mean anything.
   */
  activity_id?: string | null
}

export interface ExpenseFilters {
  categoryId?: number
  from?: string
  to?: string
  source?: ExpenseSource
}

/** Row shape of public.v_budget_vs_actual. All three figures come from SQL. */
export interface BudgetVsActual {
  project_id: string
  category: string
  budget: number
  actual: number
  remaining: number
  /** false = no budget row exists, as opposed to a budget deliberately set to 0 */
  has_budget: boolean
}

/** Return shape of public.fn_expense_total — summed in Postgres, migration 004. */
export interface ExpenseTotal {
  total_amount: number
  total_gst: number
  total_with_gst: number
  entry_count: number
}

export interface BudgetRow {
  id: string
  project_id: string
  category_id: number
  amount: number
}

// ---------- Contract Labour, BOCW/CLRA (B5, migration 054) ----------

/**
 * Attendance is headcount and a work area — every project member reads it, and
 * supervisors log it. That is the whole point of the module.
 */
export function canLogAttendance(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'supervisor'].includes(role)
}

/** Wage rates and every derived cost figure. Mirrors labour_rates' RLS. */
export function canSeeLabourCost(role: UserRole | null): boolean {
  return role !== null && MONEY_ROLES.includes(role)
}

/** Posting labour to the ledger is the accounts act, like fn_post_invoice. */
export function canPostLabour(role: UserRole | null): boolean {
  return role !== null && ['founder', 'accounts'].includes(role)
}

export interface LabourContractor {
  id: string
  name: string
  contact_person: string | null
  phone: string | null
  licence_no: string | null
  licence_authority: string | null
  licence_valid_to: string | null
  licensed_strength: number | null
  pf_code: string | null
  esi_code: string | null
  gstin: string | null
  trades: string[]
  vendor_id: string | null
  notes: string | null
  is_active: boolean
}

export interface NewLabourContractor {
  name: string
  contact_person: string
  phone: string
  licence_no: string
  licence_authority: string
  licence_valid_to: string | null
  licensed_strength: number | null
  pf_code: string
  esi_code: string
  gstin: string
  trades: string[]
  notes: string
}

/** Row of v_labour_attendance — no money on it. */
export interface AttendanceRow {
  attendance_id: string
  project_id: string
  work_date: string
  contractor_id: string
  contractor_name: string
  licence_no: string | null
  licence_valid_to: string | null
  trade: string
  workers_present: number
  overtime_hours: number
  work_area: string | null
  activity_id: string | null
  remarks: string | null
  voided_at: string | null
  void_reason: string | null
  created_by: string
  /** more workers booked than the licence permits — flagged, never blocked */
  over_licence: boolean
}

export interface NewAttendance {
  project_id: string
  work_date: string
  contractor_id: string
  trade: string
  workers_present: number
  overtime_hours: number
  work_area: string
  activity_id: string | null
  remarks: string
}

/** Row of v_labour_cost. Founder/PM/accounts only — supervisors get none. */
export interface LabourCostRow {
  attendance_id: string
  work_date: string
  contractor_name: string
  trade: string
  workers_present: number
  overtime_hours: number
  daily_rate: number | null
  rate_scope: string | null
  mandays: number
  wages: number
  ot_amount: number
  total_cost: number
  /** no rate in force for that day — posting is refused until it is set */
  rate_missing: boolean
}

export interface LabourRate {
  id: string
  project_id: string | null
  contractor_id: string | null
  trade: string
  daily_rate: number
  ot_multiplier: number
  normal_hours: number
  effective_from: string
  effective_to: string | null
  notes: string | null
}

export interface NewLabourRate {
  project_id: string | null
  contractor_id: string | null
  trade: string
  daily_rate: number
  ot_multiplier: number
  normal_hours: number
  effective_from: string
  effective_to: string | null
  notes: string
}

/** Row of fn_wage_register — the Form XVII equivalent, at gang level. */
export interface WageRegisterRow {
  contractor_id: string
  contractor_name: string
  trade: string
  days_worked: number
  mandays: number
  daily_rate: number | null
  wages: number
  ot_hours: number
  ot_amount: number
  total_payable: number
  missing_rates: number
}

export interface OvertimeRow {
  work_date: string
  contractor_name: string
  trade: string
  workers_present: number
  ot_hours: number
  normal_hours: number
  ot_multiplier: number
  ot_rate_per_hr: number
  ot_amount: number
}

export interface MusterRow {
  work_date: string
  contractor_id: string
  contractor_name: string
  trade: string
  workers_present: number
  overtime_hours: number
  work_area: string | null
}

/**
 * fn_labour_reconcile. `accrued` is what attendance says the labour was worth;
 * `booked_ledger` is what has actually reached the P&L. They are deliberately
 * separate figures — attendance never feeds the P&L on its own, or every rupee
 * of labour would be counted twice.
 */
export interface LabourReconcile {
  accrued: number
  posted: number
  booked_ledger: number
  variance: number
}

export interface LicenceAlert {
  contractor_id: string
  name: string
  licence_no: string | null
  licence_valid_to: string
  days_left: number
  display_status: 'expired' | 'due_soon' | 'valid'
}

/**
 * fn_labour_effort — the History roll-up. EFFORT only: no rate, no cost.
 * History is readable by supervisors and its exports carry no money column;
 * wages live at Money → Labour.
 */
export interface LabourEffortRow {
  contractor_id: string
  contractor_name: string
  trade: string
  days_worked: number
  mandays: number
  ot_hours: number
  peak_workers: number
}

// ---------- MIS reports & KPI dashboard (B7, migration 056) ----------

/**
 * The MIS is founder/PM/accounts. It inherits that from v_project_pnl rather
 * than declaring it — a supervisor gets zero rows from every source, so this
 * guard exists to show them a sentence instead of an empty screen.
 */
export function canSeeMis(role: UserRole | null): boolean {
  return role !== null && MONEY_ROLES.includes(role)
}

export type ProjectHealth = 'critical' | 'watch' | 'ok'

export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  critical: 'Needs attention',
  watch: 'Watch',
  ok: 'Healthy',
}

export const HEALTH_TEXT: Record<ProjectHealth, string> = {
  critical: 'text-destructive',
  watch: 'text-[var(--warning)]',
  ok: 'text-[var(--positive)]',
}

export const HEALTH_DOT: Record<ProjectHealth, string> = {
  critical: 'bg-destructive',
  watch: 'bg-[var(--warning)]',
  ok: 'bg-[var(--positive)]',
}

/** Row of v_mis_projects — the cross-project comparison table. */
export interface MisProject {
  project_id: string
  project_name: string
  project_status: string
  revenue: number
  total_cost: number
  gross_margin: number
  margin_pct: number | null
  budget_total: number
  budget_remaining: number
  budget_pct_used: number | null
  over_budget: boolean
  committed_open: number
  retention_held: number
  /** null where no schedule has been generated — a real state, not "behind" */
  activity_count: number | null
  spi: number | null
  cpi: number | null
  pct_complete: number | null
  bac: number | null
  evm_actual_cost: number | null
  open_ncrs: number
  critical_ncrs: number
  open_snags: number
  pos_pending: number
  bills_awaiting: number
  /** one verdict, computed in Postgres so screen, CSV and PDF agree */
  health: ProjectHealth
}

/**
 * fn_mis_company. `overheads` and `net_position` are null for a PM —
 * company_expenses is founder/accounts, and `sees_overheads` says which case
 * this is so the card can say "restricted" rather than show a misleading zero.
 *
 * Margin is LIFETIME to date; overheads are for the chosen period. Both spans
 * travel with the figure and the card prints them (the 040 lesson).
 */
export interface MisCompany {
  project_count: number
  active_count: number
  contract_value: number
  total_cost: number
  gross_margin: number
  blended_margin_pct: number | null
  over_budget_count: number
  bleeding_count: number
  overheads: number | null
  net_position: number | null
  sees_overheads: boolean
  overhead_from: string | null
  overhead_to: string | null
  retention_held: number
  committed_open: number
  bills_awaiting: number
  overdue_compliance: number
  open_ncrs: number
  critical_ncrs: number
  open_snags: number
  pos_pending: number
}

/**
 * One month of the trend. There is deliberately no "margin earned this month":
 * the app does not recognise revenue monthly, so only margin TO DATE is a
 * defensible figure.
 */
export interface MisTrendPoint {
  month: string
  monthly_cost: number
  cumulative_cost: number
  revenue_to_date: number
  margin_to_date: number
  margin_pct_to_date: number | null
}

export interface MisCategory {
  category_id: number
  category_name: string
  amount: number
  pct_of_total: number | null
  entry_count: number
}

export type MisExceptionKind =
  | 'budget'
  | 'margin'
  | 'cpi'
  | 'spi'
  | 'ncr'
  | 'compliance'
  | 'bg'
  | 'insurance'
  | 'ra_bill'
  | 'po'

export const EXCEPTION_LABEL: Record<MisExceptionKind, string> = {
  budget: 'Budget',
  margin: 'Margin',
  cpi: 'Cost',
  spi: 'Programme',
  ncr: 'Quality',
  compliance: 'Compliance',
  bg: 'Bank guarantee',
  insurance: 'Insurance',
  ra_bill: 'Contractor bill',
  po: 'Procurement',
}

/** Row of fn_mis_exceptions — eight sources in one shape, sorted by severity. */
export interface MisException {
  kind: MisExceptionKind
  severity: 'critical' | 'warning'
  project_id: string | null
  project_name: string | null
  title: string
  detail: string | null
  due_date: string | null
  amount: number | null
}

// ---------- Mason Learn, the reference library (C1, migration 057) ----------

export type LearnKind = 'article' | 'method_statement'
export type LearnStatus = 'draft' | 'published' | 'archived'

export const LEARN_KIND_LABEL: Record<LearnKind, string> = {
  article: 'Article',
  method_statement: 'Method statement',
}

export const LEARN_STATUS_LABEL: Record<LearnStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
}

/**
 * Everyone reads the library — it is reference, and there is not a rupee in it.
 * Drafts are the exception: RLS hides them from anyone who cannot write, so a
 * half-finished method statement is never followed on site.
 */
export function canWriteLearn(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

export interface LearnCategory {
  code: string
  name: string
  description: string | null
  sort_order: number
  article_count: number
  /** Uploaded files on this shelf (059). A shelf holding only PDFs is not empty. */
  document_count: number
}

/** Row of v_learn_articles — the list shape. */
export interface LearnArticleRow {
  id: string
  category_code: string
  category_name: string
  kind: LearnKind
  status: LearnStatus
  title: string
  ref_no: string | null
  summary: string | null
  is_refs: string[]
  trades: string[]
  tags: string[]
  activity: string | null
  version: number
  updated_at: string
  attachment_count: number
  step_count: number
}

/** One search hit. `matched_in` says whether the phrase was in a step. */
export interface LearnSearchHit {
  id: string
  category_code: string
  category_name: string
  kind: LearnKind
  status: LearnStatus
  title: string
  ref_no: string | null
  summary: string | null
  is_refs: string[]
  tags: string[]
  step_count: number
  rank: number
  /** ts_headline output — contains <b> markers, rendered as text segments */
  snippet: string | null
  matched_in: 'article' | 'step' | 'recent'
}

export interface LearnStep {
  id: string
  article_id: string
  step_no: number
  instruction: string
  safety_note: string | null
  qa_checkpoint: string | null
  is_refs: string[]
}

/** The full record, for reading and editing. */
export interface LearnArticle extends LearnArticleRow {
  body: string | null
  scope: string | null
  ppe: string | null
  created_by: string
  updated_by: string | null
}

/* ---------------- library documents (059) ---------------- */

/** Mirrors the doc_extract_status enum. */
export type DocExtractStatus = 'pending' | 'ok' | 'no_text' | 'failed'

/**
 * What the screen says about a document's searchability. Stated plainly,
 * because "this file is in the library but nothing inside it can be found" is
 * the single most surprising thing about a document library and needs to be
 * visible without asking.
 */
export const EXTRACT_LABEL: Record<DocExtractStatus, string> = {
  pending: 'Not read yet',
  ok: 'Searchable',
  no_text: 'Scanned — not searchable',
  failed: 'Could not be read',
}

/** Row of v_learn_documents. The extracted text is NOT here — it is bulk. */
export interface LearnDocumentRow {
  id: string
  article_id: string | null
  article_title: string | null
  shelf_code: string | null
  shelf_name: string | null
  status: LearnStatus
  title: string
  description: string | null
  ref_no: string | null
  is_refs: string[]
  trades: string[]
  tags: string[]
  file_path: string
  file_name: string
  file_type: string | null
  file_size: number | null
  page_count: number | null
  extract_status: DocExtractStatus
  extract_note: string | null
  has_text: boolean
  text_length: number
  created_at: string
  updated_at: string
}

/** One hit from fn_learn_doc_search. */
export interface LearnDocumentHit extends LearnDocumentRow {
  rank: number
  snippet: string | null
}

/**
 * One passage from fn_learn_retrieve — the seam a future assistant reads.
 * Every passage carries where it came from, so an answer can be traced back to
 * the document it was taken from.
 */
export interface LearnPassage {
  source_type: 'article' | 'step' | 'document'
  source_id: string
  article_id: string | null
  title: string
  ref_no: string | null
  is_refs: string[]
  passage: string
  rank: number
}

export interface NewLearnDocument {
  article_id: string | null
  category_code: string | null
  title: string
  description: string
  ref_no: string
  is_refs: string[]
  trades: string[]
  tags: string[]
}

export interface NewLearnArticle {
  category_code: string
  kind: LearnKind
  title: string
  ref_no: string
  summary: string
  body: string
  is_refs: string[]
  trades: string[]
  tags: string[]
  activity: string
  scope: string
  ppe: string
}

/** Provenance: set when an AI skeleton was generated into the article (058). */
export interface LearnAiProvenance {
  ai_drafted_at: string | null
  ai_model: string | null
}

export interface NewLearnStep {
  step_no: number
  instruction: string
  safety_note: string
  qa_checkpoint: string
  is_refs: string[]
}

/* ================================================================
   C2 — CLIENT APPROVALS (migration 060)
   ================================================================ */

export type ApprovalSubject =
  | 'material_selection'
  | 'design_change'
  | 'variation_order'
  | 'stage_signoff'
  | 'sample'
  | 'other'

export type ApprovalMethod = 'verbal' | 'whatsapp' | 'email' | 'signed'
export type ApprovalState = 'pending' | 'approved' | 'rejected'

export const APPROVAL_SUBJECT_LABEL: Record<ApprovalSubject, string> = {
  material_selection: 'Material selection',
  design_change: 'Design change',
  variation_order: 'Variation order',
  stage_signoff: 'Stage sign-off',
  sample: 'Sample or mock-up',
  other: 'Other',
}

export const APPROVAL_METHOD_LABEL: Record<ApprovalMethod, string> = {
  verbal: 'Verbal',
  whatsapp: 'WhatsApp',
  email: 'Email',
  signed: 'Signed',
}

/**
 * How much a method is worth if the approval is ever questioned. Shown on the
 * card, because a register that displays a phone call and a countersigned sheet
 * identically looks authoritative about something it cannot support.
 */
export const APPROVAL_METHOD_WEIGHT: Record<ApprovalMethod, string> = {
  verbal: 'Weakest record — attach a note or photo if you can',
  whatsapp: 'Keep the screenshot attached',
  email: 'Keep the email attached',
  signed: 'Strongest record',
}

export const APPROVAL_STATUS_LABEL: Record<ApprovalState, string> = {
  pending: 'Awaiting the client',
  approved: 'Approved',
  rejected: 'Rejected',
}

/** Founder and PM log approvals; everyone on the project reads them. */
export function canLogApprovals(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/** Row of v_client_approvals. Carries NO amount — by design (see 060). */
export interface ClientApprovalRow {
  id: string
  approval_no: string
  project_id: string
  project_name: string
  subject: ApprovalSubject
  title: string
  details: string | null
  approved_by_name: string
  client_role: string | null
  method: ApprovalMethod
  status: ApprovalState
  decided_on: string | null
  reject_reason: string | null
  decided_at: string | null
  decided_by_name: string | null
  raised_by_name: string | null
  variation_id: string | null
  /** Null for a supervisor — variation_orders' own RLS hides it. */
  vo_number: string | null
  variation_title: string | null
  document_id: string | null
  document_title: string | null
  material_id: string | null
  material_name: string | null
  evidence: string[]
  evidence_count: number
  evidence_missing: boolean
  created_at: string
}

export interface ApprovalSummary {
  pending_count: number
  approved_count: number
  rejected_count: number
  oldest_pending_days: number | null
  no_evidence_count: number
}

export interface NewClientApproval {
  project_id: string
  subject: ApprovalSubject
  title: string
  details: string
  approved_by_name: string
  client_role: string
  method: ApprovalMethod
  variation_id: string | null
  document_id: string | null
  material_id: string | null
  evidence: string[]
}

/* ================================================================
   D1 — AI PHOTO HELPER (migration 061)
   ================================================================ */

export type PhotoSource = 'site_log' | 'snag' | 'inspection' | 'other'
export type AnalysisState = 'suggested' | 'accepted' | 'dismissed'

/**
 * One thing the model thinks is worth a closer look.
 *
 * There is deliberately NO severity field. A severity is a judgement, and a
 * judgement from something that cannot measure is a number people would quote.
 * `what_to_check` is the point of the whole structure: it forces the output
 * into the grammar of a question for a person, not a finding.
 */
export interface PhotoConcern {
  concern: string
  what_to_check: string
}

export interface PhotoAnalysis {
  id: string
  project_id: string
  photo_path: string
  source: PhotoSource
  description: string | null
  concerns: PhotoConcern[]
  model: string | null
  analysed_at: string
  status: AnalysisState
  acted_by: string | null
  acted_at: string | null
  dismiss_note: string | null
  accepted_snag_id: string | null
  accepted_ncr_id: string | null
  created_at: string
}

export interface PhotoAnalysisSummary {
  total_count: number
  suggested_count: number
  accepted_count: number
  dismissed_count: number
  /** Null until something has been decided — a rate from a sample of zero isn't one. */
  accept_rate_pct: number | null
}

/**
 * Who may ask for an analysis and act on one.
 *
 * Supervisors included, deliberately: they are the ones standing in front of
 * the wall with the phone, and there is no money anywhere in this feature.
 */
export function canAnalysePhotos(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'supervisor'].includes(role)
}

/** An NCR is a formal non-conformance. Founder/PM only, matching 043. */
export function canAcceptAsNcr(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/**
 * The line that must appear next to every piece of model output in this app.
 * Kept as a constant so it cannot drift between the three screens that show it.
 */
export const AI_SUGGESTION_LABEL = 'AI suggestion — verify on site'

/* ================================================================
   D2 — CLASH REGISTER (migration 062)
   ================================================================ */

export type ClashSeverity = 'low' | 'medium' | 'high'
export type ClashStatus = 'open' | 'resolved' | 'verified'

export const CLASH_SEVERITY_LABEL: Record<ClashSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export const CLASH_STATUS_LABEL: Record<ClashStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  verified: 'Verified',
}

/** Reuses the drawing register's disciplines (029) — one list, not two. */
export const CLASH_DISCIPLINES: DrawingDiscipline[] = [
  'structural',
  'mep',
  'architectural',
  'interior',
  'landscape',
  'other',
]

/** Row of v_clashes. No money anywhere — supervisors read all of it. */
export interface ClashRow {
  id: string
  clash_no: string
  project_id: string
  system_a: string
  system_b: string
  discipline_a: DrawingDiscipline
  discipline_b: DrawingDiscipline
  location: string
  description: string
  severity: ClashSeverity
  status: ClashStatus
  drawing_a_id: string | null
  drawing_a_no: string | null
  drawing_a_title: string | null
  drawing_b_id: string | null
  drawing_b_no: string | null
  drawing_b_title: string | null
  drawing_refs: string[]
  photos: string[]
  assigned_to: string | null
  assigned_to_name: string | null
  rfi_id: string | null
  rfi_number: string | null
  rfi_status: string | null
  rfi_answered: boolean
  resolution: string | null
  resolved_at: string | null
  resolved_by_name: string | null
  verified_at: string | null
  verified_by_name: string | null
  raised_by: string
  raised_by_name: string | null
  created_at: string
  /** Null unless the clash is open. */
  open_days: number | null
}

export interface ClashSummary {
  open_count: number
  resolved_count: number
  verified_count: number
  open_high: number
  oldest_open_days: number | null
  /** Open clashes whose RFI has gone out and not come back. */
  awaiting_rfi: number
}

export interface NewClash {
  project_id: string
  system_a: string
  system_b: string
  discipline_a: DrawingDiscipline
  discipline_b: DrawingDiscipline
  location: string
  description: string
  severity: ClashSeverity
  drawing_a_id: string | null
  drawing_b_id: string | null
  drawing_refs: string[]
  photos: string[]
  assigned_to: string | null
}

/** Raise and resolve. Supervisors included — they find them on site. */
export function canWorkClashes(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'supervisor'].includes(role)
}

/**
 * Verify a clash as closed out, and raise the RFI to a consultant.
 *
 * Same split as snags (027): the person who says it is fixed should not be the
 * person who says it was checked. The server also refuses self-verification
 * even for a founder or PM.
 */
export function canVerifyClash(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/* ================================================================
   D3 — HEALTH SIGNALS (migration 063)
   ================================================================ */

export type SignalCategory = 'cost' | 'schedule' | 'quality' | 'deadline'
export type SignalLevel = 'watch' | 'concern'
/** How the number was arrived at. Printed on screen — the two are different claims. */
export type SignalBasis = 'point_in_time' | 'trend'

export const SIGNAL_CATEGORY_LABEL: Record<SignalCategory, string> = {
  cost: 'Cost',
  schedule: 'Programme',
  quality: 'Quality',
  deadline: 'Deadlines',
}

export const SIGNAL_LEVEL_LABEL: Record<SignalLevel, string> = {
  watch: 'Worth watching',
  concern: 'Needs a look',
}

export const SIGNAL_BASIS_LABEL: Record<SignalBasis, string> = {
  point_in_time: 'Measured once, today',
  trend: 'Compared with earlier readings',
}

/**
 * The line that frames the whole panel. A constant so it cannot drift between
 * the signals screen and the project card.
 *
 * These are arithmetic over a small dataset, not a model and not a forecast.
 * With four active projects there is no sample to forecast from, and a figure
 * presented as a prediction gets quoted as one.
 */
export const SIGNAL_DISCLAIMER =
  'Early signals, not forecasts. Simple arithmetic over what the app already ' +
  'holds — indicative only, and worth checking before acting on.'

export interface HealthFlag {
  project_id: string
  project_name: string
  code: string
  category: SignalCategory
  level: SignalLevel
  headline: string
  detail: string
  metric_value: number | null
  metric_label: string
  basis: SignalBasis
  /** Observations behind a trend; 1 for a point-in-time reading. */
  sample_n: number
  snoozed_until: string | null
}

export interface DeadlineSignal {
  code: string
  level: SignalLevel
  headline: string
  detail: string
  metric_value: number | null
  metric_label: string
}

export interface HealthTrendPoint {
  snap_date: string
  pct_spend: number | null
  progress_pct: number | null
  cpi: number | null
  spi: number | null
  open_snags: number
  open_ncrs: number
}

/** Founder and PM see every category; accounts sees cost and deadline only. */
export function canSeeSignals(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm', 'accounts'].includes(role)
}

/** Setting a signal aside is a judgement call — founder/PM. */
export function canAckSignals(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/* ================================================================
   IN-APP ASSISTANT (migration 064)
   ================================================================ */

export type AssistantActionKind =
  | 'task'
  | 'snag'
  | 'site_log_note'
  | 'rfi'
  | 'document_draft'

export type AssistantActionState =
  | 'proposed'
  | 'confirmed'
  | 'cancelled'
  | 'failed'

export const ACTION_KIND_LABEL: Record<AssistantActionKind, string> = {
  task: 'Create a task',
  snag: 'Raise a snag',
  site_log_note: "Add a note to today's site log",
  rfi: 'Raise an RFI',
  document_draft: 'File a note in the vault',
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Which tools ran, so "why did it say that" stays answerable. */
  toolCalls: { name: string; args: Record<string, unknown> }[]
  /** Confirmation cards attached to this turn. */
  proposals: AssistantProposal[]
  streaming?: boolean
  error?: string
}

export interface AssistantProposal {
  action_id: string
  kind: AssistantActionKind
  project: string
  values: Record<string, unknown>
  state: AssistantActionState
  resultId?: string
}

/**
 * Everyone can use the assistant. What it can SEE and DO differs by role, and
 * that difference is enforced in the database and in the tool whitelist — not
 * by hiding the panel.
 */
export function canUseAssistant(role: UserRole | null): boolean {
  return role !== null
}

/**
 * Shown at the top of the panel and next to the first answer.
 *
 * The assistant reads live data through the user's own permissions, so its
 * figures are real — but it is a language model and can still misread a
 * question or summarise badly. Saying so once, plainly, is the honest framing.
 */
export const ASSISTANT_DISCLAIMER =
  'Reads live data through your own permissions — it can only see what your ' +
  'role allows. It can draft records for you to confirm, but never creates, ' +
  'changes or deletes anything on its own, and never touches money.'
