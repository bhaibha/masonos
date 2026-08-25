# Cost reconciliation checklist — one project, every surface

**Mason OS, migrations 001–060.** Derived by reading the actual view and function bodies, not the
spec.

---

## Read this first — two of the four premises do not hold

Before you run anything, three figures **are not supposed to match**, and one flow **does not
exist**. If you go looking for agreement here you will find a bug that isn't one, and miss the ones
that are.

### ✗ B4 steel cost does NOT flow into P&L or EVM — there is no such flow

The bar bending schedule **carries no rates at all**. Migration 051 says so explicitly:

> *"it carries no rates, so there is nothing here to hide"*

BBS produces cutting lengths, unit weights, tonnage and pieces required. It has no money column
anywhere, deliberately — which is also why supervisors can use it freely.

Steel **cost** reaches the P&L the same way every other material does: a purchase order → GRN →
vendor invoice → expense, or a directly entered expense. Nothing links that expense back to the BBS.

**So the B4 reconciliation is a QUANTITY check, not a cost check** — §6 below. Asking "does steel
cost flow into EVM" has no answer because the two systems share no money column.

### ✗ B5 labour does NOT flow into P&L automatically — it must be posted

Attendance × rate is an **accrual**: what the labour on site is *worth*. `v_project_pnl` computes
cost from expenses and certified RA bills: what has been *committed*. Migration 054 refuses to add
the accrual on top, because that would count every rupee of labour twice and get the largest line on
most jobs wrong.

Labour reaches the P&L only when somebody runs **`fn_post_labour_expense`** for a period, which
writes ordinary `expenses` rows — **one per activity**, so they land in EVM's actual cost too. The
function refuses an overlapping period, so there is exactly one source of truth.

**So the B5 check is two-stage** — §5: attendance is invisible to P&L before posting, and fully
visible after.

### ≠ Dashboard "spent" ≠ P&L "total cost"

- `v_project_spend.total_spent` = **expenses only**
- `v_project_pnl.total_cost` = **expenses + certified RA bills** (`net_certified + retention_amount`)

They agree only on a project with no certified RA bills. The difference is exactly `contractor_cost`.

### ≠ EVM actual cost ≠ P&L total cost

`fn_activity_evm` computes AC from the same two sources with the same definitions, but adds two
filters:

1. **`activity_id is not null`** — anything not tagged to a schedule activity is excluded entirely
2. **dated on or before the data date** — P&L is lifetime

So: **EVM AC = P&L total_cost − untagged cost − cost after the data date.** Both gaps are legitimate;
§4 measures them so you know which is which.

### ≠ Company net position = lifetime margin − period overheads

`fn_company_net` subtracts overheads **for the chosen period** from project margin that is **lifetime
to date**. Two different time windows in one figure, deliberately, and the card says so. It only
reduces to a clean subtraction when the period covers all history.

---

## 0 · Setup

1. Sign in as **founder** (not incognito — you need every figure visible).
2. Pick **one project with real data**: some expenses, ideally at least one certified RA bill, a
   schedule with activities, and some labour attendance. Note its name.
3. Get its id — Supabase SQL editor:
   ```sql
   select id, name from public.projects order by name;
   ```
   Call it `:pid`. Substitute it into every query below.
4. Keep the SQL editor open in one tab and the app in another.

> **Why the SQL editor is the referee.** The editor connects as `postgres`, so `auth.uid()` is null
> and every RLS-gated view returns zero rows — that is the gate working, not missing data (the 038
> lesson). Every query below therefore reads **base tables**, which do work as `postgres`, and
> recomputes each figure independently. If a screen and a base-table query disagree, the screen is
> wrong.

---

## 1 · The baseline — compute every figure from base tables

Run this once. Everything else compares against it.

