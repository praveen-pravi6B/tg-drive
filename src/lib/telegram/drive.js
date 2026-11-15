import { appInfo, storageKeys } from '@/lib/config'
import { randomId } from '@/lib/crypto/bytes'
import { log } from '@/lib/logger'
import { INDEX_CAPTION, INDEX_FILE_NAME } from '@/lib/drive/index'
import { VAULT_CAPTION, VAULT_FILE_NAME, VAULT_TOPIC_TITLE } from '@/lib/vault/format'
import { EVENT_CAPTION, eventFileName, sealEvent } from '@/lib/drive/eventLog'
import {
  createDriveGroup,
  createTopic,
  deleteMessages,
  downloadMessageBytes,
  findDriveGroup,
  getChannelFull,
  listTopics,
  readTopic,
  sendDocumentToTopic,
} from './topics'

export const DRIVE_ABOUT_PREFIX = appInfo.aboutPrefix

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function toChannel(channel) {
  return {
    id: channel.id,
    accessHash: channel.accessHash ? String(channel.accessHash) : '',
    title: channel.title || '',
    username: channel.username || '',
  }
}

function parseDriveId(about) {
  return String(about || '')
    .slice(DRIVE_ABOUT_PREFIX.length)
    .trim()
    .split(/\s+/)[0]
}

/**
 * Local pointers only: the drive id, the group reference and the reserved
 * topic ids. Everything sensitive lives encrypted in Telegram.
 */
export function loadDriveState() {
  const canonical = readJson(storageKeys.drive)
  if (canonical?.channel?.id) return canonical

  // Adopt the M0 spike lab's group so an upgrade never creates a duplicate.
  const spikeGroup = readJson(storageKeys.debugGroup)
  if (spikeGroup?.id) {
    return {
      driveId: localStorage.getItem(storageKeys.debugDriveId) || spikeGroup.driveId || '',
      channel: toChannel(spikeGroup),
      indexTopicId: 0,
    }
  }

  return null
}

export function saveDriveState(state) {
  localStorage.setItem(storageKeys.drive, JSON.stringify(state))
}

export function clearDriveState() {
  localStorage.removeItem(storageKeys.drive)
  localStorage.removeItem(storageKeys.debugGroup)
  localStorage.removeItem(storageKeys.debugTopic)
  localStorage.removeItem(storageKeys.debugDriveId)
}

async function verifyChannel(client, channel) {
  const full = await getChannelFull(client, channel)
  const about = String(full.about || '')
  if (!about.startsWith(DRIVE_ABOUT_PREFIX)) return null
  return full
}

/**
 * Finds the one drive group for this account, or creates it. Never creates a
 * duplicate: cached references are verified first, then every dialog (normal
 * and archived) is searched for the `tgdrive:` about marker.
 */
export async function ensureDrive(client, { displayName = 'Drive' } = {}) {
  const cached = loadDriveState()
  if (cached?.channel?.id) {
    try {
      const full = await verifyChannel(client, cached.channel)
      if (full) {
        const state = {
          driveId: cached.driveId || parseDriveId(full.about),
          channel: toChannel(full),
          indexTopicId: cached.indexTopicId || 0,
        }
        saveDriveState(state)
        return { ...state, reused: true }
      }
    } catch (error) {
      log('warn', 'drive', 'Cached drive group is not accessible; searching', error)
    }
  }

  const found = await findDriveGroup(client, null)
  if (found) {
    const state = { driveId: found.driveId, channel: toChannel(found), indexTopicId: 0 }
    saveDriveState(state)
    log('info', 'drive', 'Adopted the existing TGDrive group', { id: state.channel.id })
    return { ...state, reused: true }
  }

  const driveId = randomId('d')
  const created = await createDriveGroup(client, {
    title: `${appInfo.name} · ${displayName || 'Drive'}`,
    driveId,
  })
  const state = { driveId, channel: toChannel(created.channel), indexTopicId: 0 }
  saveDriveState(state)
  log('info', 'drive', `Created drive ${driveId}`, { id: state.channel.id })
  return { ...state, reused: false }
}

