<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  AlertTriangle,
  HardDrive,
  KeyRound,
  Lock,
  LockOpen,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from '@lucide/vue'
import { useVaultStore } from '@/stores/vault'
import { MIN_PASSPHRASE_LENGTH } from '@/lib/vault/vault'
import { shortId } from '@/lib/utils'
import AppBadge from '@/components/ui/AppBadge.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppCard from '@/components/ui/AppCard.vue'
import AppInput from '@/components/ui/AppInput.vue'

const vault = useVaultStore()

const passphrase = ref('')
const confirm = ref('')
const formError = ref('')
const revealing = ref(false)

const isChecking = computed(() => vault.status === 'idle' || vault.status === 'checking')
const isCreate = computed(() => vault.status === 'no-vault')
const isLocked = computed(() => vault.status === 'locked')
const isUnlocked = computed(() => vault.status === 'unlocked')
const isError = computed(() => vault.status === 'error')

const createdLine = computed(() => {
  const value = vault.envelope?.createdAt
  return value ? new Date(value).toLocaleString() : '—'
})

const groupLine = computed(() =>
  vault.group?.title ? `${vault.group.title} · id ${shortId(vault.group.id, 10)}` : '—',
)

const statusBadge = computed(() => {
  if (isUnlocked.value) return { tone: 'success', label: 'Unlocked' }
  if (isLocked.value) return { tone: 'warning', label: 'Locked' }
  if (isCreate.value) return { tone: 'info', label: 'Not set up' }
  if (isError.value) return { tone: 'danger', label: 'Error' }
  return { tone: 'neutral', label: 'Checking' }
})

function clearForm() {
  passphrase.value = ''
  confirm.value = ''
  formError.value = ''
}

async function refresh() {
  clearForm()
  await vault.init({ force: true })
}

async function submitCreate() {
  formError.value = ''
  if (passphrase.value !== confirm.value) {
    formError.value = 'Passphrases do not match'
    return
  }
  try {
    await vault.create(passphrase.value, confirm.value)
    clearForm()
  } catch (error) {
    formError.value = vault.error || error.message
  }
}

async function submitUnlock() {
  formError.value = ''
  try {
    await vault.unlock(passphrase.value)
    clearForm()
  } catch (error) {
    formError.value = vault.error || error.message
  }
}

function lock() {
  vault.lock()
  clearForm()
}

async function forgetDevice() {
  const ok = window.confirm(
    'Forget this device?\n\n' +
      'This only clears local pointers. The vault and every file stay in your Telegram group, ' +
      'and you can re-discover them by signing in again.',
  )
  if (!ok) return
  vault.forgetDevice()
  await vault.init({ force: true })
}

