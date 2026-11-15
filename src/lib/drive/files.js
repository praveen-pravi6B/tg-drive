import { createSHA256 } from 'hash-wasm'
import { limits } from '@/lib/config'
import { randomId } from '@/lib/crypto/bytes'
import { deriveFileKeyBytes } from '@/lib/crypto/kdf'
import { encryptChunk, decryptChunk } from '@/lib/crypto/chunk'
import { log } from '@/lib/logger'
import {
  deleteMessages,
  downloadMessageBytes,
  readMessages,
  readTopic,
  sendDocumentToTopic,
} from '@/lib/telegram/topics'
import {
  MANIFEST_CAPTION_PREFIX,
  MANIFEST_VERSION,
  fileCategory,
  manifestCaption,
  openManifest,
  parseManifestCaption,
  sealManifest,
} from './manifest'

export function isReservedTopicTitle(title) {
  const value = String(title || '')
    .trim()
    .toLowerCase()
  return value === '#index' || value === '#trash'
}

export async function uploadFile({
  client,
  channel,
  topicId,
  file,
  masterKey,
  chunkSize = limits.chunkSize,
  onProgress = () => {},
  signal,
}) {
  if (!masterKey) throw new Error('Unlock the vault before uploading')
  if (!file) throw new Error('Choose a file to upload')
  if (file.size > limits.maxFileSize) {
    throw new Error(
      `Files larger than ${Math.round(limits.maxFileSize / (1024 * 1024))} MB are not supported yet`,
    )
  }

  const fileId = randomId('f')
  const fileKey = await deriveFileKeyBytes(masterKey, fileId)
  const total = file.size
  const count = Math.max(1, Math.ceil(total / chunkSize))
  const hasher = await createSHA256()
  hasher.init()

  const chunks = []
  const startedAt = performance.now()
  onProgress({ type: 'start', fileId, total, chunkCount: count, chunkSize })

  for (let index = 0; index < count; index += 1) {
    if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
    const start = index * chunkSize
    const end = Math.min(start + chunkSize, total)
    const plain = new Uint8Array(await file.slice(start, end).arrayBuffer())
    hasher.update(plain)

    const aad = `${fileId}:${index}:${count}`
    const { data, sha256 } = await encryptChunk({ key: fileKey, data: plain, aad })
    onProgress({
      type: 'chunk-encrypted',
      index,
      plainSize: plain.length,
      encryptedSize: data.length,
    })

    let last = 0
    const message = await sendDocumentToTopic({
      client,
      channel,
      topicId,
      name: `${fileId}-${String(index).padStart(4, '0')}.bin`,
      data,
      caption: `d1:${fileId}:${index + 1}/${count}`,
      onProgress: (progress) => {
        if (progress - last >= 0.1 || progress === 1) {
          last = progress
          onProgress({ type: 'chunk-upload-progress', index, progress })
        }
      },
    })

    chunks.push({
      index,
      messageId: message.id,
      plainSize: plain.length,
      encryptedSize: data.length,
      sha256,
    })
    onProgress({ type: 'chunk-uploaded', index, messageId: message.id })
  }

  const manifest = {
    v: MANIFEST_VERSION,
    id: fileId,
    name: file.name || 'untitled',
    size: total,
    mime: file.type || 'application/octet-stream',
    category: fileCategory(file.type, file.name),
    folderTopicId: topicId,
    chunkSize,
    chunkCount: count,
    chunks,
    hash: hasher.digest('hex'),
    createdAt: new Date().toISOString(),
  }

  const { encrypted } = await sealManifest({ masterKey, manifest })
  const manifestMessage = await sendDocumentToTopic({
    client,
    channel,
    topicId,
    name: `m_${fileId}.bin`,
    data: encrypted,
    caption: manifestCaption(fileId),
  })
  manifest.manifestMessageId = manifestMessage.id
  manifest.elapsedMs = performance.now() - startedAt

  log('info', 'drive', `Uploaded ${manifest.name} (${count} chunk${count === 1 ? '' : 's'})`, {
    fileId,
    topicId,
  })
  onProgress({ type: 'done', manifest })
  return manifest
}

