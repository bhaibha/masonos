import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/** Today in Asia/Kolkata (CLAUDE.md rule 6), as YYYY-MM-DD. */
export function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** YYYY-MM-DD shifted by whole days, without touching the local timezone. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function formatDayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(d)
}

/**
 * Selected date lives in the URL (?date=YYYY-MM-DD) rather than in a context,
 * so every Tasks screen reads it independently and a link can be shared.
 */
export function useSelectedDate(): [string, (next: string) => void] {
  const [params, setParams] = useSearchParams()
  const date = params.get('date') ?? todayIst()

  const setDate = useCallback(
    (next: string) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          p.set('date', next)
          return p
        },
        { replace: true },
      )
    },
    [setParams],
  )

  return [date, setDate]
}
