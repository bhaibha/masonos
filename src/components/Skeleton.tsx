import { cn } from '@/lib/utils'

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
    />
  )
}

/** Matches the shape of a dashboard project card so nothing jumps on load. */
export function ProjectCardSkeleton() {
  return (
    <div className="paper p-6">
      <div className="flex items-start justify-between gap-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <div className="mt-6 flex items-end justify-between gap-4">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="mt-3 h-3.5 w-28" />
      <Skeleton className="mt-8 h-[6px] w-full rounded-full" />
      <div className="mt-6 flex gap-6 border-t border-border pt-4">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3.5 w-24" />
      </div>
    </div>
  )
}

/** Generic airy row skeleton for ledgers and lists. */
export function RowSkeleton() {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-5 w-20" />
    </div>
  )
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="paper divide-y divide-border overflow-hidden">
      {Array.from({ length: rows }, (_, i) => (
        <RowSkeleton key={i} />
      ))}
    </div>
  )
}
