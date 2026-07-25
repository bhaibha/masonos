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
import BudgetVsActual from '@/pages/money/BudgetVsActual'
import ExpenseForm from '@/pages/money/ExpenseForm'
import Ledger from '@/pages/money/Ledger'
import MoneyLayout from '@/pages/money/MoneyLayout'
import Variations from '@/pages/money/Variations'
import Vendors from '@/pages/money/Vendors'
import DocsLayout from '@/pages/docs/DocsLayout'
import FolderView from '@/pages/docs/FolderView'
import Folders from '@/pages/docs/Folders'
import UploadForm from '@/pages/docs/UploadForm'
import InwardForm from '@/pages/materials/InwardForm'
import IssueForm from '@/pages/materials/IssueForm'
import MaterialMaster from '@/pages/materials/MaterialMaster'
import MaterialsLayout from '@/pages/materials/MaterialsLayout'
import StockRegister from '@/pages/materials/StockRegister'
import Orders from '@/pages/procurement/Orders'
import Incidents from '@/pages/tasks/Incidents'
import SafetyChecklist from '@/pages/tasks/SafetyChecklist'
import SiteLog from '@/pages/tasks/SiteLog'
import TaskForm from '@/pages/tasks/TaskForm'
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
              <Route path="safety" element={<SafetyChecklist />} />
              <Route path="incidents" element={<Incidents />} />
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
                <Route path="variations" element={<Variations />} />
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
              <Route path="orders" element={<Orders />} />
              <Route path="master" element={<MaterialMaster />} />
            </Route>
            {/* Confidential rows are filtered by docs_read in Postgres,
                not here. Upload is gated in-page per docs_write. */}
            <Route path="/docs" element={<DocsLayout />}>
              <Route index element={<Folders />} />
              <Route path="upload" element={<UploadForm />} />
              <Route path=":folder" element={<FolderView />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
