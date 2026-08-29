import { animate, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { formatInr } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * A money figure that counts up to its value on first paint.
 *
 * WHY THIS IS NOT DECORATION
 * --------------------------
 * A number that arrives already settled is read once and forgotten. A number
 * that moves draws the eye to it for the half-second it takes to land, which is
 * exactly the emphasis the design system asks for on money — "make numbers feel
 * important". It is the same reason a printed report sets the total in a
 * heavier face.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * It never animates BETWEEN two real values after the first render. Watching a
 * spend figure roll from last month's number to this month's would imply the
 * money moved while you watched, and somebody would screenshot the wrong frame.
 * A change of input snaps.
 *
 * It also does not run at all under `prefers-reduced-motion`, and it renders
 * the final value on the server-less first tick, so a screenshot or a
 * screen-reader never catches a half-counted figure.
 */
export function Figure({
  value,
  format = formatInr,
  className,
  duration = 0.9,
}: {
  value: number
  /** Defaults to INR. Pass a plain formatter for counts and percentages. */
  format?: (n: number) => string
  className?: string
  duration?: number
}) {
  const reduce = useReducedMotion()
  const [shown, setShown] = useState(value)
  const hasAnimated = useRef(false)

  useEffect(() => {
    // Only the first arrival animates. Later changes are real data changes and
    // must not look like the figure is drifting on its own.
    if (hasAnimated.current || reduce) {
      setShown(value)
      return
    }
    hasAnimated.current = true

    // Counting from zero is theatre when the number is small; below this the
    // animation is noise and the figure may as well just appear.
    if (Math.abs(value) < 1000) {
      setShown(value)
      return
    }

    const controls = animate(0, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setShown(v),
    })
    return () => controls.stop()
  }, [value, reduce, duration])

  return (
    <span className={cn('tabular-nums', className)}>
      {format(Math.round(shown))}
    </span>
  )
}

/**
 * A budget bar that grows to its ratio instead of appearing at it.
 *
 * The growth is what makes "over budget" legible at a glance: the fill runs
 * past the budget marker and stops, and the eye follows it there. A static bar
 * makes you find the marker yourself.
 */
export function GrowBar({
  fillTo,
  budgetAt,
  over,
  className,
}: {
  /** 0–1, the fraction of the track the spend occupies. */
  fillTo: number
  /** 0–1, where the budget marker sits. */
  budgetAt: number
  over: boolean
  className?: string
}) {
  const reduce = useReducedMotion()
  const [w, setW] = useState(reduce ? fillTo : 0)

  useEffect(() => {
    if (reduce) {
      setW(fillTo)
      return
    }
    // One frame at zero, then grow — otherwise the transition has nothing to
    // animate from on the very first paint.
    const id = requestAnimationFrame(() => setW(fillTo))
    return () => cancelAnimationFrame(id)
  }, [fillTo, reduce])

  return (
    <div
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-secondary',
        className,
      )}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)]',
          over ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]',
        )}
        style={{ width: `${Math.min(w, 1) * 100}%` }}
      />
      {/* The budget line. Only drawn when there IS a budget — a marker at zero
          would read as "budget: nothing" rather than "no budget set". */}
      {budgetAt > 0 && budgetAt < 1 && (
        <span
          aria-hidden
          className="absolute inset-y-0 w-px bg-[color-mix(in_oklab,var(--ink)_45%,transparent)]"
          style={{ left: `${budgetAt * 100}%` }}
        />
      )}
    </div>
  )
}
