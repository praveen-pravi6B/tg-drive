<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  AlertTriangle,
  CircleCheck,
  CircleX,
  Copy,
  FolderClosed,
  HardDrive,
  Play,
  RefreshCw,
  ScanLine,
  Terminal,
  Trash2,
  Upload,
} from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { limits, storageKeys } from '@/lib/config'
import { clearLogs, errorMessage, getLogs, log, subscribeLogs } from '@/lib/logger'
import { formatBytes, formatDuration, shortId } from '@/lib/utils'
import {
  archiveChannel,
  createDriveGroup,
  createTopic,
  deleteMessages,
  disableForwards,
  findDriveGroup,
  getChannelFull,
  listTopics,
  messageLabel,
  readTopic,
  sendDocumentToTopic,
} from '@/lib/telegram/topics'
import { runRoundTrip } from '@/lib/telegram/roundtrip'
import AppBadge from '@/components/ui/AppBadge.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppCard from '@/components/ui/AppCard.vue'
import AppInput from '@/components/ui/AppInput.vue'

function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

const auth = useAuthStore()
const getClient = () => auth.getClient()

const driveId = ref(
  (typeof localStorage !== 'undefined' && localStorage.getItem(storageKeys.debugDriveId)) ||
    crypto.randomUUID(),
)
const group = ref(loadJson(storageKeys.debugGroup))
const topic = ref(loadJson(storageKeys.debugTopic))
const topics = ref([])
const busy = ref('')
const newTopicTitle = ref('🧪 M0 test')
const probeMessageIds = ref([])
const probeLines = ref([])
const chunkMb = ref(20)
const cleanup = ref(true)
const selectedFile = ref(null)
const fileInput = ref(null)
const abortController = ref(null)
const logBox = ref(null)
const logs = ref(getLogs())
let unsubscribeLogs = null

const rt = reactive({
  status: 'idle',
  fileId: '',
  total: 0,
  chunkCount: 0,
  uploaded: 0,
  verified: 0,
  progress: 0,
  sourceHash: '',
  downloadedHash: '',
  match: null,
  elapsedMs: 0,
  error: '',
  rows: [],
})

const chunkBytes = computed(() => {
  const value = Number(chunkMb.value) * 1024 * 1024
  if (!Number.isFinite(value)) return limits.chunkSize
  return Math.min(Math.max(value, 512 * 1024), limits.maxChunkSize)
})

const chunkWarning = computed(() => {
  const value = Number(chunkMb.value)
  if (value < 1) return 'Chunk size must be at least 1 MB'
  if (value > limits.maxChunkSize / (1024 * 1024)) return 'Chunk size is capped at 45 MB'
  return ''
})

const canRun = computed(
  () =>
    Boolean(selectedFile.value) &&
    Boolean(group.value) &&
    Boolean(topic.value) &&
    !busy.value &&
    !chunkWarning.value,
)

const accountLine = computed(() =>
  auth.me?.username ? `@${auth.me.username}` : auth.me?.id || 'not connected',
)

const groupLine = computed(() => {
  if (!group.value) return 'not provisioned'
  return `${group.value.title || 'drive group'} · id ${shortId(group.value.id, 10)}`
})

const topicLine = computed(() => {
  if (!topic.value) return 'no topic selected'
  return `${topic.value.title || 'topic'} · id ${shortId(topic.value.id, 8)}`
})

function persistGroup(value) {
  group.value = value || null
  if (value) localStorage.setItem(storageKeys.debugGroup, JSON.stringify(value))
  else localStorage.removeItem(storageKeys.debugGroup)
}

function persistTopic(value) {
  topic.value = value || null
  if (value) localStorage.setItem(storageKeys.debugTopic, JSON.stringify(value))
  else localStorage.removeItem(storageKeys.debugTopic)
}

function selectTopic(value) {
  persistTopic({ id: value.id, title: value.title })
}

