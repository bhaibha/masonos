import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * Hand-built SVG charts, deliberately.
 *
 * The app already draws its Gantt and its spend rails this way, and three
 * charts did not justify pulling recharts and its d3 dependencies into a bundle
 * that gets downloaded on a site phone. They also get the brand for free —
 * brass accent, ink on warm off-white, tabular figures — instead of needing a
 * chart library restyled into it.
 *
 * Nothing here computes a value. Every number arrives already worked out by
 * Postgres; these components only turn them into geometry.
 */

const PAD = { top: 10, right: 8, bottom: 22, left: 8 }

export interface SeriesPoint {
  /** short axis label, e.g. "Aug" */
  label: string
  value: number
}

/**
 * Monthly bars with an optional line over them — spend per month against the
 * cumulative curve, which is the pair that actually answers "are we burning
 * faster than we were".
 *
 * The bar axis is anchored at ZERO, always. A truncated axis exaggerates every
 * movement, and this chart exists to be trusted in a board pack.
 */
export function BarChart({
  data,
  line,
  height = 140,
  format,
  lineFormat,
  emptyLabel = 'Nothing recorded yet',
}: {
  data: SeriesPoint[]
  /** overlaid line on its own scale, e.g. the cumulative total */
  line?: SeriesPoint[]
  height?: number
  format?: (v: number) => string
  lineFormat?: (v: number) => string
  emptyLabel?: string
}) {
  const gradId = useId()

  if (data.length === 0) {
    return <ChartEmpty height={height} label={emptyLabel} />
  }

  const W = 320
  const H = height
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  const maxBar = Math.max(...data.map((d) => d.value), 1)
  const maxLine = line?.length ? Math.max(...line.map((d) => d.value), 1) : 1

  const slot = innerW / data.length
  const barW = Math.max(4, Math.min(slot * 0.55, 26))

  const linePath = line?.length
    ? line
        .map((d, i) => {
          const x = PAD.left + slot * i + slot / 2
          const y = PAD.top + innerH - (d.value / maxLine) * innerH
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
    : null

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Chart of ${data.length} periods`}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.35" />
          </linearGradient>
        </defs>

        {/* Baseline, so the eye has something to measure the bars against. */}
        <line
          x1={PAD.left}
          y1={PAD.top + innerH}
          x2={W - PAD.right}
          y2={PAD.top + innerH}
          stroke="var(--border)"
          strokeWidth="1"
        />

        {data.map((d, i) => {
          const h = (d.value / maxBar) * innerH
          const x = PAD.left + slot * i + (slot - barW) / 2
          return (
            <rect
              key={d.label + i}
              x={x}
              y={PAD.top + innerH - h}
              width={barW}
              height={Math.max(h, d.value > 0 ? 1.5 : 0)}
              rx="2"
              fill={`url(#${gradId})`}
            >
              <title>
                {d.label}: {format ? format(d.value) : d.value}
              </title>
            </rect>
          )
        })}

        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke="var(--ink)"
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.55"
          />
        )}

        {/* Labels thin out on a narrow screen rather than overlapping. */}
        {data.map((d, i) => {
          const every = data.length > 8 ? 3 : data.length > 5 ? 2 : 1
          if (i % every !== 0 && i !== data.length - 1) return null
          return (
            <text
              key={`l${d.label}${i}`}
              x={PAD.left + slot * i + slot / 2}
              y={H - 6}
              textAnchor="middle"
              fontSize="8"
              fill="var(--muted)"
            >
              {d.label}
            </text>
          )
        })}
      </svg>

      {line?.length && lineFormat ? (
        <figcaption className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-[var(--accent)]" />
            per month
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-px w-3 bg-[var(--ink)] opacity-55" />
            cumulative — {lineFormat(line[line.length - 1].value)}
          </span>
        </figcaption>
      ) : null}
    </figure>
  )
}

/**
 * A single line, for a percentage that moves over time.
 *
 * Unlike the bar chart this one does NOT anchor at zero — a margin sitting
 * between 22% and 26% would be a flat line against a 0–100 axis, and the whole
 * point is to see it move. The axis range is printed beside it so the reader
 * knows the scale is not zero-based.
 */
