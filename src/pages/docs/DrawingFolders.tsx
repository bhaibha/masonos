import { FileStack } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { errText } from '@/lib/errText'
import { fetchDrawings } from '@/lib/queries/drawings'
import {
  canManageDrawings,
  DRAWING_DISCIPLINES,
  type DrawingRow,
} from '@/lib/types'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/**
 * Level 1 of the register: one folder per discipline.
 *
 * Deliberately mirrors the document vault's folder grid — it's the same mental
 * model (a wall of labelled folders), so nobody has to learn a second one.
 */
export default function DrawingFolders() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayManage = canManageDrawings(role)

  const [rows, setRows] = useState<DrawingRow[] | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setRows(await fetchDrawings(projectId))
    } catch (err) {
      toast.error('Could not load the drawing register', {
        description: errText(err),
      })
      setRows([])
    }
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (rows === null) return <ListSkeleton rows={4} />

  const counts = new Map<string, { total: number; issued: number }>()
  for (const d of rows) {
    const c = counts.get(d.discipline) ?? { total: 0, issued: 0 }
    c.total += 1
    if (d.current_revision_id !== null) c.issued += 1
    counts.set(d.discipline, c)
  }

  if (rows.length === 0) {
    return (
      <>
        <EmptyState
          icon={FileStack}
          title={mayManage ? 'No drawings yet' : 'No drawings issued yet'}
          body={
            mayManage
              ? 'Open a discipline folder to add the first drawing.'
              : 'Drawings appear here once they are issued for construction. Work-in-progress sheets are never shown on site.'
          }
        />
        <OtherProjectsHint />
      </>
    )
  }

  return (
    <Stagger className="grid grid-cols-2 gap-4 pb-6">
      {DRAWING_DISCIPLINES.map((d) => {
        const c = counts.get(d.value) ?? { total: 0, issued: 0 }
        const pending = c.total - c.issued

        return (
          <RevealItem key={d.value} className="h-full">
            <Link
              to={`/docs/register/${d.value}`}
              className="paper flex h-full flex-col p-5 transition-shadow hover:paper-lift focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              <p className="font-heading text-[17px] leading-tight font-semibold">
                {d.label}
              </p>
              <p className="mt-auto pt-4 text-sm text-muted-foreground tabular-nums">
                {c.total === 0
                  ? 'Empty'
                  : `${c.total} drawing${c.total === 1 ? '' : 's'}`}
              </p>
              {/* Only founder/PM ever see a pending count — a supervisor's
                  register contains nothing but issued drawings. */}
              {mayManage && pending > 0 && (
                <p className="mt-0.5 text-xs text-[var(--warning)] tabular-nums">
                  {pending} not issued
                </p>
              )}
            </Link>
          </RevealItem>
        )
      })}
    </Stagger>
  )
}
