// Wire format for the encrypted vault envelope.
//
// The envelope itself is plaintext JSON: it only carries public parameters
// (drive id, KDF settings, salt) plus the wrapped master key. The master key
// is never stored in the clear anywhere.

export const VAULT_VERSION = 1
export const VAULT_AAD_PREFIX = 'tgdrive:vault-v1'

// Opaque names so the #index topic does not leak anything meaningful.
export const VAULT_FILE_NAME = 'v.bin'
export const VAULT_CAPTION = 'tgv1'

export const VAULT_TOPIC_TITLE = '#index'

export function vaultAad(driveId, version = VAULT_VERSION) {
  return `${VAULT_AAD_PREFIX}:${version}:${driveId}`
}

export function encodeEnvelope(envelope) {
  return new TextEncoder().encode(JSON.stringify(envelope))
}

export function parseEnvelope(bytes) {
  let envelope
  try {
    envelope = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('Vault file is not valid JSON')
  }

  if (!envelope || typeof envelope !== 'object') throw new Error('Vault file is empty')
  if (envelope.v !== VAULT_VERSION) {
    throw new Error(`Unsupported vault version: ${envelope.v}`)
  }
  if (!envelope.driveId) throw new Error('Vault is missing its drive id')
  if (!envelope.kdf?.alg || !envelope.kdf?.salt) {
    throw new Error('Vault is missing its key-derivation parameters')
  }
  if (!envelope.wrapped) throw new Error('Vault is missing the wrapped key')

  return envelope
}
