/**
 * Company letterhead details for generated documents (PO, invoices).
 *
 * EDIT THESE ONCE with Your Masons' real registration details. They print on
 * every purchase order PDF. No settings screen yet — this file is the source
 * of truth. (When a company-profile table is added later, load from there.)
 */
export const COMPANY = {
  name: 'Your Masons',
  tagline: 'Luxury Residential Construction',
  // TODO: replace the placeholders below with real details.
  addressLines: [
    '<Bluejay Ardley No.48 Niveditha Doddabele Kengeri Hobli>',
    'Bengaluru, Karnataka <560060>',
  ],
  gstin: '<29AADFY1622P1ZO>',
  phone: '<+91 9986514614>',
  email: '<info@yourmasons.in>',
  // Default GST rate offered when generating a PO. Editable at generation time.
  defaultGstPct: 18,
} as const

/** True while any placeholder is still unedited — used to warn before printing. */
export function companyNeedsSetup(): boolean {
  return (
    COMPANY.gstin.includes('<') ||
    COMPANY.addressLines.some((l) => l.includes('<')) ||
    COMPANY.phone.includes('<')
  )
}
