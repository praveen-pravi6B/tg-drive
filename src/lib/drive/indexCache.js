const DB_NAME = 'tgdrive-index-v1'
const STORE = 'index'
const DB_VERSION = 1

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error || new Error('Failed to open index cache'))
    } catch (error) {
      reject(error)
    }
  }).catch((error) => {
    dbPromise = null
    throw error
  })
  return dbPromise
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getCachedIndex(driveId) {
  if (!driveId) return null
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const entry = await requestToPromise(store.get(String(driveId)))
    if (!entry?.bytes) return null
    return {
      driveId: String(driveId),
      messageId: Number(entry.messageId || 0),
      bytes: entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes),
      updatedAt: Number(entry.updatedAt || 0),
    }
  } catch {
    return null
  }
}

export async function putCachedIndex({ driveId, messageId, bytes }) {
  if (!driveId || !bytes) return
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    await requestToPromise(
      store.put(
        {
          driveId: String(driveId),
          messageId: Number(messageId || 0),
          bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
          updatedAt: Date.now(),
        },
        String(driveId),
      ),
    )
  } catch {
    /* cache is best-effort */
  }
}

export async function clearCachedIndex(driveId) {
  if (!driveId) return
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, 'readwrite')
    await requestToPromise(tx.objectStore(STORE).delete(String(driveId)))
  } catch {
    /* ignore */
  }
}
