import { type FormEvent, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import { errText } from '@/lib/errText'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/store/auth'

export default function Login() {
  const user = useAuth((s) => s.user)
  const loading = useAuth((s) => s.loading)
  const signIn = useAuth((s) => s.signIn)
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sendingReset, setSendingReset] = useState(false)

  /**
   * Sends a recovery link. It lands on /set-password with `type=recovery`,
   * which the same screen handles — a reset and an invite are the same act
   * from the user's side, so they are the same screen.
   *
   * The success message is deliberately identical whether or not the address
   * exists: telling a stranger "no account with that email" turns the login
   * form into a way to enumerate who the firm works with.
   */
  async function sendReset() {
    const addr = email.trim()
    if (!addr) {
      toast.error('Enter your email address first')
      return
    }
    setSendingReset(true)
    try {
      await supabase.auth.resetPasswordForEmail(addr, {
        redirectTo: `${window.location.origin}/set-password`,
      })
      toast.success('Check your email', {
        description: 'If that address has an account, a reset link is on its way.',
      })
    } catch (err) {
      toast.error('Could not send the reset link', { description: errText(err) })
    }
    setSendingReset(false)
  }

  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from && from !== '/login' ? from : '/dashboard'} replace />
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.')
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-10">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Mason OS
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your Masons — internal site management
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email" className="text-sm">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-12 text-base"
              placeholder="you@yourmasons.in"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-sm">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-12 text-base"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={busy || !email || !password}
            className="h-12 w-full text-base"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>

          {/* Without this, a recovery token can never be generated from inside
              the app, and a client who forgets their password has to telephone
              somebody. */}
          <button
            type="button"
            onClick={() => void sendReset()}
            disabled={sendingReset}
            className="w-full text-center text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {sendingReset ? 'Sending…' : 'Forgot your password?'}
          </button>
        </form>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          Accounts are created by the founder. Contact the office if you can't
          sign in.
        </p>
      </div>
    </div>
  )
}