async function ensureGroup() {
  const instance = getClient()
  if (!instance) throw new Error('Telegram client is not connected')

  if (!localStorage.getItem(storageKeys.debugDriveId)) {
    localStorage.setItem(storageKeys.debugDriveId, driveId.value)
  }

  if (group.value?.id) {
    try {
      const full = await getChannelFull(instance, group.value)
      if ((full.about || '').startsWith('tgdrive:')) {
        log('info', 'spike', 'Reusing the stored drive group', {
          id: full.id,
          about: full.about,
          archivedByApp: true,
        })
        persistGroup({ id: full.id, accessHash: full.accessHash, title: full.title, driveId: driveId.value })
        return group.value
      }
      log('warn', 'spike', 'Stored group is missing the TGDrive marker; searching own chats')
    } catch (error) {
      log('warn', 'spike', 'Stored group is not accessible; searching own chats', error)
    }
  }

  const found = await findDriveGroup(instance, driveId.value)
  if (found) {
    persistGroup({ id: found.id, accessHash: found.accessHash, title: found.title, driveId: driveId.value })
    log('info', 'spike', 'Adopted an existing TGDrive group (idempotent create)', {
      id: found.id,
      about: found.about,
    })
    return group.value
  }

  log('info', 'spike', 'No drive group found. Creating a private forum supergroup…')
  const created = await createDriveGroup(instance, {
    title: `TGDrive · ${auth.displayName || 'Spike'}`,
    driveId: driveId.value,
  })
  persistGroup({ ...created.channel, driveId: driveId.value })
  log(
    'info',
    'spike',
    `Group created${created.archived ? ' · archived' : ''}${created.forwardsDisabled ? ' · forwarding disabled' : ''}`,
    group.value,
  )
  return group.value
}

async function refreshTopics() {
  const instance = getClient()
  if (!instance) return
  busy.value = 'topics'
  try {
    await ensureGroup()
    const list = await listTopics(instance, group.value)
    topics.value = list
    if (!topic.value && list.length) selectTopic(list[0])
    log('info', 'spike', `Loaded ${list.length} forum topic(s)`, {
      topics: list.map((item) => ({ id: item.id, title: item.title })),
    })
  } catch (error) {
    if (auth.handleAuthError(error)) return
    log('error', 'spike', 'Could not load topics', error)
  } finally {
    busy.value = ''
  }
}

async function ensureTopic() {
  const instance = getClient()
  if (!instance) throw new Error('Telegram client is not connected')
  await ensureGroup()
  const list = await listTopics(instance, group.value)
  topics.value = list

  if (topic.value?.id && list.some((item) => String(item.id) === String(topic.value.id))) {
    return topic.value
  }

  const existing = list.find((item) => item.title === newTopicTitle.value)
  if (existing) {
    selectTopic(existing)
    log('info', 'spike', 'Reusing an existing topic with the same title', {
      id: existing.id,
      title: existing.title,
    })
    return topic.value
  }

  const created = await createTopic(instance, group.value, newTopicTitle.value)
  selectTopic(created)
  log('info', 'spike', `Topic created: ${created.title}`, { id: created.id })
  topics.value = await listTopics(instance, group.value)
  return topic.value
}

async function setupGroup() {
  busy.value = 'group'
  try {
    await ensureGroup()
  } catch (error) {
    if (!auth.handleAuthError(error)) log('error', 'spike', 'Group setup failed', error)
  } finally {
    busy.value = ''
  }
}

async function setupTopic() {
  busy.value = 'topic'
  try {
    await ensureTopic()
  } catch (error) {
    if (!auth.handleAuthError(error)) log('error', 'spike', 'Topic setup failed', error)
  } finally {
    busy.value = ''
  }
}

async function verifyGroup() {  busy.value = 'verify'
  try {
    const instance = getClient()
    await ensureGroup()
    const full = await getChannelFull(instance, group.value)
    log('info', 'spike', 'Group verified', {
      id: full.id,
      title: full.title,
      about: full.about,
      pinnedMsgId: full.pinnedMsgId,
      participants: full.participants,
    })
  } catch (error) {
    if (auth.handleAuthError(error)) return
    log('error', 'spike', 'Group verification failed', error)
  } finally {
    busy.value = ''
  }
}

