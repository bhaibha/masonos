import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/types'

const BASE = 'id, full_name, phone, role, is_active'
const FULL = `${BASE}, designation, must_change_password`

function toProfile(r: Record<string, unknown>): Profile {
  return {
    id: r.id as string,
    full_name: (r.full_name as string) ?? '',
    phone: (r.phone as string | null) ?? null,
    role: r.role as Profile['role'],
    is_active: Boolean(r.is_active),
    designation: (r.designation as string | null) ?? null,
    // Absent until 077 is applied; absent means "nothing to force".
    must_change_password: Boolean(r.must_change_password),
  }
}

/**
 * `designation` arrives with 019 and `must_change_password` with 077. Until
 * those are applied PostgREST rejects the column list, so we retry without them
 * — the same pattern used for v_project_spend's 007 columns. Sign-in must never
 * break on a pending migration.
 */
export async function fetchMyProfile(userId: string): Promise<Profile | null> {
  const full = await supabase
    .from('profiles')
    .select(FULL)
    .eq('id', userId)
    .maybeSingle()

  if (!full.error) {
    return full.data ? toProfile(full.data as Record<string, unknown>) : null
  }

  const { data, error } = await supabase
    .from('profiles')
    .select(BASE)
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  return data ? toProfile(data as Record<string, unknown>) : null
}
