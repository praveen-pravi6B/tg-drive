<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertTriangle,
  ArrowRight,
  KeyRound,
  Lock,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { appInfo } from '@/lib/config'
import AppButton from '@/components/ui/AppButton.vue'
import AppCard from '@/components/ui/AppCard.vue'
import AppInput from '@/components/ui/AppInput.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const apiId = ref('')
const apiHash = ref('')
const credentialsError = ref('')
const phoneMode = ref(false)
const phoneNumber = ref('')
const phoneError = ref('')
const code = ref('')
const password = ref('')
const started = ref(false)
const now = ref(Date.now())
let clock = null

const credsReady = computed(() => auth.credentialsSource !== 'none')
const secondsLeft = computed(() => Math.max(0, Math.ceil((auth.qrExpires || 0) - now.value / 1000)))

function nextTarget() {
  const next = typeof route.query.next === 'string' ? route.query.next : '/drive'
  return next.startsWith('/') ? next : '/drive'
}

function goNext() {
  router.replace(nextTarget())
}

async function beginQr() {
  if (!credsReady.value || started.value) return
  started.value = true
  await auth.startQrLogin()
}

async function saveCredentials() {
  credentialsError.value = ''
  const id = Number(apiId.value)
  if (!Number.isInteger(id) || id <= 0) {
    credentialsError.value = 'api_id must be a positive number'
    return
  }
  if (apiHash.value.trim().length < 16) {
    credentialsError.value = 'api_hash looks too short'
    return
  }
  await auth.saveCredentials(id, apiHash.value.trim())
  started.value = false
  await beginQr()
}

async function submitPhone() {
  phoneError.value = ''
  const value = phoneNumber.value.replace(/[^\d+]/g, '')
  if (value.replace(/\D/g, '').length < 7) {
    phoneError.value = 'Enter your number in international format, e.g. +15551234567'
    return
  }
  await auth.loginWithPhone(value)
}

function submitCode() {
  if (auth.submitCode(code.value)) code.value = ''
}

function submitPassword() {
  if (auth.submitPassword(password.value)) password.value = ''
}

async function switchToPhone() {
  phoneMode.value = true
  auth.error = ''
  if (['qr', 'qr-loading', 'signing-in'].includes(auth.step)) {
    await auth.cancelLogin()
    await auth.init()
  }
}

async function switchToQr() {
  phoneMode.value = false
  auth.error = ''
  await auth.cancelLogin()
  await auth.init()
  started.value = false
  await beginQr()
}

async function refreshQr() {
  await auth.cancelLogin()
  await auth.init()
  started.value = false
  await beginQr()
}

function cancel() {
  auth.cancelLogin()
  started.value = false
}

watch(
  () => auth.isAuthorized,
  (authorized) => {
    if (authorized) goNext()
  },
)

watch(
  () => auth.step,
  (step) => {
    if (step === 'code' || step === 'password') phoneMode.value = phoneMode.value || step === 'code'
  },
)

onMounted(async () => {
  clock = setInterval(() => (now.value = Date.now()), 1000)
  if (auth.status === 'idle') await auth.init()
  if (auth.isAuthorized) {
    goNext()
    return
  }
  await beginQr()
})

onUnmounted(() => clearInterval(clock))
</script>

