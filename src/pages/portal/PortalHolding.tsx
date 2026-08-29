import { LogOut } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/store/auth'

interface ClientProject {
  name: string
  client_name: string | null
  status: string
}

/**
 * Where a client lands until the portal itself is built (CP3).
 *
 * DELIBERATELY ALMOST EMPTY. It shows their project name — proof to them that
 * the account is correctly linked, and proof to us that `v_client_project` and
 * `fn_client_project()` work end to end through a real session — and nothing
 * else. No figures, no progress, no documents.
 *
 * The temptation with a holding page is to "put something useful on it while we
 * are here". Everything useful is exactly the material that needs the curated
 * screens designed properly, so this stays a door rather than becoming a
 * half-built room nobody revisits.
 */
export default function PortalHolding() {
  const profile = useAuth((s) => s.profile)
  const signOut = useAuth((s) => s.signOut)

  const [project, setProject] = useState<ClientProject | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    // The only query on this page, and it is the curated view — never
    // `projects` directly, which correctly returns nothing to a client.
    supabase
      .from('v_client_project')
      .select('name, client_name, status')
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setProject((data as ClientProject | null) ?? null)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b border-border">
        <div className="page-w flex items-center justify-between gap-3 px-5 pt-6 pb-5">
          <div className="min-w-0">
            <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Your Masons
            </p>
            <h1 className="font-heading mt-0.5 text-[24px] leading-none font-semibold">
              Client portal
            </h1>
            <p className="mt-1.5 truncate text-xs text-muted-foreground">
              {profile?.full_name ?? '—'}
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

      <main className="page-w flex-1 px-5 py-10">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : project ? (
          <div className="paper p-6">
            <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
              Your project
            </p>
            <p className="font-heading mt-1 text-[22px] leading-tight font-semibold">
              {project.name}
            </p>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              Your portal is being prepared. Progress, photos, documents,
              invoices and approvals will appear here.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              In the meantime your project team is the fastest way to get an
              answer.
            </p>
          </div>
        ) : (
          /* No linked project. Says what to do rather than just what is wrong —
             this is the state a client hits if the founder created the account
             but has not linked it yet, and they cannot fix it themselves. */
          <div className="paper p-6">
            <p className="font-heading text-[18px] font-semibold">
              Your account is not linked to a project yet
            </p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Please contact your project team and they will finish setting this
              up. Nothing is wrong with your sign-in.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
