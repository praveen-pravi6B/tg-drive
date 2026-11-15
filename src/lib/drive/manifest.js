import { aesGcmDecrypt, aesGcmEncrypt, deriveFileKeyBytes } from '@/lib/crypto/kdf'
import { fromBase64, toBase64, utf8 } from '@/lib/crypto/bytes'

export const MANIFEST_VERSION = 1
export const MANIFEST_CAPTION_PREFIX = 'tgm1:'

export function manifestCaption(fileId) {
  return `${MANIFEST_CAPTION_PREFIX}${fileId}`
}

export function parseManifestCaption(caption) {
  const value = String(caption || '')
  if (!value.startsWith(MANIFEST_CAPTION_PREFIX)) return null
  return value.slice(MANIFEST_CAPTION_PREFIX.length).trim() || null
}

export function manifestAad(fileId) {
  return `manifest-v1:${fileId}`
}

export function fileCategory(mime = '', name = '') {
  const type = String(mime || '').toLowerCase()
  const lower = String(name || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'document'
  if (type.startsWith('text/') || /\.(pdf|docx?|xlsx?|pptx?|csv|md|txt|rtf)$/i.test(lower)) {
    return 'document'
  }
  return 'other'
}

export async function sealManifest({ masterKey, manifest }) {
  if (!masterKey) throw new Error('Vault is locked')
  if (!manifest?.id) throw new Error('Manifest id is required')
  const key = await deriveFileKeyBytes(masterKey, manifest.id)
  const plain = utf8(JSON.stringify(manifest))
  const encrypted = await aesGcmEncrypt(key, plain, manifestAad(manifest.id))
  return { encrypted, fileKey: key }
}

export async function openManifest({ masterKey, fileId, blob }) {
  if (!masterKey) throw new Error('Vault is locked')
  if (!fileId) throw new Error('File id is required')
  const key = await deriveFileKeyBytes(masterKey, fileId)
  let plain
  try {
    plain = await aesGcmDecrypt(key, blob, manifestAad(fileId))
  } catch {
    throw new Error('Could not decrypt file metadata')
  }
  const manifest = JSON.parse(new TextDecoder().decode(plain))
  if (manifest?.v !== MANIFEST_VERSION || manifest.id !== fileId) {
    throw new Error('File metadata is invalid')
  }
  return { manifest, fileKey: key }
}

// Helpers for any future JSON-safe binary fields.
export const b64 = { encode: toBase64, decode: fromBase64 }
