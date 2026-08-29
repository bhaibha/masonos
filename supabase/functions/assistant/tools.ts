// ============================================================
// The tool whitelist.
//
// This file is the security boundary of the assistant. Everything the model can
// reach is in this list, and it can reach nothing else.
//
// TWO RULES, BOTH LOAD-BEARING
// ---------------------------
// 1. The model NEVER writes SQL. It picks a name from `TOOLS` and supplies
//    typed arguments. `runTool` maps that name to one hard-coded query. A name
//    that is not in the map is refused before anything runs.
//
// 2. Every query executes on the CALLER'S client, built from their own
//    Authorization header. RLS therefore applies to every row. There is no
//    service-role key in this feature at all.
//
// WHY EACH TOOL ALSO CARRIES `roles`
// ----------------------------------
// RLS alone is not enough for an ASSISTANT, and this is the non-obvious part.
//
// `v_project_spend` is security_invoker over `expenses`, whose RLS excludes
// supervisors. A supervisor selecting from it does not get an error and does
// not get zero rows — they get one row of ZEROS, because sum() over no visible
// rows is null and the view coalesces it. Verified against a real database.
//
// A human sees "restricted for your role" because the dashboard checks first.
// A model sees `total_spent: 0` and answers "nothing has been spent on Villa
// 12" — a confident lie, and worse than a refusal.
//
// So each tool names the roles that may call it. RLS remains the boundary; the
// role list stops the assistant reporting a misleading zero.
// ============================================================

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export type Role = 'founder' | 'pm' | 'supervisor' | 'accounts'

const ALL: Role[] = ['founder', 'pm', 'supervisor', 'accounts']
const MONEY: Role[] = ['founder', 'pm', 'accounts']
const SITE: Role[] = ['founder', 'pm', 'supervisor']

export interface ToolDef {
  name: string
  description: string
  /** Gemini function-declaration parameter schema. */
  parameters: Record<string, unknown>
  roles: Role[]
  /** True for tools that only PROPOSE a record; they never write. */
  proposes?: boolean
}

const projectArg = {
  project: {
    type: 'string',
    description:
      'Project name or part of it, e.g. "Villa 12". Omit to cover every ' +
      'project the user can see.',
  },
}