function documentCaption(message) {
  return String(message?.caption || message?.message || '')
}

export async function listFilesInTopic({ client, channel, topicId, masterKey, limit = 200 }) {
  if (!masterKey) return []
  const messages = await readTopic(client, channel, topicId, { limit })
  const manifests = []

  for (const message of messages) {
    const fileId = parseManifestCaption(documentCaption(message))
    if (!fileId) continue
    try {
      const blob = await downloadMessageBytes(client, message)
      const { manifest } = await openManifest({ masterKey, fileId, blob })
      manifest.manifestMessageId = message.id
      manifests.push(manifest)
    } catch (error) {
      log('warn', 'drive', `Skipped unreadable manifest ${fileId}`, error)
    }
  }

  manifests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return manifests
}

export async function downloadFile({ client, channel, manifest, masterKey, onProgress, signal }) {
  if (!masterKey) throw new Error('Unlock the vault before downloading')
  const fileKey = await deriveFileKeyBytes(masterKey, manifest.id)
  const parts = []
  const hasher = await createSHA256()
  hasher.init()
  const ordered = [...(manifest.chunks || [])].sort((a, b) => a.index - b.index)

  for (const chunk of ordered) {
    if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError')
    const [message] = await readMessages(client, channel, [chunk.messageId])
    if (!message) throw new Error(`Missing chunk ${chunk.index + 1}`)
    const encrypted = await downloadMessageBytes(client, message, (progress) =>
      onProgress?.({ type: 'download-progress', index: chunk.index, progress }),
    )
    const aad = `${manifest.id}:${chunk.index}:${manifest.chunkCount}`
    const { data, sha256 } = await decryptChunk({ key: fileKey, data: encrypted, aad })
    if (chunk.sha256 && sha256 !== chunk.sha256)
      throw new Error(`Chunk ${chunk.index + 1} failed verification`)
    hasher.update(data)
    parts.push(data)
    onProgress?.({ type: 'chunk-downloaded', index: chunk.index })
  }

  const hash = hasher.digest('hex')
  if (manifest.hash && hash !== manifest.hash) throw new Error('File hash mismatch after download')
  return { blob: new Blob(parts, { type: manifest.mime || 'application/octet-stream' }), hash }
}

export async function deleteFile({ client, channel, manifest }) {
  const ids = [
    ...(manifest.chunks || []).map((chunk) => chunk.messageId),
    manifest.manifestMessageId,
  ].filter(Boolean)
  await deleteMessages(client, channel, ids)
  log('info', 'drive', `Deleted ${manifest.name || manifest.id}`, { messages: ids.length })
}

export async function renameFile({ client, channel, topicId, manifest, newName, masterKey }) {
  if (!masterKey) throw new Error('Unlock the vault before renaming')
  const name = String(newName || '').trim()
  if (!name) throw new Error('Name is required')
  const updated = {
    ...manifest,
    name,
    category: fileCategory(manifest.mime, name),
    updatedAt: new Date().toISOString(),
  }
  delete updated.manifestMessageId
  const { encrypted } = await sealManifest({ masterKey, manifest: updated })
  const message = await sendDocumentToTopic({
    client,
    channel,
    topicId: topicId || manifest.folderTopicId,
    name: `m_${manifest.id}.bin`,
    data: encrypted,
    caption: manifestCaption(manifest.id),
  })
  if (manifest.manifestMessageId && manifest.manifestMessageId !== message.id) {
    await deleteMessages(client, channel, [manifest.manifestMessageId])
  }
  updated.manifestMessageId = message.id
  log('info', 'drive', `Renamed file ${manifest.id} to "${name}"`)
  return updated
}
