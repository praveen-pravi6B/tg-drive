import { Api } from 'telegram'
import { CustomFile } from 'telegram/client/uploads'
import bigInt from 'big-integer'
import { Buffer } from 'buffer'
import { appInfo } from '@/lib/config'
import { log } from '@/lib/logger'

export function randomBigInt() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return bigInt(hex, 16)
}

export function serializeChannel(channel) {
  return {
    id: channel.id,
    accessHash: channel.accessHash ? String(channel.accessHash) : '',
    title: channel.title || '',
    username: channel.username || '',
  }
}

export function toInputChannel(channel) {
  if (!channel?.id) throw new Error('Invalid channel reference')
  return new Api.InputChannel({
    channelId: bigInt(String(channel.id)),
    accessHash: bigInt(String(channel.accessHash || 0)),
  })
}

/**
 * `folders.EditPeerFolders` requires an InputPeer, not an InputChannel.
 * Passing InputChannel there is serialized with the wrong constructor and
 * Telegram rejects the request.
 */
export function toInputPeerChannel(channel) {
  if (!channel?.id) throw new Error('Invalid channel reference')
  return new Api.InputPeerChannel({
    channelId: bigInt(String(channel.id)),
    accessHash: bigInt(String(channel.accessHash || 0)),
  })
}

function extractMessages(updates) {
  const list = updates?.updates || []
  return list.map((update) => update.message).filter(Boolean)
}

function extractTopic(updates) {
  const messages = extractMessages(updates)
  const topicMessage = messages.find(
    (message) => message.action?.className === 'MessageActionTopicCreate',
  )
  if (topicMessage) {
    return {
      id: topicMessage.id,
      title: topicMessage.action.title,
      iconColor: topicMessage.action.iconColor,
    }
  }
  const first = messages[0]
  return first ? { id: first.id, title: null } : null
}

export async function createDriveGroup(client, { title, driveId }) {
  const about = `${appInfo.aboutPrefix}${driveId}`
  const created = await client.invoke(
    new Api.channels.CreateChannel({
      title,
      about,
      megagroup: true,
      forum: true,
    }),
  )
  const channel = (created.chats || []).find((chat) => chat.megagroup || chat.className === 'Channel')
  if (!channel) throw new Error('Telegram did not return the created supergroup')

  const result = { channel: serializeChannel(channel), archived: false, forwardsDisabled: false }
  const peer = toInputPeerChannel(result.channel)

  try {
    await client.invoke(new Api.messages.ToggleNoForwards({ peer, enabled: true }))
    result.forwardsDisabled = true
  } catch (error) {
    log(
      'warn',
      'telegram',
      `Could not disable forwarding: ${error?.errorMessage || error?.message || error}`,
      error,
    )
  }

  try {
    await client.invoke(
      new Api.folders.EditPeerFolders({
        folderPeers: [new Api.InputFolderPeer({ peer, folderId: 1 })],
      }),
    )
    result.archived = true
  } catch (error) {
    log(
      'warn',
      'telegram',
      `Could not archive the group: ${error?.errorMessage || error?.message || error}`,
      error,
    )
  }

  return result
}

export async function getChannelFull(client, channel) {
  const full = await client.invoke(
    new Api.channels.GetFullChannel({ channel: toInputChannel(channel) }),
  )
  const chat = (full.chats || []).find((item) => String(item.id) === String(channel.id)) || channel
  return {
    ...serializeChannel(chat),
    about: full.fullChat?.about || '',
    pinnedMsgId: full.fullChat?.pinnedMsgId || 0,
    participants: full.fullChat?.participantsCount || 0,
  }
}

export async function findDriveGroup(client, driveId, { limit = 100 } = {}) {
  const marker = `${appInfo.aboutPrefix}${driveId}`
  const dialogs = await client.getDialogs({ limit })

  for (const dialog of dialogs) {
    const entity = dialog.entity
    if (!entity || entity.className !== 'Channel' || !entity.megagroup) continue
    try {
      const full = await getChannelFull(client, serializeChannel(entity))
      if (full.about.startsWith(marker)) return full
    } catch {
      /* skip inaccessible chats */
    }
  }
  return null
}