export const TOOLS: ToolDef[] = [
  /* ---------------- reads: open to everyone on the project ------------- */
  {
    name: 'list_projects',
    description:
      'The projects this user can see, with status and dates. Use this first ' +
      'when the user names a project, to resolve it.',
    parameters: { type: 'object', properties: {} },
    roles: ALL,
  },
  {
    name: 'tasks_for_day',
    description: 'Tasks on a given day, with status. Defaults to today.',
    parameters: {
      type: 'object',
      properties: {
        ...projectArg,
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        status: {
          type: 'string',
          description: 'pending | done | not_done. Omit for all.',
        },
      },
    },
    roles: ALL,
  },
  {
    name: 'open_snags',
    description: 'Open and in-progress snags, newest first.',
    parameters: { type: 'object', properties: { ...projectArg } },
    roles: ALL,
  },
  {
    name: 'open_rfis',
    description: 'RFIs awaiting an answer from a consultant.',
    parameters: { type: 'object', properties: { ...projectArg } },
    roles: ALL,
  },
  {
    name: 'clash_register',
    description: 'Coordination clashes, open first.',
    parameters: { type: 'object', properties: { ...projectArg } },
    roles: ALL,
  },
  {
    name: 'material_stock',
    description: 'Quantities on hand. Quantities only — never a value.',
    parameters: { type: 'object', properties: { ...projectArg } },
    roles: ALL,
  },
  {
    name: 'search_knowledge',
    description:
      "Search the firm's own Mason Learn library — method statements, " +
      'articles and uploaded documents. Use this BEFORE answering any ' +
      'construction question, so the answer reflects how this firm works.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for.' },
      },
      required: ['query'],
    },
    roles: ALL,
  },

  /* ---------------- reads: money roles only ---------------------------- */
  {
    name: 'project_spend',
    description:
      'Spend against budget for a project: total spent, total budget, ' +
      'remaining and percent used.',
    parameters: { type: 'object', properties: { ...projectArg } },
    roles: MONEY,
  },
  {
    name: 'budget_vs_actual',
    description: 'Budget against actual spend, broken down by category.',
    parameters: { type: 'object', properties: { ...projectArg } },
    roles: MONEY,
  },
  {
    name: 'pending_purchase_orders',
    description:
      'Purchase orders that are approved or receiving but not yet fully ' +
      'received.',
    parameters: { type: 'object', properties: { ...projectArg } },
    roles: MONEY,
  },
  {
    name: 'compliance_due',
    description:
      'Statutory filings overdue or due within seven days, plus bank ' +
      'guarantee and insurance expiries.',
    parameters: { type: 'object', properties: {} },
    roles: MONEY,
  },
  {
    name: 'health_signals',
    description:
      'Early-warning flags: burn rate against progress, cost and schedule ' +
      'performance, task rollover, defects accumulating.',
    parameters: { type: 'object', properties: { ...projectArg } },
    roles: MONEY,
  },

  /* ---------------- proposals: never write ----------------------------- */
  {
    name: 'propose_task',
    description:
      'Propose creating a task. This does NOT create it — the user sees the ' +
      'exact values and must confirm. Ask for anything missing first.',
    parameters: {
      type: 'object',
      properties: {
        ...projectArg,
        title: { type: 'string', description: 'What is to be done.' },
        trade: { type: 'string', description: 'mason, electrician, plumber…' },
        work_area: { type: 'string', description: 'Where.' },
        planned_date: { type: 'string', description: 'YYYY-MM-DD.' },
      },
      required: ['project', 'title'],
    },
    roles: SITE,
    proposes: true,
  },
  {
    name: 'propose_snag',
    description:
      'Propose raising a snag. Does NOT raise it — the user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        ...projectArg,
        description: { type: 'string', description: 'What is wrong.' },
        work_area: { type: 'string', description: 'Where it is.' },
        severity: { type: 'string', description: 'low | medium | high.' },
      },
      required: ['project', 'description', 'work_area'],
    },
    roles: SITE,
    proposes: true,
  },
  {
    name: 'propose_site_log_note',
    description:
      "Propose adding a note to today's site log. Appends to the user's own " +
      'log for today; does not overwrite. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        ...projectArg,
        note: { type: 'string', description: 'The note to add.' },
      },
      required: ['project', 'note'],
    },
    roles: SITE,
    proposes: true,
  },
  {
    name: 'propose_rfi',
    description:
      'Propose raising an RFI to a consultant. The user must confirm. ' +
      'Founder and PM only.',
    parameters: {
      type: 'object',
      properties: {
        ...projectArg,
        question: { type: 'string', description: 'The question to ask.' },
        addressed_to: { type: 'string', description: 'Which consultant.' },
        category: {
          type: 'string',
          description: 'design | structural | mep | finishes | other.',
        },
        required_by: { type: 'string', description: 'YYYY-MM-DD.' },
      },
      required: ['project', 'question'],
    },
    roles: ['founder', 'pm'],
    proposes: true,
  },
  {
    name: 'propose_document_draft',
    description:
      'Propose filing a short text note in the project document vault. ' +
      'Holds text only — the assistant cannot upload a file.',
    parameters: {
      type: 'object',
      properties: {
        ...projectArg,
        title: { type: 'string', description: 'Document title.' },
        folder: { type: 'string', description: 'Vault folder. Defaults to other.' },
      },
      required: ['project', 'title'],
    },
    roles: ['founder', 'pm', 'accounts'],
    proposes: true,
  },
]

export const toolsForRole = (role: Role) =>
  TOOLS.filter((t) => t.roles.includes(role))

