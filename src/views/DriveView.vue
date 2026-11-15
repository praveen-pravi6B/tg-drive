<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  Download,
  Eye,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderClosed,
  FolderPlus,
  HardDrive,
  KeyRound,
  LoaderCircle,
  LockOpen,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from '@lucide/vue'
import { useDriveStore } from '@/stores/drive'
import { useVaultStore } from '@/stores/vault'
import { MIN_PASSPHRASE_LENGTH } from '@/lib/vault/vault'
import { formatBytes } from '@/lib/utils'
import { limits } from '@/lib/config'
import AppBadge from '@/components/ui/AppBadge.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppCard from '@/components/ui/AppCard.vue'
import AppInput from '@/components/ui/AppInput.vue'

const drive = useDriveStore()
const vault = useVaultStore()

const newFolder = ref('')
const folderError = ref('')
const actionError = ref('')
const fileInput = ref(null)
const busyFileId = ref('')
const preview = ref(null) // { item, url, kind, loading, error }
const thumbUrls = ref({})
const thumbLoading = ref({})
const vaultPassphrase = ref('')
const vaultConfirm = ref('')
const vaultFormError = ref('')
const vaultRevealing = ref(false)

function isPreviewable(item) {
  if (!item) return false
  if (Number(item.size || 0) > limits.previewMaxSize) return false
  const mime = String(item.mime || '').toLowerCase()
  return (
    item.category === 'image' ||
    item.category === 'video' ||
    item.category === 'audio' ||
    mime === 'application/pdf' ||
    (item.category === 'document' && mime === 'application/pdf')
  )
}

function previewKind(item) {
  const mime = String(item?.mime || '').toLowerCase()
  if (item?.category === 'image' || mime.startsWith('image/')) return 'image'
  if (item?.category === 'video' || mime.startsWith('video/')) return 'video'
  if (item?.category === 'audio' || mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  return 'other'
}

function closePreview() {
  if (preview.value?.url) URL.revokeObjectURL(preview.value.url)
  preview.value = null
}

function revokeThumbs() {
  for (const url of Object.values(thumbUrls.value)) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* ignore */
    }
  }
  thumbUrls.value = {}
  thumbLoading.value = {}
}

function canThumb(item) {
  if (!item || item.category !== 'image') return false
  return Number(item.size || 0) <= limits.previewMaxSize
}

async function ensureThumb(item) {
  if (!item?.id || !canThumb(item)) return
  if (thumbUrls.value[item.id] || thumbLoading.value[item.id]) return
  thumbLoading.value = { ...thumbLoading.value, [item.id]: true }
  try {
    const blob = await drive.fetchBlob(item)
    const url = URL.createObjectURL(blob)
    thumbUrls.value = { ...thumbUrls.value, [item.id]: url }
  } catch {
    /* thumbnail is optional */
  } finally {
    const next = { ...thumbLoading.value }
    delete next[item.id]
    thumbLoading.value = next
  }
}

let thumbTimer = null
function scheduleThumbs() {
  if (thumbTimer) clearTimeout(thumbTimer)
  thumbTimer = setTimeout(async () => {
    const items = (drive.files || []).filter((item) => canThumb(item) && !thumbUrls.value[item.id])
    for (const item of items.slice(0, 12)) {
      // Load sequentially to avoid hammering Telegram/network.
      // eslint-disable-next-line no-await-in-loop
      await ensureThumb(item)
    }
  }, 150)
}

async function submitVaultUnlock() {
  vaultFormError.value = ''
  try {
    await vault.unlock(vaultPassphrase.value)
    vaultPassphrase.value = ''
    vaultConfirm.value = ''
  } catch (error) {
    vaultFormError.value = vault.error || error.message
  }
}

