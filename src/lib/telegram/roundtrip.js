import { createSHA256 } from 'hash-wasm'
import { deriveFileKeyBytes, generateMasterKey } from '@/lib/crypto/kdf'
import { decryptChunk, encryptChunk } from '@/lib/crypto/chunk'
import { randomId } from '@/lib/crypto/bytes'
import { deleteMessages, downloadMessageBytes, readMessages, sendDocumentToTopic } from './topics'

/**
 * M0 spike: end-to-end encrypted chunk round-trip through a forum topic.
 * The plaintext never leaves the browser unencrypted.
 */
export async function runRoundTrip({
  client,
  channel,
  topicId,
  file,
  chunkSize,
  onEvent = () => {},
  cleanup = true,
  signal,
}) {
  const fileId = randomId('f')
  const masterKey = generateMasterKey()
  const fileKey = await deriveFileKeyBytes(masterKey, fileId)
  const total = file.size
  const chunkCount = Math.max(1, Math.ceil(total / chunkSize))
  const sourceHasher = await createSHA256()
  sourceHasher.init()

  const uploaded = []
  const startedAt = performance.now()

  onEvent({ type: 'start', fileId, total, chunkCount, chunkSize })

  for (let index = 0; index < chunkCount; index += 1) {
    if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
    const start = index * chunkSize
    const end = Math.min(start + chunkSize, total)
    const plain = new Uint8Array(await file.slice(start, end).arrayBuffer())
    const plainSize = plain.length
    sourceHasher.update(plain)

    const aad = `${fileId}:${index}:${chunkCount}`
    const { data, sha256 } = await encryptChunk({ key: fileKey, data: plain, aad })
    onEvent({ type: 'chunk-encrypted', index, plainSize, encryptedSize: data.length, sha256 })

    let lastReported = 0
    const message = await sendDocumentToTopic({
      client,
      channel,
      topicId,
      name: `${fileId}-${String(index).padStart(4, '0')}.bin`,
      data,
      caption: `D1 ${fileId} ${index + 1}/${chunkCount}`,
      onProgress: (progress) => {
        if (progress - lastReported >= 0.1 || progress === 1) {
          lastReported = progress
          onEvent({ type: 'chunk-upload-progress', index, progress })
        }
      },
    })

    uploaded.push({
      index,
      messageId: message.id,
      sha256,
      encryptedSize: data.length,
      plainSize,
    })
    onEvent({ type: 'chunk-uploaded', index, messageId: message.id, sha256 })
  }

  const sourceHash = sourceHasher.digest('hex')
  onEvent({ type: 'uploaded', sourceHash })

  const verifyHasher = await createSHA256()
  verifyHasher.init()
  const checks = []

  for (const chunk of uploaded) {
    if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError')
    const [message] = await readMessages(client, channel, [chunk.messageId])
    if (!message) throw new Error(`Chunk ${chunk.index} message disappeared`)

    const encrypted = await downloadMessageBytes(client, message, (progress) => {
      onEvent({ type: 'chunk-download-progress', index: chunk.index, progress })
    })
    const aad = `${fileId}:${chunk.index}:${chunkCount}`
    const { data, sha256 } = await decryptChunk({ key: fileKey, data: encrypted, aad })
    verifyHasher.update(data)

    const check = { index: chunk.index, ok: sha256 === chunk.sha256, sha256, size: data.length }
    checks.push(check)
    onEvent({ type: 'chunk-verified', ...check })
  }

  const downloadedHash = verifyHasher.digest('hex')
  const result = {
    fileId,
    fileName: file.name,
    total,
    chunkCount,
    chunkSize,
    sourceHash,
    downloadedHash,
    match: sourceHash === downloadedHash && checks.every((check) => check.ok),
    checks,
    elapsedMs: performance.now() - startedAt,
    messageIds: uploaded.map((chunk) => chunk.messageId),
  }

  onEvent({ type: 'done', result })

  if (cleanup && result.messageIds.length) {
    await deleteMessages(client, channel, result.messageIds)
    onEvent({ type: 'cleaned', count: result.messageIds.length })
  }

  return result
}
