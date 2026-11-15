const encoder = new TextEncoder()

export function utf8(text) {
  return encoder.encode(text)
}

export function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function fromBase64(value) {
  const binary = atob(String(value))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((sum, array) => sum + array.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const array of arrays) {
    out.set(array, offset)
    offset += array.length
  }
  return out
}

export function toArrayBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer
  return bytes.slice().buffer
}

export function randomBytes(length) {
  const out = new Uint8Array(length)
  // WebCrypto caps getRandomValues at 65,536 bytes per call.
  for (let offset = 0; offset < length; offset += 0x10000) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 0x10000, length)))
  }
  return out
}

export function randomId(prefix = 'f') {
  return `${prefix}_${toHex(randomBytes(12))}`
}
