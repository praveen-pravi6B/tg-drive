import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { useVaultStore, getMasterKey } from './vault'
import { errorMessage, log } from '@/lib/logger'
import { appendEventLog, readIndexBlob, writeIndexBlob } from '@/lib/telegram/drive'
import { createTopic, deleteTopic, listTopics, renameTopic } from '@/lib/telegram/topics'
import {
  deleteFile,
  downloadFile,
  isReservedTopicTitle,
  listFilesInTopic,
  renameFile,
  uploadFile,
} from '@/lib/drive/files'
import { openSnapshot, sealSnapshot } from '@/lib/drive/index'
import { getCachedBlob, pruneExpiredBlobs, putCachedBlob } from '@/lib/drive/mediaCache'
import { getCachedIndex, putCachedIndex } from '@/lib/drive/indexCache'
import {
  deleteUploadSession,
  getUploadSession,
  pruneUploadSessions,
  putUploadSession,
  uploadSessionKey,
} from '@/lib/drive/uploadSessions'
import { limits } from '@/lib/config'

let uploadAbort = null
let saveChain = Promise.resolve()
let uploadQueue = []
let queueProcessing = false
let queueTopicId = 0

function queueSave(task) {
  saveChain = saveChain.then(task, task)
  return saveChain
}

function isGeneralFolder(folder) {
  const title = String(folder?.title || '')
    .trim()
    .toLowerCase()
  return title === 'general' || Number(folder?.id) === 1
}

function normalizeFolder(folder) {
  const id = Number(folder.id)
  const rawTitle = String(folder.title || '').trim() || 'Untitled folder'
  const title = isGeneralFolder({ id, title: rawTitle }) ? 'Home' : rawTitle
  return { id, title }
}

function sortFolders(folders) {
  return [...folders].sort((a, b) => {
    const ag = a.title === 'Home'
    const bg = b.title === 'Home'
    if (ag && !bg) return -1
    if (!ag && bg) return 1
    return a.title.localeCompare(b.title)
  })
}

