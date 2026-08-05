/**
 * Sending a generated document to the party it's addressed to.
 *
 * Nothing here talks to WhatsApp's API — there isn't one in this stack, and
 * adding a provider for a message a person can send in two taps would be the
 * wrong trade. Instead:
 *
 *   • On a phone, the browser's own share sheet takes the PDF and lets the user
 *     pick WhatsApp. The vendor receives the actual file.
 *   • Where that isn't available (most desktops), the PDF downloads and
 *     WhatsApp Web opens with the message already written, ready for the file
 *     to be attached.
 *
 * It stops short of automatic — you still tap send — and that is deliberate:
 * an app that silently messages a client's consultant on your behalf is a
 * liability, not a feature.
 */

/** Digits only, with India's country code when none was given. */
export function waNumber(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 10) return null
  if (digits.length === 10) return `91${digits}`
  // Already carries a country code (91XXXXXXXXXX, or a longer foreign number).
  return digits.replace(/^0+/, '')
}

export interface ShareDocOpts {
  /** the generated PDF */
  file: File
  /** message body — the file is attached separately, so this must stand alone */
  message: string
  /** recipient's phone, if known */
  phone?: string | null
  /** what to call it in toasts, e.g. "RFI-0007" */
  label: string
}

export type ShareOutcome =
  | 'shared'
  | 'downloaded-and-opened-whatsapp'
  | 'cancelled'

/**
 * Returns what actually happened so the caller can word its toast honestly
 * rather than claiming "sent" when the user backed out of the share sheet.
 */
export async function shareDocument(
  opts: ShareDocOpts,
): Promise<ShareOutcome> {
  const { file, message, phone, label } = opts

  // canShare({ files }) is the only reliable test — Safari exposes share()
  // without file support, and calling it with files there throws.
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
  }

  if (
    typeof nav.share === 'function' &&
    typeof nav.canShare === 'function' &&
    nav.canShare({ files: [file] })
  ) {
    try {
      await nav.share({ files: [file], text: message, title: label })
      return 'shared'
    } catch (err) {
      // AbortError means the user closed the sheet — not a failure worth an
      // error toast. Anything else falls through to the download path.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return 'cancelled'
      }
    }
  }

  // ---------- fallback: download, then open WhatsApp with the text ----------
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)

  const to = waNumber(phone)
  const wa = to
    ? `https://wa.me/${to}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`

  window.open(wa, '_blank', 'noopener')
  return 'downloaded-and-opened-whatsapp'
}
