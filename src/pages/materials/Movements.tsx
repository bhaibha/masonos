import { ArrowDownLeft, ArrowUpRight, PackageSearch } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import {
  VoidBadge,
  VoidDialog,
  VoidNote,
  voidRowClass,
} from '@/components/VoidDialog'
import { Button } from '@/components/ui/button'
import { errText } from '@/lib/errText'
import { fetchMovements, fetchUserNames } from '@/lib/queries/voids'
import { canVoid, isVoid, type MovementRow } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

type Filter = 'all' | 'inward' | 'issue'

/**
 * Every stock movement on the project, newest first, so a PM can find and
 * reverse the one that was logged wrong. The Stock Register shows balances;
 * this shows the entries that produced them.
 *
 * No money here — it reads the rate-free v_material_inward, so supervisors can
 * use it to check what was logged even though they can't void.
 */
export default function Movements() {
  // Store, not useOutletContext — MaterialsLayout renders a bare <Outlet />
  // and CLAUDE.md rule 7 says resolve the project from the store.
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const myId = useAuth((s) => s.user?.id ?? null)

  const [rows, setRows] = useState<MovementRow[] | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [filter, setFilter] = useState<Filter>('all')
  const [voiding, setVoiding] = useState<MovementRow | null>(null)

  const load = useCallback(async () => {
    if (!projectId) return
    const data = await fetchMovements(projectId)
    setRows(data)
    setNames(await fetchUserNames(data.map((r) => r.voided_by)))
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    setRows(null)
    load().catch((err: unknown) => {
      toast.error('Could not load movements', { description: errText(err) })
      setRows([])
    })
  }, [load, projectId])

  const shown = rows?.filter((r) => filter === 'all' || r.kind === filter)

  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {(['all', 'inward', 'issue'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'min-h-11 rounded-lg px-3.5 text-sm font-medium transition-colors',
              filter === f
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {f === 'all' ? 'All' : f === 'inward' ? 'Deliveries' : 'Issues'}
          </button>
        ))}
      </div>

      {rows === null && <ListSkeleton rows={5} />}

      {shown?.length === 0 && (
        <>
          <EmptyState
            icon={PackageSearch}
            title={
              filter === 'all'
                ? 'No movements yet'
                : `No ${filter === 'inward' ? 'deliveries' : 'issues'} yet`
            }
            body="Deliveries and issues logged against this project appear here, newest first."
          />
          <OtherProjectsHint />
        </>
      )}

      {shown && shown.length > 0 && (
        <Stagger className="paper divide-y divide-border overflow-hidden">
          {shown.map((r) => (
            <RevealItem key={`${r.kind}-${r.id}`}>
              <MovementCard
                row={r}
                /* 021: a supervisor may void what they logged themselves —
                   the same rule fn_void_record enforces server-side. */
                mayVoid={canVoid(role, r.table, {
                  createdBy: r.created_by,
                  myId,
                })}
                isMine={Boolean(myId && r.created_by === myId)}
                voidedByName={r.voided_by ? names.get(r.voided_by) : null}
                onVoid={() => setVoiding(r)}
              />
            </RevealItem>
          ))}
        </Stagger>
      )}

      {voiding && (
        <VoidDialog
          table={voiding.table}
          id={voiding.id}
          summary={`${voiding.qty} ${voiding.material_unit} · ${voiding.material_name} · ${voiding.move_date}`}
          consequence={
            voiding.kind === 'inward'
              ? 'The delivery stays on record marked VOID, and its quantity is removed from stock. Blocked if that would take stock below zero.'
              : 'The issue stays on record marked VOID, and its quantity is returned to stock.'
          }
          onDone={async () => {
            setVoiding(null)
            await load()
          }}
          onCancel={() => setVoiding(null)}
        />
      )}
    </div>
  )
}

function MovementCard({
  row,
  mayVoid,
  isMine,
  voidedByName,
  onVoid,
}: {
  row: MovementRow
  mayVoid: boolean
  isMine: boolean
  voidedByName?: string | null
  onVoid: () => void
}) {
  const voided = isVoid(row)
  const inward = row.kind === 'inward'
  const Icon = inward ? ArrowDownLeft : ArrowUpRight

  return (
    <div className="px-5 py-4">
      <div className={voidRowClass(voided)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <div
              className={cn(
                'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                inward
                  ? 'bg-[color-mix(in_oklab,var(--positive)_12%,transparent)]'
                  : 'bg-secondary',
              )}
            >
              <Icon
                className={cn(
                  'size-4',
                  inward ? 'text-[var(--positive)]' : 'text-muted-foreground',
                )}
                aria-hidden="true"
              />
            </div>

            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{row.material_name}</span>
                {voided && <VoidBadge className="no-underline" />}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {row.move_date}
                {row.party ? ` · ${row.party}` : ''}
              </p>
              {row.note && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {row.note}
                </p>
              )}
            </div>
          </div>

          <p
            className={cn(
              'figure shrink-0 text-[16px] font-semibold tabular-nums',
              inward ? 'text-[var(--positive)]' : 'text-foreground',
            )}
          >
            {inward ? '+' : '−'}
            {row.qty} {row.material_unit}
          </p>
        </div>
      </div>

      {voided ? (
        <VoidNote reason={row.void_reason} by={voidedByName} at={row.voided_at} />
      ) : row.from_grn ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          From a goods receipt — void the receipt on the order to reverse this.
        </p>
      ) : mayVoid ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onVoid}
          className="mt-1 -ml-2 h-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          Void
        </Button>
      ) : (
        /* Not "nothing" — an empty row leaves people assuming corrections are
           impossible. Say who can make one. */
        !isMine && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Logged by someone else. Ask a PM or the founder to void it.
          </p>
        )
      )}
    </div>
  )
}