/**
 * Reserved topics are matched by title, so repeated calls are idempotent.
 */
export async function ensureReservedTopic(client, channel, title) {
  const wanted = String(title).trim().toLowerCase()
  const topics = await listTopics(client, channel)
  const existing = topics.find(
    (topic) =>
      String(topic.title || '')
        .trim()
        .toLowerCase() === wanted,
  )
  if (existing) return existing

  const created = await createTopic(client, channel, title)
  log('info', 'drive', `Created reserved topic ${title}`, { id: created.id })
  return created
}

function documentFileName(message) {
  const attributes = message?.media?.document?.attributes || message?.document?.attributes || []
  return attributes.find((attribute) => attribute.fileName)?.fileName || ''
}

export function isVaultMessage(message) {
  if (!message) return false
  return (
    documentFileName(message) === VAULT_FILE_NAME ||
    message.caption === VAULT_CAPTION ||
    message.message === VAULT_CAPTION
  )
}

export async function findVaultMessages(client, channel, topicId) {
  const messages = await readTopic(client, channel, topicId, { limit: 50 })
  return messages.filter(isVaultMessage).sort((a, b) => b.id - a.id)
}

export async function readVaultBlob(client, channel, topicId) {
  const [message] = await findVaultMessages(client, channel, topicId)
  if (!message) return null
  const bytes = await downloadMessageBytes(client, message)
  return { bytes, messageId: message.id }
}

/**
 * Uploads a new vault blob and removes the previous one, so exactly one
 * envelope is kept in the #index topic.
 */
export async function writeVaultBlob(client, channel, topicId, blob) {
  const message = await sendDocumentToTopic({
    client,
    channel,
    topicId,
    name: VAULT_FILE_NAME,
    data: blob,
    caption: VAULT_CAPTION,
  })

  const previous = await findVaultMessages(client, channel, topicId)
  const stale = previous.filter((item) => item.id !== message.id).map((item) => item.id)
  if (stale.length) {
    await deleteMessages(client, channel, stale)
    log('info', 'drive', `Removed ${stale.length} previous vault message(s)`)
  }

  return message
}

export function isIndexMessage(message) {
  if (!message) return false
  return (
    documentFileName(message) === INDEX_FILE_NAME ||
    message.caption === INDEX_CAPTION ||
    message.message === INDEX_CAPTION
  )
}

export async function findIndexMessages(client, channel, topicId) {
  const messages = await readTopic(client, channel, topicId, { limit: 50 })
  return messages.filter(isIndexMessage).sort((a, b) => b.id - a.id)
}

export async function readIndexBlob(client, channel, topicId) {
  const [message] = await findIndexMessages(client, channel, topicId)
  if (!message) return null
  const bytes = await downloadMessageBytes(client, message)
  return { bytes, messageId: message.id }
}

export async function writeIndexBlob(client, channel, topicId, blob) {
  const message = await sendDocumentToTopic({
    client,
    channel,
    topicId,
    name: INDEX_FILE_NAME,
    data: blob,
    caption: INDEX_CAPTION,
  })

  const previous = await findIndexMessages(client, channel, topicId)
  const stale = previous.filter((item) => item.id !== message.id).map((item) => item.id)
  if (stale.length) {
    await deleteMessages(client, channel, stale)
    log('info', 'drive', `Removed ${stale.length} previous index message(s)`)
  }

  return message
}

export { VAULT_TOPIC_TITLE }

export async function appendEventLog(client, channel, topicId, { masterKey, driveId, event }) {
  if (!topicId || !masterKey || !driveId || !event) return null
  try {
    const { eventId, encrypted } = await sealEvent({ masterKey, driveId, event })
    return await sendDocumentToTopic({
      client,
      channel,
      topicId,
      name: eventFileName(eventId),
      data: encrypted,
      caption: EVENT_CAPTION,
    })
  } catch (error) {
    log('warn', 'drive', 'Could not append encrypted event log entry', error)
    return null
  }
}
