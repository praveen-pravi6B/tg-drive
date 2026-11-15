import { storageKeys } from '@/lib/config'

const WEEK = 7 * 24 * 60 * 60

function setRememberCookie() {
  try {
    document.cookie = `tgdrive_has_session=1; Max-Age=${WEEK}; Path=/; SameSite=Strict`
  } catch {
    /* ignore */
  }
}

function clearRememberCookie() {
  try {
    document.cookie = 'tgdrive_has_session=; Max-Age=0; Path=/; SameSite=Strict'
  } catch {
    /* ignore */
  }
}

export function loadSession() {
  try {
    return localStorage.getItem(storageKeys.session) || ''
  } catch {
    return ''
  }
}

export function saveSession(sessionString) {
  if (!sessionString) return
  try {
    localStorage.setItem(storageKeys.session, sessionString)
    setRememberCookie()
  } catch {
    /* private mode / quota */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(storageKeys.session)
  } catch {
    /* ignore */
  }
  clearRememberCookie()
}

export function hasStoredSession() {
  return loadSession().length > 0
}
