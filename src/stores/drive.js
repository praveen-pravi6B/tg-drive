import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { useVaultStore, getMasterKey } from './vault'
import { errorMessage, log } from '@/lib/logger'
import { readIndexBlob, writeIndexBlob } from '@/lib/telegram/drive'
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
    allFiles: [],
    files: [],
    filesLoading: false,
    creatingFolder: false,
    indexLoaded: false,
    indexMessageId: 0,
    uploadTask: null, // { fileName, fileId, progress, stage, error, done, chunksDone, chunkCount, running }
    batchTask: null, // { mode, total, done, current, running, error }
    uploadQueueCount: 0,
  }),

  getters: {
    selectedFolder(state) {
      return state.folders.find((folder) => folder.id === state.selectedTopicId) || null
    },
    isUploading: (state) => Boolean(state.uploadTask?.running),
    isBatchRunning: (state) => Boolean(state.batchTask?.running),
  },

  actions: {
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
      if (!this.selectedTopicId) {
        this.files = []
        return
      }
      this.files = this.allFiles
        .filter((file) => Number(file.folderTopicId) === Number(this.selectedTopicId))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    },

    applySnapshot(snapshot) {
      const folders = Array.isArray(snapshot?.folders) ? snapshot.folders : []
      const files = Array.isArray(snapshot?.files) ? snapshot.files : []
      this.folders = sortFolders(
        folders
          .filter((folder) => folder?.id && !isReservedTopicTitle(folder.title))
          .map((folder) => normalizeFolder(folder)),
      )
      this.allFiles = files.filter((file) => file?.id)
      this.indexLoaded = true

      if (this.selectedTopicId && !this.folders.some((f) => f.id === this.selectedTopicId)) {
        this.selectedTopicId = 0
      }
      if (!this.selectedTopicId && this.folders[0]) {
        this.selectedTopicId = this.folders[0].id
      }
      this.syncSelectedFiles()
    },

    async loadIndex() {
      const { client, channel, masterKey, vault } = this.requireReady()
      if (!vault.indexTopicId) return null
      try {
        const stored = await readIndexBlob(client, channel, vault.indexTopicId)
        if (!stored) return null
        const snapshot = await openSnapshot({
          masterKey,
          driveId: vault.driveId,
          blob: stored.bytes,
        })
        this.indexMessageId = stored.messageId
        this.applySnapshot(snapshot)
        log('info', 'drive', 'Loaded encrypted drive index', {
          files: this.allFiles.length,
          folders: this.folders.length,
        })
        return snapshot
      } catch (error) {
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
            },
          })
          const message = await writeIndexBlob(client, channel, vault.indexTopicId, encrypted)
          this.indexMessageId = message.id
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
        const snapshot = await this.loadIndex()
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
      this.selectedTopicId = Number(topicId) || 0
      this.syncSelectedFiles()
      if (this.selectedTopicId && !this.files.length) {
        await this.refreshFiles({ persist: this.indexLoaded })
      }
    },

    mergeFilesForTopic(topicId, manifests) {
      const others = this.allFiles.filter((file) => Number(file.folderTopicId) !== Number(topicId))
      this.allFiles = [...others, ...manifests]
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

      const { client, channel, masterKey } = this.requireReady()
      uploadAbort = new AbortController()
      this.uploadTask = {
        fileName: file.name || 'file',
        fileId: '',
        progress: 0,
        stage: 'starting',
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
          onProgress: (event) => {
            if (!this.uploadTask) return
            if (event.type === 'start') {
              this.uploadTask.fileId = event.fileId
              this.uploadTask.chunkCount = event.chunkCount || 0
              this.uploadTask.stage = 'encrypting & uploading'
            } else if (event.type === 'chunk-upload-progress') {
              this.uploadTask.stage = `uploading chunk ${event.index + 1}/${this.uploadTask.chunkCount || '?'}`
            } else if (event.type === 'chunk-uploaded') {
              this.uploadTask.chunksDone = event.index + 1
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
        this.allFiles = [manifest, ...this.allFiles.filter((item) => item.id !== manifest.id)]
        this.syncSelectedFiles()
        await this.saveIndex()
        const completed = this.uploadTask
        setTimeout(() => {
          if (this.uploadTask === completed && completed?.done) this.uploadTask = null
        }, 2000)
        return manifest
      } catch (error) {
        if (this.uploadTask) {
          this.uploadTask.error = errorMessage(error)
          this.uploadTask.stage = 'failed'
          this.uploadTask.done = false
        }
        log('error', 'drive', 'Upload failed', error)
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
      await this.saveIndex()
      return updated
    },

    async remove(manifest) {
      const { client, channel } = this.requireReady()
      await deleteFile({ client, channel, manifest })
      this.allFiles = this.allFiles.filter((file) => file.id !== manifest.id)
      this.syncSelectedFiles()
      await this.saveIndex()
    },

    async deleteFolder(topicId) {
      const folderId = Number(topicId)
      if (!folderId) throw new Error('No folder selected')
      if (folderId === 1) throw new Error('Home folder cannot be deleted')
      const { client, channel } = this.requireReady()

      // Remove files in this folder from the encrypted index state.
      this.allFiles = this.allFiles.filter((file) => Number(file.folderTopicId) !== folderId)
      this.folders = this.folders.filter((folder) => folder.id !== folderId)

      if (this.selectedTopicId === folderId) {
        this.selectedTopicId = this.folders[0]?.id || 0
      }
      this.syncSelectedFiles()
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
      await this.saveIndex()
      log('info', 'drive', `Renamed folder ${folderId} to "${title}"`)
    },

    async pasteFiles({ mode, manifests, targetTopicId }) {
      const target = Number(targetTopicId)
      if (!target) throw new Error('Select a destination folder')
      const items = (manifests || []).filter(Boolean)
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
