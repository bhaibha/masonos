import { supabase } from '@/lib/supabase'

/**
 * PUBLISHING TO THE CLIENT PORTAL (migrations 065 + 068).
 *
 * Publishing lives with the thing being published — a photo is published from
 * the site log, a document is shared from the vault — never from an Admin
 * screen. Two places to manage visibility means the two eventually disagree,
 * and the disagreement is silent.
 *
 * A published photo is its OWN ROW rather than a flag on site_logs.photos,
 * because publishing is an act with an author and a time (065). It also means a
 * unique index on photo_path can stop a double tap showing the client the same
 * picture twice.
 */

export interface PublishedPhoto {
  id: string
  photo_path: string
  caption: string | null
}

/** Which of these paths are already published, so the UI can show the state. */
export async function fetchPublishedPhotos(
  projectId: string,
  paths: string[],
): Promise<Record<string, PublishedPhoto>> {
  if (paths.length === 0) return {}

  const { data, error } = await supabase
    .from('client_photos')
    .select('id, photo_path, caption')
    .eq('project_id', projectId)
    .in('photo_path', paths)

  if (error) throw error

  const map: Record<string, PublishedPhoto> = {}
  for (const r of (data ?? []) as PublishedPhoto[]) map[r.photo_path] = r
  return map
}

/**
 * Publish one photo. `published_by` and `published_at` default in the database,
 * so the record of who showed the client what cannot be supplied by the caller.
 */
export async function publishPhoto(
  projectId: string,
  photoPath: string,
  caption?: string,
): Promise<void> {
  const { error } = await supabase.from('client_photos').insert({
    project_id: projectId,
    photo_path: photoPath,
    caption: caption?.trim() || null,
  })
  if (error) throw error
}

/**
 * Unpublish. Deletes the row, which withdraws BOTH the listing and the storage
 * grant in the same instant — 068's policy permits an object only while a
 * matching row exists, so an old signed URL stops working rather than quietly
 * continuing to serve the file.
 *
 * A hard delete is right here: this is not a financial or stock record, and
 * "we showed them this picture and then stopped" is carried by the audit log on
 * client_photos rather than by keeping a tombstone row.
 */
export async function unpublishPhoto(photoPath: string): Promise<void> {
  const { error } = await supabase
    .from('client_photos')
    .delete()
    .eq('photo_path', photoPath)
  if (error) throw error
}
