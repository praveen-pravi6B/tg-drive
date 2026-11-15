const encoder = new TextEncoder()

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function importAesKey(raw, usage) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage])
}

self.addEventListener('message', async (event) => {
  const { id, type, key, data, aad } = event.data || {}
  try {
    const bytes = new Uint8Array(data)

    if (type === 'encrypt') {
      const cryptoKey = await importAesKey(key, 'encrypt')
      const nonce = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: nonce,
            additionalData: aad ? encoder.encode(aad) : undefined,
            tagLength: 128,
          },
          cryptoKey,
          bytes,
        ),
      )
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const out = new Uint8Array(nonce.length + ciphertext.length)
      out.set(nonce, 0)
      out.set(ciphertext, nonce.length)
      self.postMessage({ id, ok: true, payload: { data: out, sha256: toHex(digest) } }, [out.buffer])
      return
    }

    if (type === 'decrypt') {
      const cryptoKey = await importAesKey(key, 'decrypt')
      const nonce = bytes.subarray(0, 12)
      const ciphertext = bytes.subarray(12)
      const plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: nonce,
            additionalData: aad ? encoder.encode(aad) : undefined,
            tagLength: 128,
          },
          cryptoKey,
          ciphertext,
        ),
      )
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext))
      self.postMessage(
        { id, ok: true, payload: { data: plaintext, sha256: toHex(digest) } },
        [plaintext.buffer],
      )
      return
    }

    if (type === 'digest') {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      self.postMessage({ id, ok: true, payload: { sha256: toHex(digest) } })
      return
    }

    throw new Error(`Unknown crypto job: ${type}`)
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) })
  }
})
