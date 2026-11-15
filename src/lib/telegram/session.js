import { storageKeys } from '@/lib/config'

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
}

export function hasStoredSession() {
  return loadSession().length > 0
}