```sql
with p as (select 'PASTE-PROJECT-UUID-HERE'::uuid as pid),

-- A. Live expenses (voids excluded)
exp as (
  select coalesce(sum(e.amount + e.gst_amount), 0)::numeric(14,2) as amt,
         count(*) as n
  from public.expenses e, p
  where e.project_id = p.pid and e.voided_at is null
),
-- B. Certified contractor bills, retention included (owed either way)
ra as (
  select coalesce(sum(b.net_certified + b.retention_amount), 0)::numeric(14,2) as amt,
         coalesce(sum(b.retention_amount), 0)::numeric(14,2) as retention,
         count(*) as n
  from public.ra_bills b, p
  where b.project_id = p.pid and b.status::text = 'certified'
),
-- C. Expenses NOT tagged to a schedule activity — the EVM blind spot
untagged as (
  select coalesce(sum(e.amount + e.gst_amount), 0)::numeric(14,2) as amt,
         count(*) as n
  from public.expenses e, p
  where e.project_id = p.pid and e.voided_at is null and e.activity_id is null
),
-- D. Certified bills not tagged to an activity
untagged_ra as (
  select coalesce(sum(b.net_certified + b.retention_amount), 0)::numeric(14,2) as amt
  from public.ra_bills b, p
  where b.project_id = p.pid and b.status::text = 'certified' and b.activity_id is null
),
-- E. Voided expenses — must appear NOWHERE
voided as (
  select coalesce(sum(e.amount + e.gst_amount), 0)::numeric(14,2) as amt,
         count(*) as n
  from public.expenses e, p
  where e.project_id = p.pid and e.voided_at is not null
),
-- F. Budget
bud as (
  select coalesce(sum(b.amount), 0)::numeric(14,2) as amt
  from public.budgets b, p where b.project_id = p.pid
),
-- G. Revenue = contract + approved variations
rev as (
  select (coalesce(pr.contract_value, 0)
          + coalesce((select sum(v.cost_impact) from public.variation_orders v
                      where v.project_id = p.pid
                        and v.status::text = 'approved'), 0))::numeric(14,2) as amt
  from public.projects pr, p where pr.id = p.pid
)
select
  exp.amt                              as "A expenses (live)",
  exp.n                                as "  expense rows",
  ra.amt                               as "B certified RA bills",
  (exp.amt + ra.amt)                   as "A+B = TOTAL COST (P&L)",
  exp.amt                              as "= dashboard/detail SPENT",
  untagged.amt + untagged_ra.amt       as "C untagged (EVM cannot see)",
  (exp.amt + ra.amt) - untagged.amt - untagged_ra.amt
                                       as "EVM AC ceiling (at today)",
  voided.amt                           as "E VOIDED (must appear nowhere)",
  voided.n                             as "  voided rows",
  bud.amt                              as "F budget",
  rev.amt                              as "G revenue",
  (rev.amt - exp.amt - ra.amt)         as "GROSS MARGIN",
  ra.retention                         as "retention held (memo, NOT deducted)"
from exp, ra, untagged, untagged_ra, voided, bud, rev;
```

Write the numbers down. Call them **A**, **B**, **A+B**, **C**, **E**, **F**, **G**.

---

## 2 · The five surfaces — do they agree?

| # | Screen | Figure | Must equal | Note |
|---|---|---|---|---|
| 2.1 | **Money → Ledger** | Sum of the expense list / `fn_expense_total` for all dates | **A** | Ledger is expenses only |
| 2.2 | **Dashboard** → project card | "Spent" | **A** | `v_project_spend`, expenses only |
| 2.3 | **Dashboard** → portfolio | Total spent | **Σ A across projects** | `v_portfolio_summary` sums the same view |
| 2.4 | **Project detail** | "Spent" / budget bar numerator | **A** | Same view as 2.2 |
| 2.5 | **Project detail** | Budget | **F** | |
| 2.6 | **Project detail** | Remaining | **F − A** | |
| 2.7 | **Money → Budget** | Actual column total | **A** | `v_budget_vs_actual`, expenses only |
| 2.8 | **Money → P&L** | Total cost | **A + B** | ⚠ **larger than 2.2/2.4 by B** |
| 2.9 | **Money → P&L** | Revenue | **G** | |
| 2.10 | **Money → P&L** | Gross margin | **G − A − B** | |
| 2.11 | **Money → P&L** | Retention held | **memo only** — confirm it is NOT subtracted from margin | 038 |
| 2.12 | **Tasks → Schedule** → EVM card | AC | **≤ (A+B) − C** | see §4 |
| 2.13 | **Money → MIS** | Cost per project | **A + B** | MIS is `security_invoker` on `v_project_pnl` |
| 2.14 | **Money → MIS** | Company total | **= sum of the rows in its own table** | 056: the headline comes from the same call as the rows |

**Record any line where the screen differs from the computed value by even one rupee.**

> **2.2 vs 2.8 will differ whenever B > 0. That is correct.** Report it only if
> `2.8 − 2.2 ≠ B`.

---

## 3 · Void test — the strict one

Voiding must remove a figure from **every** surface simultaneously. There is no client-side filter
anywhere; every exclusion is in the view or the RPC.

1. Pick a live expense on the project with a **memorable amount**. Note it as **V**.
   ```sql
   select id, expense_date, description, amount + gst_amount as total
   from public.expenses
   where project_id = 'PASTE-UUID' and voided_at is null
   order by amount desc limit 5;
   ```
