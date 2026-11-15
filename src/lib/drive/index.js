import { aesGcmDecrypt, aesGcmEncrypt, deriveNamedKeyBytes } from '@/lib/crypto/kdf'
import { toArrayBuffer, utf8 } from '@/lib/crypto/bytes'

async function importAesKey(raw) {
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

export const INDEX_VERSION = 1
export const INDEX_FILE_NAME = 'i.bin'
export const INDEX_CAPTION = 'tgi1'

export function indexAad(driveId) {
  return `tgdrive:index-v1:${driveId}`
}

export function emptySnapshot(driveId = '') {
  return { v: INDEX_VERSION, driveId, updatedAt: '', folders: [], files: [], events: [] }
}

export async function sealSnapshot({ masterKey, driveId, snapshot }) {
  if (!masterKey) throw new Error('Vault is locked')
  const rawKey = await deriveNamedKeyBytes(masterKey, 'index-v1')
  const key = await importAesKey(rawKey)
  const base = emptySnapshot(driveId)
  const events = Array.isArray(snapshot?.events) ? snapshot.events : base.events
  const payload = {
    ...base,
    ...snapshot,
    events,
    v: INDEX_VERSION,
    driveId,
    updatedAt: new Date().toISOString(),
  }
  const encrypted = await aesGcmEncrypt(key, utf8(JSON.stringify(payload)), indexAad(driveId))
  return { encrypted, snapshot: payload }
}

export async function openSnapshot({ masterKey, driveId, blob }) {
  if (!masterKey) throw new Error('Vault is locked')
  const rawKey = await deriveNamedKeyBytes(masterKey, 'index-v1')
  const key = await importAesKey(rawKey)
  let plain
  try {
    plain = await aesGcmDecrypt(key, blob, indexAad(driveId))
  } catch {
    throw new Error('Could not decrypt the drive index')
  }
  const snapshot = JSON.parse(new TextDecoder().decode(plain))
  if (snapshot?.v !== INDEX_VERSION) throw new Error('Unsupported index version')
  if (driveId && snapshot.driveId && snapshot.driveId !== driveId) {
    throw new Error('Index belongs to a different drive')
  }
  if (!Array.isArray(snapshot.events)) snapshot.events = []
  return snapshot
}