async function submitVaultCreate() {
  vaultFormError.value = ''
  if (vaultPassphrase.value !== vaultConfirm.value) {
    vaultFormError.value = 'Passphrases do not match'
    return
  }
  try {
    await vault.create(vaultPassphrase.value, vaultConfirm.value)
    vaultPassphrase.value = ''
    vaultConfirm.value = ''
  } catch (error) {
    vaultFormError.value = vault.error || error.message
  }
}

function openItem(item) {
  if (isPreviewable(item)) openPreview(item)
  else download(item)
}

async function openPreview(item) {
  if (!isPreviewable(item)) return
  closePreview()
  actionError.value = ''
  busyFileId.value = item.id
  preview.value = { item, url: '', kind: previewKind(item), loading: true, error: '' }
  try {
    const blob = await drive.fetchBlob(item)
    if (!preview.value || preview.value.item?.id !== item.id) return
    preview.value.url = URL.createObjectURL(blob)
  } catch (error) {
    if (preview.value && preview.value.item?.id === item.id) {
      preview.value.error = error.message
    }
  } finally {
    if (preview.value && preview.value.item?.id === item.id) preview.value.loading = false
    busyFileId.value = ''
  }
}

onBeforeUnmount(() => {
  closePreview()
  revokeThumbs()
  if (thumbTimer) clearTimeout(thumbTimer)
})

const ready = computed(() => vault.status === 'unlocked')
const needsVault = computed(() => ['no-vault', 'locked'].includes(vault.status))
const checking = computed(() => ['idle', 'checking'].includes(vault.status))

const vaultBadge = computed(() => {
  if (vault.status === 'unlocked') return { tone: 'success', label: 'Unlocked' }
  if (vault.status === 'locked') return { tone: 'warning', label: 'Locked' }
  if (vault.status === 'no-vault') return { tone: 'info', label: 'No vault' }
  if (vault.status === 'error') return { tone: 'danger', label: 'Error' }
  return { tone: 'neutral', label: 'Checking' }
})

function iconFor(category) {
  if (category === 'image') return FileImage
  if (category === 'video') return FileVideo
  if (category === 'audio') return FileAudio
  if (category === 'document') return FileText
  return File
}

function formatDate(value) {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return '—'
  }
}

async function createFolder() {
  folderError.value = ''
  const name = newFolder.value.trim()
  if (!name) {
    folderError.value = 'Enter a folder name'
    return
  }
  try {
    await drive.createFolder(name)
    newFolder.value = ''
  } catch (error) {
    folderError.value = error.message
  }
}

function pickFile() {
  fileInput.value?.click()
}

async function onFilePicked(event) {
  const [file] = event.target.files || []
  event.target.value = ''
  if (!file) return
  actionError.value = ''
  try {
    await drive.upload(file)
  } catch (error) {
    actionError.value = error.message
  }
}

async function download(manifest) {
  actionError.value = ''
  busyFileId.value = manifest.id
  try {
    await drive.download(manifest)
  } catch (error) {
    actionError.value = error.message
  } finally {
    busyFileId.value = ''
  }
}

async function removeFile(manifest) {
  const ok = window.confirm(
    `Delete "${manifest.name}"?\n\nThis removes its encrypted chunks and manifest from Telegram.`,
  )
  if (!ok) return
  actionError.value = ''
  busyFileId.value = manifest.id
  try {
    await drive.remove(manifest)
  } catch (error) {
    actionError.value = error.message
  } finally {
    busyFileId.value = ''
  }
}

watch(
  () => vault.status,
  async (status, previous) => {
    if (status === 'unlocked' && previous !== 'unlocked') {
      vaultFormError.value = ''
      await drive.init()
    }
    if (status !== 'unlocked') {
      drive.reset()
      revokeThumbs()
    }
  },
)

watch(
  () => [drive.files, drive.selectedTopicId, ready.value],
  () => {
    if (ready.value) scheduleThumbs()
  },
  { deep: true },
)

