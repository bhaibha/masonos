export type UserRole = 'founder' | 'pm' | 'supervisor' | 'accounts'

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
}

/** What each access role can reach — shown next to the picker so the founder
 *  understands exactly what they're granting. */
export const ROLE_ACCESS_NOTE: Record<UserRole, string> = {
  founder: 'Full access to every project, every module, all figures.',
  pm: 'All modules on assigned projects, including budgets and rates.',
  supervisor:
    'Tasks, site log, materials, safety, snags on assigned projects. All money, rates and confidential documents are hidden by the database.',
  accounts: 'All money modules across every project. Cannot write site data.',
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
}

export interface NewDocument {
  project_id: string
  folder: DocFolder
  title: string
  file_path: string
  file_type: string | null
  is_confidential: boolean
  po_id?: string | null
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

export interface PurchaseOrder {
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

export interface PoInvoiceRow {
  id: string
  invoice_no: string | null
  invoice_date: string
  gst_amount: number
  approved: boolean
}

// ---------- Variation Orders ----------

export type VoStatus = 'submitted' | 'approved' | 'rejected'

export const VO_STATUS_LABEL: Record<VoStatus, string> = {
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
}

/** vo_insert — PM or founder raise. */
export function canRaiseVO(role: UserRole | null): boolean {
  return role !== null && ['founder', 'pm'].includes(role)
}

/** vo_update approval — founder only. */
export function canApproveVO(role: UserRole | null): boolean {
  return role === 'founder'
}

export interface VariationOrder {
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

export interface ExpenseRow {
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