export async function archiveChannel(client, channel) {
  await client.invoke(
    new Api.folders.EditPeerFolders({
      folderPeers: [new Api.InputFolderPeer({ peer: toInputPeerChannel(channel), folderId: 1 })],
    }),
  )
}

export async function disableForwards(client, channel) {
  await client.invoke(
    new Api.messages.ToggleNoForwards({ peer: toInputPeerChannel(channel), enabled: true }),
  )
}

export async function createTopic(client, channel, title) {
  const updates = await client.invoke(
    new Api.channels.CreateForumTopic({
      channel: toInputChannel(channel),
      title,
      randomId: randomBigInt(),
    }),
  )
  const topic = extractTopic(updates)
  if (!topic?.id) throw new Error('Topic created but Telegram did not return its id')
  return topic
}

export async function listTopics(client, channel, { limit = 100 } = {}) {
  const result = await client.invoke(
    new Api.channels.GetForumTopics({
      channel: toInputChannel(channel),
      limit,
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
    }),
  )
  return (result.topics || []).map((topic) => ({
    id: topic.id,
    title: topic.title,
    closed: Boolean(topic.closed),
    pinned: Boolean(topic.pinned),
    date: topic.date,
    topMessage: topic.topMessage,
  }))
}

export async function deleteTopic(client, channel, topicId) {
  await client.invoke(
    new Api.channels.DeleteTopicHistory({
      channel: toInputChannel(channel),
      topMsgId: topicId,
    }),
  )
}

export async function sendDocumentToTopic({
  client,
  channel,
  topicId,
  name,
  data,
  caption,
  onProgress,
}) {
  const bytes = Buffer.from(data)
  const file = new CustomFile(name, bytes.length, '', bytes)

  // Upload separately. `sendFile` -> `uploadFile` defaults `maxBufferSize` to
  // 20 MB - 1 byte; anything larger makes GramJS ignore the in-memory buffer
  // and try to read `file.path` (empty in a browser), which fails instantly.
  // Passing the exact size keeps the buffer path for every chunk.
  const uploaded = await client.uploadFile({
    file,
    workers: 1,
    onProgress,
    maxBufferSize: Math.max(bytes.length, 1),
  })

  return client.sendFile(toInputChannel(channel), {
    file: uploaded,
    caption,
    forceDocument: true,
    // GramJS only builds the `reply_to` object when `replyTo` is set, and it
    // drops `topMsgId` otherwise. Telegram expects the topic id in
    // `reply_to_msg_id` for messages posted inside a forum topic.
    replyTo: topicId,
    topMsgId: topicId,
  })
}

export async function readTopic(client, channel, topicId, { limit = 20, offsetId = 0 } = {}) {
  const messages = await client.getMessages(toInputChannel(channel), {
    replyTo: topicId,
    limit,
    offsetId,
    addOffset: 0,
  })
  return messages.filter(Boolean)
}

export async function readMessages(client, channel, ids) {
  return client.getMessages(toInputChannel(channel), { ids })
}

export async function downloadMessageBytes(client, message, onProgress) {
  const buffer = await client.downloadMedia(message, { progressCallback: onProgress })
  if (!buffer) throw new Error('Telegram returned an empty file')
  return new Uint8Array(buffer)
}

export async function deleteMessages(client, channel, ids) {
  if (!ids?.length) return
  await client.deleteMessages(toInputChannel(channel), ids, { revoke: true })
}

export async function pinMessage(client, channel, messageId) {
  await client.invoke(
    new Api.messages.UpdatePinnedMessage({
      peer: toInputChannel(channel),
      id: messageId,
      silent: true,
    }),
  )
}

export function messageLabel(message) {
  return (
    message?.message ||
    message?.caption ||
    message?.media?.document?.attributes?.find((attribute) => attribute.fileName)?.fileName ||
    `message ${message?.id}`
  )
}
