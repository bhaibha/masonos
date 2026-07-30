import { ClipboardList, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchOpenSis, type OpenSi } from '@/lib/queries/siteInstructions'
import { SI_STATUS_LABEL } from '@/lib/types'
import { todayIst } from '@/lib/useSelectedDate'
import { cn } from '@/lib/utils'

/**
 * Outstanding site instructions, shown above the day's tasks until each one is
 * marked complete.
 *
 * An instruction isn't a task — it has no planned date and doesn't roll over —
 * so it can't just be merged into the task list. But it IS work someone on site
 * has been told to do, and burying it on its own tab means it gets forgotten.
 * This strip sits above the day's work on every date, because an open
 * instruction is outstanding regardless of which day you're looking at.
 *
 * Renders nothing when there are none, so it costs no space on a clean project.
 */
export function OpenInstructions({ projectId }: { projectId: string | null }) {
  const [rows, setRows] = useState<OpenSi[]>([])

  useEffect(() => {
    if (!projectId) {
      setRows([])
      return
    }
    let cancelled = false
    fetchOpenSis(projectId).then((r) => {
      if (!cancelled) setRows(r)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  if (rows.length === 0) return null

  const today = todayIst()
  const overdue = rows.filter(
    (r) => r.required_by !== null && r.required_by < today,
  ).length

  return (
    <section className="paper overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <p className="flex items-center gap-2 text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
          <ClipboardList className="size-3.5" aria-hidden="true" />
          Open instructions
        </p>
        <span
          className={cn(
            'text-[11px] tabular-nums',
            overdue > 0 ? 'font-medium text-destructive' : 'text-muted-foreground',
          )}
        >
          {rows.length}
          {overdue > 0 && ` · ${overdue} overdue`}
        </span>
      </div>

      <div className="divide-y divide-border">
        {rows.map((si) => {
          const late = si.required_by !== null && si.required_by < today
          return (
            <Link
              key={si.id}
              to="/tasks/instructions"
              className="flex items-start justify-between gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0">
                <p className="line-clamp-2 text-sm">{si.instruction}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">{si.si_number}</span>
                  {si.work_area && <span>{si.work_area}</span>}
                  {si.status === 'acknowledged' && (
                    <span>{SI_STATUS_LABEL.acknowledged}</span>
                  )}
                  {si.required_by && (
                    <span className={cn(late && 'font-medium text-destructive')}>
                      By {si.required_by}
                      {late && ' · overdue'}
                    </span>
                  )}
                </p>
              </div>
              <ChevronRight
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
          )
        })}
      </div>
    </section>
  )
}
