# Client security test

**Migration 065.** Proves a client sees only their own project's curated data, and nothing of your
margin, fee, other clients, or the internal app.

Every check below is a **database** query. None of it goes through the UI, because the UI is not the
protection — if these pass, no screen you build later can leak, and if they fail, no screen can save
you.

---

## 0 · Setup — create a test client

Run in the **Supabase SQL editor** as `postgres`.

**1.** Create the auth user. Supabase Dashboard → **Authentication → Users → Add user**.
Email `testclient@yourmasons.test`, set a password, confirm it.

**2.** Make them a client and link them to ONE project:

```sql
-- Replace both uuids.
--   <USER_ID>    : the id from Authentication → Users
--   <PROJECT_ID> : select id, name from public.projects;

update public.profiles set role = 'client' where id = '<USER_ID>';

insert into public.client_projects (user_id, project_id, granted_by)
values ('<USER_ID>', '<PROJECT_ID>', (select id from public.profiles where role = 'founder' limit 1));
```

**3.** Give them something to see, so an empty result can't be mistaken for a pass:

```sql
-- Share exactly one document.
update public.documents set client_visible = true
where id = (select id from public.documents
            where project_id = '<PROJECT_ID>' and not is_confidential limit 1);

-- Publish one photo.
insert into public.client_photos (project_id, photo_path, caption)
select s.project_id, s.photos[1], 'Progress this week'
from public.site_logs s
where s.project_id = '<PROJECT_ID>' and cardinality(s.photos) > 0
limit 1
on conflict (photo_path) do nothing;
```

> **If §2 returns nothing for everything, the test is worthless** — you can't tell a working gate
> from an empty database. Step 3 exists so at least one curated view has data in it.

---

## 1 · The database-side proof (SQL editor)

This impersonates the client **inside Postgres**, which is stricter than logging in — it bypasses
every layer of the app.

```sql
-- Impersonate the client. Everything below runs as they would.
set local role authenticated;
set local request.jwt.claims = '{"sub":"<USER_ID>","role":"authenticated"}';
```

> On Supabase, `auth.uid()` reads `request.jwt.claims->>'sub'`. If the block below errors, run
> §2 (the browser console version) instead — it is the same test through a real session.

### 1a · Identity

```sql
select public.my_role()::text        as role,          -- expect: client
       public.is_client()            as is_client,     -- expect: t
       public.is_internal()          as is_internal,   -- expect: f
       public.fn_client_project()    as my_project;    -- expect: <PROJECT_ID>
```

### 1b · Every internal money surface must be **0**

```sql
select 'expenses'           as surface, count(*) from public.expenses
union all select 'budgets',             count(*) from public.budgets
union all select 'purchase_orders',     count(*) from public.purchase_orders
union all select 'po_lines',            count(*) from public.po_lines
union all select 'variation_orders',    count(*) from public.variation_orders
union all select 'invoices (raw)',      count(*) from public.invoices
union all select 'ra_bills',            count(*) from public.ra_bills
union all select 'retention_releases',  count(*) from public.retention_releases
union all select 'bank_guarantees',     count(*) from public.bank_guarantees
union all select 'insurance_policies',  count(*) from public.insurance_policies
union all select 'company_expenses',    count(*) from public.company_expenses
union all select 'vendors',             count(*) from public.vendors
union all select 'labour_rates',        count(*) from public.labour_rates
union all select 'rate_comparisons',    count(*) from public.rate_comparisons
union all select 'audit_log',           count(*) from public.audit_log
union all select 'v_project_pnl',       count(*) from public.v_project_pnl
union all select 'v_project_spend',     count(*) from public.v_project_spend
union all select 'v_budget_vs_actual',  count(*) from public.v_budget_vs_actual
union all select 'v_portfolio_summary', count(*) from public.v_portfolio_summary
order by 1;
```

**Every row must read 0.** Any non-zero is a leak — stop and report it.

### 1c · Company-wide data must be **0**

These were `using (true)` before 065 and would have been fully visible.

```sql
select 'project_members'    as surface, count(*) from public.project_members
union all select 'projects (raw)',      count(*) from public.projects
union all select 'materials',           count(*) from public.materials
union all select 'expense_categories',  count(*) from public.expense_categories
union all select 'labour_contractors',  count(*) from public.labour_contractors
union all select 'labour_workers',      count(*) from public.labour_workers
union all select 'learn_articles',      count(*) from public.learn_articles
union all select 'learn_categories',    count(*) from public.learn_categories
union all select 'chat_threads',        count(*) from public.chat_threads
order by 1;
```

**All 0.** `project_members` matters most — it maps every project in the company and would hand a
client the project ids of your other clients.

### 1d · Project data must be **0** (they reach it only through the curated views)

