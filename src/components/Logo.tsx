/**
 * The Your Masons mark.
 *
 * Two forms, because the artwork does not survive being scaled to one size:
 *
 *  - `full`  — the "YM" monogram inside the column-and-beam arch. The thinnest
 *    stroke in it is 8px at the source's 1126px width, i.e. under 1.4px at
 *    192px. It is legible from about 80px up and is what the login screen and
 *    the client portal use.
 *  - `mark`  — the monogram alone, the columns and beam removed. This is what
 *    the small PWA icons are built from, and what to reach for anywhere the
 *    logo has to sit next to a line of text.
 *
 * Both files live in `public/` and are referenced by literal path rather than
 * imported, deliberately: the service worker pre-caches them by name in its
 * SHELL list, and a Vite-hashed URL could not be listed there. Renaming either
 * file means editing `public/sw.js` too.
 *
 * The PNGs are gold on TRANSPARENT, not on the charcoal tile — the tile belongs
 * to the app icon, where the OS decides the surface behind it. On screen the
 * mark sits on whatever the page background is, which is how it stays right if
 * the palette ever changes.
 */

interface LogoProps {
  variant?: 'full' | 'mark'
  /** rendered height in px; the width follows the artwork's own ratio */
  height?: number
  className?: string
}

const ART = {
  full: { src: '/logo-full.png', w: 440, h: 481 },
  mark: { src: '/logo-mark.png', w: 160, h: 202 },
} as const

export function Logo({ variant = 'full', height = 96, className }: LogoProps) {
  const { src, w, h } = ART[variant]

  return (
    <img
      src={src}
      // Decorative: every place this appears already carries the name in text
      // next to it, so announcing "Your Masons logo" would read it twice.
      alt=""
      aria-hidden="true"
      width={Math.round((w / h) * height)}
      height={height}
      style={{ height, width: 'auto' }}
      className={className}
      // The intrinsic size is set above, so the box is reserved before the
      // bytes land and nothing below it jumps.
      decoding="async"
    />
  )
}
