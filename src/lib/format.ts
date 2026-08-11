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
/**
 * Profit / loss / break-even, as one decision made in one place.
 *
 * Green for profit, red for loss, blue for exactly nil. The label and the
 * figure always take the SAME colour — a muted word next to a red number reads
 * as decoration; both coloured reads as a verdict.
 */
export type MarginTone = 'profit' | 'loss' | 'breakeven'

export function marginTone(margin: number): MarginTone {
  if (margin > 0) return 'profit'
  if (margin < 0) return 'loss'
  return 'breakeven'
}

export const MARGIN_TEXT: Record<MarginTone, string> = {
  profit: 'text-[var(--positive)]',
  loss: 'text-destructive',
  breakeven: 'text-[var(--neutral)]',
}

export const MARGIN_LABEL: Record<MarginTone, string> = {
  profit: 'Margin',
  loss: 'Loss',
  breakeven: 'Break-even',
}

/**
 * EVM index bands.
 *
 * ≥ 1 good, 0.9–1 watch, < 0.9 alert — the conventional thresholds, kept in one
 * place so the card, the row and any future report cannot disagree about what
 * counts as trouble. `null` (undefined index) is its own band: an activity that
 * has not started has no performance, which is not the same as bad performance.
 */
export type IndexBand = 'good' | 'watch' | 'alert' | 'na'

export function indexBand(v: number | null | undefined): IndexBand {
  if (v === null || v === undefined) return 'na'
  if (v >= 1) return 'good'
  if (v >= 0.9) return 'watch'
  return 'alert'
}

export const INDEX_TEXT: Record<IndexBand, string> = {
  good: 'text-[var(--positive)]',
  watch: 'text-[var(--warning)]',
  alert: 'text-destructive',
  na: 'text-muted-foreground',
}

export const INDEX_BG: Record<IndexBand, string> = {
  good: 'bg-[var(--positive)]',
  watch: 'bg-[var(--warning)]',
  alert: 'bg-destructive',
  na: 'bg-border',
}

/** "1.04" / "n/a" — never "Infinity", never a bare 0 standing in for unknown. */
export function formatIndex(v: number | null | undefined): string {
  return v === null || v === undefined ? 'n/a' : v.toFixed(2)
}

/**
 * The plain-English read. Deliberately says "on plan" rather than "on track"
 * when an index is merely ≥ 1 — the number says the plan is being met, not
 * that the plan was any good.
 */
export function evmVerdict(
  spi: number | null,
  cpi: number | null,
): string {
  const s = indexBand(spi)
  const c = indexBand(cpi)

  if (s === 'na' && c === 'na') {
    return 'Not enough recorded yet — no planned value has fallen due and nothing has been spent against the programme.'
  }

  const sched =
    s === 'na'
      ? 'Schedule performance not yet measurable'
      : s === 'good'
        ? 'On or ahead of programme'
        : s === 'watch'
          ? 'Slipping slightly'
          : 'Behind programme'

  const cost =
    c === 'na'
      ? 'no cost booked yet'
      : c === 'good'
        ? 'within cost'
        : c === 'watch'
          ? 'cost creeping up'
          : 'over cost'

  return `${sched}, ${cost}.`
}

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