2. Record every "before" figure from §2 (2.1, 2.2, 2.4, 2.7, 2.8, 2.10, 2.12, 2.13).
3. In the app: **Money → Ledger** → open that expense → **Void**, with a reason.
   *(Voiding is founder/accounts. The reason is a CHECK constraint, not a form rule.)*
4. Re-check every figure.

| # | Surface | Expected after void |
|---|---|---|
| 3.1 | Ledger total | **A − V** |
| 3.2 | The row itself | Still listed, marked **VOID**, with the reason |
| 3.3 | Dashboard project card spent | **A − V** |
| 3.4 | Dashboard portfolio total | dropped by **V** |
| 3.5 | Project detail spent | **A − V** |
| 3.6 | Project detail remaining | **increased by V** |
| 3.7 | Budget vs actual — that category | **decreased by V** |
| 3.8 | P&L total cost | **A + B − V** |
| 3.9 | P&L gross margin | **increased by V** |
| 3.10 | EVM AC (if that expense was activity-tagged) | **decreased by V** |
| 3.11 | EVM CPI | **increased** (EV unchanged, AC smaller) |
| 3.12 | MIS cost for this project | **A + B − V** |
| 3.13 | Company P&L total cost | **decreased by V** |
| 3.14 | Audit log | a VOID entry naming the row and the reason |

Re-run the §1 query. **E must now include V** and **A must have dropped by exactly V.**

**Any surface that still counts V is a client-side filter that shouldn't exist — report it with the
screen name.**

### 3b · Void cascades

| # | Action | Expected |
|---|---|---|
| 3.15 | Void a **petty cash** entry | The mirrored expense (`pc_entry_id`) reverses too — ledger and P&L both drop |
| 3.16 | Void a **vendor invoice** | The expense it posted (`po_invoices.expense_id`) reverses — P&L drops |
| 3.17 | Void a **GRN** | The `material_inward` rows it created reverse — **stock** drops, P&L unchanged (a GRN is not cost) |
| 3.18 | Void a GRN that would push stock below zero | **Refused** |
| 3.19 | Void an invoice that is stranded | **Refused** |

---

## 4 · EVM actual cost — measure the gap, don't assume it

```sql
-- What EVM can see vs what the P&L counts
with p as (select 'PASTE-UUID'::uuid as pid)
select
  (select coalesce(sum(amount + gst_amount),0) from public.expenses e, p
    where e.project_id=p.pid and e.voided_at is null)                as pnl_expenses,
  (select coalesce(sum(amount + gst_amount),0) from public.expenses e, p
    where e.project_id=p.pid and e.voided_at is null
      and e.activity_id is not null)                                 as evm_visible_expenses,
  (select count(*) from public.expenses e, p
    where e.project_id=p.pid and e.voided_at is null
      and e.activity_id is null)                                     as untagged_expense_rows,
  (select coalesce(sum(net_certified + retention_amount),0)
     from public.ra_bills b, p
    where b.project_id=p.pid and b.status::text='certified')         as pnl_bills,
  (select coalesce(sum(net_certified + retention_amount),0)
     from public.ra_bills b, p
    where b.project_id=p.pid and b.status::text='certified'
      and b.activity_id is not null)                                 as evm_visible_bills;
```

| # | Check | Expected |
|---|---|---|
| 4.1 | EVM card AC (data date = today) | `evm_visible_expenses + evm_visible_bills` |
| 4.2 | `untagged_expense_rows` | **Note the number.** Every one is invisible to earned value |
| 4.3 | Set the EVM data date to an **earlier** date | AC **drops** — only costs dated on or before it count |
| 4.4 | Set the data date to **today** | AC returns to 4.1 |
| 4.5 | Tag an untagged expense to an activity (**Money → Ledger → retag**, `fn_retag_expense`) | AC **rises by that amount**; P&L total cost **unchanged** |
| 4.6 | BAC total on the EVM card | equals Σ `schedule_activities.budget_amount` — **note: this is the schedule budget, not `budgets`** (§7.3) |

> **4.2 is the number that matters.** If `untagged_expense_rows` is large, CPI is being computed
> against a fraction of the real spend and is flattering. That is a data-entry gap, not a code bug —
> but it makes every EVM index on the screen misleading, and it is worth reporting the count.

---

## 5 · Labour (B5) — the two-stage check

### Stage 1: attendance only, nothing posted

```sql
-- accrual (what labour is worth) — must NOT be in the P&L
select * from public.fn_labour_reconcile('PASTE-UUID', 'YYYY-MM-01', 'YYYY-MM-30');
```

