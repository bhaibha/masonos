import { PackageOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ListSkeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { errText } from '@/lib/errText'
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

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    setRows(null)

    fetchStock(projectId)
      .then((data) => {
        if (!cancelled) setRows(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          toast.error('Could not load stock.', { description: errText(err) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectId])

  const lowCount = rows?.filter((r) => r.low_stock).length ?? 0

  return (
    <div className="space-y-4 pb-6">

      {rows === null && <ListSkeleton rows={5} />}

      {rows?.length === 0 && (
        <>
          <EmptyState
            icon={PackageOpen}
            title="No stock movement yet"
            body="Once a delivery is logged, running stock per material shows here — with a flag when anything drops to its low-stock level."
            actionLabel={canLogMaterials(role) ? 'Log a delivery' : undefined}
            actionTo={canLogMaterials(role) ? '/materials/inward' : undefined}
          />
          <OtherProjectsHint />
        </>
      )}

      {rows && rows.length > 0 && (
        <>
          {lowCount > 0 && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {lowCount} material{lowCount === 1 ? '' : 's'} at or below the
              low-stock level.
            </p>
          )}

          <Stagger className="paper divide-y divide-border overflow-hidden">
            {rows.map((r) => (
              <RevealItem key={r.material_id} className="px-4 py-3">
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
              </RevealItem>
            ))}
          </Stagger>

          <p className="text-xs text-muted-foreground">
            Quantities come from <code className="text-[11px]">v_stock</code>.
            Materials with no movement on this project don't appear.
          </p>
        </>
      )}
    </div>
  )
}
