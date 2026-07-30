import { FileDiff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { OtherProjectsHint } from '@/components/ProjectPicker'
import { FieldRow, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { companyNeedsSetup } from '@/lib/company'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import { createDocument } from '@/lib/queries/documents'
import { fetchProject } from '@/lib/queries/projects'
import {
  createVariation,
  fetchProjectContract,
  fetchVariations,
  setVariationStatus,
} from '@/lib/queries/variations'
import {
  CancelDialog,
  CancelNote,
  RejectVoDialog,
} from '@/components/VoidDialog'
import { uploadDocument } from '@/lib/storage'
import {
  canApproveVO,
  canCancel,
  canRaiseVO,
  type VariationOrder,
  VO_STATUS_LABEL,
  type VoStatus,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { generateVoFile, generateVoPdf } from '@/lib/voPdf'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

const STATUS_TONE: Record<VoStatus, string> = {
  submitted: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
  approved: 'bg-[color-mix(in_oklab,var(--positive)_14%,transparent)] text-[var(--positive)]',
  rejected: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-destructive/10 text-destructive',
}

export default function Variations() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)

  const [rows, setRows] = useState<VariationOrder[] | null>(null)
  const [raising, setRaising] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setRows(await fetchVariations(projectId))
    } catch (err) {
      toast.error('Could not load variations', { description: errText(err) })
      setRows([])
    }
  }, [projectId])

  useEffect(() => {
    setRows(null)
    void reload()
  }, [reload])

  if (raising) {
    return (
      <RaiseVariation
        onDone={() => {
          setRaising(false)
          void reload()
        }}
        onCancel={() => setRaising(false)}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      {/* The contract-value summary lives on Project Detail, not here — this
          screen is the list of variations. `contract` is still fetched below
          because the VO PDF prints the before/after contract figures. */}

      {canRaiseVO(role) && (
        <Button className="h-12 w-full text-base" onClick={() => setRaising(true)}>
          Raise variation
        </Button>
      )}

      {rows === null && <ListSkeleton rows={3} />}

      {rows !== null && rows.length === 0 && (
        <>
          <EmptyState
            icon={FileDiff}
            title="No variations yet"
            body="Log any change to the agreed scope — extra work or omissions — with its cost impact. Approved variations adjust the contract value."
            actionLabel={canRaiseVO(role) ? 'Raise a variation' : undefined}
            onAction={canRaiseVO(role) ? () => setRaising(true) : undefined}
          />
          <OtherProjectsHint />
        </>
      )}

      {rows && rows.length > 0 && (
        <Stagger className="space-y-3">
          {rows.map((vo) => (
            <RevealItem key={vo.id}>
              <VariationCard vo={vo} onChanged={reload} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

function VariationCard({
  vo,
  onChanged,
}: {
  vo: VariationOrder
  onChanged: () => Promise<void>
}) {
  const role = useAuth((s) => s.role)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const over = vo.cost_impact < 0
  const cancelled = vo.status === 'cancelled'

  async function approve() {
    setBusy(true)
    try {
      await setVariationStatus(vo.id, 'approved')
      toast.success('Variation approved', {
        description: 'The revised contract value has moved.',
      })
      await onChanged()
    } catch (err) {
      toast.error('Could not update the variation', { description: errText(err) })
    }
    setBusy(false)
  }

  async function download(file: boolean) {
    setBusy(true)
    try {
      const [project, contract] = await Promise.all([
        fetchProject(vo.project_id),
        fetchProjectContract(vo.project_id),
      ])
      const opts = {
        vo,
        projectName: project?.name ?? '',
        siteAddress: project?.site_address ?? null,
        clientName: project?.client_name ?? null,
        contract,
      }
      if (file) {
        const f = generateVoFile(opts)
        const { path, fileType } = await uploadDocument(vo.project_id, f)
        await createDocument({
          project_id: vo.project_id,
          folder: 'contracts',
          title: `${vo.vo_number} · ${vo.title}`,
          file_path: path,
          file_type: fileType,
          is_confidential: true,
        })
        toast.success('Filed to Docs → Contracts')
      } else {
        generateVoPdf(opts)
        toast[companyNeedsSetup() ? 'warning' : 'success'](
          companyNeedsSetup()
            ? 'VO generated — fill company details in src/lib/company.ts'
            : 'Variation order PDF downloaded',
        )
      }
    } catch (err) {
      toast.error('Could not generate the VO', { description: errText(err) })
    }
    setBusy(false)
  }

  return (
    <article className="paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[17px] font-semibold tabular-nums">
            {vo.vo_number}
          </p>
          <p className="mt-0.5 truncate text-sm font-medium">{vo.title}</p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            STATUS_TONE[vo.status],
          )}
        >
          {VO_STATUS_LABEL[vo.status]}
        </span>
      </div>

      {vo.description && (
        <p className="mt-2 text-sm text-muted-foreground">{vo.description}</p>
      )}

      <p
        className={cn(
          'figure mt-3 text-[20px] font-semibold',
          over ? 'text-destructive' : 'text-positive',
        )}
      >
        {over ? '− ' : '+ '}
        {formatInr(Math.abs(vo.cost_impact))}
      </p>

      {/* Why it was cancelled or rejected — the figure moved, so say why. */}
      {(cancelled || vo.status === 'rejected') && (
        <CancelNote
          reason={vo.cancel_reason}
          at={vo.cancelled_at}
          verb={cancelled ? 'Cancelled' : 'Rejected'}
        />
      )}

      {canApproveVO(role) && vo.status === 'submitted' && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="h-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
          <Button className="h-11" disabled={busy} onClick={() => void approve()}>
            Approve
          </Button>
        </div>
      )}

      {vo.status === 'approved' && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              className="h-11"
              disabled={busy}
              onClick={() => void download(false)}
            >
              Download VO
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={busy}
              onClick={() => void download(true)}
            >
              File to Docs
            </Button>
          </div>

          {/* The only way to undo an approval. An approved VO has already moved
              revised_contract_value; cancelling puts it back, server-side. */}
          {canCancel(role, 'variation_orders') && (
            <Button
              variant="ghost"
              className="mt-2 h-11 w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={busy}
              onClick={() => setCancelling(true)}
            >
              Cancel variation
            </Button>
          )}
        </>
      )}

      {cancelling && (
        <CancelDialog
          table="variation_orders"
          id={vo.id}
          summary={`${vo.vo_number} · ${vo.title} · ${over ? '−' : '+'}${formatInr(
            Math.abs(vo.cost_impact),
          )}`}
          consequence="This variation has already been added to the contract value. Cancelling removes it again — the revised contract figure corrects itself. The VO keeps its number and stays on record."
          onDone={async () => {
            setCancelling(false)
            await onChanged()
          }}
          onCancel={() => setCancelling(false)}
        />
      )}

      {rejecting && (
        <RejectVoDialog
          id={vo.id}
          summary={`${vo.vo_number} · ${vo.title} · ${over ? '−' : '+'}${formatInr(
            Math.abs(vo.cost_impact),
          )}`}
          onDone={async () => {
            setRejecting(false)
            await onChanged()
          }}
          onCancel={() => setRejecting(false)}
        />
      )}
    </article>
  )
}

function RaiseVariation({
  onDone,
  onCancel,
}: {
  onDone: () => void
  onCancel: () => void
}) {
  const projectId = useProjects((s) => s.selectedId)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [sign, setSign] = useState<'add' | 'omit'>('add')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!projectId) return
    if (title.trim() === '') {
      toast.error('Give the variation a title')
      return
    }
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('Enter the cost impact amount')
      return
    }

    setBusy(true)
    try {
      await createVariation({
        project_id: projectId,
        title: title.trim(),
        description,
        cost_impact: sign === 'omit' ? -n : n,
      })
      toast.success('Variation raised')
      onDone()
    } catch (err) {
      toast.error('Could not raise the variation', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5 pb-6">
      <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        New variation
      </p>

      <FieldRow label="Title" htmlFor="vo_title">
        <Input
          id="vo_title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-12 text-base"
          placeholder="Extra bathroom — first floor"
        />
      </FieldRow>

      <FieldRow label="Description" htmlFor="vo_desc">
        <Textarea
          id="vo_desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What changed and why"
        />
      </FieldRow>

      <FieldRow label="Cost impact (₹)" htmlFor="vo_amount">
        <div className="flex gap-2">
          <div className="flex overflow-hidden rounded-lg border border-input">
            <button
              type="button"
              onClick={() => setSign('add')}
              className={cn(
                'px-4 text-sm font-medium',
                sign === 'add'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground',
              )}
            >
              + Add
            </button>
            <button
              type="button"
              onClick={() => setSign('omit')}
              className={cn(
                'px-4 text-sm font-medium',
                sign === 'omit'
                  ? 'bg-destructive text-destructive-foreground'
                  : 'text-muted-foreground',
              )}
            >
              − Omit
            </button>
          </div>
          <Input
            id="vo_amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-12 flex-1 text-base tabular-nums"
            placeholder="0.00"
          />
        </div>
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" className="h-12" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button className="h-12" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Raising…' : 'Raise variation'}
        </Button>
      </div>
    </div>
  )
}
