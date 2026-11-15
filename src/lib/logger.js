const MAX_ENTRIES = 500
const entries = []
const subscribers = new Set()

function emit(entry) {
  for (const fn of subscribers) {
    try {
      fn(entry)
    } catch {
      /* listener errors must not break logging */
    }
  }
}

export function log(level, scope, message, data) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level,
    scope,
    message: String(message ?? ''),
    data: data === undefined ? undefined : safeSerialize(data),
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)

  const line = `[${entry.ts.slice(11, 23)}] ${level.toUpperCase()} ${scope}: ${entry.message}`
  if (level === 'error') console.error(line, data ?? '')
  else if (level === 'warn') console.warn(line, data ?? '')
  else console.log(line, data ?? '')

  emit(entry)
  return entry
}

function safeSerialize(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.errorMessage, stack: value.stack }
  }
  if (typeof value === 'bigint') return `${value}n`
  if (value && typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return String(value)
    }
  }
  return value
}

export function getLogs() {
  return entries.slice()
}

export function clearLogs() {
  entries.length = 0
  emit(null)
}

export function subscribeLogs(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function errorMessage(error) {
  if (!error) return 'Unknown error'
  return error.errorMessage || error.message || String(error)
}