async function reArchive() {
  busy.value = 'archive'
  try {
    await archiveChannel(getClient(), group.value)
    log('info', 'spike', 'Group moved to the Telegram Archive folder')
  } catch (error) {
    if (auth.handleAuthError(error)) return
    log('error', 'spike', 'Archive failed', error)
  } finally {
    busy.value = ''
  }
}

async function reDisableForwards() {
  busy.value = 'forwards'
  try {
    await disableForwards(getClient(), group.value)
    log('info', 'spike', 'Content forwarding/saving disabled for this group')
  } catch (error) {
    if (auth.handleAuthError(error)) return
    log('error', 'spike', 'Could not disable forwarding', error)
  } finally {
    busy.value = ''
  }
}

async function sendProbe() {
  busy.value = 'probe'
  try {
    const instance = getClient()
    await ensureTopic()
    const body = new TextEncoder().encode(
      JSON.stringify({
        kind: 'tgdrive-m0-probe',
        driveId: driveId.value,
        at: new Date().toISOString(),
        userAgent: navigator.userAgent,
      }),
    )
    const message = await sendDocumentToTopic({
      client: instance,
      channel: group.value,
      topicId: topic.value.id,
      name: 'probe.txt',
      data: body,
      caption: 'M0 probe document',
    })
    probeMessageIds.value = [message.id, ...probeMessageIds.value].slice(0, 20)
    log('info', 'spike', 'Probe document sent to topic', {
      messageId: message.id,
      topicId: topic.value.id,
      bytes: body.length,
    })
  } catch (error) {
    if (auth.handleAuthError(error)) return
    log('error', 'spike', 'Could not send probe', error)
  } finally {
    busy.value = ''
  }
}

async function readProbe() {
  busy.value = 'read'
  try {
    const messages = await readTopic(getClient(), group.value, topic.value.id, { limit: 15 })
    probeLines.value = messages.map((message) => ({
      id: message.id,
      label: messageLabel(message),
      date: message.date ? new Date(message.date * 1000).toLocaleTimeString() : '',
    }))
    log('info', 'spike', `Read ${messages.length} message(s) from the topic`)
  } catch (error) {
    if (auth.handleAuthError(error)) return
    log('error', 'spike', 'Could not read the topic', error)
  } finally {
    busy.value = ''
  }
}

async function deleteProbes() {
  if (!probeMessageIds.value.length) return
  busy.value = 'delete'
  try {
    await deleteMessages(getClient(), group.value, probeMessageIds.value)
    log('info', 'spike', `Deleted ${probeMessageIds.value.length} probe message(s)`)
    probeMessageIds.value = []
  } catch (error) {
    if (auth.handleAuthError(error)) return
    log('error', 'spike', 'Could not delete probes', error)
  } finally {
    busy.value = ''
  }
}

function onFileChange(event) {
  rt.error = ''
  const file = event.target.files?.[0] || null
  if (!file) {
    selectedFile.value = null
    return
  }
  if (file.size > limits.maxFileSize) {
    rt.status = 'error'
    rt.error = `File is ${formatBytes(file.size)}; the limit is ${formatBytes(limits.maxFileSize)}.`
    selectedFile.value = null
    event.target.value = ''
    return
  }
  selectedFile.value = file
  log('info', 'spike', `Selected ${file.name} (${formatBytes(file.size)})`)
}

function resetRoundTrip() {
  rt.status = 'idle'
  rt.fileId = ''
  rt.total = 0
  rt.chunkCount = 0
  rt.uploaded = 0
  rt.verified = 0
  rt.progress = 0
  rt.sourceHash = ''
  rt.downloadedHash = ''
  rt.match = null
  rt.elapsedMs = 0
  rt.error = ''
  rt.rows = []
  probeLines.value = []
}

