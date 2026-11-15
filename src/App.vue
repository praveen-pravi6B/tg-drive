<script setup>
import { computed, onMounted } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useOnline } from '@vueuse/core'
import { Cloud, HardDrive, KeyRound, LogOut, Terminal, WifiOff } from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { useVaultStore } from '@/stores/vault'
import AppButton from '@/components/ui/AppButton.vue'

const auth = useAuthStore()
const vault = useVaultStore()
const route = useRoute()
const router = useRouter()
const online = useOnline()

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

async function signOut() {
  vault.reset()
  await auth.logout()
  router.replace({ name: 'login' })
}

onMounted(() => {
  if (auth.status === 'idle') auth.init()
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
        <RouterLink
          to="/"
          class="flex items-center gap-2.5"
        >
          <span
            class="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-glow"
          >
            <Cloud class="h-4 w-4" />
          </span>
          <span class="text-sm font-semibold tracking-tight">TGDrive</span>
          <span
            class="hidden rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline"
          >
            M1
          </span>
        </RouterLink>

        <nav
          v-if="showShellNav"
          class="ml-4 flex items-center gap-1"
        >
          <RouterLink
            to="/drive"
            class="focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            :class="route.name === 'drive' && 'bg-white/5 text-foreground'"
          >
            <HardDrive class="h-3.5 w-3.5" />
            Drive
          </RouterLink>
          <RouterLink
            to="/vault"
            class="focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            :class="route.name === 'vault' && 'bg-white/5 text-foreground'"
          >
            <KeyRound class="h-3.5 w-3.5" />
            Vault
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
          <div
            v-if="auth.isAuthorized"
            class="hidden items-center gap-2 sm:flex"
          >
            <span
              class="grid h-7 w-7 place-items-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground"
            >
              {{ initials || 'TG' }}
            </span>
            <div class="leading-tight">
              <div class="max-w-[140px] truncate text-xs font-medium">
                {{ auth.displayName }}
              </div>
              <div class="max-w-[140px] truncate text-[10px] text-muted-foreground">
                {{ auth.me?.username ? `@${auth.me.username}` : auth.me?.id }}
              </div>
            </div>
            <AppButton
              variant="ghost"
              size="icon"
              title="Sign out"
              @click="signOut"
            >
              <LogOut class="h-4 w-4" />
            </AppButton>
          </div>
          <RouterLink
            v-else-if="route.name !== 'login'"
            to="/login"
          >
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
