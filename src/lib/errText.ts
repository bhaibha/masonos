/**
 * Human-readable message from any thrown value. Supabase / PostgREST errors are
 * plain objects (not `Error` instances), so `err instanceof Error` misses them
 * and toasts show no detail. This digs the message out of both shapes.
 */
export function errText(err: unknown): string | undefined {
  if (!err) return undefined
  if (err instanceof Error) return err.message
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>
    const parts = [o.message, o.details, o.hint]
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
    if (parts.length > 0) return parts.join(' — ')
  }
  return typeof err === 'string' ? err : undefined
}
