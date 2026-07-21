import { Toaster as Sonner } from 'sonner'

/**
 * Toasts inherit the design tokens rather than sonner's defaults, so a success
 * is brass-on-paper and an error is the same warm danger red used in-page.
 * Positioned top-centre: on a phone the bottom is the tab bar and the thumb.
 */
export function Toaster() {
  return (
    <Sonner
      position="top-center"
      offset={12}
      duration={3200}
      toastOptions={{
        classNames: {
          toast:
            'group flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-[var(--shadow-card-lift)]',
          title: 'font-medium',
          description: 'text-muted-foreground',
          success: '[&_[data-icon]]:text-[var(--positive)]',
          warning: '[&_[data-icon]]:text-[var(--warning)]',
          error: '[&_[data-icon]]:text-destructive',
          actionButton:
            'rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground',
        },
      }}
    />
  )
}
