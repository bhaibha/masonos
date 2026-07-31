/**
 * Rupee amount → words, Indian numbering (lakh / crore).
 *
 * This is FORMATTING, not money math — it converts a figure Postgres already
 * computed into the sentence a GST invoice has to carry ("Rupees Four Lakh
 * Twenty Thousand Only"). It never adds, derives or rounds a total; the caller
 * passes the stored value and this restates it.
 *
 * Paise are included only when non-zero, which is how Indian invoices read.
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
]
const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty',
  'Ninety',
]

/** 0–99 → words. */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? ''
  const t = TENS[Math.floor(n / 10)] ?? ''
  const o = ONES[n % 10] ?? ''
  return o ? `${t} ${o}` : t
}

/** 0–999 → words. */
function threeDigits(n: number): string {
  const h = Math.floor(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (h > 0) parts.push(`${ONES[h]} Hundred`)
  if (rest > 0) parts.push(twoDigits(rest))
  return parts.join(' ')
}

/**
 * Splits on the Indian grouping: crore (10^7), lakh (10^5), thousand (10^3),
 * then the last three digits. Not the western thousand/million grouping —
 * getting this wrong on an Indian invoice is immediately obvious.
 */
function integerToWords(n: number): string {
  if (n === 0) return 'Zero'

  const crore = Math.floor(n / 10_000_000)
  const lakh = Math.floor((n % 10_000_000) / 100_000)
  const thousand = Math.floor((n % 100_000) / 1_000)
  const rest = n % 1_000

  const parts: string[] = []
  if (crore > 0) parts.push(`${integerToWords(crore)} Crore`)
  if (lakh > 0) parts.push(`${threeDigits(lakh)} Lakh`)
  if (thousand > 0) parts.push(`${threeDigits(thousand)} Thousand`)
  if (rest > 0) parts.push(threeDigits(rest))

  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * "Rupees Four Lakh Twenty Thousand and Fifty Paise Only".
 * Negative amounts are prefixed "Minus" — a credit note or a deduction line.
 */
export function amountInWords(amount: number): string {
  if (!Number.isFinite(amount)) return ''

  const negative = amount < 0
  const abs = Math.abs(amount)
  // Round to paise first so 0.005 cases don't produce "and 0 Paise".
  const cents = Math.round(abs * 100)
  const rupees = Math.floor(cents / 100)
  const paise = cents % 100

  const parts = ['Rupees', integerToWords(rupees)]
  if (paise > 0) parts.push('and', twoDigits(paise), 'Paise')
  parts.push('Only')

  const words = parts.join(' ').replace(/\s+/g, ' ').trim()
  return negative ? `Minus ${words}` : words
}
