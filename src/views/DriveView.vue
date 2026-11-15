<script setup>
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ArrowRight,
  CloudUpload,
  Database,
  FolderClosed,
  HardDrive,
  Image,
  KeyRound,
  Music,
  Terminal,
  Video,
} from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { useVaultStore } from '@/stores/vault'
import { formatBytes, shortId } from '@/lib/utils'
import { limits, storageKeys } from '@/lib/config'
import AppBadge from '@/components/ui/AppBadge.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppCard from '@/components/ui/AppCard.vue'

const auth = useAuthStore()
const vault = useVaultStore()

// Fall back to the M0 spike lab pointer until the vault store has resolved.
const legacyGroup = (() => {
  try {
    return JSON.parse(localStorage.getItem(storageKeys.debugGroup) || 'null')
  } catch {
    return null
  }
})()

const group = computed(() => vault.group || legacyGroup)

const vaultBadge = computed(() => {
  if (vault.status === 'unlocked') return { tone: 'success', label: 'Vault unlocked' }
  if (vault.status === 'locked') return { tone: 'warning', label: 'Vault locked' }
  if (vault.status === 'no-vault') return { tone: 'info', label: 'No vault yet' }
  if (vault.status === 'error') return { tone: 'danger', label: 'Vault error' }
  return { tone: 'neutral', label: 'Checking vault' }
})

const vaultLine = computed(() => {
  if (vault.status === 'unlocked') return 'Master key is in memory for this tab'
  if (vault.status === 'locked') return 'Unlock with your passphrase to derive file keys'
  if (vault.status === 'no-vault') return 'Create a passphrase to start your encrypted drive'
  if (vault.status === 'error') return vault.error || 'Could not read the vault'
  return 'Resolving the drive group and #index topic'
})

const vaultAction = computed(() => (vault.status === 'no-vault' ? 'Create vault' : 'Open vault'))

const folders = [
  { name: 'Photos', icon: Image, count: '—' },
  { name: 'Videos', icon: Video, count: '—' },
  { name: 'Documents', icon: FolderClosed, count: '—' },
  { name: 'Audio', icon: Music, count: '—' },
]

const accountLine = computed(() =>
  auth.me?.username ? `@${auth.me.username}` : auth.me?.id || 'not connected',
)

onMounted(() => {
  vault.init()
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-7xl gap-6 px-5 py-6">
    <aside class="hidden w-56 shrink-0 space-y-5 lg:block">
      <div class="space-y-1">
        <div class="px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Drive
        </div>
        <RouterLink
          to="/drive"
          class="flex items-center gap-2 rounded-lg bg-white/5 px-2.5 py-2 text-sm font-medium"
        >
          <HardDrive class="h-4 w-4 text-sky-300" />
          My Drive
        </RouterLink>
        <RouterLink
          to="/vault"
          class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
        >
          <KeyRound class="h-4 w-4" />
          Vault
          <span class="ml-auto text-[10px]">
            {{
              vault.status === 'unlocked' ? 'open' : vault.status === 'no-vault' ? 'new' : 'locked'
            }}
          </span>
        </RouterLink>
      </div>

      <div class="space-y-1">
        <div class="px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Folders
        </div>
        <button
          v-for="folder in folders"
          :key="folder.name"
          type="button"
          class="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground/70"
          disabled
        >
          <component
            :is="folder.icon"
            class="h-4 w-4"
          />
          {{ folder.name }}
          <span class="ml-auto text-[10px]">{{ folder.count }}</span>
        </button>
      </div>

      <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3">
        <div class="flex items-center gap-2 text-xs font-medium">
          <Database class="h-3.5 w-3.5 text-sky-300" />
          Storage
        </div>
        <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Telegram supergroup · {{ group?.title || 'not provisioned yet' }}
        </p>
        <RouterLink
          to="/debug"
          class="mt-2 inline-flex text-[11px] text-sky-300 hover:underline"
        >
          Open spike lab
        </RouterLink>
      </div>
    </aside>

    <section class="min-w-0 flex-1 space-y-5">
      <div class="flex flex-wrap items-center gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h1 class="text-lg font-semibold tracking-tight">
              My Drive
            </h1>
            <AppBadge
              tone="info"
              dot
            >
              M1 vault
            </AppBadge>
          </div>
          <p class="text-xs text-muted-foreground">
            Signed in as {{ accountLine }} · {{ limits.maxFileSize / (1024 * 1024) }} MB per file ·
            {{ Math.round(limits.chunkSize / (1024 * 1024)) }} MB chunks
          </p>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <AppButton
            variant="outline"
            size="md"
            disabled
            title="Folder creation lands in M2"
          >
            <FolderClosed class="h-4 w-4" />
            New folder
          </AppButton>
          <AppButton
            disabled
            title="Upload UI lands in M4"
          >
            <CloudUpload class="h-4 w-4" />
            Upload
          </AppButton>
        </div>
      </div>

      <AppCard
        title="Storage engine"
        description="Where the project is right now"
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Account
            </div>
            <div class="mt-1 truncate text-sm font-medium">
              {{ auth.displayName || '—' }}
            </div>
            <div class="text-[11px] text-muted-foreground">
              {{ accountLine }}
            </div>
          </div>
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Drive group
            </div>
            <div class="mt-1 truncate text-sm font-medium">
              {{ group?.title || 'Not provisioned' }}
            </div>
            <div class="text-[11px] text-muted-foreground">
              {{ group?.id ? `id ${shortId(group.id, 12)}` : 'Run the spike lab to create it' }}
            </div>
          </div>
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Chunk size
            </div>
            <div class="mt-1 text-sm font-medium">
              {{ formatBytes(limits.chunkSize) }}
            </div>
            <div class="text-[11px] text-muted-foreground">
              AES-256-GCM per chunk
            </div>
          </div>
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <div class="flex items-center justify-between gap-2">
              <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
                Vault
              </div>
              <AppBadge :tone="vaultBadge.tone">
                {{ vaultBadge.label }}
              </AppBadge>
            </div>
            <div class="mt-1 text-sm font-medium">
              <RouterLink
                to="/vault"
                class="text-sky-300 hover:underline"
              >
                {{ vaultAction }}
              </RouterLink>
            </div>
            <div class="text-[11px] text-muted-foreground">
              {{ vaultLine }}
            </div>
          </div>
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Index
            </div>
            <div class="mt-1 text-sm font-medium">
              {{ vault.indexTopicId ? '#index topic ready' : 'Not built yet' }}
            </div>
            <div class="text-[11px] text-muted-foreground">
              M5 · file index on top of this topic
            </div>
          </div>
        </div>
      </AppCard>

      <div
        class="rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-6 py-12 text-center"
      >
        <span
          class="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-sky-400/10 text-sky-300"
        >
          <Terminal class="h-5 w-5" />
        </span>
        <h2 class="mt-4 text-sm font-semibold">
          The drive UI is intentionally empty
        </h2>
        <p class="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          Folder and file screens are wired after the storage primitives are proven. The vault now
          seals a master key in Telegram, and the spike lab still exercises group creation, topic
          posting, encrypted chunk upload, download and hash verification against your real account.
        </p>
        <RouterLink
          to="/debug"
          class="mt-4 inline-block"
        >
          <AppButton>
            Open spike lab
            <ArrowRight class="h-4 w-4" />
          </AppButton>
        </RouterLink>
      </div>
    </section>
  </div>
</template>