```sql
select 'schedule_activities' as surface, count(*) from public.schedule_activities
union all select 'tasks',               count(*) from public.tasks
union all select 'site_logs',           count(*) from public.site_logs
union all select 'documents (raw)',     count(*) from public.documents
union all select 'snags',               count(*) from public.snags
union all select 'rfis',                count(*) from public.rfis
union all select 'clashes',             count(*) from public.clashes
union all select 'drawings',            count(*) from public.drawings
order by 1;
```

**All 0.**

### 1e · `profiles` — exactly **one** row, their own

```sql
select count(*) as rows_visible from public.profiles;   -- expect exactly 1
select full_name, role::text from public.profiles;      -- expect only the client
```

If this shows your staff, the `profiles_read` policy did not update.

### 1f · The management fee must be unreachable **by every route**

```sql
-- Direct: must error with "permission denied for column"
select management_fee_pct from public.projects;

-- Through the curated view: the column must not exist at all
select * from public.v_client_project;

-- Through invoices: a management_fee invoice must NOT appear
select invoice_number, total from public.v_client_invoices;
```

Cross-check against the truth (run this as **yourself**, in a separate window):

```sql
select invoice_number, inv_type::text, total from public.invoices
where project_id = '<PROJECT_ID>' order by invoice_number;
```

**Every `management_fee` and `vendor_voucher` invoice in that list must be absent from §1f.**

### 1g · The curated layer — should return **their** data

```sql
select * from public.v_client_project;             -- 1 row, their project
select * from public.v_client_progress_summary;    -- 1 row, a percentage
select count(*) from public.v_client_progress;     -- activities, no budget column
select * from public.v_client_spend_by_category;   -- categories + amounts
select * from public.v_client_spend_summary;       -- contract, spent, %
select * from public.v_client_documents;           -- ONLY the one you shared
select * from public.v_client_photos;              -- ONLY the one you published
select * from public.v_client_invoices;            -- progress bills only
select * from public.v_client_approvals;
select * from public.v_client_messages;
```

Confirm by eye:
- `v_client_progress` has **no** `budget_amount`, `cpi`, `spi` or cost column.
- `v_client_documents` shows only what you flagged in step 3 — **not** the confidential one.
- `v_client_project` has **no** `management_fee_pct`.

### 1h · Cross-client isolation

Create a **second** client on a **different** project (repeat §0), then, as client two:

```sql
select name from public.v_client_project;          -- their project ONLY
select count(*) from public.v_client_documents;    -- 0 of client one's documents
select count(*) from public.v_client_photos;       -- 0
select count(*) from public.v_client_invoices;     -- 0 of client one's invoices
```

### 1i · The defence-in-depth test — **do not skip this**

This is the one that matters in three years, when somebody adds a client to a project by mistake.
The §2 script cannot do this one: it needs the founder to create the bad state first.

**Step 1 — as `postgres` in the SQL editor, deliberately make the mistake.** No placeholders to
fill in; it finds both ids itself. (`profiles` has NO email column — `id, full_name, phone, role,
is_active`. The email lives in `auth.users`.)

```sql
insert into public.project_members (project_id, user_id)
select cp.project_id, cp.user_id
from public.client_projects cp
join auth.users u on u.id = cp.user_id
where u.email = 'testclient@yourmasons.test'
on conflict do nothing;
```

**Step 2 — re-run the §2 console script** in the client's browser tab. **Every count must still be
0.** `is_member()` returns false for a client *before* it consults `project_members` at all, so the
bad row must change nothing.

**Step 3 — remove the bad row.**

```sql
delete from public.project_members pm
using public.client_projects cp, auth.users u
where pm.project_id = cp.project_id
  and pm.user_id   = cp.user_id
  and u.id = cp.user_id
  and u.email = 'testclient@yourmasons.test';
```

If any count came back non-zero, the hardened `is_member()` did not apply — stop and report it. That
single function is what stands between a client and thirty internal tables.

---

## 2 · The fast way — one paste, automated

**Use this.** It runs everything in §1b–§1g plus the write refusals, and prints a PASS/FAIL table.

1. Start the dev server: `npm run dev` (the console helper is stripped from production builds, on
   purpose — there is no `window.supabase` on the deployed app).
2. Open **localhost** in an **incognito** window and sign in as the test client.
3. **F12 → Console.**
4. Open `client-security-test.js`, select all, copy, paste into the console, press Enter.

It reads only. It writes nothing and changes nothing.

You will get a table and one of two verdicts:

- **`✓ ALL n CHECKS PASSED — no leak found.`**
- **`✗ n FAILURE(S)`** with the offending rows listed. Send me those rows.

Then do **§1i by hand** — it is the only check the script cannot perform, because it needs a founder
to deliberately create the bad state first.

---

## 2b · The manual browser version (same tests, one at a time)

