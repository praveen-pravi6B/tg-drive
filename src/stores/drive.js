import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { useVaultStore, getMasterKey } from './vault'
import { errorMessage, log } from '@/lib/logger'
import { readIndexBlob, writeIndexBlob } from '@/lib/telegram/drive'
import { createTopic, listTopics } from '@/lib/telegram/topics'
import {
  deleteFile,
  downloadFile,
  isReservedTopicTitle,
  listFilesInTopic,
  renameFile,
  uploadFile,
} from '@/lib/drive/files'
import { openSnapshot, sealSnapshot } from '@/lib/drive/index'
import { limits } from '@/lib/config'

let uploadAbort = null
let saveChain = Promise.resolve()

function queueSave(task) {
  saveChain = saveChain.then(task, task)
  return saveChain
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
  }),

  getters: {
    selectedFolder(state) {
      return state.folders.find((folder) => folder.id === state.selectedTopicId) || null
    },
    isUploading: (state) => Boolean(state.uploadTask?.running),
  },

  actions: {
    reset() {
      if (uploadAbort) uploadAbort.abort()
      uploadAbort = null
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
      this.folders = folders
        .filter((folder) => folder?.id && !isReservedTopicTitle(folder.title))
        .map((folder) => ({ id: Number(folder.id), title: folder.title || 'Untitled folder' }))
        .sort((a, b) => a.title.localeCompare(b.title))
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
          this.folders = topics
            .filter((topic) => topic.id && !isReservedTopicTitle(topic.title))
            .map((topic) => ({ id: topic.id, title: topic.title || 'Untitled folder' }))
            .sort((a, b) => a.title.localeCompare(b.title))

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
          this.folders.push({ id: topic.id, title: topic.title || title })
          this.folders.sort((a, b) => a.title.localeCompare(b.title))
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

    async upload(file) {
      if (!file) throw new Error('Choose a file')
      if (file.size > limits.maxFileSize) {
        throw new Error(`Max file size is ${Math.round(limits.maxFileSize / (1024 * 1024))} MB`)
      }
      if (this.isUploading) throw new Error('An upload is already running')
      if (!this.selectedTopicId) throw new Error('Create or select a folder first')

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
          topicId: this.selectedTopicId,
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

    cancelUpload() {
      if (uploadAbort) uploadAbort.abort()
    },

    clearUpload() {
      if (uploadAbort) uploadAbort.abort()
      this.uploadTask = null
    },

    async fetchBlob(manifest) {
      const { client, channel, masterKey } = this.requireReady()
      const { blob } = await downloadFile({ client, channel, manifest, masterKey })
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
      this.allFiles = this.allFiles.map((file) => (file.id === manifest.id ? { ...file, ...updated } : file))
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
  },
})
