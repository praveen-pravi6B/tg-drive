import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { useVaultStore, getMasterKey } from './vault'
import { errorMessage, log } from '@/lib/logger'
import { createTopic, listTopics } from '@/lib/telegram/topics'
import {
  deleteFile,
  downloadFile,
  isReservedTopicTitle,
  listFilesInTopic,
  uploadFile,
} from '@/lib/drive/files'
import { limits } from '@/lib/config'

let uploadAbort = null

export const useDriveStore = defineStore('drive', {
  state: () => ({
    status: 'idle', // idle | loading | ready | error
    error: '',
    folders: [],
    selectedTopicId: 0,
    files: [],
    filesLoading: false,
    creatingFolder: false,
    upload: null, // { fileName, fileId, progress, stage, error, done }
  }),

  getters: {
    selectedFolder(state) {
      return state.folders.find((folder) => folder.id === state.selectedTopicId) || null
    },
    isUploading: (state) => Boolean(state.upload && !state.upload.done && !state.upload.error),
  },

  actions: {
    reset() {
      if (uploadAbort) uploadAbort.abort()
      uploadAbort = null
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
      return { client, channel: vault.group, masterKey }
    },

    async refreshFolders() {
      const { client, channel } = this.requireReady()
      this.status = this.status === 'idle' ? 'loading' : this.status
      this.error = ''
      try {
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
        if (this.selectedTopicId) await this.refreshFiles()
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
          this.files = []
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
      this.files = []
      if (this.selectedTopicId) await this.refreshFiles()
    },

    async refreshFiles() {
      if (!this.selectedTopicId) return
      const vault = useVaultStore()
      if (vault.status !== 'unlocked') return
      const { client, channel, masterKey } = this.requireReady()
      this.filesLoading = true
      try {
        this.files = await listFilesInTopic({
          client,
          channel,
          topicId: this.selectedTopicId,
          masterKey,
          limit: 200,
        })
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
      this.upload = {
        fileName: file.name,
        fileId: '',
        progress: 0,
        stage: 'starting',
        chunksDone: 0,
        chunkCount: 0,
        error: '',
        done: false,
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
            if (!this.upload) return
            if (event.type === 'start') {
              this.upload.fileId = event.fileId
              this.upload.chunkCount = event.chunkCount
              this.upload.stage = 'encrypting & uploading'
            } else if (event.type === 'chunk-upload-progress') {
              this.upload.stage = `uploading chunk ${event.index + 1}/${this.upload.chunkCount || '?'}`
            } else if (event.type === 'chunk-uploaded') {
              this.upload.chunksDone = event.index + 1
              this.upload.progress = Math.round(
                (this.upload.chunksDone / (this.upload.chunkCount || 1)) * 100,
              )
            } else if (event.type === 'done') {
              this.upload.progress = 100
              this.upload.stage = 'saved'
              this.upload.done = true
            }
          },
        })
        this.files = [manifest, ...this.files]
        return manifest
      } catch (error) {
        if (this.upload) {
          this.upload.error = errorMessage(error)
          this.upload.stage = 'failed'
        }
        log('error', 'drive', 'Upload failed', error)
        throw error
      } finally {
        uploadAbort = null
      }
    },

    cancelUpload() {
      if (uploadAbort) uploadAbort.abort()
    },

    clearUpload() {
      if (this.isUploading) return
      this.upload = null
    },

    async download(manifest) {
      const { client, channel, masterKey } = this.requireReady()
      const { blob } = await downloadFile({ client, channel, manifest, masterKey })
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

    async remove(manifest) {
      const { client, channel } = this.requireReady()
      await deleteFile({ client, channel, manifest })
      this.files = this.files.filter((file) => file.id !== manifest.id)
    },
  },
})
