import Dexie from 'dexie'

const DB_NAME = 'tgdrive-uploads-v1'

let db

function getDb() {
  if (db) return db
  try {
    db = new Dexie(DB_NAME)
    db.version(1).stores({
      sessions: '&key, driveId, updatedAt',
    })
  } catch {
    db = null
  }
  return db
}

export function uploadSessionKey({ driveId, topicId, file }) {
  const name = String(file?.name || '')
  const size = Number(file?.size || 0)
  const modified = Number(file?.lastModified || 0)
  return `${driveId || ''}:${Number(topicId || 0)}:${size}:${modified}:${name}`
}

export async function getUploadSession(key) {
  const database = getDb()
  if (!database || !key) return null
  try {
    const row = await database.table('sessions').get(key)
    return row || null
  } catch {
    return null
  }
}

export async function putUploadSession(session) {
  const database = getDb()
  if (!database || !session?.key) return
  try {
    await database.table('sessions').put({
      ...session,
      updatedAt: Date.now(),
    })
  } catch {
    /* best-effort */
  }
}

export async function deleteUploadSession(key) {
  const database = getDb()
  if (!database || !key) return
  try {
    await database.table('sessions').delete(key)
  } catch {
    /* ignore */
  }
}

export async function pruneUploadSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const database = getDb()
  if (!database) return
  try {
    const cutoff = Date.now() - maxAgeMs
    await database.table('sessions').where('updatedAt').below(cutoff).delete()
  } catch {
    /* ignore */
  }
}
