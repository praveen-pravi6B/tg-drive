import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveKekArgon2id,
  deriveKekPbkdf2,
  generateMasterKey,
} from '@/lib/crypto/kdf'
import { fromBase64, randomBytes, toBase64 } from '@/lib/crypto/bytes'
import { VAULT_VERSION, encodeEnvelope, parseEnvelope, vaultAad } from './format'

export const MIN_PASSPHRASE_LENGTH = 12

// 64 MiB / 3 passes is a reasonable 2025-ish default for a browser KDF and
// stays under a second on typical hardware. Parameters are stored in the
// envelope, so raising them later keeps old vaults readable.
export const DEFAULT_KDF = {
  alg: 'argon2id',
  iterations: 3,
  parallelism: 1,
  memorySize: 64 * 1024,
  hashLength: 32,
}

export function validatePassphrase(passphrase) {
  const value = String(passphrase ?? '')
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters`
  }
  if (!value.trim()) return 'Passphrase cannot be only spaces'
  return ''
}

async function deriveKek(passphrase, kdf) {
  const salt = fromBase64(kdf.salt)

  if (kdf.alg === 'argon2id') {
    const { key } = await deriveKekArgon2id(passphrase, salt, {
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
      memorySize: kdf.memorySize,
      hashLength: kdf.hashLength,
    })
    return key
  }

  if (kdf.alg === 'pbkdf2') {
    const { key } = await deriveKekPbkdf2(passphrase, salt, kdf.iterations)
    return key
  }

  throw new Error(`Unsupported key-derivation algorithm: ${kdf.alg}`)
}

async function buildEnvelope({ masterKey, passphrase, driveId, kdf }) {
  const params = {
    ...DEFAULT_KDF,
    ...kdf,
    salt: kdf?.salt || toBase64(randomBytes(16)),
  }
  const key = await deriveKek(passphrase, params)
  const wrapped = await aesGcmEncrypt(key, masterKey, vaultAad(driveId))
  const now = new Date().toISOString()

  return {
    v: VAULT_VERSION,
    driveId,
    kdf: params,
    wrapped: toBase64(wrapped),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Generates a fresh master key and seals it under a passphrase-derived KEK.
 * Returns the master key (memory only), the public envelope and the bytes to
 * upload to Telegram.
 */
export async function createVault({ passphrase, driveId, kdf }) {
  const problem = validatePassphrase(passphrase)
  if (problem) throw new Error(problem)
  if (!driveId) throw new Error('A drive id is required')

  const masterKey = generateMasterKey()
  const envelope = await buildEnvelope({ masterKey, passphrase, driveId, kdf })

  return { masterKey, envelope, blob: encodeEnvelope(envelope) }
}

/**
 * Re-wraps an existing master key under a new passphrase.
 */
export async function rewrapVault({ masterKey, driveId, passphrase, kdf }) {
  const problem = validatePassphrase(passphrase)
  if (problem) throw new Error(problem)
  if (!masterKey || masterKey.length !== 32) throw new Error('A master key is required')
  if (!driveId) throw new Error('A drive id is required')

  const envelope = await buildEnvelope({ masterKey, passphrase, driveId, kdf })

  return { envelope, blob: encodeEnvelope(envelope) }
}

/**
 * Derives the KEK from the stored parameters and unwraps the master key.
 * Wrong passphrases and tampered vaults both fail the GCM tag check.
 */
export async function unlockVault({ passphrase, blob, driveId }) {
  if (!String(passphrase ?? '')) throw new Error('Enter your passphrase')

  const envelope = parseEnvelope(blob)
  if (driveId && envelope.driveId !== driveId) {
    throw new Error('This vault belongs to a different drive')
  }

  const key = await deriveKek(passphrase, envelope.kdf)

  let masterKey
  try {
    masterKey = await aesGcmDecrypt(
      key,
      fromBase64(envelope.wrapped),
      vaultAad(envelope.driveId, envelope.v),
    )
  } catch {
    throw new Error('Wrong passphrase, or the vault is damaged')
  }

  if (masterKey.length !== 32) throw new Error('Vault key has an unexpected length')

  return { masterKey, envelope }
}