export const useDriveStore = defineStore('drive', {
  state: () => ({
    status: 'idle', // idle | loading | ready | error
    error: '',
    folders: [],
    selectedTopicId: 0,
    showTrash: false,
    allFiles: [],
    files: [],
    filesLoading: false,
    creatingFolder: false,
    indexLoaded: false,
    indexMessageId: 0,
    uploadTask: null, // { fileName, fileId, progress, stage, error, done, chunksDone, chunkCount, running }
    batchTask: null, // { mode, total, done, current, running, error }
    uploadQueueCount: 0,
    events: [],
  }),

  getters: {
    selectedFolder(state) {
      return state.folders.find((folder) => folder.id === state.selectedTopicId) || null
    },
    isUploading: (state) => Boolean(state.uploadTask?.running),
    isBatchRunning: (state) => Boolean(state.batchTask?.running),
    trashFiles(state) {
      return (state.allFiles || [])
        .filter((file) => file?.trashedAt)
        .sort((a, b) => String(b.trashedAt || '').localeCompare(String(a.trashedAt || '')))
    },
  },

  actions: {
    appendEvent(type, data = {}) {
      const event = { type, at: new Date().toISOString(), ...data }
      const list = Array.isArray(this.events) ? this.events : []
      list.push(event)
      this.events = list.length > 200 ? list.slice(-200) : list

      // Append-only encrypted event entry in #index (best-effort).
      try {
        const vault = useVaultStore()
        const auth = useAuthStore()
        const client = auth.getClient?.()
        const masterKey = getMasterKey()
        if (
          auth.isAuthorized &&
          client &&
          vault.status === 'unlocked' &&
          masterKey &&
          vault.group?.id &&
          vault.indexTopicId
        ) {
          appendEventLog(client, vault.group, vault.indexTopicId, {
            masterKey,
            driveId: vault.driveId,
            event: { type, at: event.at, data },
          }).catch(() => {})
        }
      } catch {
        /* ignore */
      }
    },

    reset() {
      if (uploadAbort) uploadAbort.abort()
      uploadAbort = null
      uploadQueue = []
      queueProcessing = false
      queueTopicId = 0
      saveChain = Promise.resolve()
      this.$reset()
    },

    async init() {
      const vault = useVaultStore()
      await vault.init()
      if (vault.status === 'error') {
        this.status = 'error'
        this.error = vault.error
        return
      }
      if (vault.status !== 'unlocked') {
        this.status = 'idle'
        return
      }
      await this.refreshFolders()
      this.status = 'ready'
    },

    requireReady() {
      const vault = useVaultStore()
      const auth = useAuthStore()
      const client = auth.getClient()
      const masterKey = getMasterKey()
      if (!auth.isAuthorized || !client) throw new Error('Sign in to continue')
      if (vault.status !== 'unlocked' || !masterKey) throw new Error('Unlock the vault to continue')
      if (!vault.group?.id) throw new Error('The drive group is not ready yet')
      return { client, channel: vault.group, masterKey, vault }
    },

    syncSelectedFiles() {
      if (this.showTrash) {
        this.files = this.trashFiles
        return
      }
      if (!this.selectedTopicId) {
        this.files = []
        return
      }
      this.files = this.allFiles
        .filter(
          (file) => !file?.trashedAt && Number(file.folderTopicId) === Number(this.selectedTopicId),
        )
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    },

    applySnapshot(snapshot) {
      const folders = Array.isArray(snapshot?.folders) ? snapshot.folders : []
      const files = Array.isArray(snapshot?.files) ? snapshot.files : []
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      this.folders = sortFolders(
        folders
          .filter((folder) => folder?.id && !isReservedTopicTitle(folder.title))
          .map((folder) => normalizeFolder(folder)),
      )
      this.allFiles = files.filter((file) => file?.id)
      this.events = events.slice(-200)
      this.indexLoaded = true

      if (this.selectedTopicId && !this.folders.some((f) => f.id === this.selectedTopicId)) {
        this.selectedTopicId = 0
      }
      if (!this.selectedTopicId && this.folders[0]) {
        this.selectedTopicId = this.folders[0].id
      }
      this.syncSelectedFiles()
    },

    async loadIndex({ preferCache = false } = {}) {
      const { client, channel, masterKey, vault } = this.requireReady()
      if (!vault.indexTopicId) return null

      if (preferCache && !this.indexLoaded) {
        const cached = await getCachedIndex(vault.driveId)
        if (cached?.bytes) {
          try {
            const snapshot = await openSnapshot({
              masterKey,
              driveId: vault.driveId,
              blob: cached.bytes,
            })
            this.indexMessageId = cached.messageId || 0
            this.applySnapshot(snapshot)
            log('info', 'drive', 'Loaded drive index from local cache', {
              files: this.allFiles.length,
              folders: this.folders.length,
            })
          } catch {
            /* ignore bad/stale cache */
          }
        }
      }

      try {
        const stored = await readIndexBlob(client, channel, vault.indexTopicId)
        if (!stored) {
          const cached = await getCachedIndex(vault.driveId)
          if (cached?.bytes) {
            const snapshot = await openSnapshot({
              masterKey,
              driveId: vault.driveId,
              blob: cached.bytes,
            })
            this.indexMessageId = cached.messageId || 0
            this.applySnapshot(snapshot)
            log('info', 'drive', 'Loaded drive index from local cache (remote missing)', {
              files: this.allFiles.length,
              folders: this.folders.length,
            })
            return snapshot
          }
          return null
        }

        if (preferCache && this.indexLoaded && this.indexMessageId === stored.messageId) {
          putCachedIndex({
            driveId: vault.driveId,
            messageId: stored.messageId,
            bytes: stored.bytes,
          }).catch(() => {})
          return { cached: true }
        }

        const snapshot = await openSnapshot({
          masterKey,
          driveId: vault.driveId,
          blob: stored.bytes,
        })
        this.indexMessageId = stored.messageId
        this.applySnapshot(snapshot)
        putCachedIndex({
          driveId: vault.driveId,
          messageId: stored.messageId,
          bytes: stored.bytes,
        }).catch(() => {})
        log('info', 'drive', 'Loaded encrypted drive index', {
          files: this.allFiles.length,
          folders: this.folders.length,
        })
        return snapshot
      } catch (error) {
        const cached = await getCachedIndex(vault.driveId)
        if (cached?.bytes) {
          try {
            const snapshot = await openSnapshot({
              masterKey,
              driveId: vault.driveId,
              blob: cached.bytes,
            })
            this.indexMessageId = cached.messageId || 0
            this.applySnapshot(snapshot)
            log(
              'warn',
              'drive',
              'Using locally cached drive index after remote load failure',
              error,
            )
            return snapshot
          } catch {
            /* fall through */
          }
        }
        log('warn', 'drive', 'Could not load drive index; falling back to live scan', error)
        return null
      }
    },

    async saveIndex() {
      const { client, channel, masterKey, vault } = this.requireReady()
      if (!vault.indexTopicId) return
      return queueSave(async () => {
        try {
          const { encrypted } = await sealSnapshot({
            masterKey,
            driveId: vault.driveId,
            snapshot: {
              folders: this.folders,
              files: this.allFiles,
              events: Array.isArray(this.events) ? this.events.slice(-200) : [],
            },
          })
          const message = await writeIndexBlob(client, channel, vault.indexTopicId, encrypted)
          this.indexMessageId = message.id
          putCachedIndex({
            driveId: vault.driveId,
            messageId: message.id,
            bytes: encrypted,
          }).catch(() => {})
          log('info', 'drive', 'Saved encrypted drive index', {
            files: this.allFiles.length,
            folders: this.folders.length,
          })
        } catch (error) {
          log('warn', 'drive', 'Could not save drive index', error)
        }
      })
    },

    async refreshFolders({ scanCurrent = true } = {}) {
      const { client, channel } = this.requireReady()
      this.status = this.status === 'idle' ? 'loading' : this.status
      this.error = ''
      try {
        // Prefer the encrypted snapshot; it contains folders and file metadata.
        const snapshot = await this.loadIndex({ preferCache: true })
        if (!snapshot) {
          const topics = await listTopics(client, channel, { limit: 100 })
          this.folders = sortFolders(
            topics
              .filter((topic) => topic.id && !isReservedTopicTitle(topic.title))
              .map((topic) => normalizeFolder(topic)),
          )

          if (this.selectedTopicId && !this.folders.some((f) => f.id === this.selectedTopicId)) {
            this.selectedTopicId = 0
            this.files = []
          }
          if (!this.selectedTopicId && this.folders[0]) {
            this.selectedTopicId = this.folders[0].id
          }
          // Build the index progressively from the selected folder if needed.
          if (scanCurrent && this.selectedTopicId) await this.refreshFiles({ persist: true })
        } else if (scanCurrent && this.selectedTopicId && !this.files.length) {
          // Snapshot knew the folder but had no entries yet for this selection view.
          this.syncSelectedFiles()
          if (!this.files.length) await this.refreshFiles({ persist: false })
        }

        this.purgeExpiredTrash().catch(() => {})
        this.status = 'ready'
      } catch (error) {
        this.status = 'error'
        this.error = errorMessage(error)
        log('error', 'drive', 'Could not load folders', error)
      }
    },

    async createFolder(name) {
      const title = String(name || '').trim()
      if (!title) throw new Error('Folder name is required')
      const { client, channel } = this.requireReady()
      this.creatingFolder = true
      try {
        const topic = await createTopic(client, channel, title)
        if (topic?.id) {
          this.folders = sortFolders([
            ...this.folders,
            normalizeFolder({ id: topic.id, title: topic.title || title }),
          ])
          this.selectedTopicId = topic.id
          this.syncSelectedFiles()
          this.appendEvent('folder.create', {
            folderTopicId: topic.id,
            title: topic.title || title,
          })
          await this.saveIndex()
        }
        log('info', 'drive', `Created folder "${title}"`)
        return topic
      } catch (error) {
        log('error', 'drive', 'Could not create folder', error)
        throw error
      } finally {
        this.creatingFolder = false
      }
    },

    async selectFolder(topicId) {
      this.showTrash = false
      this.selectedTopicId = Number(topicId) || 0
      this.syncSelectedFiles()
      if (this.selectedTopicId && !this.files.length) {
        await this.refreshFiles({ persist: this.indexLoaded })
      }
    },

    async selectTrash() {
      this.showTrash = true
      this.syncSelectedFiles()
    },

    mergeFilesForTopic(topicId, manifests) {
      const trashedInTopic = this.allFiles.filter(
        (file) => Number(file.folderTopicId) === Number(topicId) && file?.trashedAt,
      )
      const others = this.allFiles.filter((file) => Number(file.folderTopicId) !== Number(topicId))
      const activeManifests = (manifests || []).filter((file) => !file?.trashedAt)
      this.allFiles = [...others, ...trashedInTopic, ...activeManifests]
      this.syncSelectedFiles()
    },

    async refreshFiles({ persist = false } = {}) {
      if (!this.selectedTopicId) return
      const vault = useVaultStore()
      if (vault.status !== 'unlocked') return
      const { client, channel, masterKey } = this.requireReady()
      this.filesLoading = true
      try {
        const manifests = await listFilesInTopic({
          client,
          channel,
          topicId: this.selectedTopicId,
          masterKey,
          limit: 200,
        })
        this.mergeFilesForTopic(this.selectedTopicId, manifests)
        if (persist || this.indexLoaded) await this.saveIndex()
      } catch (error) {
        log('error', 'drive', 'Could not load files', error)
        this.error = errorMessage(error)
      } finally {
        this.filesLoading = false
      }
    },

    async _runUpload(file, topicId = this.selectedTopicId) {
      if (!file) throw new Error('Choose a file')
      if (file.size > limits.maxFileSize) {
        throw new Error(`Max file size is ${Math.round(limits.maxFileSize / (1024 * 1024))} MB`)
      }
      const targetTopicId = Number(topicId)
      if (!targetTopicId) throw new Error('Create or select a folder first')

      const { client, channel, masterKey, vault } = this.requireReady()
      uploadAbort = new AbortController()
      pruneUploadSessions().catch(() => {})

      const sessionKey = uploadSessionKey({ driveId: vault.driveId, topicId: targetTopicId, file })
      let session = await getUploadSession(sessionKey)
      const expectedCount = Math.max(1, Math.ceil(file.size / limits.chunkSize))
      if (
        session &&
        (session.driveId !== vault.driveId ||
          Number(session.topicId) !== targetTopicId ||
          Number(session.chunkSize) !== limits.chunkSize ||
          Number(session.chunkCount) !== expectedCount ||
          String(session.fileName || '') !== String(file.name || '') ||
          Number(session.fileSize || 0) !== Number(file.size || 0))
      ) {
        await deleteUploadSession(sessionKey)
        session = null
      }

      if (session && !session.fileId) {
        await deleteUploadSession(sessionKey)
        session = null
      }

      const resumeChunks = Array.isArray(session?.chunks) ? session.chunks : []
      const resume =
        session && session.fileId
          ? {
              fileId: session.fileId,
              chunkSize: Number(session.chunkSize || limits.chunkSize),
              chunks: resumeChunks,
            }
          : null

      this.uploadTask = {
        fileName: file.name || 'file',
        fileId: resume?.fileId || '',
        progress: 0,
        stage: resumeChunks.length ? 'resuming upload' : 'starting',
        chunksDone: 0,
        chunkCount: 0,
        error: '',
        done: false,
        running: true,
      }

      try {
        const manifest = await uploadFile({
          client,
          channel,
          topicId: targetTopicId,
          file,
          masterKey,
          chunkSize: limits.chunkSize,
          signal: uploadAbort.signal,
          resume,
          onChunkStored: async (chunkMeta, meta) => {
            const current = (await getUploadSession(sessionKey)) || {
              key: sessionKey,
              driveId: vault.driveId,
              topicId: targetTopicId,
              fileName: file.name || 'file',
              fileSize: file.size,
              mime: file.type || 'application/octet-stream',
              fileId: meta.fileId,
              chunkSize: meta.chunkSize,
              chunkCount: meta.chunkCount,
              chunks: [],
              createdAt: Date.now(),
            }
            const chunks = Array.isArray(current.chunks) ? current.chunks.slice() : []
            const idx = chunks.findIndex((c) => Number(c.index) === Number(chunkMeta.index))
            if (idx >= 0) chunks[idx] = chunkMeta
            else chunks.push(chunkMeta)
            await putUploadSession({
              ...current,
              key: sessionKey,
              driveId: vault.driveId,
              topicId: targetTopicId,
              fileName: file.name || 'file',
              fileSize: file.size,
              mime: file.type || 'application/octet-stream',
              fileId: meta.fileId,
              chunkSize: meta.chunkSize,
              chunkCount: meta.chunkCount,
              chunks,
            })
          },
          onProgress: (event) => {
            if (!this.uploadTask) return
            if (event.type === 'start') {
              this.uploadTask.fileId = event.fileId
              this.uploadTask.chunkCount = event.chunkCount || 0
              this.uploadTask.stage = event.resumed ? 'resuming upload' : 'encrypting & uploading'
              const done = resumeChunks.filter((c) => c && c.messageId).length
              this.uploadTask.chunksDone = done
              this.uploadTask.progress = event.chunkCount
                ? Math.round((done / event.chunkCount) * 100)
                : 0
            } else if (event.type === 'chunk-skipped') {
              this.uploadTask.chunksDone = Math.max(
                this.uploadTask.chunksDone || 0,
                event.index + 1,
              )
              this.uploadTask.progress = this.uploadTask.chunkCount
                ? Math.round((this.uploadTask.chunksDone / this.uploadTask.chunkCount) * 100)
                : 0
              this.uploadTask.stage = `resuming (${this.uploadTask.chunksDone}/${this.uploadTask.chunkCount || '?'})`
            } else if (event.type === 'chunk-upload-progress') {
              this.uploadTask.stage = `uploading chunk ${event.index + 1}/${this.uploadTask.chunkCount || '?'}`
            } else if (event.type === 'chunk-retry') {
              this.uploadTask.stage = `retrying chunk ${event.index + 1}/${this.uploadTask.chunkCount || '?'}`
            } else if (event.type === 'chunk-uploaded') {
              this.uploadTask.chunksDone = Math.max(
                this.uploadTask.chunksDone || 0,
                event.index + 1,
              )
              this.uploadTask.progress = Math.round(
                (this.uploadTask.chunksDone / (this.uploadTask.chunkCount || 1)) * 100,
              )
            } else if (event.type === 'done') {
              this.uploadTask.progress = 100
              this.uploadTask.stage = 'saved'
              this.uploadTask.done = true
            }
          },
        })
        await deleteUploadSession(sessionKey)
        this.allFiles = [manifest, ...this.allFiles.filter((item) => item.id !== manifest.id)]
        this.syncSelectedFiles()
        this.appendEvent('file.upload', {
          fileId: manifest.id,
          folderTopicId: manifest.folderTopicId,
        })
        await this.saveIndex()
        const completed = this.uploadTask
        setTimeout(() => {
          if (this.uploadTask === completed && completed?.done) this.uploadTask = null
        }, 2000)
        return manifest
      } catch (error) {
        if (this.uploadTask) {
          this.uploadTask.error = errorMessage(error)
          this.uploadTask.stage = uploadAbort?.signal?.aborted ? 'paused' : 'failed'
          this.uploadTask.done = false
        }
        if (!uploadAbort?.signal?.aborted) {
          log('error', 'drive', 'Upload failed', error)
        } else {
          log('info', 'drive', 'Upload paused/cancelled; progress saved for resume when possible')
        }
        throw error
      } finally {
        if (this.uploadTask) this.uploadTask.running = false
        uploadAbort = null
      }
    },

    async upload(file, topicId = this.selectedTopicId) {
      if (this.isUploading) throw new Error('An upload is already running')
      return this._runUpload(file, topicId)
    },

    async _processUploadQueue() {
      if (queueProcessing) return
      queueProcessing = true
      try {
        while (uploadQueue.length) {
          const next = uploadQueue.shift()
          this.uploadQueueCount = uploadQueue.length
          if (!next?.file) continue
          try {
            await this._runUpload(next.file, next.topicId || queueTopicId || this.selectedTopicId)
          } catch (error) {
            // Stop queue on error/cancel; keep error visible in uploadTask until dismissed.
            uploadQueue = []
            this.uploadQueueCount = 0
            break
          }
        }
      } finally {
        queueProcessing = false
        this.uploadQueueCount = uploadQueue.length
      }
    },

    enqueueUploads(files, topicId = this.selectedTopicId) {
      const targetTopicId = Number(topicId)
      if (!targetTopicId) throw new Error('Create or select a folder first')
      const list = Array.from(files || []).filter(Boolean)
      if (!list.length) return 0
      for (const file of list) {
        if (file.size > limits.maxFileSize) {
          throw new Error(
            `"${file.name || 'file'}" exceeds ${Math.round(limits.maxFileSize / (1024 * 1024))} MB`,
          )
        }
        uploadQueue.push({ file, topicId: targetTopicId })
      }
      queueTopicId = targetTopicId
      this.uploadQueueCount = uploadQueue.length
      this._processUploadQueue()
      return list.length
    },

    cancelUpload() {
      uploadQueue = []
      this.uploadQueueCount = 0
      if (uploadAbort) uploadAbort.abort()
    },

    clearUpload() {
      uploadQueue = []
      this.uploadQueueCount = 0
      if (uploadAbort) uploadAbort.abort()
      this.uploadTask = null
    },

    async fetchBlob(manifest) {
      pruneExpiredBlobs().catch(() => {})
      const cached = await getCachedBlob(manifest)
      if (cached) return cached

      const { client, channel, masterKey } = this.requireReady()
      const { blob } = await downloadFile({ client, channel, manifest, masterKey })
      putCachedBlob(manifest, blob).catch(() => {})
      return blob
    },

    async download(manifest) {
      const blob = await this.fetchBlob(manifest)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = manifest.name || 'download'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    },

    async rename(manifest, newName) {
      const { client, channel, masterKey } = this.requireReady()
      const updated = await renameFile({
        client,
        channel,
        topicId: manifest.folderTopicId || this.selectedTopicId,
        manifest,
        newName,
        masterKey,
      })
      this.allFiles = this.allFiles.map((file) =>
        file.id === manifest.id ? { ...file, ...updated } : file,
      )
      this.syncSelectedFiles()
      this.appendEvent('file.rename', { fileId: manifest.id })
      await this.saveIndex()
      return updated
    },

    async remove(manifest) {
      if (!manifest?.id) return
      // Soft delete: move to trash (30-day retention).
      this.allFiles = this.allFiles.map((file) =>
        file.id === manifest.id
          ? {
              ...file,
              trashedAt: file.trashedAt || new Date().toISOString(),
              trashedFromTopicId: file.folderTopicId,
            }
          : file,
      )
      this.syncSelectedFiles()
      this.appendEvent('file.trash', { fileId: manifest.id })
      await this.saveIndex()
    },

    async restore(manifest) {
      if (!manifest?.id) return
      const targetFolderId = Number(manifest.trashedFromTopicId || manifest.folderTopicId)
      const folderExists = this.folders.some((f) => f.id === targetFolderId)
      const restoreTo = folderExists ? targetFolderId : this.folders[0]?.id || targetFolderId
      this.allFiles = this.allFiles.map((file) =>
        file.id === manifest.id
          ? { ...file, trashedAt: '', trashedFromTopicId: 0, folderTopicId: restoreTo }
          : file,
      )
      this.syncSelectedFiles()
      this.appendEvent('file.restore', { fileId: manifest.id })
      await this.saveIndex()
    },

    async deletePermanently(manifest) {
      if (!manifest?.id) return
      const { client, channel } = this.requireReady()
      await deleteFile({ client, channel, manifest })
      this.allFiles = this.allFiles.filter((file) => file.id !== manifest.id)
      this.syncSelectedFiles()
      this.appendEvent('file.delete', { fileId: manifest.id })
      await this.saveIndex()
    },

    async purgeExpiredTrash() {
      const retentionMs = Number(limits.trashRetentionDays || 30) * 24 * 60 * 60 * 1000
      const cutoff = Date.now() - retentionMs
      const expired = this.allFiles.filter((file) => {
        if (!file?.trashedAt) return false
        const t = new Date(file.trashedAt).getTime()
        return Number.isFinite(t) && t < cutoff
      })
      if (!expired.length) return 0
      const { client, channel } = this.requireReady()
      for (const file of expired) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await deleteFile({ client, channel, manifest: file })
          this.allFiles = this.allFiles.filter((item) => item.id !== file.id)
        } catch (error) {
          log('warn', 'drive', 'Could not purge expired trashed file', error)
        }
      }
      this.syncSelectedFiles()
      await this.saveIndex()
      return expired.length
    },

    async emptyTrash() {
      const trashed = this.allFiles.filter((file) => file?.trashedAt)
      if (!trashed.length) return 0
      const { client, channel } = this.requireReady()
      for (const file of trashed) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await deleteFile({ client, channel, manifest: file })
          this.allFiles = this.allFiles.filter((item) => item.id !== file.id)
        } catch (error) {
          log('warn', 'drive', 'Could not permanently delete trashed file', error)
        }
      }
      this.syncSelectedFiles()
      await this.saveIndex()
      return trashed.length
    },

    async deleteFolder(topicId) {
      const folderId = Number(topicId)
      if (!folderId) throw new Error('No folder selected')
      if (folderId === 1) throw new Error('Home folder cannot be deleted')
      const { client, channel } = this.requireReady()

      // Remove files in this folder from the encrypted index state (including trashed).
      this.allFiles = this.allFiles.filter((file) => Number(file.folderTopicId) !== folderId)
      this.folders = this.folders.filter((folder) => folder.id !== folderId)

      if (this.selectedTopicId === folderId) {
        this.selectedTopicId = this.folders[0]?.id || 0
      }
      this.syncSelectedFiles()
      this.appendEvent('folder.delete', { folderTopicId: folderId })
      await this.saveIndex()

      try {
        await deleteTopic(client, channel, folderId)
        log('info', 'drive', `Deleted folder/topic ${folderId}`)
      } catch (error) {
        log('error', 'drive', 'Could not delete folder topic on Telegram', error)
        throw error
      }
    },

    async renameFolder(topicId, newTitle) {
      const folderId = Number(topicId)
      const title = String(newTitle || '').trim()
      if (!folderId) throw new Error('No folder selected')
      if (folderId === 1) throw new Error('Home folder cannot be renamed')
      if (!title) throw new Error('Folder name is required')
      const { client, channel } = this.requireReady()
      await renameTopic(client, channel, folderId, title)
      this.folders = sortFolders(
        this.folders.map((folder) =>
          folder.id === folderId ? normalizeFolder({ ...folder, title }) : folder,
        ),
      )
      this.syncSelectedFiles()
      this.appendEvent('folder.rename', { folderTopicId: folderId, title })
      await this.saveIndex()
      log('info', 'drive', `Renamed folder ${folderId} to "${title}"`)
    },

    async pasteFiles({ mode, manifests, targetTopicId }) {
      const target = Number(targetTopicId)
      if (!target) throw new Error('Select a destination folder')
      const items = (manifests || []).filter((m) => m && !m.trashedAt)
      if (!items.length) return
      if (this.isUploading || this.isBatchRunning) throw new Error('Another operation is running')

      this.batchTask = { mode, total: items.length, done: 0, current: '', running: true, error: '' }
      try {
        for (const manifest of items) {
          if (mode === 'cut' && Number(manifest.folderTopicId) === target) {
            this.batchTask.done += 1
            continue
          }
          this.batchTask.current = manifest.name || 'file'
          const blob = await this.fetchBlob(manifest)
          const file = new File([blob], manifest.name || 'file', {
            type: manifest.mime || blob.type || 'application/octet-stream',
          })
          // Sequential re-upload into destination folder (new file id/manifest).
          await this.upload(file, target)
          if (mode === 'cut') {
            await this.remove(manifest)
          }
          this.batchTask.done += 1
        }
      } catch (error) {
        this.batchTask.error = errorMessage(error)
        log('error', 'drive', 'Paste operation failed', error)
        throw error
      } finally {
        if (this.batchTask) this.batchTask.running = false
      }
    },

    clearBatchTask() {
      if (this.batchTask?.running) return
      this.batchTask = null
    },
  },
})
