import { Wallet } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/EmptyState'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { RevealItem, Stagger } from '@/components/Reveal'
import { ListSkeleton } from '@/components/Skeleton'
import { VoidBadge, VoidDialog, VoidNote, voidRowClass } from '@/components/VoidDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { formatInr } from '@/lib/format'
import { fetchCategories } from '@/lib/queries/expenses'
import {
  createPettyCashAccount,
  createPettyCashEntry,
  fetchPettyCashAccounts,
  fetchPettyCashCounts,
  fetchPettyCashEntries,
  recordPettyCashCount,
} from '@/lib/queries/pettyCash'
import { fetchTeam } from '@/lib/queries/admin'
import { compressImage, signedReceiptUrl, uploadReceipt } from '@/lib/storage'
import {
  canManagePettyCash,
  canVoid,
  isVoid,
  PC_ENTRY_LABEL,
  PC_ENTRY_TYPES,
  type ExpenseCategory,
  type PcEntryType,
  type PettyCashAccount,
  type PettyCashCount,
  type PettyCashEntry,
  type TeamMember,
  type UserRole,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { todayIst } from '@/lib/useSelectedDate'
import { useAuth } from '@/store/auth'
import { useProjects } from '@/store/project'

/**
 * M21 PETTY CASH — the screen the module has been missing since migration 002.
 *
 * ONE COMPONENT SERVES BOTH AUDIENCES, because RLS already separates them.
 * `pca_read` / `pce_read` (002, re-emitted with the active check in 078) return
 * an account to its HOLDER or to founder/accounts. So the office opens this and
 * sees every tin on the project; a supervisor opens the same screen and sees
 * the one they hold. Nothing here filters by role to achieve that — writing a
 * client-side filter would be a second copy of the policy, and the two would
 * drift.
 *
 * What role DOES decide is which buttons exist: opening an account is
 * founder/accounts (`pca_write`), and voiding is founder/accounts (the
 * `petty_cash_entries` branch of fn_void_record). Both are hidden rather than
 * shown-and-refused — the repo's standing rule about never offering a control
 * the database will decline.
 *
 * Mounted at /money/petty-cash for the office and /tasks/petty-cash for the
 * holder, because /money is guarded by MONEY_ROLES and a site supervisor is not
 * in it. Same component, two doorways.
 */
export default function PettyCash() {
  const projectId = useProjects((s) => s.selectedId)
  const role = useAuth((s) => s.role)
  const mayManage = canManagePettyCash(role)

  const [accounts, setAccounts] = useState<PettyCashAccount[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      setAccounts(await fetchPettyCashAccounts(projectId))
    } catch (err) {
      toast.error('Could not load petty cash', { description: errText(err) })
      setAccounts([])
    }
  }, [projectId])

  useEffect(() => {
    setAccounts(null)
    setOpenId(null)
    void reload()
  }, [reload])

  if (creating) {
    return (
      <NewAccountForm
        projectId={projectId ?? ''}
        existing={accounts ?? []}
        onDone={() => {
          setCreating(false)
          void reload()
        }}
        onCancel={() => setCreating(false)}
      />
    )
  }

  const open = accounts?.find((a) => a.id === openId) ?? null
  if (open) {
    return (
      <AccountDetail
        account={open}
        role={role}
        onBack={() => {
          setOpenId(null)
          void reload()
        }}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      {mayManage && (
        <Button
          className="h-12 w-full text-base"
          onClick={() => setCreating(true)}
        >
          Open an imprest account
        </Button>
      )}

      {accounts === null && <ListSkeleton rows={3} />}

      {accounts?.length === 0 && (
        <EmptyState
          icon={Wallet}
          title={mayManage ? 'No petty cash on this project' : 'You hold no petty cash here'}
          body={
            mayManage
              ? 'Open an imprest account for whoever holds the cash on site, then every spend they log posts straight to the ledger.'
              : 'If you should be holding a float for this site, ask the office to open an imprest account in your name.'
          }
          actionLabel={mayManage ? 'Open an imprest account' : undefined}
          onAction={mayManage ? () => setCreating(true) : undefined}
        />
      )}

      {accounts && accounts.length > 0 && (
        <Stagger className="card-grid">
          {accounts.map((a) => (
            <RevealItem key={a.id}>
              <AccountCard account={a} onOpen={() => setOpenId(a.id)} />
            </RevealItem>
          ))}
        </Stagger>
      )}
    </div>
  )
}

