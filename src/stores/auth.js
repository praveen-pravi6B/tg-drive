import { defineStore } from 'pinia'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import QRCode from 'qrcode'
import { appInfo, getApiCredentials, hasCredentials, setApiCredentials } from '@/lib/config'
import { errorMessage, log } from '@/lib/logger'
import { clearSession, loadSession, saveSession } from '@/lib/telegram/session'
import { toBase64Url } from '@/lib/crypto/bytes'

let tg = null
let initPromise = null
const pendingSteps = new Map()

function waitForStep(step) {
  return new Promise((resolve, reject) => {
    pendingSteps.set(step, { resolve, reject })
  })
}

function settleStep(step, value) {
  const pending = pendingSteps.get(step)
  if (!pending) return false
  pendingSteps.delete(step)
  pending.resolve(value)
  return true
}

function rejectSteps(error) {
  for (const pending of pendingSteps.values()) pending.reject(error)
  pendingSteps.clear()
}

function mapUser(user) {
  if (!user) return null
  return {
    id: String(user.id),
    firstName: user.firstName || user.first_name || '',
    lastName: user.lastName || user.last_name || '',
    username: user.username || '',
    phone: user.phone || '',
    premium: Boolean(user.premium),
  }
}

function createClient(sessionString = '') {
  const { apiId, apiHash } = getApiCredentials()
  if (!apiId || !apiHash) throw new Error('Telegram API credentials are missing')

  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    useWSS: true,
    deviceModel: 'TGDrive Web',
    systemVersion: navigator.userAgent,
    appVersion: appInfo.version,
    langCode: 'en',
    floodSleepThreshold: 30,
  })
}

function disposeClient({ logOut = false } = {}) {
  const instance = tg
  tg = null
  if (!instance) return Promise.resolve()
  const done = logOut
    ? instance.logOut().catch((error) => log('warn', 'auth', 'logOut failed', error))
    : Promise.resolve()
  return done.finally(() => {
    try {
      instance.disconnect()
    } catch {
      /* already gone */
    }
  })
}