export function LineChart({
  data,
  height = 120,
  format = (v) => `${v}%`,
  emptyLabel = 'Nothing recorded yet',
}: {
  data: SeriesPoint[]
  height?: number
  format?: (v: number) => string
  emptyLabel?: string
}) {
  const gradId = useId()

  if (data.length < 2) {
    return (
      <ChartEmpty
        height={height}
        label={data.length === 1 ? 'One month so far — no trend yet' : emptyLabel}
      />
    )
  }

  const W = 320
  const H = height
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  const values = data.map((d) => d.value)
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  // A flat series still needs a band, or every point lands on one pixel row.
  const pad = rawMax === rawMin ? Math.max(Math.abs(rawMax) * 0.1, 1) : 0
  const min = rawMin - pad
  const max = rawMax + pad
  const span = max - min || 1

  const x = (i: number) => PAD.left + (innerW / (data.length - 1)) * i
  const y = (v: number) => PAD.top + innerH - ((v - min) / span) * innerH

  const path = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`)
    .join(' ')
  const area = `${path} L${x(data.length - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`

  const last = data[data.length - 1]
  const first = data[0]
  const rising = last.value >= first.value

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Trend from ${format(first.value)} to ${format(last.value)}`}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={rising ? 'var(--positive)' : 'var(--danger)'}
              stopOpacity="0.18"
            />
            <stop
              offset="100%"
              stopColor={rising ? 'var(--positive)' : 'var(--danger)'}
              stopOpacity="0"
            />
          </linearGradient>
        </defs>

        <path d={area} fill={`url(#${gradId})`} />
        <path
          d={path}
          fill="none"
          stroke={rising ? 'var(--positive)' : 'var(--danger)'}
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={x(data.length - 1)}
          cy={y(last.value)}
          r="2.6"
          fill={rising ? 'var(--positive)' : 'var(--danger)'}
        />

        {data.map((d, i) => {
          const every = data.length > 8 ? 3 : data.length > 5 ? 2 : 1
          if (i % every !== 0 && i !== data.length - 1) return null
          return (
            <text
              key={`l${d.label}${i}`}
              x={x(i)}
              y={H - 6}
              textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}
              fontSize="8"
              fill="var(--muted)"
            >
              {d.label}
            </text>
          )
        })}
      </svg>

      {/* The scale is stated because the axis is not zero-based. */}
      <figcaption className="mt-1 text-[10px] text-muted-foreground tabular-nums">
        {format(rawMin)} – {format(rawMax)} · now {format(last.value)}
      </figcaption>
    </figure>
  )
}

/**
 * Horizontal bars for a ranked breakdown. Horizontal because category names are
 * words, and words rotated 45° under a vertical bar chart are unreadable on a
 * phone.
 */
export function CategoryBars({
  data,
  format,
  max = 8,
  emptyLabel = 'Nothing recorded yet',
}: {
  data: { label: string; value: number; pct: number | null }[]
  format: (v: number) => string
  max?: number
  emptyLabel?: string
}) {
  if (data.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    )
  }

  const shown = data.slice(0, max)
  const rest = data.slice(max)
  const top = Math.max(...data.map((d) => d.value), 1)
  const restTotal = rest.reduce((a, d) => a + d.value, 0)

  return (
    <ul className="space-y-2.5">
      {shown.map((d) => (
        <li key={d.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm">{d.label}</span>
            <span className="shrink-0 text-sm tabular-nums">
              {format(d.value)}
              {d.pct !== null && (
                <span className="ml-1.5 text-[11px] text-muted-foreground">
                  {d.pct}%
                </span>
              )}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${Math.max((d.value / top) * 100, 1)}%` }}
            />
          </div>
        </li>
      ))}

      {/* The tail is summarised rather than dropped — a breakdown that silently
          omits rows does not add up to the total printed above it. */}
      {rest.length > 0 && (
        <li className="flex items-baseline justify-between gap-3 pt-1 text-xs text-muted-foreground">
          <span>
            {rest.length} smaller {rest.length === 1 ? 'category' : 'categories'}
          </span>
          <span className="tabular-nums">{format(restTotal)}</span>
        </li>
      )}
    </ul>
  )
}

function ChartEmpty({ height, label }: { height: number; label: string }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-lg border border-dashed border-border',
      )}
      style={{ height }}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
