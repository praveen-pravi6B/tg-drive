const DEFAULT_CHUNK_SIZE = 20 * 1024 * 1024
const DEFAULT_MAX_FILE_SIZE = 200 * 1024 * 1024
const API_STORAGE_KEY = 'tgdrive.api.v1'

export const appInfo = {
  name: 'TGDrive',
  version: '0.1.0',
  groupPrefix: 'TGDrive',
  aboutPrefix: 'tgdrive:',
}

function readStoredCredentials() {
  try {
    const raw = localStorage.getItem(API_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.apiId || !parsed?.apiHash) return null
    return parsed
  } catch {
    return null
  }
}

export function getApiCredentials() {
  const stored = readStoredCredentials()
  const envId = Number(import.meta.env.VITE_TG_API_ID || 0)
  const envHash = import.meta.env.VITE_TG_API_HASH || ''
  return {
    apiId: Number(stored?.apiId || envId || 0),
    apiHash: String(stored?.apiHash || envHash || ''),
    source: stored ? 'local' : envId && envHash ? 'env' : 'none',
  }
}

export function setApiCredentials(apiId, apiHash) {
  localStorage.setItem(
    API_STORAGE_KEY,
    JSON.stringify({ apiId: Number(apiId), apiHash: String(apiHash).trim() }),
  )
}

export function clearApiCredentials() {
  localStorage.removeItem(API_STORAGE_KEY)
}

export function hasCredentials() {
  const { apiId, apiHash } = getApiCredentials()
  return Number.isFinite(apiId) && apiId > 0 && apiHash.length >= 16
}

const envChunkSize = Number(import.meta.env.VITE_TG_CHUNK_SIZE || 0)

export const limits = {
  chunkSize: envChunkSize > 0 ? envChunkSize : DEFAULT_CHUNK_SIZE,
  maxFileSize: DEFAULT_MAX_FILE_SIZE,
  maxChunkSize: 45 * 1024 * 1024,
  previewMaxSize: 50 * 1024 * 1024,
  uploadConcurrency: 1,
  trashRetentionDays: 30,
}

export const storageKeys = {
  session: 'tgdrive.session.v1',
  debugGroup: 'tgdrive.debug.group.v1',
  debugTopic: 'tgdrive.debug.topic.v1',
  debugDriveId: 'tgdrive.debug.driveid.v1',
  drive: 'tgdrive.drive.v1',
  vault: 'tgdrive.vault.v1',
}