onMounted(() => {
  vault.init()
})
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-5 px-5 py-6">
    <div class="flex flex-wrap items-center gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <h1 class="text-lg font-semibold tracking-tight">
            Vault
          </h1>
          <AppBadge
            :tone="statusBadge.tone"
            dot
          >
            {{ statusBadge.label }}
          </AppBadge>
        </div>
        <p class="text-xs text-muted-foreground">
          One passphrase wraps the master key. Every file key is derived from it.
        </p>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <AppButton
          v-if="isUnlocked"
          variant="outline"
          size="sm"
          @click="lock"
        >
          <Lock class="h-4 w-4" />
          Lock
        </AppButton>
        <AppButton
          variant="ghost"
          size="sm"
          :loading="isChecking"
          title="Re-read the vault from Telegram"
          @click="refresh"
        >
          <RefreshCw class="h-4 w-4" />
          Refresh
        </AppButton>
      </div>
    </div>

    <AppCard
      v-if="isChecking"
      title="Checking the vault"
      description="Resolving your drive group and the #index topic"
    >
      <div class="flex items-center gap-3 py-6 text-sm text-muted-foreground">
        <span
          class="h-4 w-4 animate-spin rounded-full border-2 border-sky-300/40 border-t-sky-300"
        />
        Looking for an encrypted envelope in Telegram…
      </div>
    </AppCard>

    <AppCard
      v-else-if="isError"
      title="The vault could not be loaded"
      description="Telegram or the drive group returned an error"
    >
      <div class="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
        <p class="text-xs leading-relaxed text-red-200">
          {{ vault.error || 'Unknown error' }}
        </p>
      </div>
      <AppButton
        class="mt-4"
        variant="outline"
        :loading="isChecking"
        @click="refresh"
      >
        <RefreshCw class="h-4 w-4" />
        Try again
      </AppButton>
    </AppCard>

    <template v-else>
      <AppCard
        title="Drive"
        description="Facts read from Telegram, not from this device"
      >
        <dl class="grid gap-3 text-xs sm:grid-cols-2">
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Drive id
            </dt>
            <dd class="mt-1 font-mono text-[11px]">
              {{ vault.driveId || '—' }}
            </dd>
          </div>
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Group
            </dt>
            <dd class="mt-1 truncate text-xs font-medium">
              {{ groupLine }}
            </dd>
          </div>
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Index topic
            </dt>
            <dd class="mt-1 text-xs font-medium">
              #index · id {{ vault.indexTopicId || '—' }}
            </dd>
          </div>
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Vault message
            </dt>
            <dd class="mt-1 text-xs font-medium">
              {{ vault.vaultMessageId ? `id ${vault.vaultMessageId}` : 'none yet' }}
            </dd>
          </div>
        </dl>
      </AppCard>

      <AppCard
        v-if="isCreate"
        title="Create your vault"
        description="Pick a passphrase you will remember. It cannot be reset."
      >
        <form
          class="space-y-4"
          @submit.prevent="submitCreate"
        >
          <div class="flex items-start gap-3 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
            <ShieldCheck class="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
            <p class="text-xs leading-relaxed text-muted-foreground">
              The passphrase wraps a random 256-bit master key with Argon2id and stores only the
              wrapped key in the <span class="font-mono">#index</span> topic. Nobody — including
              Telegram — can recover your files if you forget it. There is no reset.
            </p>
          </div>

          <AppInput
            v-model="passphrase"
            :type="revealing ? 'text' : 'password'"
            label="Passphrase"
            :hint="`At least ${MIN_PASSPHRASE_LENGTH} characters. A long sentence works well.`"
            autocomplete="new-password"
          />
          <AppInput
            v-model="confirm"
            :type="revealing ? 'text' : 'password'"
            label="Confirm passphrase"
            autocomplete="new-password"
          />

          <label class="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              v-model="revealing"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-border bg-background"
            >
            Show passphrase
          </label>

          <p
            v-if="formError"
            class="text-xs text-red-300"
          >
            {{ formError }}
          </p>

          <div class="flex items-center gap-2">
            <AppButton
              type="submit"
              :loading="vault.busy === 'create'"
            >
              <KeyRound class="h-4 w-4" />
              Create vault
            </AppButton>
            <span class="text-[11px] text-muted-foreground">
              Encrypts before upload. Takes a second or two.
            </span>
          </div>
        </form>
      </AppCard>

      <AppCard
        v-else-if="isLocked"
        title="Unlock this drive"
        description="The envelope is in Telegram; your passphrase stays local"
      >
        <form
          class="space-y-4"
          @submit.prevent="submitUnlock"
        >
          <dl class="grid gap-3 text-xs sm:grid-cols-2">
            <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
                Key derivation
              </dt>
              <dd class="mt-1 font-mono text-[11px]">
                {{ vault.kdfLine || '—' }}
              </dd>
            </div>
            <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
                Created
              </dt>
              <dd class="mt-1 text-xs font-medium">
                {{ createdLine }}
              </dd>
            </div>
          </dl>

          <AppInput
            v-model="passphrase"
            :type="revealing ? 'text' : 'password'"
            label="Passphrase"
            autocomplete="current-password"
          />

          <label class="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              v-model="revealing"
              type="checkbox"
              class="h-3.5 w-3.5 rounded border-border bg-background"
            >
            Show passphrase
          </label>

          <p
            v-if="formError"
            class="text-xs text-red-300"
          >
            {{ formError }}
          </p>

          <AppButton
            type="submit"
            :loading="vault.busy === 'unlock'"
          >
            <LockOpen class="h-4 w-4" />
            Unlock
          </AppButton>
        </form>
      </AppCard>

      <AppCard
        v-else-if="isUnlocked"
        title="Vault is unlocked"
        description="The master key lives in this tab only"
      >
        <div
          class="flex items-start gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3"
        >
          <ShieldCheck class="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
          <div class="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p>
              File keys can now be derived. Locking drops the master key from memory; a reload
              always starts locked.
            </p>
            <p class="text-emerald-200/80">
              Unlocked {{ vault.unlockedAt ? new Date(vault.unlockedAt).toLocaleTimeString() : '' }}
            </p>
          </div>
        </div>

        <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2">
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Wrapped key
            </dt>
            <dd class="mt-1 text-xs font-medium">
              AES-256-GCM · AAD bound to drive id
            </dd>
          </div>
          <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
            <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Key derivation
            </dt>
            <dd class="mt-1 font-mono text-[11px]">
              {{ vault.kdfLine || '—' }}
            </dd>
          </div>
        </dl>
      </AppCard>

      <AppCard
        title="This device"
        description="Local pointers only — nothing secret is stored in the browser"
      >
        <div class="flex flex-wrap items-center gap-2">
          <AppButton
            variant="outline"
            size="sm"
            @click="refresh"
          >
            <RefreshCw class="h-4 w-4" />
            Re-read from Telegram
          </AppButton>
          <AppButton
            variant="danger"
            size="sm"
            @click="forgetDevice"
          >
            <Trash2 class="h-4 w-4" />
            Forget this device
          </AppButton>
          <span class="text-[11px] text-muted-foreground">
            Forgetting never deletes anything in Telegram.
          </span>
        </div>
      </AppCard>
    </template>

    <p class="flex items-center justify-center gap-2 text-[11px] text-muted-foreground/70">
      <HardDrive class="h-3.5 w-3.5" />
      Vault envelope v{{ vault.envelope?.v || 1 }} · stored as an opaque document in #index
    </p>
  </div>
</template>
