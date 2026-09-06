import { KeyRound, Mail } from 'lucide-react'
import type { CreateMode } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * HOW THIS PERSON GETS IN — one control, shared by the Team form and the
 * Clients form so the two cannot drift apart in wording or behaviour.
 *
 * Both paths produce the same account. They differ in one thing that matters:
 * who ends up knowing the password.
 *
 * `direct` is FIRST and is the default, because it is the one that works today
 * — Supabase will not deliver mail to anybody outside the project team until
 * custom SMTP is configured, so an invite silently fails on a fresh project.
 * Offering it first would be offering the broken one first.
 */
export function CreateModePicker({
  value,
  onChange,
  who,
}: {
  value: CreateMode
  onChange: (m: CreateMode) => void
  /** 'them' for staff, 'your client' — only changes the copy. */
  who: string
}) {
  return (
    <div>
      <p className="text-sm leading-none font-medium">How they get in</p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Option
          active={value === 'direct'}
          onClick={() => onChange('direct')}
          icon={KeyRound}
          title="Set a password"
          body={`You choose a password and give it to ${who}. Works with no email at all. They must change it the first time they sign in.`}
        />
        <Option
          active={value === 'invite'}
          onClick={() => onChange('invite')}
          icon={Mail}
          title="Send an invitation"
          body={`${who[0].toUpperCase()}${who.slice(1)} gets an email and chooses their own password, so nobody here ever knows it. Needs email to be set up.`}
        />
      </div>
    </div>
  )
}

function Option({
  active,
  onClick,
  icon: Icon,
  title,
  body,
}: {
  active: boolean
  onClick: () => void
  icon: typeof KeyRound
  title: string
  body: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-xl border p-3.5 text-left transition-colors',
        active
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-foreground/20',
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'size-4 shrink-0',
            active ? 'text-primary' : 'text-muted-foreground',
          )}
          aria-hidden="true"
        />
        <span className={cn('text-sm', active && 'font-medium')}>{title}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {body}
      </p>
    </button>
  )
}
