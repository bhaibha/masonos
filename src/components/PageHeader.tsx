import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/store/auth'

export function PageHeader({
  title,
  eyebrow,
}: {
  title: string
  eyebrow?: string
}) {
  const profile = useAuth((s) => s.profile)
  const role = useAuth((s) => s.role)
  const signOut = useAuth((s) => s.signOut)

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-lg items-center justify-between gap-3 px-5 pt-5 pb-4">
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
    </header>
  )
}
