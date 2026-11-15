let worker = null
let sequence = 0
const pending = new Map()

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('../../workers/crypto.worker.js', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event) => {
    const { id, ok, payload, error } = event.data || {}
    const job = pending.get(id)
    if (!job) return
    pending.delete(id)
    if (ok) job.resolve(payload)
    else job.reject(new Error(error || 'Crypto worker error'))
  })
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Crypto worker crashed')
    for (const job of pending.values()) job.reject(error)
    pending.clear()
    worker = null
  })
  return worker
}

function request(type, payload, transfer = []) {
  const instance = ensureWorker()
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    instance.postMessage({ id, type, ...payload }, transfer)
  })
}

function transferable(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer
  return bytes.slice().buffer
}

/**
 * Returns the wire format used on Telegram: 12-byte nonce || AES-GCM ciphertext.
 * The plaintext SHA-256 is computed inside the worker before the buffer is detached.
 */
export function encryptChunk({ key, data, aad }) {
  return request('encrypt', { key, data, aad }, [transferable(data)])
}

export function decryptChunk({ key, data, aad }) {
  return request('decrypt', { key, data, aad }, [transferable(data)])
}

export function sha256Hex(data) {
  return request('digest', { data }, [transferable(data)]).then((result) => result.sha256)
}
