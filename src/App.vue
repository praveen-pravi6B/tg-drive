<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useOnline } from '@vueuse/core'
import { Cloud, HardDrive, KeyRound, Lock, LogOut, Terminal, User, WifiOff } from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { useDriveStore } from '@/stores/drive'
import { useVaultStore } from '@/stores/vault'
import AppButton from '@/components/ui/AppButton.vue'

const auth = useAuthStore()
const drive = useDriveStore()
const vault = useVaultStore()
const route = useRoute()
const router = useRouter()
const online = useOnline()
const profileOpen = ref(false)

const initials = computed(() => {
  const name = auth.displayName || auth.me?.username || ''
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
})

const showShellNav = computed(() => auth.isAuthorized)

function lockVault() {
  vault.lock()
}

async function signOut() {
  profileOpen.value = false
  drive.reset()
  vault.reset()
  await auth.logout()
  router.replace({ name: 'login' })
}

function closeProfile() {
  profileOpen.value = false
}

onMounted(() => {
  if (auth.status === 'idle') auth.init()
  window.addEventListener('click', closeProfile)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeProfile)
})
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <div
      v-if="!online"
      class="flex items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-xs text-amber-200"
    >
      <WifiOff class="h-3.5 w-3.5" />
      You are offline. Telegram operations will resume when the connection returns.
    </div>

    <header class="sticky top-0 z-30 border-b border-white/5 bg-background/70 backdrop-blur-xl">
      <div class="mx-auto flex h-14 w-full max-w-7xl items-center gap-4 px-5">
        <RouterLink to="/" class="flex items-center gap-2.5">
          <span
            class="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-glow"
          >
            <Cloud class="h-4 w-4" />
          </span>
          <span class="text-sm font-semibold tracking-tight">TGDrive</span>
        </RouterLink>

        <nav v-if="showShellNav" class="ml-4 flex items-center gap-1">
          <RouterLink
            to="/drive"
            class="focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            :class="route.name === 'drive' && 'bg-white/5 text-foreground'"
          >
            <HardDrive class="h-3.5 w-3.5" />
            Drive
          </RouterLink>
          <RouterLink
            to="/debug"
            class="focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            :class="route.name === 'debug' && 'bg-white/5 text-foreground'"
          >
            <Terminal class="h-3.5 w-3.5" />
            Spike lab
          </RouterLink>
        </nav>

        <div class="ml-auto flex items-center gap-2">
          <div v-if="auth.isAuthorized" class="relative flex items-center gap-1.5">
            <AppButton
              v-if="vault.isUnlocked"
              variant="ghost"
              size="icon"
              title="Lock vault"
              @click.stop="lockVault"
            >
              <Lock class="h-4 w-4" />
            </AppButton>

            <button
              type="button"
              class="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-white/5 focus-ring"
              @click.stop="profileOpen = !profileOpen"
            >
              <span
                class="grid h-7 w-7 overflow-hidden place-items-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground"
              >
                <img v-if="auth.photoUrl" :src="auth.photoUrl" alt="" class="h-full w-full object-cover" >
                <template v-else>{{ initials || 'TG' }}</template>
              </span>
              <div class="hidden leading-tight text-left sm:block">
                <div class="max-w-[140px] truncate text-xs font-medium">
                  {{ auth.displayName }}
                </div>
              </div>
            </button>

            <div
              v-if="profileOpen"
              class="absolute right-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-xl border border-white/10 bg-background/95 p-3 shadow-xl backdrop-blur"
              @click.stop
            >
              <div class="flex items-center gap-3">
                <span
                  class="grid h-10 w-10 overflow-hidden place-items-center rounded-full bg-accent text-sm font-semibold text-accent-foreground"
                >
                  <img v-if="auth.photoUrl" :src="auth.photoUrl" alt="" class="h-full w-full object-cover" >
                  <template v-else>{{ initials || 'TG' }}</template>
                </span>
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium">{{ auth.displayName || 'Telegram user' }}</div>
                  <div class="truncate text-xs text-muted-foreground">
                    {{ auth.me?.username ? `@${auth.me.username}` : auth.me?.id || '—' }}
                  </div>
                </div>
              </div>
              <div class="mt-3 space-y-1 border-t border-white/5 pt-3 text-xs">
                <div class="flex items-center justify-between text-muted-foreground">
                  <span>Vault</span>
                  <span :class="vault.isUnlocked ? 'text-emerald-300' : 'text-amber-300'">
                    {{ vault.isUnlocked ? 'Unlocked' : vault.status === 'no-vault' ? 'Not set up' : 'Locked' }}
                  </span>
                </div>
              </div>
              <div class="mt-3 flex flex-col gap-1 border-t border-white/5 pt-2">
                <RouterLink
                  to="/vault"
                  class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-white/5"
                  @click="profileOpen = false"
                >
                  <KeyRound class="h-3.5 w-3.5" />
                  Manage vault
                </RouterLink>
                <button
                  type="button"
                  class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-red-300 hover:bg-red-500/10"
                  @click="signOut"
                >
                  <LogOut class="h-3.5 w-3.5" />
                  Sign out
                </button>
              </div>
            </div>
          </div>
          <RouterLink v-else-if="route.name !== 'login'" to="/login">
            <AppButton size="sm">Sign in</AppButton>
          </RouterLink>
        </div>
      </div>
    </header>

    <main class="flex-1">
      <RouterView />
    </main>

    <footer class="border-t border-white/5 px-5 py-4">
      <div
        class="mx-auto flex w-full max-w-7xl flex-col gap-1 text-[11px] text-muted-foreground/70 sm:flex-row sm:items-center sm:justify-between"
      >
        <span>TGDrive · encrypted chunks in your own private Telegram supergroup</span>
        <span>No backend · no analytics · keys never leave this device</span>
      </div>
    </footer>
  </div>
</template>
