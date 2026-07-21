import { supabase } from '@/lib/supabase'
import type { NewVendor, Vendor } from '@/lib/types'

const COLUMNS = 'id, name, phone, gstin, category, is_active'

/**
 * RLS `vendors_read` restricts the whole table to founder/pm/accounts, so a
 * supervisor gets an empty list rather than an error. That's the same role set
 * as MONEY_ROLES, which already gates the /money route.
 */
export async function fetchVendors(includeInactive = false): Promise<Vendor[]> {
  let q = supabase.from('vendors').select(COLUMNS).order('name')
  if (!includeInactive) q = q.eq('is_active', true)

  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as Vendor[]
}

/** Returns the created row so callers can select it straight away. */
export async function createVendor(input: NewVendor): Promise<Vendor> {
  const { data, error } = await supabase
    .from('vendors')
    .insert({
      name: input.name,
      phone: input.phone || null,
      gstin: input.gstin || null,
      category: input.category || null,
    })
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data as Vendor
}

export async function updateVendor(
  id: string,
  input: NewVendor,
): Promise<Vendor> {
  const { data, error } = await supabase
    .from('vendors')
    .update({
      name: input.name,
      phone: input.phone || null,
      gstin: input.gstin || null,
      category: input.category || null,
    })
    .eq('id', id)
    .select(COLUMNS)
    .single()

  if (error) throw error
  return data as Vendor
}

/**
 * Soft delete. Expenses and inward rows reference vendors by id, so a hard
 * delete would either fail on the FK or orphan history.
 */
export async function setVendorActive(
  id: string,
  isActive: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('vendors')
    .update({ is_active: isActive })
    .eq('id', id)

  if (error) throw error
}