function handleEvent(event) {
  switch (event.type) {
    case 'start':
      rt.status = 'uploading'
      rt.fileId = event.fileId
      rt.total = event.total
      rt.chunkCount = event.chunkCount
      log(
        'info',
        'roundtrip',
        `Starting ${formatBytes(event.total)} in ${event.chunkCount} chunk(s) of ${formatBytes(event.chunkSize)}`,
        { fileId: event.fileId },
      )
      break
    case 'chunk-encrypted':
      rt.rows[event.index] = {
        ...(rt.rows[event.index] || {}),
        index: event.index,
        uploadSha: event.sha256,
        encryptedSize: event.encryptedSize,
      }
      break
    case 'chunk-uploaded':
      rt.uploaded += 1
      rt.rows[event.index] = {
        ...(rt.rows[event.index] || {}),
        index: event.index,
        messageId: event.messageId,
        uploadSha: event.sha256,
      }
      rt.progress = (rt.uploaded / Math.max(1, rt.chunkCount)) * 50
      log('info', 'roundtrip', `Chunk ${event.index + 1}/${rt.chunkCount} uploaded`, {
        messageId: event.messageId,
        sha256: event.sha256.slice(0, 16),
      })
      break
    case 'uploaded':
      rt.sourceHash = event.sourceHash
      rt.status = 'downloading'
      log('info', 'roundtrip', `Upload complete · source sha256 ${event.sourceHash}`)
      break
    case 'chunk-verified':
      rt.verified += 1
      rt.rows[event.index] = {
        ...(rt.rows[event.index] || {}),
        index: event.index,
        downloadSha: event.sha256,
        verified: event.ok,
      }
      rt.progress = 50 + (rt.verified / Math.max(1, rt.chunkCount)) * 50
      log(event.ok ? 'info' : 'error', 'roundtrip', `Chunk ${event.index + 1}/${rt.chunkCount} verified`, {
        ok: event.ok,
      })
      break
    case 'done':
      rt.status = 'done'
      rt.progress = 100
      rt.sourceHash = event.result.sourceHash
      rt.downloadedHash = event.result.downloadedHash
      rt.match = event.result.match
      rt.elapsedMs = event.result.elapsedMs
      log(event.result.match ? 'info' : 'error', 'roundtrip', 'Round-trip finished', {
        match: event.result.match,
        elapsed: formatDuration(event.result.elapsedMs),
      })
      break
    case 'cleaned':
      log('info', 'roundtrip', `Cleaned up ${event.count} chunk message(s)`)
      break
    default:
      break
  }
}

async function startRoundTrip() {
  if (!selectedFile.value) return
  resetRoundTrip()
  busy.value = 'roundtrip'
  const controller = new AbortController()
  abortController.value = controller

  try {
    await ensureGroup()
    await ensureTopic()
    log('info', 'roundtrip', 'Uploading encrypted chunks to the selected topic', {
      topicId: topic.value.id,
      chunkSize: formatBytes(chunkBytes.value),
    })
    const result = await runRoundTrip({
      client: getClient(),
      channel: group.value,
      topicId: topic.value.id,
      file: selectedFile.value,
      chunkSize: chunkBytes.value,
      cleanup: cleanup.value,
      signal: controller.signal,
      onEvent: handleEvent,
    })
    rt.rows = result.checks.map((check) => {
      const upload = rt.rows[check.index] || {}
      return { ...upload, ...check, index: check.index }
    })
  } catch (error) {
    if (auth.handleAuthError(error)) return
    if (error?.name === 'AbortError') {
      rt.status = 'aborted'
      log('warn', 'roundtrip', 'Round-trip aborted by user')
    } else {
      rt.status = 'error'
      rt.error = errorMessage(error)
      log('error', 'roundtrip', 'Round-trip failed', error)
    }
  } finally {
    busy.value = ''
    abortController.value = null
  }
}

function abortRoundTrip() {
  abortController.value?.abort()
}

function clearFile() {
  selectedFile.value = null
  if (fileInput.value) fileInput.value.value = ''
  resetRoundTrip()
}

