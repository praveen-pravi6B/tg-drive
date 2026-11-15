import { log } from '@/lib/logger'
import { sleep } from '@/lib/utils'

function floodWaitSeconds(error) {
  if (!error) return 0
  if (Number.isFinite(error.seconds) && error.seconds > 0) return error.seconds
  const msg = String(error.errorMessage || error.message || '')
  const m = msg.match(/FLOOD_WAIT_(\d+)/i)
  if (m) return Number(m[1]) || 0
  return 0
}

export async function withFloodRetry(fn, { label = 'operation', maxRetries = 5, onWait } = {}) {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (error) {
      const waitSec = floodWaitSeconds(error)
      if (waitSec > 0 && attempt < maxRetries) {
        attempt += 1
        const ms = (waitSec + 1) * 1000
        log(
          'warn',
          'telegram',
          `Flood wait ${waitSec}s during ${label}, retrying (${attempt}/${maxRetries})`,
        )
        try {
          onWait?.({ seconds: waitSec, attempt })
        } catch {
          /* ignore */
        }
        await sleep(ms)
        continue
      }
      throw error
    }
  }
}
