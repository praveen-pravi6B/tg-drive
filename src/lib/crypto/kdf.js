import { argon2id } from 'hash-wasm'
import { concatBytes, randomBytes, toArrayBuffer, utf8 } from './bytes'

const HKDF_SALT = utf8('tgdrive-hkdf-v1')
const AES_GCM = { name: 'AES-GCM', length: 256 }

async function importHkdfKey(rawMaster) {
  return crypto.subtle.importKey('raw', toArrayBuffer(rawMaster), 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ])
}

export function generateMasterKey() {
  return randomBytes(32)
}

export async function deriveFileKeyBytes(masterRaw, fileId) {
  const base = await importHkdfKey(masterRaw)
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT,
      info: utf8(`file-v1:${fileId}`),
    },
    base,
    256,
  )
  return new Uint8Array(bits)
}

export async function deriveNamedKeyBytes(masterRaw, info) {
  const base = await importHkdfKey(masterRaw)
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: utf8(info) },
    base,
    256,
  )
  return new Uint8Array(bits)
}

export async function deriveVaultKey(masterRaw) {
  const raw = await deriveNamedKeyBytes(masterRaw, 'vault-v1')
  return crypto.subtle.importKey('raw', raw, AES_GCM, false, ['encrypt', 'decrypt'])
}

/**
 * Argon2id is the preferred passphrase KDF. Parameters are stored with the
 * vault so they can be raised later without breaking older vaults.
 */
export async function deriveKekArgon2id(passphrase, salt, options = {}) {
  const params = {
    iterations: 3,
    parallelism: 1,
    memorySize: 64 * 1024,
    hashLength: 32,
    ...options,
  }
  const raw = await argon2id({
    password: utf8(passphrase),
    salt,
    outputType: 'binary',
    ...params,
  })
  const key = await crypto.subtle.importKey('raw', raw, AES_GCM, false, ['encrypt', 'decrypt'])
  return { key, params }
}

export async function deriveKekPbkdf2(passphrase, salt, iterations = 600000) {
  const material = await crypto.subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ])
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    AES_GCM,
    false,
    ['encrypt', 'decrypt'],
  )
  return { key, params: { iterations } }
}

async function ensureAesKey(key, usages = ['encrypt', 'decrypt']) {
  if (typeof CryptoKey !== 'undefined' && key instanceof CryptoKey) return key
  if (key instanceof Uint8Array || key instanceof ArrayBuffer || ArrayBuffer.isView(key)) {
    return crypto.subtle.importKey(
      'raw',
      toArrayBuffer(key instanceof Uint8Array ? key : new Uint8Array(key.buffer || key)),
      { name: 'AES-GCM' },
      false,
      usages,
    )
  }
  return key
}

export async function aesGcmEncrypt(key, plaintext, aad = '') {
  const cryptoKey = await ensureAesKey(key, ['encrypt', 'decrypt'])
  const nonce = randomBytes(12)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: aad ? utf8(aad) : undefined,
        tagLength: 128,
      },
      cryptoKey,
      plaintext,
    ),
  )
  return concatBytes(nonce, ciphertext)
}

export async function aesGcmDecrypt(key, payload, aad = '') {
  const cryptoKey = await ensureAesKey(key, ['encrypt', 'decrypt'])
  const nonce = payload.subarray(0, 12)
  const ciphertext = payload.subarray(12)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: aad ? utf8(aad) : undefined,
      tagLength: 128,
    },
    cryptoKey,
    ciphertext,
  )
  return new Uint8Array(plaintext)
}
