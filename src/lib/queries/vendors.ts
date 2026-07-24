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

export interface UnregisteredVendor {
  vendor_name: string
  uses: number
}

/** Distinct free-text vendor names not yet registered (v_unregistered_vendors). */
export async function fetchUnregisteredVendors(): Promise<UnregisteredVendor[]> {
  const { data, error } = await supabase
    .from('v_unregistered_vendors')
    .select('vendor_name, uses')
  if (error) return []
  return (data ?? []).map((r) => ({
    vendor_name: r.vendor_name as string,
    uses: Number(r.uses),
  }))
}

/**
 * Registers a free-text vendor name and back-links every record that used it
 * (fn_register_vendor, migration 017). Returns the vendor id.
 */
export async function registerFreeTextVendor(name: string): Promise<string> {
  const { data, error } = await supabase.rpc('fn_register_vendor', {
    p_name: name,
  })
  if (error) throw error
  return data as string
}

export async function fetchVendor(id: string): Promise<Vendor | null> {
  const { data, error } = await supabase
    .from('vendors')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return (data as Vendor | null) ?? null
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
