import { supabase } from '@/lib/supabase'
import type { NewSiteLog, SiteLogRow } from '@/lib/types'

const COLUMNS =
  'id, project_id, log_date, weather, labour_mason, labour_helper, labour_other, work_summary, issues, photos, created_by'

/**
 * The signed-in user's own log for a project on a date.
 *
 * NOTE: site_logs is unique on (project_id, log_date, created_by), so the
 * schema permits one log per *user* per day, not one per project per day.
 * This reads and writes only the caller's own row — matching logs_update,
 * which allows `created_by = auth.uid() or is_founder()`.
 */
export async function fetchMySiteLog(
  projectId: string,
  date: string,
  userId: string,
): Promise<SiteLogRow | null> {
  const { data, error } = await supabase
    .from('site_logs')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .eq('log_date', date)
    .eq('created_by', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as unknown as SiteLogRow
  return { ...row, photos: row.photos ?? [] }
}

/** Every log filed for a project on a date, by anyone (RLS: is_member). */
export async function fetchSiteLogsForDate(
  projectId: string,
  date: string,
): Promise<SiteLogRow[]> {
  const { data, error } = await supabase
    .from('site_logs')
    .select(COLUMNS)
    .eq('project_id', projectId)
    .eq('log_date', date)
    .order('created_at')

  if (error) throw error
  return (data ?? []).map((r) => {
    const row = r as unknown as SiteLogRow
    return { ...row, photos: row.photos ?? [] }
  })
}

export async function upsertSiteLog(input: NewSiteLog): Promise<void> {
  const { error } = await supabase.from('site_logs').upsert(
    {
      project_id: input.project_id,
      log_date: input.log_date,
      weather: input.weather || null,
      labour_mason: input.labour_mason,
      labour_helper: input.labour_helper,
      labour_other: input.labour_other,
      work_summary: input.work_summary || null,
      issues: input.issues || null,
      photos: input.photos,
      created_by: input.created_by,
    },
    { onConflict: 'project_id,log_date,created_by' },
  )
  if (error) throw error
}
