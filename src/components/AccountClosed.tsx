import { Lock } from 'lucide-react'
import { useState } from 'react'
import { FadeUp } from '@/components/Reveal'
import { Button } from '@/components/ui/button'
import { APP_NAME } from '@/lib/appName'
import { useAuth } from '@/store/auth'

/**
 * WHAT A DEACTIVATED ACCOUNT SEES (078).
 *
 * Migration 078 made `profiles.is_active` load-bearing: my_role() returns NULL
 * for a deactivated account, so every policy in the database refuses. Without
 * this screen that person would still sign in successfully — Supabase issues a
 * JWT either way — and land on a dashboard where every card reads zero and
 * every list is empty.
 *
 * That is the failure this repo has a rule about (056, 063, 066): a row of
 * zeros reads as a fact about the company rather than a refusal. "No expenses
 * on Villa Aadhya" and "you no longer have access" look identical, and the
 * first one is a lie.
 *
 * So it is said in a sentence, with the only two things they can actually do:
 * sign out, or talk to a person. No support form, no retry button — neither
 * would change anything, and an accurate message with no action is a dead end
 * (the 054/057 lesson).
 */
export function AccountClosed() {
  const signOut = useAuth((s) => s.signOut)
  const profile = useAuth((s) => s.profile)
  const [signingOut, setSigningOut] = useState(false)

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b border-border">
        <div className="page-w px-5 pt-8 pb-6">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Your Masons
          </p>
          <h1 className="font-heading mt-0.5 text-[26px] leading-none font-semibold">
            {APP_NAME}
          </h1>
        </div>
      </header>

      <main className="page-w flex-1 px-5 py-10">
        <FadeUp>
          <div className="paper p-6">
            <div className="flex items-start gap-3">
              <Lock
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div>
                <p className="font-heading text-[19px] leading-tight font-semibold">
                  This account is no longer active
                </p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {profile?.full_name ? `${profile.full_name}, your ` : 'Your '}
                  access to {APP_NAME} has been switched off. Nothing here will
                  load until somebody at Your Masons turns it back on.
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  If you think this is a mistake, speak to whoever set up your
                  account — they can reactivate it in a moment.
                </p>
              </div>
            </div>

            <Button
              type="button"
              className="mt-6 h-12 w-full text-base"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true)
                void signOut()
              }}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </FadeUp>
      </main>
    </div>
  )
}
