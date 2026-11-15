import { aesGcmDecrypt, aesGcmEncrypt, deriveNamedKeyBytes } from '@/lib/crypto/kdf'
import { randomId, toArrayBuffer, utf8 } from '@/lib/crypto/bytes'

export const EVENT_VERSION = 1
export const EVENT_CAPTION = 'tge1'

async function importAesKey(raw) {
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

export function eventAad(driveId, eventId) {
  return `tgdrive:event-v1:${driveId}:${eventId}`
}

export function eventFileName(eventId) {
  return `e_${eventId}.bin`
}

export async function sealEvent({ masterKey, driveId, event }) {
  if (!masterKey) throw new Error('Vault is locked')
  const eventId = event?.id || randomId('e')
  const rawKey = await deriveNamedKeyBytes(masterKey, 'event-v1')
  const key = await importAesKey(rawKey)
  const payload = {
    v: EVENT_VERSION,
    id: eventId,
    type: event?.type || 'unknown',
    at: event?.at || new Date().toISOString(),
    data: event?.data || {},
  }
  const encrypted = await aesGcmEncrypt(
    key,
    utf8(JSON.stringify(payload)),
    eventAad(driveId, eventId),
  )
  return { eventId, encrypted, payload }
}

export async function openEvent({ masterKey, driveId, eventId, blob }) {
  if (!masterKey) throw new Error('Vault is locked')
  const rawKey = await deriveNamedKeyBytes(masterKey, 'event-v1')
  const key = await importAesKey(rawKey)
  const plain = await aesGcmDecrypt(key, blob, eventAad(driveId, eventId))
  const payload = JSON.parse(new TextDecoder().decode(plain))
  if (payload?.v !== EVENT_VERSION) throw new Error('Unsupported event version')
  return payload
}

export function isEventMessage(message) {
  if (!message) return false
  const caption = String(message.caption || message.message || '')
  if (caption !== EVENT_CAPTION) return false
  const attrs = message?.media?.document?.attributes || message?.document?.attributes || []
  const name = attrs.find((a) => a.fileName)?.fileName || ''
  return name.startsWith('e_') && name.endsWith('.bin')
}
