import imageCompression from 'browser-image-compression'
import { supabase } from '@/lib/supabase'

export const RECEIPTS_BUCKET = 'receipts'
export const SITE_PHOTOS_BUCKET = 'site-photos'
export const DOCUMENTS_BUCKET = 'documents'
export const COMPLIANCE_BUCKET = 'compliance'

/** CLAUDE.md rule 3: nothing over 300KB reaches Storage. */
const MAX_SIZE_MB = 0.3

/** Shared compressor — same budget for receipts and site photos. */
export async function compressImage(file: File): Promise<File> {
  return imageCompression(file, {
    maxSizeMB: MAX_SIZE_MB,
    maxWidthOrHeight: 1600,
    useWebWorker: true,
    fileType: 'image/jpeg',
    initialQuality: 0.8,
  })
}

/** @deprecated kept for the Money module's existing import */
export const compressReceipt = compressImage

/**
 * Every object key MUST be `<project_id>/<uuid>.<ext>`. Since migration 006 the
 * storage policies derive the owning project from that leading segment, so a
 * path without it is unreadable by anyone (fn_storage_project returns NULL).
 */
function objectPath(projectId: string, ext: string): string {
  if (!projectId) {
    throw new Error(
      'Refusing to upload without a project id — storage policies key access ' +
        'off the leading path segment (migration 006).',
    )
  }
  return `${projectId}/${crypto.randomUUID()}${ext}`
}

async function upload(
  bucket: string,
  projectId: string,
  file: File,
): Promise<string> {
  const compressed = await compressImage(file)
  const path = objectPath(projectId, '.jpg')

  const { error } = await supabase.storage.from(bucket).upload(path, compressed, {
    contentType: 'image/jpeg',
    upsert: false,
  })

  if (error) throw error
  return path
}

/**
 * Compresses then uploads a receipt photo. Returns the storage path to persist
 * in expenses.receipt_path. Bucket is private — read back via signed URL.
 */
export async function uploadReceipt(
  projectId: string,
  file: File,
): Promise<string> {
  return upload(RECEIPTS_BUCKET, projectId, file)
}

/** Returns the storage path to append to site_logs.photos. */
export async function uploadSitePhoto(
  projectId: string,
  file: File,
): Promise<string> {
  return upload(SITE_PHOTOS_BUCKET, projectId, file)
}

async function signed(
  bucket: string,
  path: string,
  expiresInSeconds: number,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds)

  if (error) return null
  return data.signedUrl
}

export async function signedReceiptUrl(
  path: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  return signed(RECEIPTS_BUCKET, path, expiresInSeconds)
}

export async function signedSitePhotoUrl(
  path: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  return signed(SITE_PHOTOS_BUCKET, path, expiresInSeconds)
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '')
}

/**
 * Vault upload. Images are compressed to the same ≤300KB budget as receipts;
 * everything else (PDF, DOCX, DWG…) is uploaded byte-for-byte — compressing a
 * contract or a drawing would corrupt it.
 *
 * Returns { path, fileType } for the documents row.
 */
export async function uploadDocument(
  projectId: string,
  file: File,
): Promise<{ path: string; fileType: string }> {
  const isImage = file.type.startsWith('image/')
  const payload = isImage ? await compressImage(file) : file
  const ext = isImage ? '.jpg' : extensionOf(file.name)
  const contentType = isImage ? 'image/jpeg' : file.type || 'application/octet-stream'

  const path = objectPath(projectId, ext)

  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(path, payload, { contentType, upsert: false })

  if (error) throw error
  return { path, fileType: contentType }
}

export async function signedDocumentUrl(
  path: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  return signed(DOCUMENTS_BUCKET, path, expiresInSeconds)
}

/**
 * Proof of a statutory filing (migration 028). A GST return belongs to the
 * company, not to a villa, so a company-wide item has no project id to key the
 * path off — those objects go under the literal `company/` prefix, which the
 * bucket's policies accept alongside the usual project-id prefix.
 *
 * PDFs and challans are uploaded byte-for-byte; only images are compressed.
 * A filing acknowledgement that has been re-encoded is not proof of anything.
 */
export async function uploadComplianceProof(
  projectId: string | null,
  file: File,
): Promise<string> {
  const isImage = file.type.startsWith('image/')
  const payload = isImage ? await compressImage(file) : file
  const ext = isImage ? '.jpg' : extensionOf(file.name)
  const contentType = isImage
    ? 'image/jpeg'
    : file.type || 'application/octet-stream'

  const prefix = projectId ?? 'company'
  const path = `${prefix}/${crypto.randomUUID()}${ext}`

  const { error } = await supabase.storage
    .from(COMPLIANCE_BUCKET)
    .upload(path, payload, { contentType, upsert: false })

  if (error) throw error
  return path
}

export async function signedComplianceUrl(
  path: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  return signed(COMPLIANCE_BUCKET, path, expiresInSeconds)
}
