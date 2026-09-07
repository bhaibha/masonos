import { LogOut, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '@/store/auth'

export function PageHeader({
  title,
  eyebrow,
  width = 'list',
}: {
  title: string
  eyebrow?: string
  /**
   * Must match the width of the page underneath it, or on a wide screen the
   * title sits at a different left edge from the content it labels — which
   * reads as a broken layout rather than a design choice.
   */
  width?: 'list' | 'wide'
}) {
  const profile = useAuth((s) => s.profile)
  const role = useAuth((s) => s.role)
  const signOut = useAuth((s) => s.signOut)

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-xl">
      <div
        className={cn(
          width === 'wide' ? 'page-w-wide' : 'page-w',
          'flex items-center justify-between gap-3 px-5 pt-5 pb-4',
        )}
      >
        <div className="min-w-0">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            {eyebrow ?? 'Your Masons'}
          </p>
          <h1 className="font-heading mt-0.5 text-[26px] leading-none font-semibold">
            {title}
          </h1>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">
            {profile?.full_name ?? '—'}
            {role && <span className="capitalize"> · {role}</span>}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Two-factor lives next to sign out because that is where people
              look for anything about their own account, and it is the only
              other thing in this header that is about the PERSON rather than
              the project. */}
          {/* A Link wearing the button's own classes — this Button has no
              `asChild`, and nesting an anchor inside a <button> is invalid
              HTML that breaks keyboard navigation. */}
          <Link
            to="/security"
            aria-label="Security"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'icon-lg' }),
              'text-muted-foreground',
            )}
          >
            <ShieldCheck className="size-[18px]" />
          </Link>

          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Sign out"
            onClick={() => void signOut()}
            className="text-muted-foreground"
          >
            <LogOut className="size-[18px]" />
          </Button>
        </div>
      </div>
    </header>
  )
}
