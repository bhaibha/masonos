import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchStock } from '@/lib/queries/materials'
import { canLogMaterials, type StockRow } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const qty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

export default function StockRegister() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  const [rows, setRows] = useState<StockRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    setRows(null)
    setError(null)

    fetchStock(projectId)
      .then((data) => {
        if (!cancelled) setRows(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load stock.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectId])

  const lowCount = rows?.filter((r) => r.low_stock).length ?? 0

  return (
    <div className="space-y-4 pb-6">
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {rows === null && !error && (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      )}

      {rows?.length === 0 && (
        <div className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing received or issued on this project yet.
          </p>
          {canLogMaterials(role) && (
            <Link
              to="/materials/inward"
              className="mt-2 inline-block text-sm font-medium underline underline-offset-4"
            >
              Log a delivery
            </Link>
          )}
        </div>
      )}

      {rows && rows.length > 0 && (
        <>
          {lowCount > 0 && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {lowCount} material{lowCount === 1 ? '' : 's'} at or below the
              low-stock level.
            </p>
          )}

          <ul className="divide-y divide-border rounded-xl border border-border">
            {rows.map((r) => (
              <li key={r.material_id} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      In {qty.format(r.total_in)} · Out {qty.format(r.total_out)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p
                      className={cn(
                        'font-heading text-lg font-semibold tabular-nums',
                        r.low_stock && 'text-destructive',
                      )}
                    >
                      {qty.format(r.in_stock)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        {r.unit}
                      </span>
                    </p>
                    {r.low_stock && (
                      <span className="mt-0.5 inline-block rounded-md bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive">
                        Low stock
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <p className="text-xs text-muted-foreground">
            Quantities come from <code className="text-[11px]">v_stock</code>.
            Materials with no movement on this project don't appear.
          </p>
        </>
      )}
    </div>
  )
}
