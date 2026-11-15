import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { errorMessage, log } from '@/lib/logger'
import {
  clearDriveState,
  ensureDrive,
  ensureReservedTopic,
  readVaultBlob,
  writeVaultBlob,
} from '@/lib/telegram/drive'
import { VAULT_TOPIC_TITLE, parseEnvelope } from '@/lib/vault/format'
import { createVault, unlockVault, validatePassphrase } from '@/lib/vault/vault'

// The master key stays in module scope on purpose: it is never reactive, never
// persisted, and never leaves this tab. Losing it only costs a passphrase entry.
let masterKey = null
let vaultBlob = null
let inflight = null

export function getMasterKey() {
  return masterKey
}

export function clearMasterKey() {
  masterKey = null
}

export const useVaultStore = defineStore('vault', {
  state: () => ({
    status: 'idle', // idle | checking | no-vault | locked | unlocked | error
    error: '',
    busy: '', // '' | 'create' | 'unlock'
    driveId: '',
    group: null,
    indexTopicId: 0,
    vaultMessageId: 0,
    envelope: null,
    unlockedAt: 0,
  }),

  getters: {
    isUnlocked: (state) => state.status === 'unlocked' && Boolean(masterKey),
    hasVault: (state) => Boolean(state.envelope),
    shortDriveId: (state) => (state.driveId ? `${state.driveId.slice(0, 12)}…` : '—'),
    kdfLine: (state) => {
      const kdf = state.envelope?.kdf
      if (!kdf) return ''
      const memory = kdf.memorySize ? `${Math.round(kdf.memorySize / 1024)} MiB` : ''
      const passes = kdf.iterations ? `${kdf.iterations} passes` : ''
      return [kdf.alg, memory, passes].filter(Boolean).join(' · ')
    },
  },

  actions: {
    reset() {
      masterKey = null
      vaultBlob = null
      inflight = null
      this.$reset()
    },

    /**
     * Resolves the drive group, the reserved #index topic and the vault blob.
     * Safe to call repeatedly; concurrent calls share one promise.
     */
    async init({ force = false } = {}) {
      const auth = useAuthStore()
      const client = auth.getClient()
      if (!auth.isAuthorized || !client) return
      if (inflight) return inflight
      if (!force && ['locked', 'unlocked', 'no-vault'].includes(this.status)) return

      inflight = (async () => {
        this.status = 'checking'
        this.error = ''
        try {
          const drive = await ensureDrive(client, { displayName: auth.displayName })
          this.driveId = drive.driveId
          this.group = drive.channel

          const topic = await ensureReservedTopic(client, drive.channel, VAULT_TOPIC_TITLE)
          this.indexTopicId = topic.id

          const stored = await readVaultBlob(client, drive.channel, topic.id)
          if (!stored) {
            vaultBlob = null
            this.envelope = null
            this.vaultMessageId = 0
            this.status = 'no-vault'
            log('info', 'vault', 'No vault in this drive yet', { driveId: this.driveId })
            return
          }

          vaultBlob = stored.bytes
          this.vaultMessageId = stored.messageId
          this.envelope = parseEnvelope(stored.bytes)
          this.status = masterKey ? 'unlocked' : 'locked'
          log('info', 'vault', `Vault found for ${this.driveId}`, {
            messageId: stored.messageId,
            kdf: this.envelope.kdf.alg,
          })
        } catch (error) {
          this.status = 'error'
          this.error = errorMessage(error)
          log('error', 'vault', 'Could not load the vault', error)
        } finally {
          inflight = null
        }
      })()

      return inflight
    },

    async create(passphrase, confirm) {
      const problem = validatePassphrase(passphrase)
      if (problem) throw new Error(problem)
      if (passphrase !== confirm) throw new Error('Passphrases do not match')

      await this.init()
      if (!this.driveId || !this.indexTopicId) {
        throw new Error('The drive is not ready yet')
      }
      if (this.hasVault) throw new Error('This drive already has a vault')

      const auth = useAuthStore()
      const client = auth.getClient()
      this.busy = 'create'
      this.error = ''
      try {
        const created = await createVault({ passphrase, driveId: this.driveId })
        const message = await writeVaultBlob(client, this.group, this.indexTopicId, created.blob)

        masterKey = created.masterKey
        vaultBlob = created.blob
        this.envelope = created.envelope
        this.vaultMessageId = message.id
        this.status = 'unlocked'
        this.unlockedAt = Date.now()
        log('info', 'vault', 'Vault created and stored encrypted in #index', {
          messageId: message.id,
        })
      } catch (error) {
        this.error = errorMessage(error)
        log('error', 'vault', 'Vault creation failed', error)
        throw error
      } finally {
        this.busy = ''
      }
    },

    async unlock(passphrase) {
      await this.init()
      if (!vaultBlob) {
        this.status = 'no-vault'
        throw new Error('No vault was found in this drive')
      }

      this.busy = 'unlock'
      this.error = ''
      try {
        const { masterKey: key } = await unlockVault({
          passphrase,
          blob: vaultBlob,
          driveId: this.driveId,
        })
        masterKey = key
        this.status = 'unlocked'
        this.unlockedAt = Date.now()
        log('info', 'vault', 'Vault unlocked for this tab')
      } catch (error) {
        this.error = errorMessage(error)
        log('warn', 'vault', 'Unlock failed', error)
        throw error
      } finally {
        this.busy = ''
      }
    },

    lock() {
      masterKey = null
      this.unlockedAt = 0
      this.status = this.envelope ? 'locked' : 'no-vault'
      log('info', 'vault', 'Vault locked; master key dropped from memory')
    },

    /**
     * Forgets local pointers only. The vault and every chunk stay in Telegram;
     * signing in again re-discovers the drive by its about marker.
     */
    forgetDevice() {
      clearDriveState()
      this.reset()
      log('info', 'vault', 'This device forgot the drive (Telegram data untouched)')
    },
  },
})