async function ensureConnected() {
  if (!tg) throw new Error('Telegram client is not ready')
  if (tg.connected) return tg
  const ok = await tg.connect()
  if (!ok) throw new Error('Could not reach Telegram. Check your connection and try again.')
  return tg
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    status: 'idle',
    step: 'idle',
    error: '',
    me: null,
    qrUrl: '',
    qrExpires: 0,
    phone: '',
    codeViaApp: false,
    passwordHint: '',
    credentialsSource: getApiCredentials().source,
    lastErrorCode: '',
  }),

  getters: {
    isAuthorized: (state) => state.status === 'authorized' && Boolean(state.me),
    hasCredentials: () => hasCredentials(),
    displayName: (state) => {
      if (!state.me) return ''
      return [state.me.firstName, state.me.lastName].filter(Boolean).join(' ') || state.me.username
    },
  },

  actions: {
    resetSessionState() {
      this.status = 'idle'
      this.step = 'idle'
      this.error = ''
      this.me = null
      this.qrUrl = ''
      this.qrExpires = 0
      this.passwordHint = ''
      this.lastErrorCode = ''
    },

    async init() {
      if (tg && this.status !== 'error') return
      if (tg) await disposeClient()
      if (!hasCredentials()) {
        this.status = 'no-credentials'
        this.credentialsSource = 'none'
        return
      }
      if (initPromise) return initPromise

      initPromise = (async () => {
        this.status = 'connecting'
        this.error = ''
        const saved = loadSession()
        try {
          tg = createClient(saved)

          // No stored session: do not touch the network yet. The login view
          // renders immediately and starts QR/phone auth when the user is ready.
          if (!saved) {
            this.status = 'unauthorized'
            this.step = 'idle'
            return
          }

          await ensureConnected()
          let authorized = false
          try {
            authorized = await tg.checkAuthorization()
          } catch (error) {
            log('warn', 'auth', 'Stored session is no longer valid', error)
            clearSession()
          }

          if (authorized) {
            this.me = mapUser(await tg.getMe())
            saveSession(tg.session.save())
            this.status = 'authorized'
            this.step = 'done'
            log('info', 'auth', `Restored session for ${this.me.username || this.me.id}`)
          } else {
            clearSession()
            this.status = 'unauthorized'
            this.step = 'idle'
          }
        } catch (error) {
          await disposeClient()
          this.status = 'error'
          this.error = errorMessage(error)
          log('error', 'auth', 'Connection failed', error)
        } finally {
          initPromise = null
        }
      })()

      return initPromise
    },

    saveCredentials(apiId, apiHash) {
      setApiCredentials(apiId, apiHash)
      this.credentialsSource = 'local'
      this.error = ''
      return this.restart()
    },

    async restart() {
      rejectSteps(new Error('Auth restarted'))
      await disposeClient()
      clearSession()
      this.resetSessionState()
      return this.init()
    },

    async startQrLogin() {
      if (this.status === 'authorized') return
      if (!tg) await this.init()
      if (!tg) throw new Error('Telegram client is not ready')
      await ensureConnected()

      const { apiId, apiHash } = getApiCredentials()
      this.error = ''
      this.step = 'qr-loading'

      try {
        await tg.signInUserWithQrCode(
          { apiId, apiHash },
          {
            qrCode: async ({ token, expires }) => {
              const url = `tg://login?token=${toBase64Url(new Uint8Array(token))}`
              this.qrUrl = await QRCode.toDataURL(url, {
                margin: 1,
                width: 320,
                errorCorrectionLevel: 'M',
                color: { dark: '#0b1220', light: '#ffffff' },
              })
              this.qrExpires = expires
              this.step = 'qr'
            },
            password: async (hint) => {
              this.passwordHint = hint || ''
              this.step = 'password'
              return waitForStep('password')
            },
            onError: (error) => {
              const code = error?.errorMessage || ''
              this.lastErrorCode = code
              log('warn', 'auth', `QR login error: ${code || errorMessage(error)}`)
              if (code === 'SESSION_PASSWORD_NEEDED') return false
              if (code === 'AUTH_USER_CANCEL') return true
              this.error = errorMessage(error)
              return true
            },
          },
        )
        await this.completeLogin()
      } catch (error) {
        if (error?.errorMessage === 'AUTH_USER_CANCEL') return
        this.error = errorMessage(error)
        this.step = 'idle'
        log('error', 'auth', 'QR login failed', error)
      }
    },

    async loginWithPhone(phone) {
      if (!tg) await this.init()
      if (!tg) throw new Error('Telegram client is not ready')
      if (!phone) throw new Error('Phone number is required')
      await ensureConnected()

      this.phone = phone
      this.error = ''
      this.step = 'phone-connecting'

      try {
        await tg.start({
          phoneNumber: async () => phone,
          phoneCode: async (isCodeViaApp) => {
            this.codeViaApp = Boolean(isCodeViaApp)
            this.step = 'code'
            return waitForStep('code')
          },
          password: async (hint) => {
            this.passwordHint = hint || ''
            this.step = 'password'
            return waitForStep('password')
          },
          onError: (error) => {
            const code = error?.errorMessage || ''
            this.lastErrorCode = code
            if (code === 'SESSION_PASSWORD_NEEDED') return false
            if (code === 'AUTH_USER_CANCEL') return true
            this.error = errorMessage(error)
            return true
          },
        })
        await this.completeLogin()
      } catch (error) {
        if (error?.errorMessage === 'AUTH_USER_CANCEL') return
        this.error = errorMessage(error)
        this.step = 'phone'
        log('error', 'auth', 'Phone login failed', error)
      }
    },

    submitCode(code) {
      if (!settleStep('code', String(code || '').trim())) return false
      this.step = 'signing-in'
      return true
    },

    submitPassword(password) {
      if (!settleStep('password', String(password || ''))) return false
      this.step = 'signing-in'
      return true
    },

    async completeLogin() {
      if (!tg) throw new Error('Telegram client is not ready')
      const authorized = await tg.checkAuthorization()
      if (!authorized) {
        this.status = 'unauthorized'
        this.error = 'Telegram did not confirm the session'
        return
      }
      this.me = mapUser(await tg.getMe())
      saveSession(tg.session.save())
      this.status = 'authorized'
      this.step = 'done'
      this.qrUrl = ''
      this.error = ''
      log('info', 'auth', `Signed in as ${this.me.username || this.me.id}`)
    },

    async cancelLogin() {
      rejectSteps(Object.assign(new Error('Login cancelled'), { errorMessage: 'AUTH_USER_CANCEL' }))
      await disposeClient()
      this.resetSessionState()
      if (hasCredentials()) this.status = 'unauthorized'
      else this.status = 'no-credentials'
    },

    getClient() {
      return tg
    },

    handleAuthError(error) {
      const code = error?.errorMessage || ''
      if (['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED_BAN'].includes(code)) {
        log('error', 'auth', `Session rejected by Telegram: ${code}`)
        clearSession()
        disposeClient()
        this.resetSessionState()
        this.status = 'unauthorized'
        this.error = 'This Telegram session was revoked. Please sign in again.'
        return true
      }
      return false
    },

    async logout() {
      log('info', 'auth', 'Signing out')
      await disposeClient({ logOut: true })
      clearSession()
      this.resetSessionState()
      this.status = hasCredentials() ? 'unauthorized' : 'no-credentials'
      this.step = 'idle'
    },
  },
})