onMounted(async () => {
  await vault.init()
  if (vault.status === 'unlocked') await drive.init()
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-7xl gap-6 px-5 py-6">
    <aside class="hidden w-60 shrink-0 space-y-5 lg:block">
      <div class="space-y-2">
        <div class="flex items-center justify-between px-2">
          <div class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Folders
          </div>
          <button
            type="button"
            class="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-40"
            :disabled="!ready || drive.status === 'loading'"
            title="Refresh folders"
            @click="drive.refreshFolders()"
          >
            <RefreshCw class="h-3.5 w-3.5" />
          </button>
        </div>

        <div v-if="ready" class="space-y-1">
          <button
            v-for="folder in drive.folders"
            :key="folder.id"
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-white/5"
            :class="
              folder.id === drive.selectedTopicId
                ? 'bg-white/5 text-foreground'
                : 'text-muted-foreground'
            "
            @click="drive.selectFolder(folder.id)"
          >
            <FolderClosed
              class="h-4 w-4 shrink-0"
              :class="folder.id === drive.selectedTopicId && 'text-sky-300'"
            />
            <span class="truncate">{{ folder.title }}</span>
          </button>
          <p
            v-if="!drive.folders.length && drive.status === 'ready'"
            class="px-2 py-2 text-[11px] text-muted-foreground"
          >
            No folders yet. Create one to start uploading.
          </p>
        </div>
        <p v-else class="px-2 py-2 text-[11px] text-muted-foreground">
          Unlock the vault to see folders.
        </p>
      </div>

      <div v-if="ready" class="space-y-2 rounded-xl border border-white/5 bg-white/[0.02] p-3">
        <div class="flex items-center gap-2 text-xs font-medium">
          <FolderPlus class="h-3.5 w-3.5 text-sky-300" />
          New folder
        </div>
        <AppInput
          v-model="newFolder"
          placeholder="Folder name"
          @keydown.enter.prevent="createFolder"
        />
        <AppButton
          size="sm"
          variant="outline"
          class="w-full"
          :loading="drive.creatingFolder"
          @click="createFolder"
        >
          Create
        </AppButton>
        <p v-if="folderError" class="text-[11px] text-red-300">
          {{ folderError }}
        </p>
      </div>

      <RouterLink
        to="/vault"
        class="flex items-center gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-xs text-muted-foreground hover:bg-white/[0.04]"
      >
        <KeyRound class="h-3.5 w-3.5" />
        Vault
        <AppBadge :tone="vaultBadge.tone" class="ml-auto">{{ vaultBadge.label }}</AppBadge>
      </RouterLink>
    </aside>

    <section class="min-w-0 flex-1 space-y-5">
      <div class="flex flex-wrap items-center gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h1 class="truncate text-lg font-semibold tracking-tight">
              {{ drive.selectedFolder?.title || 'My Drive' }}
            </h1>
            <AppBadge tone="info" dot> M2 drive </AppBadge>
          </div>
          <p class="text-xs text-muted-foreground">
            {{ limits.maxFileSize / (1024 * 1024) }} MB per file ·
            {{ Math.round(limits.chunkSize / (1024 * 1024)) }} MB chunks · one upload at a time
          </p>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <AppButton
            variant="outline"
            size="md"
            :disabled="!ready || drive.filesLoading"
            @click="drive.refreshFiles()"
          >
            <RefreshCw class="h-4 w-4" />
            Refresh
          </AppButton>
          <input ref="fileInput" type="file" class="hidden" @change="onFilePicked" />
          <AppButton
            :disabled="!ready || !drive.selectedTopicId || drive.isUploading"
            :title="!drive.selectedTopicId ? 'Create or select a folder first' : ''"
            @click="pickFile"
          >
            <Upload class="h-4 w-4" />
            Upload
          </AppButton>
        </div>
      </div>

      <div
        v-if="actionError || drive.error || vault.error"
        class="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-200"
      >
        {{ actionError || drive.error || vault.error }}
      </div>

      <AppCard v-if="checking" title="Loading drive" description="Resolving the vault and group">
        <div class="flex items-center gap-3 py-4 text-sm text-muted-foreground">
          <LoaderCircle class="h-4 w-4 animate-spin text-sky-300" />
          Checking your Telegram drive…
        </div>
      </AppCard>

      <template v-else-if="ready">
        <div class="space-y-3 lg:hidden">
          <div class="flex gap-2">
            <AppInput
              v-model="newFolder"
              placeholder="New folder name"
              class="flex-1"
              @keydown.enter.prevent="createFolder"
            />
            <AppButton variant="outline" :loading="drive.creatingFolder" @click="createFolder">
              <FolderPlus class="h-4 w-4" />
            </AppButton>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="folder in drive.folders"
              :key="folder.id"
              type="button"
              class="rounded-full border px-3 py-1 text-xs"
              :class="
                folder.id === drive.selectedTopicId
                  ? 'border-sky-400/40 bg-sky-400/10 text-sky-200'
                  : 'border-white/10 text-muted-foreground'
              "
              @click="drive.selectFolder(folder.id)"
            >
              {{ folder.title }}
            </button>
          </div>
        </div>

        <AppCard
          v-if="drive.uploadTask"
          :title="`Upload: ${drive.uploadTask.fileName || 'file'}`"
          description="Encrypted on this device before sending"
        >
          <div class="space-y-2">
            <div class="flex items-center justify-between text-xs text-muted-foreground">
              <span class="capitalize">{{ drive.uploadTask.stage || 'starting' }}</span>
              <span>{{ Number(drive.uploadTask.progress || 0) }}%</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-white/5">
              <div
                class="h-full rounded-full bg-sky-400 transition-all"
                :style="{ width: `${Number(drive.uploadTask.progress || 0)}%` }"
              />
            </div>
            <div class="flex items-center gap-2">
              <p v-if="drive.uploadTask.error" class="text-xs text-red-300">
                {{ drive.uploadTask.error }}
              </p>
              <p v-else-if="drive.uploadTask.done" class="text-xs text-emerald-300">
                Upload complete and manifest saved.
              </p>
              <p v-else class="text-xs text-muted-foreground">
                {{ Number(drive.uploadTask.chunksDone || 0) }}/{{ drive.uploadTask.chunkCount || '…' }}
                chunks uploaded
              </p>
              <div class="ml-auto flex gap-2">
                <AppButton
                  v-if="drive.isUploading"
                  size="sm"
                  variant="outline"
                  @click="drive.cancelUpload()"
                >
                  Cancel
                </AppButton>
                <AppButton v-else size="sm" variant="ghost" @click="drive.clearUpload()">
                  Dismiss
                </AppButton>
              </div>
            </div>
          </div>
        </AppCard>

        <AppCard
          v-if="!drive.selectedTopicId"
          title="Create a folder"
          description="Each folder is a Telegram forum topic in your drive group"
        >
          <p class="text-sm text-muted-foreground">
            Folders map to topics. Create one to start uploading encrypted files.
          </p>
        </AppCard>

        <AppCard
          v-else
          :title="`Files in ${drive.selectedFolder?.title || 'folder'}`"
          :description="`${drive.files.length} item${drive.files.length === 1 ? '' : 's'}`"
        >
          <template #actions>
            <AppBadge v-if="drive.filesLoading" tone="neutral" dot> Loading </AppBadge>
          </template>

          <div
            v-if="drive.filesLoading && !drive.files.length"
            class="flex items-center gap-3 py-8 text-sm text-muted-foreground"
          >
            <LoaderCircle class="h-4 w-4 animate-spin text-sky-300" />
            Reading encrypted manifests…
          </div>

          <div
            v-else-if="!drive.files.length"
            class="rounded-xl border border-dashed border-white/10 px-6 py-10 text-center"
          >
            <HardDrive class="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p class="mt-3 text-sm font-medium">No files yet</p>
            <p class="mt-1 text-xs text-muted-foreground">
              Upload a file and it will be chunked, encrypted, and stored in this folder.
            </p>
          </div>

          <ul v-else class="divide-y divide-white/5">
            <li v-for="item in drive.files" :key="item.id" class="flex items-center gap-3 py-3">
              <button
                type="button"
                class="shrink-0 overflow-hidden rounded-lg focus-ring"
                :title="isPreviewable(item) ? 'Open preview' : 'Download file'"
                @click="openItem(item)"
              >
                <img
                  v-if="thumbUrls[item.id]"
                  :src="thumbUrls[item.id]"
                  :alt="item.name"
                  class="h-10 w-10 object-cover"
                >
                <span
                  v-else
                  class="grid h-10 w-10 place-items-center bg-white/5 text-sky-300"
                >
                  <component :is="iconFor(item.category)" class="h-4 w-4" />
                </span>
              </button>

              <button
                type="button"
                class="min-w-0 flex-1 rounded text-left focus-ring"
                :title="isPreviewable(item) ? 'Open preview' : 'Download file'"
                @click="openItem(item)"
              >
                <div class="truncate text-sm font-medium">
                  {{ item.name }}
                </div>
                <div class="text-[11px] text-muted-foreground">
                  {{ formatBytes(item.size) }} · {{ item.chunkCount }} chunk{{
                    item.chunkCount === 1 ? '' : 's'
                  }}
                  · {{ item.category }} · {{ formatDate(item.createdAt) }}
                </div>
              </button>

              <div class="flex shrink-0 items-center gap-1">
                <AppButton
                  v-if="isPreviewable(item)"
                  variant="ghost"
                  size="icon"
                  title="Open"
                  :loading="busyFileId === item.id && preview?.item?.id === item.id"
                  :disabled="busyFileId && busyFileId !== item.id"
                  @click="openPreview(item)"
                >
                  <Eye class="h-4 w-4" />
                </AppButton>
                <AppButton
                  variant="ghost"
                  size="icon"
                  title="Download"
                  :loading="busyFileId === item.id && preview?.item?.id !== item.id ? false : busyFileId === item.id"
                  :disabled="busyFileId && busyFileId !== item.id"
                  @click="download(item)"
                >
                  <Download class="h-4 w-4" />
                </AppButton>
                <AppButton
                  variant="ghost"
                  size="icon"
                  title="Delete"
                  :disabled="busyFileId === item.id"
                  @click="removeFile(item)"
                >
                  <Trash2 class="h-4 w-4" />
                </AppButton>
              </div>
            </li>
          </ul>
        </AppCard>
      </template>

      <AppCard
        v-else-if="vault.status === 'error'"
        title="Could not open the vault"
        description="Telegram or the drive group returned an error"
      >
        <p class="text-sm text-red-200">{{ vault.error || 'Unknown error' }}</p>
        <AppButton class="mt-4" variant="outline" @click="vault.init({ force: true })">
          <RefreshCw class="h-4 w-4" />
          Try again
        </AppButton>
      </AppCard>

      <div v-else-if="needsVault" class="py-16 text-center text-sm text-muted-foreground">
        Unlock your drive to continue.
      </div>

      <p class="text-[11px] text-muted-foreground/70">
        Folder names are topic titles in Telegram. File names and manifests are encrypted; chunk
        documents use opaque ids.
      </p>
    </section>
  </div>

  <div
    v-if="needsVault && !checking"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
  >
    <div class="w-full max-w-md rounded-xl border border-white/10 bg-background p-5 shadow-2xl">
      <div class="flex items-center gap-2">
        <span class="grid h-9 w-9 place-items-center rounded-lg bg-sky-400/10 text-sky-300">
          <KeyRound class="h-4 w-4" />
        </span>
        <div>
          <h2 class="text-sm font-semibold">
            {{ vault.status === 'no-vault' ? 'Create your vault' : 'Unlock your drive' }}
          </h2>
          <p class="text-[11px] text-muted-foreground">
            {{ vault.status === 'no-vault' ? 'Set a passphrase to protect your files.' : 'Enter your passphrase to continue.' }}
          </p>
        </div>
      </div>

      <form
        class="mt-4 space-y-3"
        @submit.prevent="vault.status === 'no-vault' ? submitVaultCreate() : submitVaultUnlock()"
      >
        <p v-if="vault.status === 'no-vault'" class="text-xs leading-relaxed text-muted-foreground">
          Use at least {{ MIN_PASSPHRASE_LENGTH }} characters. This passphrase cannot be recovered.
        </p>
        <AppInput
          v-model="vaultPassphrase"
          :type="vaultRevealing ? 'text' : 'password'"
          label="Passphrase"
          :autocomplete="vault.status === 'no-vault' ? 'new-password' : 'current-password'"
        />
        <AppInput
          v-if="vault.status === 'no-vault'"
          v-model="vaultConfirm"
          :type="vaultRevealing ? 'text' : 'password'"
          label="Confirm passphrase"
          autocomplete="new-password"
        />
        <label class="flex items-center gap-2 text-xs text-muted-foreground">
          <input v-model="vaultRevealing" type="checkbox" class="h-3.5 w-3.5 rounded border-border bg-background">
          Show passphrase
        </label>

        <p v-if="vaultFormError || vault.error" class="text-xs text-red-300">
          {{ vaultFormError || vault.error }}
        </p>

        <div class="flex items-center gap-2 pt-1">
          <AppButton type="submit" :loading="vault.busy === 'create' || vault.busy === 'unlock'">
            <LockOpen class="h-4 w-4" />
            {{ vault.status === 'no-vault' ? 'Create & unlock' : 'Unlock' }}
          </AppButton>
          <RouterLink to="/vault" class="text-xs text-muted-foreground hover:text-foreground">
            Manage vault
          </RouterLink>
        </div>
      </form>
    </div>
  </div>

  <div
    v-if="preview"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    @click.self="closePreview"
  >
    <div
      class="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/10 bg-background shadow-2xl"
    >
      <div class="flex items-center gap-3 border-b border-white/5 px-4 py-3">
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium">
            {{ preview.item?.name }}
          </div>
          <div class="text-[11px] text-muted-foreground">
            {{ formatBytes(preview.item?.size || 0) }} · {{ preview.item?.mime || 'file' }}
          </div>
        </div>
        <AppButton variant="ghost" size="sm" @click="download(preview.item)">
          <Download class="h-4 w-4" />
          Download
        </AppButton>
        <AppButton variant="ghost" size="icon" title="Close" @click="closePreview">
          <X class="h-4 w-4" />
        </AppButton>
      </div>

      <div
        class="flex min-h-[300px] flex-1 items-center justify-center overflow-auto bg-black/20 p-4"
      >
        <div v-if="preview.loading" class="flex items-center gap-3 text-sm text-muted-foreground">
          <LoaderCircle class="h-5 w-5 animate-spin text-sky-300" />
          Downloading and decrypting…
        </div>
        <div v-else-if="preview.error" class="max-w-md text-center text-sm text-red-300">
          {{ preview.error }}
        </div>
        <img
          v-else-if="preview.kind === 'image' && preview.url"
          :src="preview.url"
          :alt="preview.item?.name"
          class="max-h-[70vh] max-w-full rounded object-contain"
        >
        <video
          v-else-if="preview.kind === 'video' && preview.url"
          :src="preview.url"
          controls
          class="max-h-[70vh] max-w-full rounded"
        />
        <audio
          v-else-if="preview.kind === 'audio' && preview.url"
          :src="preview.url"
          controls
          class="w-full max-w-xl"
        />
        <iframe
          v-else-if="preview.kind === 'pdf' && preview.url"
          :src="preview.url"
          class="h-[70vh] w-full rounded bg-white"
          title="PDF preview"
        />
        <div v-else class="text-sm text-muted-foreground">Preview not available. Use Download.</div>
      </div>
    </div>
  </div>
</template>
