/**
 * Display-only formatting. No money math happens here — every total, balance
 * and fee is computed in Postgres (CLAUDE.md rule 2). These helpers only turn
 * numbers that Postgres already calculated into strings.
 */

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

export function formatInr(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return '—'
  const n = typeof amount === 'string' ? Number(amount) : amount
  if (Number.isNaN(n)) return '—'
  return inr.format(n)
}

/**
 * Ratio for a progress bar's width. Presentation only — never rendered as a
 * currency figure, and never used to derive an amount.
 */
export function spendRatio(spent: number, budget: number): number {
  if (!budget || budget <= 0) return 0
  return Math.min(spent / budget, 1)
}

export interface BarGeometry {
  /** where the budget line sits, 0–1 of the rail */
  budgetAt: number
  /** how far the fill reaches, 0–1 of the rail */
  fillTo: number
  over: boolean
  hasBudget: boolean
}

/**
 * Geometry for the spend rail. Widths only — no currency is derived here.
 *
 * The rail is normalised to max(spent, budget), so:
 *  · under budget → the budget line sits at the far right and the fill stops short
 *  · over budget  → the fill runs the full rail and visibly crosses the budget
 *                   line, which moves inward in proportion to the overspend
 * A solid full bar can't distinguish "exactly on budget" from "double budget";
 * this can.
 */
export function barGeometry(spent: number, budget: number): BarGeometry {
  if (!budget || budget <= 0) {
    return { budgetAt: 0, fillTo: 0, over: false, hasBudget: false }
  }

  const max = Math.max(spent, budget)
  return {
    budgetAt: budget / max,
    fillTo: spent / max,
    over: spent > budget,
    hasBudget: true,
  }
}