/** Resolves a name fragment to one project the caller can actually see. */
async function resolveProject(
  db: SupabaseClient,
  name: string | undefined,
): Promise<{ id: string; name: string } | null> {
  const q = db.from('projects').select('id, name').limit(20)
  const { data } = name ? await q.ilike('name', `%${name}%`) : await q
  const rows = (data ?? []) as { id: string; name: string }[]
  return rows[0] ?? null
}

const cap = <T,>(rows: T[] | null, n = 25) => (rows ?? []).slice(0, n)

/**
 * Runs one whitelisted tool. Anything not in the switch is refused.
 *
 * Returns a plain object that goes back to the model as the function response.
 * Errors are RETURNED, not thrown: the model should be told "that is restricted
 * for your role" so it can say so, rather than the whole turn collapsing.
 */
export async function runTool(
  db: SupabaseClient,
  role: Role,
  threadId: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const def = TOOLS.find((t) => t.name === name)
  if (!def) return { error: `Unknown tool "${name}". Refused.` }

  if (!def.roles.includes(role)) {
    // The sentence the model relays. Deliberately explicit about WHY, so the
    // user is not left thinking the data does not exist.
    return {
      error:
        'restricted for your role — this information is not available to a ' +
        role +
        '. Tell the user their role does not have access to this, and suggest ' +
        'they ask a founder or the accounts team.',
    }
  }

  const p = (args.project as string | undefined) ?? undefined

  switch (name) {
    case 'list_projects': {
      const { data } = await db
        .from('projects')
        .select('id, name, client_name, status, start_date, target_end_date')
        .order('name')
      return { projects: cap(data) }
    }

    case 'tasks_for_day': {
      const proj = p ? await resolveProject(db, p) : null
      let q = db
        .from('tasks')
        .select('title, trade, work_area, status, planned_date, done_qty, qty_unit')
        .eq('planned_date', (args.date as string) ?? new Date().toISOString().slice(0, 10))
        .limit(40)
      if (proj) q = q.eq('project_id', proj.id)
      if (args.status) q = q.eq('status', args.status as string)
      const { data, error } = await q
      if (error) return { error: error.message }
      return { project: proj?.name ?? 'all visible', tasks: cap(data, 40) }
    }

    case 'open_snags': {
      const proj = p ? await resolveProject(db, p) : null
      let q = db
        .from('snags')
        .select('snag_number, work_area, description, severity, status, raised_date')
        .in('status', ['open', 'in_progress'])
        .order('raised_date', { ascending: false })
        .limit(25)
      if (proj) q = q.eq('project_id', proj.id)
      const { data, error } = await q
      if (error) return { error: error.message }
      return { project: proj?.name ?? 'all visible', snags: cap(data) }
    }

    case 'open_rfis': {
      const proj = p ? await resolveProject(db, p) : null
      let q = db
        .from('rfis')
        .select('rfi_number, question, addressed_to, status, raised_date, required_by')
        .eq('status', 'open')
        .order('raised_date', { ascending: false })
        .limit(25)
      if (proj) q = q.eq('project_id', proj.id)
      const { data, error } = await q
      if (error) return { error: error.message }
      return { project: proj?.name ?? 'all visible', rfis: cap(data) }
    }

    case 'clash_register': {
      const proj = p ? await resolveProject(db, p) : null
      let q = db
        .from('v_clashes')
        .select('clash_no, system_a, system_b, location, severity, status, open_days, rfi_number')
        .order('status')
        .limit(25)
      if (proj) q = q.eq('project_id', proj.id)
      const { data, error } = await q
      if (error) return { error: error.message }
      return { project: proj?.name ?? 'all visible', clashes: cap(data) }
    }

    case 'material_stock': {
      const proj = p ? await resolveProject(db, p) : null
      let q = db
        .from('v_stock')
        .select('name, unit, in_stock, low_stock')
        .order('name')
        .limit(40)
      if (proj) q = q.eq('project_id', proj.id)
      const { data, error } = await q
      if (error) return { error: error.message }
      return {
        note: 'Quantities only. This app does not value stock.',
        stock: cap(data, 40),
      }
    }

    case 'search_knowledge': {
      const { data, error } = await db.rpc('fn_learn_retrieve', {
        p_q: (args.query as string) ?? '',
        p_limit: 8,
      })
      if (error) return { error: error.message }
      return { passages: cap(data, 8) }
    }

    case 'project_spend': {
      const proj = p ? await resolveProject(db, p) : null
      let q = db
        .from('v_project_spend')
        .select('name, total_spent, total_budget, remaining, pct_used')
        .limit(10)
      if (proj) q = q.eq('project_id', proj.id)
      const { data, error } = await q
      if (error) return { error: error.message }
      return { spend: cap(data, 10), currency: 'INR' }
    }

    case 'budget_vs_actual': {
      const proj = p ? await resolveProject(db, p) : null
      if (!proj) return { error: 'Name a project for this one.' }
      const { data, error } = await db
        .from('v_budget_vs_actual')
        .select('category, budget, actual, remaining')
        .eq('project_id', proj.id)
        .limit(40)
      if (error) return { error: error.message }
      return { project: proj.name, lines: cap(data, 40), currency: 'INR' }
    }

    case 'pending_purchase_orders': {
      const proj = p ? await resolveProject(db, p) : null
      let q = db
        .from('purchase_orders')
        .select('po_number, status, expected_date, created_at')
        .in('status', ['approved', 'receiving'])
        .order('created_at', { ascending: false })
        .limit(25)
      if (proj) q = q.eq('project_id', proj.id)
      const { data, error } = await q
      if (error) return { error: error.message }
      return { project: proj?.name ?? 'all visible', orders: cap(data) }
    }

    case 'compliance_due': {
      const [c, g, i] = await Promise.all([
        db.rpc('fn_compliance_alert'),
        db.rpc('fn_bg_alert'),
        db.rpc('fn_insurance_alert'),
      ])
      return {
        compliance: c.data ?? null,
        bank_guarantees: g.data ?? null,
        insurance: i.data ?? null,
      }
    }

    case 'health_signals': {
      const proj = p ? await resolveProject(db, p) : null
      const { data, error } = await db.rpc('fn_project_health_flags', {
        p_project: proj?.id ?? null,
      })
      if (error) return { error: error.message }
      return {
        note:
          'Early signals, not forecasts. Each carries the number it was ' +
          'computed from and whether it was measured once or trended.',
        signals: cap(data, 15),
      }
    }

    /* ------------------- proposals ------------------- */
    case 'propose_task':
    case 'propose_snag':
    case 'propose_site_log_note':
    case 'propose_rfi':
    case 'propose_document_draft': {
      const proj = await resolveProject(db, p)
      if (!proj) {
        return {
          error:
            'Could not find that project among the ones you can see. Ask the ' +
            'user which project they mean.',
        }
      }

      const kind = name.replace('propose_', '')
      const payload = { ...args }
      delete (payload as Record<string, unknown>).project

      const { data, error } = await db.rpc('fn_assistant_propose', {
        p_thread: threadId,
        p_kind: kind,
        p_project: proj.id,
        p_payload: payload,
      })
      if (error) return { error: error.message }

      // The model is told this is PENDING. It must not tell the user the record
      // exists — it does not, and will not until they tap Confirm.
      return {
        proposed: true,
        action_id: data,
        kind,
        project: proj.name,
        values: payload,
        note:
          'NOTHING HAS BEEN CREATED YET. A confirmation card is now on screen. ' +
          'Tell the user to check the values and tap Confirm. Do not claim the ' +
          'record exists.',
      }
    }

    default:
      return { error: `Tool "${name}" has no implementation. Refused.` }
  }
}
