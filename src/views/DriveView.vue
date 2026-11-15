<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  Download,
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
  RefreshCw,
  Trash2,
  Upload,
} from '@lucide/vue'
import { useDriveStore } from '@/stores/drive'
import { useVaultStore } from '@/stores/vault'
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
      await drive.init()
    }
    if (status !== 'unlocked') {
      drive.reset()
    }
  },
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

        <div
          v-if="ready"
          class="space-y-1"
        >
          <button
            v-for="folder in drive.folders"
            :key="folder.id"
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-white/5"
            :class="folder.id === drive.selectedTopicId ? 'bg-white/5 text-foreground' : 'text-muted-foreground'"
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
        <p
          v-else
          class="px-2 py-2 text-[11px] text-muted-foreground"
        >
          Unlock the vault to see folders.
        </p>
      </div>

      <div
        v-if="ready"
        class="space-y-2 rounded-xl border border-white/5 bg-white/[0.02] p-3"
      >
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
        <p
          v-if="folderError"
          class="text-[11px] text-red-300"
        >
          {{ folderError }}
        </p>
      </div>

      <RouterLink
        to="/vault"
        class="flex items-center gap-2 rounded-xl border border-white/5 bg-white/[0.02] p-3 text-xs text-muted-foreground hover:bg-white/[0.04]"
      >
        <KeyRound class="h-3.5 w-3.5" />
        Vault
        <AppBadge
          :tone="vaultBadge.tone"
          class="ml-auto"
        >{{ vaultBadge.label }}</AppBadge>
      </RouterLink>
    </aside>

    <section class="min-w-0 flex-1 space-y-5">
      <div class="flex flex-wrap items-center gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h1 class="truncate text-lg font-semibold tracking-tight">
              {{ drive.selectedFolder?.title || 'My Drive' }}
            </h1>
            <AppBadge
              tone="info"
              dot
            >
              M2 drive
            </AppBadge>
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
          <input
            ref="fileInput"
            type="file"
            class="hidden"
            @change="onFilePicked"
          >
          <AppButton
            :disabled="!ready || !drive.selectedTopicId || drive.isUploading"
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

      <AppCard
        v-if="checking"
        title="Loading drive"
        description="Resolving the vault and group"
      >
        <div class="flex items-center gap-3 py-4 text-sm text-muted-foreground">
          <LoaderCircle class="h-4 w-4 animate-spin text-sky-300" />
          Checking your Telegram drive…
        </div>
      </AppCard>

      <AppCard
        v-else-if="needsVault"
        title="Vault required"
        description="Files are encrypted with a key only your passphrase can unlock"
      >
        <p class="text-sm text-muted-foreground">
          {{ vault.status === 'no-vault' ? 'Create a vault to generate your master key and start uploading.' : 'Unlock your vault to derive file keys and access this drive.' }}
        </p>
        <RouterLink
          to="/vault"
          class="mt-4 inline-block"
        >
          <AppButton>
            <KeyRound class="h-4 w-4" />
            {{ vault.status === 'no-vault' ? 'Create vault' : 'Unlock vault' }}
          </AppButton>
        </RouterLink>
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
            <AppButton
              variant="outline"
              :loading="drive.creatingFolder"
              @click="createFolder"
            >
              <FolderPlus class="h-4 w-4" />
            </AppButton>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="folder in drive.folders"
              :key="folder.id"
              type="button"
              class="rounded-full border px-3 py-1 text-xs"
              :class="folder.id === drive.selectedTopicId ? 'border-sky-400/40 bg-sky-400/10 text-sky-200' : 'border-white/10 text-muted-foreground'"
              @click="drive.selectFolder(folder.id)"
            >
              {{ folder.title }}
            </button>
          </div>
        </div>

        <AppCard
          v-if="drive.upload"
          :title="`Upload: ${drive.upload.fileName}`"
          description="Encrypted on this device before sending"
        >
          <div class="space-y-2">
            <div class="flex items-center justify-between text-xs text-muted-foreground">
              <span class="capitalize">{{ drive.upload.stage }}</span>
              <span>{{ drive.upload.progress }}%</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-white/5">
              <div
                class="h-full rounded-full bg-sky-400 transition-all"
                :style="{ width: `${drive.upload.progress}%` }"
              />
            </div>
            <div class="flex items-center gap-2">
              <p
                v-if="drive.upload.error"
                class="text-xs text-red-300"
              >
                {{ drive.upload.error }}
              </p>
              <p
                v-else-if="drive.upload.done"
                class="text-xs text-emerald-300"
              >
                Upload complete and manifest saved.
              </p>
              <p
                v-else
                class="text-xs text-muted-foreground"
              >
                {{ drive.upload.chunksDone }}/{{ drive.upload.chunkCount || '…' }} chunks uploaded
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
                <AppButton
                  v-else
                  size="sm"
                  variant="ghost"
                  @click="drive.clearUpload()"
                >
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
            <AppBadge
              v-if="drive.filesLoading"
              tone="neutral"
              dot
            >
              Loading
            </AppBadge>
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
            <p class="mt-3 text-sm font-medium">
              No files yet
            </p>
            <p class="mt-1 text-xs text-muted-foreground">
              Upload a file and it will be chunked, encrypted, and stored in this folder.
            </p>
          </div>

          <ul
            v-else
            class="divide-y divide-white/5"
          >
            <li
              v-for="item in drive.files"
              :key="item.id"
              class="flex items-center gap-3 py-3"
            >
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/5 text-sky-300">
                <component
                  :is="iconFor(item.category)"
                  class="h-4 w-4"
                />
              </span>
              <div class="min-w-0 flex-1">
                <div
                  class="truncate text-sm font-medium"
                  :title="item.name"
                >
                  {{ item.name }}
                </div>
                <div class="text-[11px] text-muted-foreground">
                  {{ formatBytes(item.size) }} · {{ item.chunkCount }} chunk{{ item.chunkCount === 1 ? '' : 's' }} · {{ item.category }} · {{ formatDate(item.createdAt) }}
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <AppButton
                  variant="ghost"
                  size="icon"
                  title="Download"
                  :loading="busyFileId === item.id"
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

      <p class="text-[11px] text-muted-foreground/70">
        Folder names are topic titles in Telegram. File names and manifests are encrypted; chunk documents use opaque ids.
      </p>
    </section>
  </div>
</template>
