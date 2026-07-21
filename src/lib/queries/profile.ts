import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/types'

export async function fetchMyProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, phone, role, is_active')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  return (data as Profile | null) ?? null
}