/* ---------------- Account card ---------------- */

function AccountCard({
  account: a,
  onOpen,
}: {
  account: PettyCashAccount
  onOpen: () => void
}) {
  // A negative tin means more has been spent than was ever handed over — always
  // an error somewhere, so it is coloured as one rather than left to be noticed.
  const negative = a.balance !== null && a.balance < 0

  return (
    <button
      type="button"
      onClick={onOpen}
      className="paper w-full p-5 text-left transition-transform active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[17px] font-semibold">{a.holder_name}</p>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {a.project_name}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            In hand
          </p>
          {a.balance === null ? (
            // Not "₹0.00" — a refused view is a permission result, not an empty
            // tin, and printing zero would state a fact the app doesn't have.
            <p className="mt-0.5 text-sm text-muted-foreground">
              Restricted for your role
            </p>
          ) : (
            <p
              className={cn(
                'font-heading mt-0.5 text-[22px] leading-none font-semibold tabular-nums',
                negative && 'text-destructive',
              )}
            >
              {formatInr(a.balance)}
            </p>
          )}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Imprest {formatInr(a.imprest_amount)}
      </p>
    </button>
  )
}

/* ---------------- Open an account ---------------- */

function NewAccountForm({
  projectId,
  existing,
  onDone,
  onCancel,
}: {
  projectId: string
  existing: PettyCashAccount[]
  onDone: () => void
  onCancel: () => void
}) {
  const [team, setTeam] = useState<TeamMember[] | null>(null)
  const [holder, setHolder] = useState('')
  const [imprest, setImprest] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchTeam()
      .then(setTeam)
      .catch((err) => {
        toast.error('Could not load the team', { description: errText(err) })
        setTeam([])
      })
  }, [])

  // `unique (project_id, holder)` in 002 — one tin per person per project. The
  // form removes people who already have one rather than letting the insert
  // fail on a constraint the person cannot see.
  const taken = new Set(existing.map((a) => a.holder))
  const available = (team ?? []).filter((p) => p.is_active && !taken.has(p.id))

  async function save() {
    const amount = Number(imprest)
    if (!holder) {
      toast.error('Choose who holds the cash')
      return
    }
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('Enter the opening float')
      return
    }
    setBusy(true)
    try {
      await createPettyCashAccount({
        project_id: projectId,
        holder,
        imprest_amount: amount,
      })
      toast.success('Imprest account opened')
      onDone()
    } catch (err) {
      toast.error('Could not open the account', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="paper space-y-4 p-5">
        <h2 className="font-heading text-lg font-semibold">
          Open an imprest account
        </h2>

        <FieldRow
          label="Held by"
          htmlFor="pc-holder"
          hint="One account per person per project."
        >
          <Select
            id="pc-holder"
            value={holder}
            onChange={(e) => setHolder(e.target.value)}
            className="h-12 text-base"
          >
            <option value="">Choose…</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
                {p.designation ? ` · ${p.designation}` : ''}
              </option>
            ))}
          </Select>
        </FieldRow>

        {team !== null && available.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Everyone active on this project already holds an account.
          </p>
        )}

        <FieldRow
          label="Opening float"
          htmlFor="pc-imprest"
          hint="The cash handed over to start. Later top-ups are entries, not edits to this figure."
        >
          <Input
            id="pc-imprest"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={imprest}
            onChange={(e) => setImprest(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="20000"
          />
        </FieldRow>

        <div className="flex gap-2">
          <Button
            className="h-12 flex-1 text-base"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Opening…' : 'Open account'}
          </Button>
          <Button variant="ghost" className="h-12" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- One account ---------------- */

function AccountDetail({
  account: a,
  role,
  onBack,
}: {
  account: PettyCashAccount
  role: UserRole | null
  onBack: () => void
}) {
  const [entries, setEntries] = useState<PettyCashEntry[] | null>(null)
  const [counts, setCounts] = useState<PettyCashCount[]>([])
  const [logging, setLogging] = useState(false)
  const [counting, setCounting] = useState(false)
  const [voiding, setVoiding] = useState<PettyCashEntry | null>(null)

  // fn_void_record's petty_cash_entries branch is founder/accounts only (021).
  const mayVoid = canVoid(role, 'petty_cash_entries')

  const reload = useCallback(async () => {
    try {
      const [e, c] = await Promise.all([
        fetchPettyCashEntries(a.id),
        fetchPettyCashCounts(a.id),
      ])
      setEntries(e)
      setCounts(c)
    } catch (err) {
      toast.error('Could not load the account', { description: errText(err) })
      setEntries([])
    }
  }, [a.id])

  useEffect(() => {
    setEntries(null)
    void reload()
  }, [reload])

  // The closing figure the database computed, which is also what a count is
  // checked against and what gets frozen onto the count row.
  const book = a.balance ?? 0
  const lastCount = counts[0] ?? null

  if (logging) {
    return (
      <EntryForm
        account={a}
        onDone={() => {
          setLogging(false)
          void reload()
          onBack()
        }}
        onCancel={() => setLogging(false)}
      />
    )
  }

  if (counting) {
    return (
      <CountForm
        account={a}
        bookBalance={book}
        onDone={() => {
          setCounting(false)
          void reload()
        }}
        onCancel={() => setCounting(false)}
      />
    )
  }

  return (
    <div className="space-y-4 pb-6">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        ← All accounts
      </button>

      {/* Balance */}
      <div className="paper p-5">
        <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
          {a.holder_name} · {a.project_name}
        </p>
        <p
          className={cn(
            'font-heading mt-1 text-[34px] leading-none font-semibold tabular-nums',
            book < 0 && 'text-destructive',
          )}
        >
          {a.balance === null ? '—' : formatInr(book)}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Opening float {formatInr(a.imprest_amount)}
          {lastCount &&
            ` · last counted ${lastCount.counted_on}${
              lastCount.variance === 0
                ? ' and it matched'
                : ` and it was ${formatInr(Math.abs(lastCount.variance))} ${
                    lastCount.variance < 0 ? 'short' : 'over'
                  }`
            }`}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button className="h-11" onClick={() => setLogging(true)}>
            Log entry
          </Button>
          <Button variant="outline" className="h-11" onClick={() => setCounting(true)}>
            Count the tin
          </Button>
        </div>
      </div>

      {entries === null && <ListSkeleton rows={4} />}

      {entries?.length === 0 && (
        <EmptyState
          icon={Wallet}
          title="Nothing logged yet"
          body="Log a spend as it happens, with a photo of the chit. Every spend posts to the project ledger automatically."
          actionLabel="Log entry"
          onAction={() => setLogging(true)}
        />
      )}

      {entries && entries.length > 0 && (
        <div className="paper divide-y divide-border p-0">
          {/* Newest at the top — the running balance is still computed in date
              order, this only reverses the reading order. */}
          {[...entries].reverse().map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              mayVoid={mayVoid}
              onVoid={() => setVoiding(e)}
            />
          ))}
        </div>
      )}

      {counts.length > 0 && <CountHistory counts={counts} />}

      {voiding && (
        <VoidDialog
          table="petty_cash_entries"
          id={voiding.id}
          summary={`${PC_ENTRY_LABEL[voiding.entry_type]} · ${formatInr(voiding.amount)} · ${voiding.entry_date}`}
          consequence={
            voiding.entry_type === 'spend'
              ? 'The balance goes back up, and the expense this created in the project ledger is reversed with it (020).'
              : 'The balance is restated without this movement. The entry stays on record, marked VOID.'
          }
          onDone={async () => {
            setVoiding(null)
            await reload()
            // The headline balance lives on the account row fetched by the
            // parent, so the list has to re-read for the figure to move.
            onBack()
          }}
          onCancel={() => setVoiding(null)}
        />
      )}
    </div>
  )
}