function copyGroupId() {
  if (group.value?.id) navigator.clipboard?.writeText(String(group.value.id))
}

function levelClass(level) {
  if (level === 'error') return 'text-red-300'
  if (level === 'warn') return 'text-amber-300'
  if (level === 'info') return 'text-sky-300'
  return 'text-muted-foreground'
}

watch(group, (value) => {
  if (!value) localStorage.removeItem(storageKeys.debugGroup)
})

onMounted(() => {
  localStorage.setItem(storageKeys.debugDriveId, driveId.value)
  unsubscribeLogs = subscribeLogs((entry) => {
    logs.value = entry === null ? [] : getLogs()
    nextTick(() => {
      if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
    })
  })
})

onUnmounted(() => {
  unsubscribeLogs?.()
})
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-5 px-5 py-6">
    <div class="flex flex-wrap items-end gap-3">
      <div>
        <div class="flex items-center gap-2">
          <h1 class="text-lg font-semibold tracking-tight">
            M0 storage spike lab
          </h1>
          <AppBadge
            tone="warning"
            dot
          >
            Live against your account
          </AppBadge>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          Proves the Telegram primitives before the drive UI exists: forum group, topics, topic
          posting, and an encrypted 200 MB round-trip.
        </p>
      </div>
      <div class="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
        <span class="hidden sm:inline">{{ accountLine }}</span>
        <AppBadge
          :tone="auth.isAuthorized ? 'success' : 'danger'"
          dot
        >
          {{ auth.isAuthorized ? 'session active' : 'signed out' }}
        </AppBadge>
      </div>
    </div>

    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
          Drive id
        </div>
        <div class="mt-1 truncate text-xs font-medium">
          {{ shortId(driveId, 18) }}
        </div>
      </div>
      <div class="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
          Group
        </div>
        <div class="mt-1 truncate text-xs font-medium">
          {{ groupLine }}
        </div>
      </div>
      <div class="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
          Topic
        </div>
        <div class="mt-1 truncate text-xs font-medium">
          {{ topicLine }}
        </div>
      </div>
      <div class="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
          Limits
        </div>
        <div class="mt-1 truncate text-xs font-medium">
          {{ formatBytes(limits.maxFileSize) }} / 1 file
        </div>
      </div>
    </div>

    <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
      <div class="space-y-5">
        <AppCard
          title="1 · Drive group"
          description="Idempotent creation via the tgdrive: marker"
        >
          <template #actions>
            <AppButton
              size="sm"
              variant="secondary"
              :loading="busy === 'group' || busy === 'verify'"
              @click="verifyGroup"
            >
              <ScanLine class="h-3.5 w-3.5" />
              Verify
            </AppButton>
          </template>

          <div class="space-y-4">
            <dl class="grid gap-2 text-xs sm:grid-cols-2">
              <div class="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Title
                </dt>
                <dd class="mt-0.5 truncate font-medium">
                  {{ group?.title || '—' }}
                </dd>
              </div>
              <div class="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                <dt class="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Channel id
                </dt>
                <dd class="mt-0.5 flex items-center gap-2 truncate font-mono text-[11px]">
                  {{ group?.id || '—' }}
                  <button
                    v-if="group?.id"
                    type="button"
                    class="text-muted-foreground hover:text-foreground"
                    title="Copy id"
                    @click="copyGroupId"
                  >
                    <Copy class="h-3 w-3" />
                  </button>
                </dd>
              </div>
            </dl>

            <div class="flex flex-wrap gap-2">
              <AppButton
                :loading="busy === 'group'"
                :disabled="Boolean(busy) && busy !== 'group'"
                @click="setupGroup"
              >
                <HardDrive class="h-4 w-4" />
                Find or create group
              </AppButton>
              <AppButton
                variant="outline"
                size="md"
                :loading="busy === 'archive'"
                :disabled="!group"
                @click="reArchive"
              >
                <FolderClosed class="h-4 w-4" />
                Archive
              </AppButton>
              <AppButton
                variant="outline"
                size="md"
                :loading="busy === 'forwards'"
                :disabled="!group"
                @click="reDisableForwards"
              >
                <AlertTriangle class="h-4 w-4" />
                Disable forwarding
              </AppButton>
            </div>

            <p class="text-[11px] leading-relaxed text-muted-foreground/80">
              Creation is idempotent: the group's public description carries
              <code class="rounded bg-white/5 px-1 py-0.5 font-mono text-[10px]">tgdrive:&lt;driveId&gt;</code>
              and the app searches for it before creating anything. Telegram channels cannot be
              archived by the server, so “archived” means placed in your client's Archive folder;
              the app itself has no delete action.
            </p>
          </div>
        </AppCard>

        <AppCard
          title="2 · Topics"
          description="Each folder will map to one forum topic"
        >
          <template #actions>
            <AppButton
              size="sm"
              variant="ghost"
              :loading="busy === 'topics'"
              @click="refreshTopics"
            >
              <RefreshCw class="h-3.5 w-3.5" />
              Refresh
            </AppButton>
          </template>

          <div class="space-y-3">
            <div class="flex flex-wrap items-end gap-2">
              <div class="min-w-[200px] flex-1">
                <AppInput
                  v-model="newTopicTitle"
                  label="New topic title"
                  placeholder="🧪 M0 test"
                />
              </div>
              <AppButton
                variant="secondary"
                :loading="busy === 'topic'"
                :disabled="!newTopicTitle.trim()"
                @click="setupTopic"
              >
                <Play class="h-4 w-4" />
                Create / select
              </AppButton>
            </div>

            <div
              v-if="topics.length"
              class="max-h-44 space-y-1 overflow-auto pr-1"
            >
              <button
                v-for="item in topics"
                :key="item.id"
                type="button"
                class="flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors"
                :class="
                  String(topic?.id) === String(item.id)
                    ? 'border-sky-400/30 bg-sky-400/10 text-sky-100'
                    : 'border-white/5 bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05]'
                "
                @click="selectTopic(item)"
              >
                <FolderClosed class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ item.title }}</span>
                <span class="ml-auto font-mono text-[10px] opacity-60">{{ item.id }}</span>
              </button>
            </div>
            <p
              v-else
              class="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-muted-foreground"
            >
              No topics loaded. Create one to continue.
            </p>
          </div>
        </AppCard>

        <AppCard
          title="3 · Message probe"
          description="Send, read and delete a small document in the topic"
        >
          <div class="space-y-3">
            <div class="flex flex-wrap gap-2">
              <AppButton
                :loading="busy === 'probe'"
                @click="sendProbe"
              >
                <Upload class="h-4 w-4" />
                Send probe
              </AppButton>
              <AppButton
                variant="outline"
                :loading="busy === 'read'"
                :disabled="!topic"
                @click="readProbe"
              >
                <ScanLine class="h-4 w-4" />
                Read topic
              </AppButton>
              <AppButton
                variant="ghost"
                :loading="busy === 'delete'"
                :disabled="!probeMessageIds.length"
                @click="deleteProbes"
              >
                <Trash2 class="h-4 w-4" />
                Delete probes ({{ probeMessageIds.length }})
              </AppButton>
            </div>

            <div
              v-if="probeLines.length"
              class="max-h-40 space-y-1 overflow-auto rounded-lg border border-white/5 bg-black/20 p-2"
            >
              <div
                v-for="line in probeLines"
                :key="line.id"
                class="flex items-center gap-2 font-mono text-[11px] text-muted-foreground"
              >
                <span class="w-8 shrink-0 text-right opacity-50">{{ line.id }}</span>
                <span class="truncate">{{ line.label }}</span>
                <span class="ml-auto shrink-0 opacity-50">{{ line.date }}</span>
              </div>
            </div>
          </div>
        </AppCard>

        <AppCard
          title="4 · Encrypted chunk round-trip"
          description="200 MB max · 1 file at a time · plaintext never leaves the browser"
        >
          <div class="space-y-4">
            <div class="flex flex-wrap items-center gap-2">
              <input
                ref="fileInput"
                type="file"
                class="hidden"
                @change="onFileChange"
              >
              <AppButton
                variant="secondary"
                :disabled="Boolean(busy)"
                @click="fileInput?.click()"
              >
                <Upload class="h-4 w-4" />
                Choose file
              </AppButton>
              <div
                v-if="selectedFile"
                class="flex min-w-0 items-center gap-2 text-xs"
              >
                <span class="max-w-[260px] truncate font-medium">{{ selectedFile.name }}</span>
                <span class="text-muted-foreground">{{ formatBytes(selectedFile.size) }}</span>
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground"
                  title="Remove file"
                  @click="clearFile"
                >
                  <CircleX class="h-3.5 w-3.5" />
                </button>
              </div>
              <span
                v-else
                class="text-[11px] text-muted-foreground"
              >
                Pick any file up to {{ formatBytes(limits.maxFileSize) }}
              </span>
            </div>

            <div class="grid items-end gap-3 sm:grid-cols-[140px_1fr_auto]">
              <AppInput
                v-model.number="chunkMb"
                type="number"
                label="Chunk size (MB)"
                :min="1"
                :max="45"
                mono
                :error="chunkWarning"
              />
              <label class="flex h-10 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  v-model="cleanup"
                  type="checkbox"
                  class="accent-sky-400"
                >
                Delete chunk messages after verification
              </label>
              <AppButton
                :loading="rt.status === 'uploading' || rt.status === 'downloading'"
                :disabled="!canRun"
                @click="startRoundTrip"
              >
                <Play class="h-4 w-4" />
                Run round-trip
              </AppButton>
            </div>

            <div
              v-if="rt.status !== 'idle'"
              class="space-y-3 rounded-lg border border-white/5 bg-white/[0.02] p-3"
            >
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <AppBadge
                  :tone="
                    rt.status === 'done'
                      ? rt.match
                        ? 'success'
                        : 'danger'
                      : rt.status === 'error'
                        ? 'danger'
                        : rt.status === 'aborted'
                          ? 'warning'
                          : 'info'
                  "
                  dot
                >
                  {{ rt.status }}
                </AppBadge>
                <span class="text-muted-foreground">
                  {{ rt.uploaded }}/{{ rt.chunkCount }} uploaded · {{ rt.verified }}/{{ rt.chunkCount }} verified
                </span>
                <span class="ml-auto font-mono text-[11px]">{{ Math.round(rt.progress) }}%</span>
              </div>
              <div class="h-1.5 overflow-hidden rounded-full bg-white/5">
                <div
                  class="h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 transition-[width] duration-300"
                  :style="{ width: `${rt.progress}%` }"
                />
              </div>

              <dl class="grid gap-2 text-[11px] sm:grid-cols-2">
                <div class="rounded border border-white/5 bg-black/20 px-2 py-1.5">
                  <dt class="text-muted-foreground">
                    Source sha256
                  </dt>
                  <dd class="truncate font-mono">
                    {{ rt.sourceHash || '—' }}
                  </dd>
                </div>
                <div class="rounded border border-white/5 bg-black/20 px-2 py-1.5">
                  <dt class="text-muted-foreground">
                    Downloaded sha256
                  </dt>
                  <dd class="truncate font-mono">
                    {{ rt.downloadedHash || '—' }}
                  </dd>
                </div>
              </dl>

              <div
                v-if="rt.match !== null"
                class="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                :class="rt.match ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'"
              >
                <CircleCheck
                  v-if="rt.match"
                  class="h-4 w-4 shrink-0"
                />
                <CircleX
                  v-else
                  class="h-4 w-4 shrink-0"
                />
                <span>
                  {{ rt.match ? 'Hashes match — encrypted round-trip verified.' : 'Hash mismatch — do not trust this pipeline.' }}
                  <span v-if="rt.elapsedMs"> Took {{ formatDuration(rt.elapsedMs) }}.</span>
                </span>
              </div>

              <div
                v-if="rt.error"
                class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-red-300"
              >
                <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
                <span>{{ rt.error }}</span>
              </div>

              <div
                v-if="rt.rows.length"
                class="max-h-52 overflow-auto rounded-lg border border-white/5"
              >
                <table class="w-full text-left text-[11px]">
                  <thead class="sticky top-0 bg-card text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th class="px-2 py-1.5 font-medium">
                        #
                      </th>
                      <th class="px-2 py-1.5 font-medium">
                        msg id
                      </th>
                      <th class="px-2 py-1.5 font-medium">
                        encrypted
                      </th>
                      <th class="px-2 py-1.5 font-medium">
                        plain sha
                      </th>
                      <th class="px-2 py-1.5 font-medium">
                        check
                      </th>
                    </tr>
                  </thead>
                  <tbody class="font-mono">
                    <tr
                      v-for="row in rt.rows"
                      :key="row.index"
                      class="border-t border-white/5 text-muted-foreground"
                    >
                      <td class="px-2 py-1.5">
                        {{ row.index + 1 }}
                      </td>
                      <td class="px-2 py-1.5">
                        {{ row.messageId || '—' }}
                      </td>
                      <td class="px-2 py-1.5">
                        {{ row.encryptedSize ? formatBytes(row.encryptedSize) : '—' }}
                      </td>
                      <td class="px-2 py-1.5">
                        {{ (row.uploadSha || '—').slice(0, 12) }}
                      </td>
                      <td class="px-2 py-1.5">
                        <span
                          v-if="row.verified === true"
                          class="text-emerald-300"
                        >ok</span>
                        <span
                          v-else-if="row.verified === false"
                          class="text-red-300"
                        >mismatch</span>
                        <span v-else>—</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div
                v-if="abortController"
                class="flex justify-end"
              >
                <AppButton
                  variant="danger"
                  size="sm"
                  @click="abortRoundTrip"
                >
                  Abort
                </AppButton>
              </div>
            </div>
          </div>
        </AppCard>
      </div>

      <div class="space-y-3 xl:sticky xl:top-20 xl:h-fit">
        <AppCard
          title="Live log"
          description="Everything the spike does, including Telegram errors"
          :padded="false"
        >
          <template #actions>
            <AppButton
              variant="ghost"
              size="sm"
              @click="clearLogs"
            >
              <Trash2 class="h-3.5 w-3.5" />
              Clear
            </AppButton>
          </template>
          <div
            ref="logBox"
            class="mono max-h-[70vh] min-h-[320px] overflow-auto px-3 py-2"
          >
            <div
              v-if="!logs.length"
              class="px-1 py-6 text-center text-[11px] text-muted-foreground"
            >
              <Terminal class="mx-auto mb-2 h-5 w-5 opacity-40" />
              Nothing logged yet.
            </div>
            <div
              v-for="entry in logs"
              :key="entry.id"
              class="mb-1 flex gap-2"
            >
              <span class="shrink-0 text-muted-foreground/50">{{ entry.ts.slice(11, 19) }}</span>
              <span class="w-14 shrink-0 truncate opacity-70">{{ entry.scope }}</span>
              <span
                :class="levelClass(entry.level)"
                class="min-w-0 break-words"
              >{{ entry.message }}</span>
            </div>
          </div>
        </AppCard>

        <div class="rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-[11px] leading-relaxed text-amber-200/80">
          <div class="mb-1 flex items-center gap-1.5 font-medium text-amber-200">
            <AlertTriangle class="h-3.5 w-3.5" />
            Before you run 200 MB
          </div>
          Use a spare account while developing. Each chunk is a separate upload and message; Telegram
          rate-limits per chat, and repeated large uploads on a new account are the fastest way to
          attract restrictions.
        </div>
      </div>
    </div>
  </div>
</template>