| # | Check | Expected |
|---|---|---|
| 5.1 | **Money → Labour** shows an attendance-based cost | **Yes** — this is the accrual |
| 5.2 | P&L total cost | **Does NOT include it** |
| 5.3 | EVM AC | **Does NOT include it** |
| 5.4 | `fn_labour_reconcile` | Shows **both** figures side by side plus the variance |
| 5.5 | Dashboard / project detail spent | Unchanged by attendance |

**5.2 and 5.3 showing the accrual would be the double-count bug 054 exists to prevent. Report
immediately if so.**

### Stage 2: post the period

In the app: **Money → Labour → post the period to expenses** (`fn_post_labour_expense`).

| # | Check | Expected |
|---|---|---|
| 5.6 | Ledger | **One new expense per activity**, not one lump |
| 5.7 | Each posted expense | carries an `activity_id` |
| 5.8 | P&L total cost | **increased by the posted total** |
| 5.9 | EVM AC | **increased by the same amount** (they are activity-tagged) |
| 5.10 | Dashboard / project detail spent | increased by the same amount |
| 5.11 | Post the **same period again** | **Refused** — overlapping periods are blocked |
| 5.12 | `labour_postings` | one row recording the period, total and expense count |
| 5.13 | Re-run `fn_labour_reconcile` | accrual and posted cost now agree (variance ≈ 0) |
| 5.14 | Void one posted expense | P&L and EVM both drop; the `labour_postings` row still records the original |

---

## 6 · Steel (B4) — a quantity reconciliation, not a cost one

There is no cost link. What you can reconcile is **tonnage scheduled vs tonnage received**.

```sql
-- Steel the BBS says the job needs
select * from public.v_bbs_project_steel where project_id = 'PASTE-UUID';

-- Steel actually received (adjust the material name match to yours)
select m.name, sum(mi.qty) as qty_received, m.unit
from public.material_inward mi
join public.materials m on m.id = mi.material_id
where mi.project_id = 'PASTE-UUID'
  and mi.voided_at is null
  and (m.name ilike '%steel%' or m.name ilike '%tmt%' or m.name ilike '%bar%')
group by m.name, m.unit;
```

| # | Check | Expected |
|---|---|---|
| 6.1 | BBS total tonnage per diameter | matches the printed schedule |
| 6.2 | `pieces_required` | consistent with `stock_length_m` |
| 6.3 | Tonnage received vs BBS tonnage | Received should exceed scheduled by a wastage allowance. **A large shortfall means the BBS is incomplete, not that stock is wrong** |
| 6.4 | Any rupee figure anywhere in the BBS module | **None.** If one appears, that is a new leak — report it |
| 6.5 | `fn_bbs_selftest()` | **8/8 passing at 0.00 mm** |
| 6.6 | Steel **cost** in the P&L | arrives as ordinary expenses / PO invoices — **verify it is counted once**, not once as an expense and again as a GRN |

---

## 7 · Company P&L = Σ project margins − overheads

```sql
-- Σ of every project's margin, computed from base tables
with per_project as (
  select pr.id, pr.name,
    (coalesce(pr.contract_value,0)
      + coalesce((select sum(v.cost_impact) from public.variation_orders v
                  where v.project_id = pr.id and v.status::text='approved'),0)
      - coalesce((select sum(e.amount + e.gst_amount) from public.expenses e
                  where e.project_id = pr.id and e.voided_at is null),0)
      - coalesce((select sum(b.net_certified + b.retention_amount) from public.ra_bills b
                  where b.project_id = pr.id and b.status::text='certified'),0)
    )::numeric(14,2) as margin
  from public.projects pr
)
select
  (select sum(margin) from per_project)                as sum_project_margins,
  (select coalesce(sum(amount + gst_amount),0)
     from public.company_expenses
    where voided_at is null
      and spend_date between '2026-04-01' and '2026-08-21')  as overheads_in_period,
  (select sum(margin) from per_project)
    - (select coalesce(sum(amount + gst_amount),0)
         from public.company_expenses
        where voided_at is null
          and spend_date between '2026-04-01' and '2026-08-21') as net_position;
```

| # | Check | Expected |
|---|---|---|
| 7.1 | **Money → P&L** company total margin | = `sum_project_margins` — `fn_company_pnl` sums `v_project_pnl`, so this must match **exactly** |
| 7.2 | Sum the per-project margin rows on screen by hand | = the company headline. **A headline that disagrees with the list under it is the fastest way to lose a reader** |
| 7.3 | **Overheads** total for the chosen period | = `overheads_in_period` |
| 7.4 | **Net position** card | = `net_position` |
| 7.5 | The card's wording | Must say **"Net position"**, state that it is margin lifetime-to-date less overheads for the chosen period, and say in words that it is **not cash** |
| 7.6 | Change the overhead period | Overheads and net position change; **project margin does not** — it is lifetime by design |
| 7.7 | Void a company expense | Overheads drop, net position rises |
| 7.8 | A project with revenue and no cost | Counted as **"not started"**, not as profitable |