Sign in as the test client in an incognito window. **F12 → Console.** Run each line.

```js
// Curated layer — should return DATA
(await window.supabase.from('v_client_project').select('*')).data
(await window.supabase.from('v_client_spend_summary').select('*')).data
(await window.supabase.from('v_client_documents').select('*')).data
(await window.supabase.from('v_client_invoices').select('*')).data

// Internal tables — every one must be []
(await window.supabase.from('expenses').select('*').limit(5)).data
(await window.supabase.from('budgets').select('*').limit(5)).data
(await window.supabase.from('purchase_orders').select('*').limit(5)).data
(await window.supabase.from('invoices').select('*').limit(5)).data
(await window.supabase.from('variation_orders').select('*').limit(5)).data
(await window.supabase.from('ra_bills').select('*').limit(5)).data
(await window.supabase.from('company_expenses').select('*').limit(5)).data
(await window.supabase.from('vendors').select('*').limit(5)).data
(await window.supabase.from('labour_rates').select('*').limit(5)).data
(await window.supabase.from('project_members').select('*').limit(5)).data
(await window.supabase.from('projects').select('*').limit(5)).data
(await window.supabase.from('tasks').select('*').limit(5)).data
(await window.supabase.from('documents').select('*').limit(5)).data
(await window.supabase.from('schedule_activities').select('*').limit(5)).data
(await window.supabase.from('audit_log').select('*').limit(5)).data

// Views — must be []
(await window.supabase.from('v_project_pnl').select('*')).data
(await window.supabase.from('v_project_spend').select('*')).data
(await window.supabase.from('v_portfolio_summary').select('*')).data

// The fee — must be a permission ERROR, not a value
(await window.supabase.from('projects').select('id, management_fee_pct'))

// The internal assistant — must refuse
(await window.supabase.rpc('fn_assistant_quota', { p_limit: 60 }))
(await window.supabase.rpc('fn_company_pnl'))
(await window.supabase.rpc('fn_project_health_flags', { p_project: null })).data
```

**Reading the results**

| Result | Meaning |
|---|---|
| `[]` | Correct — RLS refused. |
| `{ error: { message: "permission denied for column …" } }` | Correct for the fee check. |
| Any array with rows in it | **Leak.** Report the exact line. |
| Any object containing a rupee figure you did not intend | **Leak.** |

---

## 3 · What a client is allowed to write

Only two things. Confirm both work, and that nothing else does.

```js
// Send a message — should succeed
(await window.supabase.from('client_messages')
   .insert({ project_id: '<PROJECT_ID>', body: 'Test from the client' }))

// The from_client flag must be TRUE even though we did not send it
(await window.supabase.from('v_client_messages').select('*')).data

// Decide an approval — should succeed on a pending item on THEIR project
(await window.supabase.rpc('fn_client_decide',
   { p_id: '<APPROVAL_ID>', p_decision: 'approved' }))

// --- these must all FAIL ---
(await window.supabase.from('expenses').insert({ amount: 1 }))
(await window.supabase.from('tasks').insert({ title: 'x' }))
(await window.supabase.from('client_photos').insert({ project_id: '<PROJECT_ID>', photo_path: 'x' }))
(await window.supabase.from('documents').update({ client_visible: true }).neq('id', null))
(await window.supabase.from('client_projects').update({ project_id: '<OTHER_PROJECT_ID>' }).neq('id', null))
```

The last one matters: a client must not be able to re-point themselves at another project.

---

## 4 · Report template

```
CHECK:     §1b expenses
EXPECTED:  0
SAW:       0
```

One line per section is enough if it passed: `§1b — all 19 surfaces 0.`

For anything that failed, give me the **exact query** and the **exact output**.

---

## 5 · Known and intended — do not report these

- **`profiles` returns 1 row.** Their own, so the portal can show their name.
- **`client_projects` returns 1 row.** Their own link.
- **`contract_value` is visible** in `v_client_project` and `v_client_spend_summary`. It is their own
  contract. See the note below.
- **The curated views return nothing when YOU query them.** `fn_client_project()` is null for
  internal staff, so `v_client_*` is empty for a founder. That is the gate working, not a fault.

---

## 6 · The commercial decision this test cannot make for you

`v_client_spend_summary` returns **contract value** and **total spent** together. A client with a
calculator can subtract one from the other and arrive at your gross position on their job.

That is what open book means — you are showing them cost on purpose. The management fee percentage
is never exposed, and neither is margin as a figure. But the subtraction is available to anyone who
thinks of it.

**If that is not acceptable**, the fix is one line: drop `contract_value` from `v_client_project` and
`v_client_spend_summary`, and show spend against a separate client-facing budget instead. Nothing
else in migration 065 depends on it.

This is a commercial choice, not a security bug, which is why it is at the end of a security test
rather than being quietly decided in a migration.
