/**
 * Which document kinds may be shared with a client.
 *
 * MIRRORS `fn_doc_kind_shareable` in migration 075, which is the real gate —
 * `fn_set_document_shared` refuses anything not on the list, so this copy only
 * decides whether to OFFER the control. Two copies of a rule is a smell, and
 * the mitigation is that the database one is authoritative and this one can
 * only ever be more restrictive in effect: if they drift, the button appears
 * and the save fails loudly rather than sharing something it should not.
 *
 * Never offer a control the database will refuse — the same reason the toggle
 * is hidden on a confidential document.
 */
const SHAREABLE = new Set([
  '', // a plain upload: drawing, contract, permit, photo
  'variation_order',
  'invoice',
  'qa_plan',
])

/**
 * Excluded, each for its own reason:
 *   rfi                    a question to a consultant, often about a problem
 *   site_instruction       internal direction to the site
 *   ncr                    the firm's own defect record
 *   purchase_order         carries rates
 *   comparative_statement  carries every vendor's quote — never shareable
 */
export function isShareableKind(kind: string | null | undefined): boolean {
  return SHAREABLE.has(kind ?? '')
}

/** For the "why is there no button" line in the vault. */
export const KIND_LABEL: Record<string, string> = {
  rfi: 'RFI',
  site_instruction: 'site instruction',
  ncr: 'non-conformance report',
  purchase_order: 'purchase order',
  comparative_statement: 'rate comparison',
}