/* ---------------- One entry ---------------- */

const TYPE_TONE: Record<PcEntryType, string> = {
  top_up: 'text-[var(--positive)]',
  spend: 'text-foreground',
  return: 'text-muted-foreground',
}

function EntryRow({
  entry: e,
  mayVoid,
  onVoid,
}: {
  entry: PettyCashEntry
  mayVoid: boolean
  onVoid: () => void
}) {
  const voided = isVoid(e)
  const [receipt, setReceipt] = useState<string | null>(null)

  async function openReceipt() {
    if (!e.receipt_path) return
    try {
      const url = await signedReceiptUrl(e.receipt_path)
      if (!url) throw new Error('Storage did not return a link.')
      setReceipt(url)
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      toast.error('Could not open the receipt', { description: errText(err) })
    }
  }

  return (
    <div className="px-4 py-3">
      <div className={cn('flex items-start justify-between gap-3', voidRowClass(voided))}>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className={TYPE_TONE[e.entry_type]}>
              {PC_ENTRY_LABEL[e.entry_type]}
            </span>
            {e.category_name && (
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tracking-wider text-muted-foreground uppercase">
                {e.category_name}
              </span>
            )}
            {voided && <VoidBadge className="no-underline" />}
          </p>
          {e.description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{e.description}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {e.entry_date}
            {e.created_by_name && ` · ${e.created_by_name}`}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p
            className={cn(
              'text-sm font-semibold tabular-nums',
              e.entry_type === 'top_up' ? 'text-[var(--positive)]' : 'text-foreground',
            )}
          >
            {e.entry_type === 'top_up' ? '+' : '−'}
            {formatInr(e.amount)}
          </p>
          {/* The balance as it stood after this entry — walked back from the
              figure Postgres computed, never summed in the browser. */}
          {e.running_balance !== null && !voided && (
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {formatInr(e.running_balance)}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {e.receipt_path && (
          <button
            type="button"
            onClick={() => void openReceipt()}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {receipt ? 'Receipt opened' : 'View receipt'}
          </button>
        )}
        {!voided && mayVoid && (
          <button
            type="button"
            onClick={onVoid}
            className="text-xs text-destructive underline underline-offset-4"
          >
            Void
          </button>
        )}
      </div>

      {voided && <VoidNote reason={e.void_reason} by={null} at={e.voided_at} />}
    </div>
  )
}

/* ---------------- Log an entry ---------------- */

function EntryForm({
  account: a,
  onDone,
  onCancel,
}: {
  account: PettyCashAccount
  onDone: () => void
  onCancel: () => void
}) {
  const [type, setType] = useState<PcEntryType>('spend')
  const [date, setDate] = useState(todayIst())
  const [amount, setAmount] = useState('')
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [description, setDescription] = useState('')
  const [receipt, setReceipt] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [kb, setKb] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    fetchCategories()
      .then(setCategories)
      .catch(() => setCategories([]))
  }, [])

  async function pickReceipt(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    try {
      const compressed = await compressImage(file)
      setReceipt(compressed)
      setPreview(URL.createObjectURL(compressed))
      setKb(Math.round(compressed.size / 1024))
    } catch {
      toast.error('Could not process that photo.')
    }
  }

  async function save() {
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter an amount greater than zero')
      return
    }
    setBusy(true)
    try {
      let path: string | null = null
      if (receipt) {
        setStatus('Uploading the receipt…')
        path = await uploadReceipt(a.project_id, receipt)
      }
      setStatus('Saving…')
      await createPettyCashEntry({
        account_id: a.id,
        entry_date: date,
        entry_type: type,
        amount: value,
        category_id: categoryId ? Number(categoryId) : null,
        description,
        receipt_path: path,
      })
      toast.success(`${PC_ENTRY_LABEL[type]} logged`, {
        description:
          type === 'spend'
            ? 'Posted to the project ledger as a petty cash expense.'
            : undefined,
      })
      onDone()
    } catch (err) {
      toast.error('Could not save the entry', { description: errText(err) })
      setBusy(false)
      setStatus(null)
    }
  }

  const hint = PC_ENTRY_TYPES.find((t) => t.value === type)?.hint

  return (
    <div className="space-y-4 pb-6">
      <div className="paper space-y-4 p-5">
        <h2 className="font-heading text-lg font-semibold">
          Log an entry · {a.holder_name}
        </h2>

        <FieldRow label="What happened" htmlFor="pc-type" hint={hint}>
          <Select
            id="pc-type"
            value={type}
            onChange={(e) => setType(e.target.value as PcEntryType)}
            className="h-12 text-base"
          >
            {PC_ENTRY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </FieldRow>

        <FieldRow label="Date" htmlFor="pc-date">
          <Input
            id="pc-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>

        <FieldRow label="Amount" htmlFor="pc-amount">
          <Input
            id="pc-amount"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="0.00"
          />
        </FieldRow>

        {/* Category only on a spend: a top-up or a return is cash moving in or
            out of the tin, not a cost, and never reaches the ledger. */}
        {type === 'spend' && (
          <FieldRow
            label="Category"
            htmlFor="pc-cat"
            hint="Where this lands in the project ledger. Left blank it files under Misc."
          >
            <Select
              id="pc-cat"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="h-12 text-base"
            >
              <option value="">Misc</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FieldRow>
        )}

        <FieldRow label="What for" htmlFor="pc-desc">
          <Textarea
            id="pc-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Auto fare to the hardware shop and back"
          />
        </FieldRow>

        <FieldRow
          label="Receipt photo"
          htmlFor="pc-receipt"
          hint={
            kb !== null
              ? `Compressed to ${kb} KB before upload.`
              : 'Photograph the chit now — it is the only record a cash spend leaves.'
          }
        >
          <Input
            id="pc-receipt"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => void pickReceipt(e.target.files)}
            className="h-12 text-base"
          />
        </FieldRow>

        {preview && (
          <img
            src={preview}
            alt=""
            className="max-h-48 rounded-lg border border-border object-contain"
          />
        )}

        {status && <p className="text-xs text-muted-foreground">{status}</p>}

        <div className="flex gap-2">
          <Button
            className="h-12 flex-1 text-base"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : `Log ${PC_ENTRY_LABEL[type].toLowerCase()}`}
          </Button>
          <Button variant="ghost" className="h-12" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Reconciliation ---------------- */

function CountForm({
  account: a,
  bookBalance,
  onDone,
  onCancel,
}: {
  account: PettyCashAccount
  bookBalance: number
  onDone: () => void
  onCancel: () => void
}) {
  const [countedOn, setCountedOn] = useState(todayIst())
  const [counted, setCounted] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const value = Number(counted)
  const entered = counted.trim() !== '' && Number.isFinite(value)
  const variance = entered ? Number((value - bookBalance).toFixed(2)) : null
  const off = variance !== null && variance !== 0

  async function save() {
    if (!entered || value < 0) {
      toast.error('Enter what you actually counted')
      return
    }
    if (off && note.trim() === '') {
      toast.error('Say why it does not match', {
        description: 'A difference with no explanation is what this screen exists to catch.',
      })
      return
    }
    setBusy(true)
    try {
      await recordPettyCashCount({
        account_id: a.id,
        counted_on: countedOn,
        counted_amount: value,
        // The figure the person is looking at, stored as-is. It is frozen on
        // the row so voiding an old entry later cannot restate what this
        // count was checked against.
        book_balance: bookBalance,
        note,
      })
      toast.success(off ? 'Count recorded with the difference' : 'Counted and it matched')
      onDone()
    } catch (err) {
      toast.error('Could not record the count', { description: errText(err) })
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="paper space-y-4 p-5">
        <h2 className="font-heading text-lg font-semibold">
          Count the tin · {a.holder_name}
        </h2>

        <FieldRow label="Counted on" htmlFor="pcc-date">
          <Input
            id="pcc-date"
            type="date"
            value={countedOn}
            onChange={(e) => setCountedOn(e.target.value)}
            className="h-12 text-base"
          />
        </FieldRow>

        <FieldRow
          label="Cash actually in hand"
          htmlFor="pcc-amount"
          hint="Count the notes and coins, then type the total."
        >
          <Input
            id="pcc-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            className="h-12 text-base tabular-nums"
            placeholder="0.00"
          />
        </FieldRow>

        {/* The comparison, shown as arithmetic rather than one number the
            person has to trust (the 075 rule). */}
        <div className="rounded-lg bg-secondary/50 p-4">
          <Line label="App says" value={formatInr(bookBalance)} />
          <Line label="You counted" value={entered ? formatInr(value) : '—'} />
          <div className="mt-2 border-t border-border pt-2">
            <Line
              label={
                variance === null
                  ? 'Difference'
                  : variance === 0
                    ? 'Matches'
                    : variance < 0
                      ? 'Short by'
                      : 'Over by'
              }
              value={variance === null ? '—' : formatInr(Math.abs(variance))}
              strong
              tone={variance === null ? '' : variance === 0 ? 'text-[var(--positive)]' : 'text-destructive'}
            />
          </div>
        </div>

        {off && (
          <FieldRow
            label="Why"
            htmlFor="pcc-note"
            hint="Required when the count does not match. A CHECK constraint enforces it, not just this form."
          >
            <Textarea
              id="pcc-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="₹500 spent on the sand unloading, chit not yet handed in."
            />
          </FieldRow>
        )}

        {off && (
          <p className="text-xs text-muted-foreground">
            Recording this does not correct the balance. Once you know what the
            difference was, log it as an ordinary entry — the app will not move
            money on your behalf because two numbers disagreed.
          </p>
        )}

        <div className="flex gap-2">
          <Button
            className="h-12 flex-1 text-base"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Record the count'}
          </Button>
          <Button variant="ghost" className="h-12" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

function Line({
  label,
  value,
  strong,
  tone,
}: {
  label: string
  value: string
  strong?: boolean
  tone?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className={cn('text-sm', strong ? 'font-medium' : 'text-muted-foreground')}>
        {label}
      </span>
      <span
        className={cn(
          'tabular-nums',
          strong ? 'font-heading text-lg font-semibold' : 'text-sm',
          tone,
        )}
      >
        {value}
      </span>
    </div>
  )
}

function CountHistory({ counts }: { counts: PettyCashCount[] }) {
  return (
    <div className="paper p-5">
      <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
        Counts
      </p>
      <ul className="mt-3 divide-y divide-border">
        {counts.map((c) => (
          <li key={c.id} className="py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm">{c.counted_on}</span>
              <span
                className={cn(
                  'text-sm font-medium tabular-nums',
                  c.variance === 0 ? 'text-[var(--positive)]' : 'text-destructive',
                )}
              >
                {c.variance === 0
                  ? 'Matched'
                  : `${c.variance < 0 ? 'Short' : 'Over'} ${formatInr(Math.abs(c.variance))}`}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              Counted {formatInr(c.counted_amount)} against {formatInr(c.book_balance)}
              {c.counted_by_name && ` · ${c.counted_by_name}`}
            </p>
            {c.note && <p className="mt-1 text-sm">{c.note}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}
