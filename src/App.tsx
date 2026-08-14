import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/AppShell'
import { RequireAuth } from '@/components/RequireAuth'
import { Toaster } from '@/components/Toaster'
import { RequireRole } from '@/components/RequireRole'
import { ADMIN_ROLES, BUDGET_WRITE_ROLES, MONEY_ROLES } from '@/lib/types'
import Dashboard from '@/pages/Dashboard'
import Login from '@/pages/Login'
import ProjectDetail from '@/pages/ProjectDetail'
import AdminLayout from '@/pages/admin/AdminLayout'
import AdminProjects from '@/pages/admin/AdminProjects'
import AdminTeam from '@/pages/admin/AdminTeam'
import BudgetEditor from '@/pages/money/BudgetEditor'
import Compliance from '@/pages/money/Compliance'
import BudgetVsActual from '@/pages/money/BudgetVsActual'
import ExpenseForm from '@/pages/money/ExpenseForm'
import Insurance from '@/pages/money/Insurance'
import Invoices from '@/pages/money/Invoices'
import Ledger from '@/pages/money/Ledger'
import Overheads from '@/pages/money/Overheads'
import Pnl from '@/pages/money/Pnl'
import RaBills from '@/pages/money/RaBills'
import Retention from '@/pages/money/Retention'
import MoneyLayout from '@/pages/money/MoneyLayout'
import Variations from '@/pages/money/Variations'
import Vendors from '@/pages/money/Vendors'
import DocsLayout from '@/pages/docs/DocsLayout'
import DrawingDetail from '@/pages/docs/DrawingDetail'
import DrawingFolders from '@/pages/docs/DrawingFolders'
import DrawingList from '@/pages/docs/DrawingList'
import FolderView from '@/pages/docs/FolderView'
import Folders from '@/pages/docs/Folders'
import UploadForm from '@/pages/docs/UploadForm'
import InwardForm from '@/pages/materials/InwardForm'
import IssueForm from '@/pages/materials/IssueForm'
import MaterialMaster from '@/pages/materials/MaterialMaster'
import MaterialsLayout from '@/pages/materials/MaterialsLayout'
import Movements from '@/pages/materials/Movements'
import StockRegister from '@/pages/materials/StockRegister'
import Comparisons from '@/pages/procurement/Comparisons'
import Orders from '@/pages/procurement/Orders'
import Bbs from '@/pages/tasks/Bbs'
import Incidents from '@/pages/tasks/Incidents'
import Rfis from '@/pages/tasks/Rfis'
import SafetyChecklist from '@/pages/tasks/SafetyChecklist'
import Qa from '@/pages/tasks/Qa'
import Schedule from '@/pages/tasks/Schedule'
import SiteInstructions from '@/pages/tasks/SiteInstructions'
import SiteLog from '@/pages/tasks/SiteLog'
import Snags from '@/pages/tasks/Snags'
import TaskForm from '@/pages/tasks/TaskForm'
import TaskHistory from '@/pages/tasks/TaskHistory'
import TaskList from '@/pages/tasks/TaskList'
import TasksLayout from '@/pages/tasks/TasksLayout'
import { useAuth } from '@/store/auth'