<template>
  <div class="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:py-16">
    <section class="space-y-8">
      <div class="space-y-4">
        <div class="inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-[11px] font-medium text-sky-300">
          <ShieldCheck class="h-3.5 w-3.5" />
          Zero-knowledge · serverless
        </div>
        <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">
          Your files, inside your own Telegram.
        </h1>
        <p class="max-w-xl text-sm leading-relaxed text-muted-foreground">
          TGDrive turns one private forum supergroup into an encrypted drive. Files are chunked and
          encrypted on this device, then stored as documents in topics that mirror your folders.
          There is no server, no account, and no copy of your keys anywhere else.
        </p>
      </div>

      <ul class="space-y-3 text-sm">
        <li class="flex gap-3">
          <span class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/5">
            <Lock class="h-3.5 w-3.5 text-sky-300" />
          </span>
          <div>
            <div class="font-medium">
              AES-256-GCM, per file
            </div>
            <p class="text-xs text-muted-foreground">
              Every file gets its own key derived from a master key that never leaves the browser.
            </p>
          </div>
        </li>
        <li class="flex gap-3">
          <span class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/5">
            <Smartphone class="h-3.5 w-3.5 text-sky-300" />
          </span>
          <div>
            <div class="font-medium">
              Sign in by scanning a code
            </div>
            <p class="text-xs text-muted-foreground">
              Standard Telegram MTProto login. Your session stays in this browser.
            </p>
          </div>
        </li>
        <li class="flex gap-3">
          <span class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/5">
            <KeyRound class="h-3.5 w-3.5 text-sky-300" />
          </span>
          <div>
            <div class="font-medium">
              Recoverable on another device
            </div>
            <p class="text-xs text-muted-foreground">
              A passphrase unlocks an encrypted vault stored in the drive group itself.
            </p>
          </div>
        </li>
      </ul>

      <div class="flex items-start gap-2.5 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3.5 text-xs text-amber-200/90">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          This is an unofficial Telegram client and uses your account's storage. Keep volumes
          reasonable, and never treat it as your only copy of anything important.
        </p>
      </div>
    </section>

    <section class="w-full">
      <AppCard
        v-if="!credsReady"
        title="Connect your Telegram app"
        description="One-time setup for this deployment"
      >
        <form
          class="space-y-4"
          @submit.prevent="saveCredentials"
        >
          <p class="text-xs leading-relaxed text-muted-foreground">
            Create an app at
            <a
              class="text-sky-300 underline decoration-sky-300/30 underline-offset-2"
              href="https://my.telegram.org"
              target="_blank"
              rel="noreferrer noopener"
            >my.telegram.org</a>
            (API development tools) and copy the two values from <em>App configuration</em>.
          </p>
          <AppInput
            v-model="apiId"
            label="api_id"
            inputmode="numeric"
            placeholder="12345678"
            mono
          />
          <AppInput
            v-model="apiHash"
            label="api_hash"
            placeholder="0123456789abcdef0123456789abcdef"
            mono
          />
          <p
            v-if="credentialsError"
            class="text-xs text-destructive"
          >
            {{ credentialsError }}
          </p>
          <AppButton
            type="submit"
            class="w-full"
            :loading="auth.status === 'connecting'"
          >
            Save and continue
            <ArrowRight class="h-4 w-4" />
          </AppButton>
          <p class="text-[11px] leading-relaxed text-muted-foreground/70">
            Credentials are stored in this browser only. They are visible in the client bundle by
            design — use a dedicated Telegram app for TGDrive.
          </p>
        </form>
      </AppCard>

      <AppCard v-else>
        <template #header>
          <div class="flex items-center gap-3">
            <span class="grid h-9 w-9 place-items-center rounded-lg bg-sky-400/10 text-sky-300">
              <QrCode
                v-if="!phoneMode"
                class="h-4 w-4"
              />
              <Smartphone
                v-else
                class="h-4 w-4"
              />
            </span>
            <div>
              <h2 class="text-sm font-semibold">
                {{ phoneMode ? 'Sign in with your phone' : 'Scan with Telegram' }}
              </h2>
              <p class="text-xs text-muted-foreground">
                {{
                  phoneMode
                    ? 'Telegram will send a login code to your account.'
                    : 'Settings → Devices → Link Desktop Device'
                }}
              </p>
            </div>
          </div>
        </template>

        <div class="space-y-4">
          <div
            v-if="auth.error"
            class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-red-300"
          >
            <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{{ auth.error }}</span>
          </div>

          <!-- QR flow -->
          <template v-if="!phoneMode">
            <div
              v-if="auth.step === 'password'"
              class="space-y-3"
            >
              <p class="text-xs text-muted-foreground">
                Two-step verification is enabled on this account.
                <span v-if="auth.passwordHint">Hint: “{{ auth.passwordHint }}”</span>
              </p>
              <form
                class="space-y-3"
                @submit.prevent="submitPassword"
              >
                <AppInput
                  v-model="password"
                  type="password"
                  label="Password"
                  autocomplete="current-password"
                />
                <AppButton
                  type="submit"
                  class="w-full"
                  :loading="auth.step === 'signing-in'"
                >
                  Unlock and sign in
                </AppButton>
              </form>
            </div>

            <div
              v-else-if="auth.step === 'qr' && auth.qrUrl"
              class="space-y-3"
            >
              <div class="mx-auto w-fit rounded-2xl bg-white p-3 shadow-glow">
                <img
                  :src="auth.qrUrl"
                  alt="Telegram login QR code"
                  class="h-56 w-56"
                >
              </div>
              <div class="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                <span v-if="secondsLeft > 0">Refreshes in {{ secondsLeft }}s</span>
                <span
                  v-else
                  class="flex items-center gap-1 text-sky-300"
                >
                  <RefreshCw class="h-3 w-3 animate-spin" />
                  Getting a fresh code…
                </span>
              </div>
              <p class="text-center text-[11px] text-muted-foreground/70">
                Open Telegram on your phone, go to Settings → Devices → Link Desktop Device, and
                point the camera at this code.
              </p>
            </div>

            <div
              v-else-if="auth.step === 'signing-in'"
              class="flex flex-col items-center gap-3 py-8"
            >
              <RefreshCw class="h-6 w-6 animate-spin text-sky-300" />
              <p class="text-xs text-muted-foreground">
                Signing in…
              </p>
            </div>

            <div
              v-else
              class="flex flex-col items-center gap-3 py-8"
            >
              <RefreshCw class="h-6 w-6 animate-spin text-sky-300" />
              <p class="text-xs text-muted-foreground">
                Requesting a login code from Telegram…
              </p>
            </div>

            <div class="flex items-center justify-between border-t border-white/5 pt-3">
              <AppButton
                variant="ghost"
                size="sm"
                @click="switchToPhone"
              >
                <Smartphone class="h-3.5 w-3.5" />
                Use phone number
              </AppButton>
              <AppButton
                variant="ghost"
                size="sm"
                @click="refreshQr"
              >
                <RefreshCw class="h-3.5 w-3.5" />
                New QR
              </AppButton>
            </div>
          </template>

          <!-- Phone flow -->
          <template v-else>
            <form
              v-if="!['code', 'password', 'signing-in'].includes(auth.step)"
              class="space-y-3"
              @submit.prevent="submitPhone"
            >
              <AppInput
                v-model="phoneNumber"
                label="Phone number"
                placeholder="+15551234567"
                inputmode="tel"
                autocomplete="tel"
                :error="phoneError"
              />
              <AppButton
                type="submit"
                class="w-full"
                :loading="auth.step === 'phone-connecting'"
              >
                Send code
              </AppButton>
            </form>

            <form
              v-else-if="auth.step === 'code'"
              class="space-y-3"
              @submit.prevent="submitCode"
            >
              <p class="text-xs text-muted-foreground">
                Enter the code Telegram sent you
                {{ auth.codeViaApp ? 'in the Telegram app' : 'by SMS' }}.
              </p>
              <AppInput
                v-model="code"
                label="Login code"
                inputmode="numeric"
                autocomplete="one-time-code"
                mono
              />
              <AppButton
                type="submit"
                class="w-full"
                :loading="auth.step === 'signing-in'"
              >
                Continue
              </AppButton>
            </form>

            <form
              v-else-if="auth.step === 'password'"
              class="space-y-3"
              @submit.prevent="submitPassword"
            >
              <p class="text-xs text-muted-foreground">
                Two-step verification is enabled.
                <span v-if="auth.passwordHint">Hint: “{{ auth.passwordHint }}”</span>
              </p>
              <AppInput
                v-model="password"
                type="password"
                label="Password"
                autocomplete="current-password"
              />
              <AppButton
                type="submit"
                class="w-full"
                :loading="auth.step === 'signing-in'"
              >
                Unlock and sign in
              </AppButton>
            </form>

            <div
              v-else
              class="flex flex-col items-center gap-3 py-8"
            >
              <RefreshCw class="h-6 w-6 animate-spin text-sky-300" />
              <p class="text-xs text-muted-foreground">
                Signing in…
              </p>
            </div>

            <div class="flex items-center justify-between border-t border-white/5 pt-3">
              <AppButton
                variant="ghost"
                size="sm"
                @click="switchToQr"
              >
                <QrCode class="h-3.5 w-3.5" />
                Use QR code
              </AppButton>
              <AppButton
                v-if="['code', 'password'].includes(auth.step)"
                variant="ghost"
                size="sm"
                @click="cancel"
              >
                Cancel
              </AppButton>
            </div>
          </template>
        </div>
      </AppCard>

      <p class="mt-4 text-center text-[11px] text-muted-foreground/60">
        {{ appInfo.name }} v{{ appInfo.version }} · session stored in this browser · sign out from
        the header at any time
      </p>
    </section>
  </div>
</template>