> **7.6 is the deliberate asymmetry.** Two different time windows in one figure. Report it only if
> the card fails to label both spans.

---

## 8 · Double-count traps — check each one is counted exactly ONCE

| # | Path | Must appear in cost | Must NOT also appear as |
|---|---|---|---|
| 8.1 | Petty cash spend | once, via the mirrored expense | a second standalone expense |
| 8.2 | Vendor invoice posted against a PO | once, via `po_invoices.expense_id` → expense | the PO's ordered value |
| 8.3 | Committed (approved PO, not yet invoiced) | **NOT in total_cost** — it is a separate `committed_open` column | part of cost |
| 8.4 | Certified RA bill | once, as `net_certified + retention_amount` | plus a separate retention deduction |
| 8.5 | Retention held | **memo only** | a deduction from margin (038) |
| 8.6 | Labour attendance | only after posting | both as accrual and as posted expense |
| 8.7 | Material inward from a GRN | **stock only** | a cost line (cost comes from the invoice) |
| 8.8 | Approved variation | in **revenue** | also in cost |

```sql
-- 8.1 — petty cash mirrored exactly once
select count(*) as pc_entries, count(distinct e.id) as mirrored_expenses
from public.petty_cash_entries pc
left join public.expenses e on e.pc_entry_id = pc.id
where pc.voided_at is null;

-- 8.2 — every posted invoice has exactly one expense
select i.id, count(e.id) as expense_rows
from public.po_invoices i
left join public.expenses e on e.id = i.expense_id
where i.voided_at is null
group by i.id having count(e.id) <> 1;   -- expect ZERO rows
```

---

## 9 · Figures that will not reconcile — my list, before you start

State these as known when you report, so we can tell them apart from real breaks.

| Figure A | Figure B | Difference | Why | By design? |
|---|---|---|---|---|
| Dashboard/detail **Spent** | P&L **Total cost** | certified RA bills | different scope: ledger vs full cost | **Yes** |
| Budget-vs-actual **Actual** | P&L **Total cost** | certified RA bills | same reason | **Yes** |
| EVM **AC** | P&L **Total cost** | untagged cost + cost after data date | EVM needs an `activity_id` and a cut-off | **Yes** |
| EVM **BAC** | Project **budget** | different tables entirely | `schedule_activities.budget_amount` vs `budgets` | **Yes — and worth a look.** Nothing forces these to agree, and nothing on screen compares them |
| Company **net position** | Σ margins − overheads | period mismatch | lifetime margin, period overheads | **Yes**, if labelled |
| **Margin** | revenue − cost + retention | retention | retention is already inside cost | **Yes** |
| BBS **tonnage** | steel **cost** | no link exists | BBS has no rates | **Yes** |
| Labour **accrual** | P&L labour cost | everything, until posted | accrual vs payment | **Yes** |
| Site log **headcount** | labour attendance headcount | whatever was typed last | two sources for one fact (054) | **No — known gap.** `fn_labour_headcount_check` shows the variance; it has never been resolved |

### The one I'd look at hardest

**EVM BAC vs project budget.** `schedule_activities.budget_amount` is set when the schedule is
generated; `budgets` is set on the Money side. They are entirely separate tables with no constraint
between them, no reconciliation view, and nothing on any screen that compares them. If they have
drifted, every EVM index on the Schedule screen is measuring against a budget the Money module has
never agreed to.

```sql
select
  (select coalesce(sum(budget_amount),0) from public.schedule_activities
    where project_id = 'PASTE-UUID')  as evm_bac,
  (select coalesce(sum(amount),0) from public.budgets
    where project_id = 'PASTE-UUID')  as money_budget;
```

Report both numbers. If they differ materially, that is a real finding and probably its own session.

---

## 10 · Reporting template

```
FIGURE:     e.g. Project detail → Spent
EXPECTED:   1,84,20,000  (query §1, value A)
SAW:        1,84,95,000
DELTA:      +75,000
CONTEXT:    before/after void of expense V=75,000
VERDICT:    BREAK | KNOWN (§9 row n) | UNSURE
```

If a section reconciles cleanly, one line: `§3 Void test — all 14 lines pass.`

Report the §4.2 untagged count and the §9 BAC-vs-budget pair **even if nothing is broken** — both
are health numbers I want to see.