export default function App() {
  const init = useAuth((s) => s.init)

  useEffect(() => init(), [init])

  return (
    <BrowserRouter>
      <Toaster />
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route path="/dashboard" element={<Dashboard />} />
            {/* Sets the store's selected project, so the tabs stay scoped. */}
            <Route path="/project/:id" element={<ProjectDetail />} />

            {/* Founder only. RLS agrees: projects_write, members_write and
                profiles_admin all check is_founder(), so this guard is the
                second line of defence, not the boundary. */}
            <Route element={<RequireRole allow={ADMIN_ROLES} />}>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<AdminProjects />} />
                <Route path="team" element={<AdminTeam />} />
              </Route>
            </Route>

            {/* All four roles may read; accounts is read-only per 001_core.sql. */}
            <Route path="/tasks" element={<TasksLayout />}>
              <Route index element={<TaskList />} />
              <Route path="new" element={<TaskForm />} />
              <Route path="log" element={<SiteLog />} />
              {/* B1 Schedule + EVM. No role guard: every project member reads
                  the programme. The cost half is closed off inside Postgres —
                  budget_amount is revoked from authenticated and the EVM
                  functions return a supervisor zero rows. */}
              <Route path="schedule" element={<Schedule />} />
              {/* B2 QA/QC. No role guard: every project member reads the
                  inspection plan and raises NCRs. Sign-off and closure are
                  founder/PM, enforced inside fn_record_inspection and
                  fn_set_ncr_status rather than by hiding a button. */}
              <Route path="qa" element={<Qa />} />
              {/* B4 bar bending schedule. No role guard: the bar bender is the
                  audience, and a BBS carries no rates. Authoring is founder/PM
                  at RLS, and the IS constants are founder-only. */}
              <Route path="bbs" element={<Bbs />} />
              {/* Task history across a date range, with CSV export. Its own
                  from/to dates, so it ignores the layout's day picker. */}
              <Route path="history" element={<TaskHistory />} />
              <Route path="safety" element={<SafetyChecklist />} />
              <Route path="incidents" element={<Incidents />} />
              {/* A6 Site Instructions. Readable by every project member —
                  the table holds no figures, so no role guard here. */}
              <Route path="instructions" element={<SiteInstructions />} />
              {/* A7 RFIs. Same reasoning as instructions — no figures on the
                  table, so every project member reads it. */}
              <Route path="rfis" element={<Rfis />} />
              {/* A8 Snags. Supervisors raise and resolve defects on their own
                  project; verification is founder/PM, enforced in the RPC. */}
              <Route path="snags" element={<Snags />} />
            </Route>

            {/* Supervisors are blocked here and by RLS in 002_money.sql. */}
            <Route element={<RequireRole allow={MONEY_ROLES} />}>
              <Route path="/money" element={<MoneyLayout />}>
                <Route index element={<Ledger />} />
                <Route path="new" element={<ExpenseForm />} />
                <Route path="budget" element={<BudgetVsActual />} />
                {/* vendors_read/write is founder/pm/accounts — identical to
                    MONEY_ROLES, so the parent guard already covers it. */}
                <Route path="vendors" element={<Vendors />} />
                <Route path="orders" element={<Orders />} />
                {/* B3 rate comparison. Deliberately NOT mirrored under
                    /materials the way Orders is: a PO has a rate-free half a
                    supervisor needs, and a comparison has none — it is rates
                    end to end. The MONEY_ROLES guard here and the RLS on
                    rate_comparisons say the same thing twice. */}
                <Route path="compare" element={<Comparisons />} />
                <Route path="variations" element={<Variations />} />
                {/* A4 Invoices. RLS restricts the table to founder/accounts,
                    so the parent MONEY_ROLES guard is the outer layer only. */}
                <Route path="invoices" element={<Invoices />} />
                {/* A9 Compliance calendar. Founder/PM/accounts — exactly the
                    MONEY_ROLES the parent guard already enforces, and RLS on
                    compliance_items repeats it. */}
                <Route path="compliance" element={<Compliance />} />
                {/* A11 RA bills. Founder/PM/accounts read; certification is
                    founder/PM, enforced in fn_certify_ra_bill. */}
                <Route path="bills" element={<RaBills />} />
                {/* A12 retention ledger + bank guarantee register. Retention
                    held is derived from certified bills, never entered. */}
                <Route path="retention" element={<Retention />} />
                {/* B6 P&L. Not project-scoped — it spans every project the
                    caller may see, and the company card is founder-only. */}
                <Route path="pnl" element={<Pnl />} />
                {/* M29 part 2 — company overheads. No project at all: these
                    are the firm's own costs. company_expenses' RLS is
                    founder/accounts, and the page says so for a PM who
                    reaches the URL directly. */}
                <Route path="overheads" element={<Overheads />} />
                {/* A13 insurance register. Company-wide or per project, like
                    compliance — project_id is nullable. */}
                <Route path="insurance" element={<Insurance />} />
                <Route element={<RequireRole allow={BUDGET_WRITE_ROLES} />}>
                  <Route path="budget/edit" element={<BudgetEditor />} />
                </Route>
              </Route>
            </Route>

            {/* inward/issue are gated in-page; mat_write is founder/pm only. */}
            <Route path="/materials" element={<MaterialsLayout />}>
              <Route index element={<StockRegister />} />
              <Route path="inward" element={<InwardForm />} />
              <Route path="issue" element={<IssueForm />} />
              {/* Movement history — where a delivery or issue gets voided. */}
              <Route path="movements" element={<Movements />} />
              <Route path="orders" element={<Orders />} />
              <Route path="master" element={<MaterialMaster />} />
            </Route>
            {/* Confidential rows are filtered by docs_read in Postgres,
                not here. Upload is gated in-page per docs_write. */}
            <Route path="/docs" element={<DocsLayout />}>
              <Route index element={<Folders />} />
              <Route path="upload" element={<UploadForm />} />
              {/* A10 drawing register, three levels: disciplines → drawings →
                  one drawing's revisions (where issuing happens).
                  Deliberately NOT /docs/drawings: the vault has a folder whose
                  value is literally "drawings", and a static segment outranks
                  `:folder`, so that route would swallow the folder. */}
              <Route path="register" element={<DrawingFolders />} />
              <Route path="register/:discipline" element={<DrawingList />} />
              <Route
                path="register/:discipline/:drawingId"
                element={<DrawingDetail />}
              />
              <Route path=":folder" element={<FolderView />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
