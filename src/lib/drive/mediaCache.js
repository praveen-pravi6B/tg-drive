import Dexie from 'dexie'

const DAY = 24 * 60 * 60 * 1000
const DB_NAME = 'tgdrive-media'

let db

function getDb() {
  if (db) return db
  try {
    db = new Dexie(DB_NAME)
    db.version(1).stores({
      blobs: '&key, expiresAt',
    })
  } catch {
    db = null
  }
  return db
}

function cacheKey(manifest) {
  const id = manifest?.id || 'unknown'
  const version = manifest?.hash || manifest?.updatedAt || manifest?.createdAt || 'v1'
  return `${id}:${version}`
}

export async function getCachedBlob(manifest) {
  const database = getDb()
  if (!database || !manifest?.id) return null
  const key = cacheKey(manifest)
  try {
    const row = await database.table('blobs').get(key)
    if (!row) return null
    if (!row.expiresAt || row.expiresAt <= Date.now() || !row.blob) {
      await database.table('blobs').delete(key).catch(() => {})
      return null
    }
    return row.blob
  } catch {
    return null
  }
}

export async function putCachedBlob(manifest, blob) {
  const database = getDb()
  if (!database || !manifest?.id || !blob) return
  const key = cacheKey(manifest)
  const now = Date.now()
  try {
    await database.table('blobs').put({
      key,
      id: manifest.id,
      hash: manifest.hash || '',
      mime: blob.type || manifest.mime || 'application/octet-stream',
      size: blob.size || 0,
      blob,
      cachedAt: now,
      expiresAt: now + DAY,
    })
  } catch {
    /* best-effort cache */
  }
}

export async function pruneExpiredBlobs() {
  const database = getDb()
  if (!database) return
  try {
    await database.table('blobs').where('expiresAt').belowOrEqual(Date.now()).delete()
  } catch {
    /* ignore */
  }
}

export async function clearMediaCache() {
  const database = getDb()
  if (!database) return
  try {
    await database.table('blobs').clear()
  } catch {
    /* ignore */
  }
}
