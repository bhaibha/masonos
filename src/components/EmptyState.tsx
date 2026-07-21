import type { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Friendly line + one clear primary action. Never a bare "no data".
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  actionLabel,
  actionTo,
  onAction,
}: {
  icon?: LucideIcon
  title: string
  body?: string
  actionLabel?: string
  actionTo?: string
  onAction?: () => void
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      {Icon && (
        <div className="mb-5 flex size-14 items-center justify-center rounded-full bg-secondary">
          <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
        </div>
      )}

      <p className="font-heading text-lg font-medium">{title}</p>
      {body && (
        <p className="mt-1.5 max-w-xs text-sm text-muted-foreground">{body}</p>
      )}

      {/* Base UI's Button has no asChild — style the Link directly. */}
      {actionLabel && actionTo && (
        <Link
          to={actionTo}
          className={cn(buttonVariants(), 'mt-6 h-12 px-6 text-base')}
        >
          {actionLabel}
        </Link>
      )}

      {actionLabel && !actionTo && onAction && (
        <Button onClick={onAction} className="mt-6 h-12 px-6 text-base">
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
