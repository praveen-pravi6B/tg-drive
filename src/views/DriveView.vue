<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import {
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderPlus,
  HardDrive,
  KeyRound,
  LayoutGrid,
  Link2,
  List,
  LoaderCircle,
  LockOpen,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Trash2,
  Upload,
  X,
} from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { useDriveStore } from '@/stores/drive'
import { useVaultStore } from '@/stores/vault'
import MiniSearch from 'minisearch'
import { MIN_PASSPHRASE_LENGTH } from '@/lib/vault/vault'
import { formatBytes } from '@/lib/utils'
import { limits } from '@/lib/config'
import AppButton from '@/components/ui/AppButton.vue'
import AppCard from '@/components/ui/AppCard.vue'
import AppInput from '@/components/ui/AppInput.vue'

const auth = useAuthStore()
const drive = useDriveStore()
const vault = useVaultStore()
const route = useRoute()

const viewMode = ref('grid') // grid | list
const newMenuOpen = ref(false)
const showNewFolder = ref(false)
const newFolder = ref('')
const folderError = ref('')
const actionError = ref('')
const fileInput = ref(null)
const busyFileId = ref('')
const preview = ref(null) // { item, url, kind, loading, error }
const thumbUrls = ref({})
const thumbLoading = ref({})
const contextMenu = ref(null) // { x, y, kind: 'file'|'folder'|'background', item }
const renameTarget = ref(null) // { kind: 'file'|'folder', item }
const renameValue = ref('')
const vaultPassphrase = ref('')
const vaultConfirm = ref('')
const vaultFormError = ref('')
const vaultRevealing = ref(false)
const selectedIds = ref(new Set())
const clipboard = ref(null) // { mode: 'cut'|'copy', ids: string[], sourceTopicId: number }
const selectionMode = ref(false)
const selectionAnchor = ref(-1)
const searchQuery = ref('')
const categoryFilter = ref('all') // all | image | video | audio | document
const searchAll = ref(false)

const videoRef = ref(null)
const videoPlaying = ref(false)
const videoTime = ref(0)
const videoDuration = ref(0)

const restoringSession = computed(
  () =>
    !auth.isAuthorized &&
    (auth.status === 'connecting' || (auth.status === 'idle' && auth.hasStoredSession)),
)
const ready = computed(() => auth.isAuthorized && vault.status === 'unlocked')
const needsVault = computed(
  () => auth.isAuthorized && ['no-vault', 'locked'].includes(vault.status),
)
const checking = computed(
  () =>
    restoringSession.value || (auth.isAuthorized && ['idle', 'checking'].includes(vault.status)),
)

const allActiveFiles = computed(() => (drive.allFiles || []).filter((f) => f && !f.trashedAt))

const searchIndex = computed(() => {
  const mini = new MiniSearch({
    fields: ['name'],
    storeFields: ['id'],
    searchOptions: { prefix: true, fuzzy: 0.2 },
  })
  mini.addAll(
    allActiveFiles.value.map((f) => ({
      id: f.id,
      name: f.name || '',
    })),
  )
  return mini
})

const visibleFiles = computed(() => {
  const q = String(searchQuery.value || '').trim()
  const cat = categoryFilter.value
  const base =
    searchAll.value && !drive.showTrash && (q || cat !== 'all')
      ? allActiveFiles.value
      : drive.files || []

  let result = base
  if (q) {
    if (searchAll.value && !drive.showTrash) {
      const hits = searchIndex.value.search(q)
      const ids = new Set(hits.map((h) => h.id))
      result = base.filter((f) => ids.has(f.id))
      // preserve relevance order from MiniSearch
      const order = new Map(hits.map((h, i) => [h.id, i]))
      result = [...result].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    } else {
      const lower = q.toLowerCase()
      result = base.filter((f) =>
        String(f?.name || '')
          .toLowerCase()
          .includes(lower),
      )
    }
  }

  if (cat !== 'all') {
    result = result.filter((file) => file?.category === cat)
  }
  return result
})
const previewableInFolder = computed(() => visibleFiles.value.filter((f) => isPreviewable(f)))
const selectedCount = computed(() => selectedIds.value.size)
const hasSelection = computed(() => selectedIds.value.size > 0)
const showSelectionUi = computed(() => selectionMode.value || selectedIds.value.size > 0)
const hasClipboard = computed(
  () => Array.isArray(clipboard.value?.ids) && clipboard.value.ids.length > 0,
)
const clipboardCount = computed(() => clipboard.value?.ids?.length || 0)

function isPreviewable(item) {
  if (!item) return false
  if (Number(item.size || 0) > limits.previewMaxSize) return false
  const mime = String(item.mime || '').toLowerCase()
  return (
    item.category === 'image' ||
    item.category === 'video' ||
    item.category === 'audio' ||
    mime === 'application/pdf'
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
    return new Date(value).toLocaleDateString()
  } catch {
    return '—'
  }
}

function closePreview() {
  if (preview.value?.url) URL.revokeObjectURL(preview.value.url)
  preview.value = null
  videoPlaying.value = false
  videoTime.value = 0
  videoDuration.value = 0
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
  // keep thumbnails to reasonably sized images
  return Number(item.size || 0) <= Math.min(limits.previewMaxSize, 15 * 1024 * 1024)
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
    const items = (visibleFiles.value || []).filter(
      (item) => canThumb(item) && !thumbUrls.value[item.id],
    )
    for (const item of items.slice(0, 12)) {
      await ensureThumb(item)
    }
  }, 150)
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

function isSelected(id) {
  return selectedIds.value.has(id)
}
function itemIndex(id) {
  return visibleFiles.value.findIndex((f) => f.id === id)
}
function setSelectionRange(from, to) {
  const list = visibleFiles.value
  const start = Math.max(0, Math.min(from, to))
  const end = Math.min(list.length - 1, Math.max(from, to))
  const next = new Set()
  for (let i = start; i <= end; i += 1) {
    if (list[i]?.id) next.add(list[i].id)
  }
  selectedIds.value = next
  if (next.size) selectionMode.value = true
  else selectionMode.value = false
}
function toggleSelection(id) {
  const idx = itemIndex(id)
  if (idx >= 0) selectionAnchor.value = idx
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
  if (next.size === 0) selectionMode.value = false
}
function clearSelection() {
  if (selectedIds.value.size) selectedIds.value = new Set()
  selectionMode.value = false
  selectionAnchor.value = -1
}
function selectAllCurrent() {
  selectedIds.value = new Set((visibleFiles.value || []).map((f) => f.id).filter(Boolean))
  if (selectedIds.value.size) {
    selectionMode.value = true
    selectionAnchor.value = 0
  }
}
function copySelection() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  clipboard.value = { mode: 'copy', ids, sourceTopicId: drive.selectedTopicId }
  actionError.value = ''
}
function cutSelection() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  clipboard.value = { mode: 'cut', ids, sourceTopicId: drive.selectedTopicId }
  actionError.value = ''
}
async function pasteClipboard() {
  if (!hasClipboard.value || !drive.selectedTopicId) return
  actionError.value = ''
  const manifests = (clipboard.value.ids || [])
    .map((id) => drive.allFiles.find((f) => f.id === id))
    .filter(Boolean)
  if (!manifests.length) {
    clipboard.value = null
    return
  }
  try {
    await drive.pasteFiles({
      mode: clipboard.value.mode,
      manifests,
      targetTopicId: drive.selectedTopicId,
    })
    clipboard.value = null
    drive.clearBatchTask()
    clearSelection()
  } catch (error) {
    actionError.value = drive.batchTask?.error || error.message
  }
}
function clearClipboard() {
  clipboard.value = null
}

async function openItem(item) {
  if (!item) return
  if (searchAll.value && !drive.showTrash && Number(item.folderTopicId) !== drive.selectedTopicId) {
    await drive.selectFolder(item.folderTopicId)
  }
  if (isPreviewable(item)) openPreview(item)
  else download(item)
}

function previewIndex() {
  if (!preview.value?.item) return -1
  return previewableInFolder.value.findIndex((f) => f.id === preview.value.item.id)
}

function canPrev() {
  return previewIndex() > 0
}
function canNext() {
  const idx = previewIndex()
  return idx >= 0 && idx < previewableInFolder.value.length - 1
}
function goPrev() {
  const idx = previewIndex()
  if (idx > 0) openPreview(previewableInFolder.value[idx - 1])
}
function goNext() {
  const idx = previewIndex()
  if (idx >= 0 && idx < previewableInFolder.value.length - 1) {
    openPreview(previewableInFolder.value[idx + 1])
  }
}

function onVideoLoaded() {
  const v = videoRef.value
  if (!v) return
  videoDuration.value = v.duration || 0
}
function onVideoTime() {
  const v = videoRef.value
  if (!v) return
  videoTime.value = v.currentTime || 0
  videoPlaying.value = !v.paused
}
function togglePlay() {
  const v = videoRef.value
  if (!v) return
  if (v.paused) v.play()
  else v.pause()
}
function seekVideo(e) {
  const v = videoRef.value
  if (!v) return
  const value = Number(e.target.value)
  v.currentTime = value
  videoTime.value = value
}
function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function openContextMenu(e, item, kind = 'file') {
  e.preventDefault()
  e.stopPropagation?.()
  contextMenu.value = { x: e.clientX, y: e.clientY, item: item || null, kind }
}
function openBackgroundMenu(e) {
  if (!ready.value || !drive.selectedTopicId) return
  openContextMenu(e, null, 'background')
}
function openFolderMenu(e, folder) {
  if (!folder) return
  openContextMenu(e, folder, 'folder')
}
function closeContextMenu() {
  contextMenu.value = null
}
function ctxOpen(item) {
  openItem(item)
  closeContextMenu()
}
function ctxDownload(item) {
  download(item)
  closeContextMenu()
}
function ctxDelete(item) {
  trashFile(item)
  closeContextMenu()
}
function ctxRestore(item) {
  restoreFile(item)
  closeContextMenu()
}
function ctxDeletePermanently(item) {
  deletePermanentlyFile(item)
  closeContextMenu()
}
function ctxCopy(item) {
  if (!item) return
  clipboard.value = { mode: 'copy', ids: [item.id], sourceTopicId: drive.selectedTopicId }
  selectionMode.value = true
  selectedIds.value = new Set([item.id])
  selectionAnchor.value = itemIndex(item.id)
  closeContextMenu()
}
function ctxCut(item) {
  if (!item) return
  clipboard.value = { mode: 'cut', ids: [item.id], sourceTopicId: drive.selectedTopicId }
  selectionMode.value = true
  selectedIds.value = new Set([item.id])
  selectionAnchor.value = itemIndex(item.id)
  closeContextMenu()
}
async function ctxCopyLink(item) {
  if (!item?.id) return
  try {
    const url = new URL('/drive', window.location.origin)
    url.searchParams.set('file', String(item.id))
    await navigator.clipboard.writeText(url.toString())
  } catch (error) {
    actionError.value = 'Could not copy link'
  } finally {
    closeContextMenu()
  }
}
function ctxToggleSelect(item) {
  if (!item) return
  if (!isSelected(item.id)) selectionMode.value = true
  toggleSelection(item.id)
  closeContextMenu()
}
function ctxPaste() {
  pasteClipboard()
  closeContextMenu()
}
function ctxSelectAll() {
  selectAllCurrent()
  closeContextMenu()
}
function onGlobalClick() {
  closeContextMenu()
  newMenuOpen.value = false
}
function isTypingTarget(target) {
  const tag = target?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable
}
function onGlobalKey(e) {
  if (e.key === 'Escape') {
    closeContextMenu()
    closePreview()
    newMenuOpen.value = false
    renameTarget.value = null
    if (!preview.value) clearSelection()
    return
  }

  if (preview.value) {
    if (preview.value.kind === 'video' && e.key === ' ' && !isTypingTarget(e.target)) {
      e.preventDefault()
      togglePlay()
    }
    if (e.key === 'ArrowRight' && canNext()) goNext()
    if (e.key === 'ArrowLeft' && canPrev()) goPrev()
    return
  }

  if (isTypingTarget(e.target) || renameTarget.value || !ready.value) return

  const meta = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()

  if (meta && key === 'a') {
    if (visibleFiles.value.length) {
      e.preventDefault()
      selectAllCurrent()
    }
    return
  }
  if (meta && key === 'c') {
    if (!drive.showTrash && selectedCount.value) {
      e.preventDefault()
      copySelection()
    }
    return
  }
  if (meta && key === 'x') {
    if (!drive.showTrash && selectedCount.value) {
      e.preventDefault()
      cutSelection()
    }
    return
  }
  if (meta && key === 'v') {
    if (!drive.showTrash && hasClipboard.value && drive.selectedTopicId) {
      e.preventDefault()
      pasteClipboard()
    }
    return
  }

  if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    if (!visibleFiles.value.length) return
    e.preventDefault()
    let anchor = selectionAnchor.value
    if (anchor < 0) anchor = 0
    let cursor = anchor
    // extend from current end of selection if any, else anchor
    if (selectedIds.value.size) {
      const indices = [...selectedIds.value].map(itemIndex).filter((i) => i >= 0)
      if (indices.length) {
        cursor =
          e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? Math.min(...indices) : Math.max(...indices)
      }
    }
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
    const next = Math.max(0, Math.min(visibleFiles.value.length - 1, cursor + delta))
    setSelectionRange(anchor, next)
    selectionAnchor.value = anchor
  }
}

function startRename(item) {
  if (!item || selectedCount.value > 1) return
  renameTarget.value = { kind: 'file', item }
  renameValue.value = item?.name || ''
  closeContextMenu()
  nextTick(() => {
    const el = document.getElementById('rename-input')
    el?.focus?.()
    el?.select?.()
  })
}
function startRenameFolder(folder) {
  if (!folder || Number(folder.id) === 1) return
  renameTarget.value = { kind: 'folder', item: folder }
  renameValue.value = folder?.title || ''
  closeContextMenu()
  nextTick(() => {
    const el = document.getElementById('rename-input')
    el?.focus?.()
    el?.select?.()
  })
}
async function submitRename() {
  if (!renameTarget.value) return
  const name = renameValue.value.trim()
  if (!name) return
  actionError.value = ''
  const target = renameTarget.value
  busyFileId.value = target.item?.id || ''
  try {
    if (target.kind === 'folder') {
      await drive.renameFolder(target.item.id, name)
    } else {
      await drive.rename(target.item, name)
    }
    renameTarget.value = null
  } catch (error) {
    actionError.value = error.message
  } finally {
    busyFileId.value = ''
  }
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
    showNewFolder.value = false
  } catch (error) {
    folderError.value = error.message
  }
}

async function deleteCurrentFolder() {
  const folder = drive.selectedFolder
  if (!folder || Number(folder.id) === 1) return
  const count = drive.files.length
  const ok = window.confirm(
    `Delete folder "${folder.title}"?\n\nThis removes the folder topic and its files from Telegram. (${count} file(s) in the current index)`,
  )
  if (!ok) return
  actionError.value = ''
  try {
    await drive.deleteFolder(folder.id)
  } catch (error) {
    actionError.value = error.message
  }
}

async function deleteFolderById(folder) {
  if (!folder || Number(folder.id) === 1) return
  const filesInFolder = drive.allFiles.filter(
    (file) => Number(file.folderTopicId) === Number(folder.id),
  ).length
  const ok = window.confirm(
    `Delete folder "${folder.title}"?\n\nThis removes the folder topic and its files from Telegram. (${filesInFolder} file(s) in the current index)`,
  )
  if (!ok) return
  actionError.value = ''
  closeContextMenu()
  try {
    await drive.deleteFolder(folder.id)
  } catch (error) {
    actionError.value = error.message
  }
}

function pickFile() {
  newMenuOpen.value = false
  fileInput.value?.click()
}
function openNewFolder() {
  newMenuOpen.value = false
  showNewFolder.value = true
  folderError.value = ''
  nextTick(() => document.getElementById('new-folder-input')?.focus?.())
}
function onFilePicked(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  if (!files.length) return
  actionError.value = ''
  try {
    drive.enqueueUploads(files)
  } catch (error) {
    actionError.value = error.message
  }
}

async function download(manifest) {
  if (!manifest) return
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
async function trashFile(manifest) {
  if (!manifest) return
  const ok = window.confirm(`Move "${manifest.name}" to Trash?\n\nIt will be kept for 30 days.`)
  if (!ok) return
  actionError.value = ''
  busyFileId.value = manifest.id
  try {
    await drive.remove(manifest)
    if (preview.value?.item?.id === manifest.id) closePreview()
  } catch (error) {
    actionError.value = error.message
  } finally {
    busyFileId.value = ''
  }
}
async function restoreFile(manifest) {
  if (!manifest) return
  actionError.value = ''
  busyFileId.value = manifest.id
  try {
    await drive.restore(manifest)
  } catch (error) {
    actionError.value = error.message
  } finally {
    busyFileId.value = ''
  }
}
async function deletePermanentlyFile(manifest) {
  if (!manifest) return
  const ok = window.confirm(
    `Delete "${manifest.name}" permanently?\n\nThis removes its encrypted chunks and manifest from Telegram.`,
  )
  if (!ok) return
  actionError.value = ''
  busyFileId.value = manifest.id
  try {
    await drive.deletePermanently(manifest)
    if (preview.value?.item?.id === manifest.id) closePreview()
  } catch (error) {
    actionError.value = error.message
  } finally {
    busyFileId.value = ''
  }
}
async function emptyTrashNow() {
  const count = drive.trashFiles.length + drive.trashedFolders.length
  if (!count) return
  const ok = window.confirm(
    `Empty Trash?\n\nThis permanently deletes ${count} item(s) and their encrypted data from Telegram.`,
  )
  if (!ok) return
  actionError.value = ''
  try {
    await drive.emptyTrash()
  } catch (error) {
    actionError.value = error.message
  }
}

async function restoreFolder(folder) {
  if (!folder) return
  actionError.value = ''
  try {
    await drive.restoreFolder(folder.id)
  } catch (error) {
    actionError.value = error.message
  }
}

async function deleteFolderPermanently(folder) {
  if (!folder) return
  const ok = window.confirm(
    `Delete folder "${folder.title}" permanently?\n\nThis removes the folder and all its files from Telegram.`,
  )
  if (!ok) return
  actionError.value = ''
  try {
    await drive.deleteFolderPermanently(folder.id)
  } catch (error) {
    actionError.value = error.message
  }
}

watch(
  () => auth.isAuthorized,
  async (authorized) => {
    if (authorized) {
      await vault.init()
      if (vault.status === 'unlocked') await drive.init()
    } else {
      drive.reset()
      vault.reset()
      revokeThumbs()
    }
  },
)

watch(
  () => vault.status,
  async (status, previous) => {
    if (!auth.isAuthorized) return
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
  () => [drive.files, drive.selectedTopicId, ready.value, searchQuery.value, categoryFilter.value],
  () => {
    if (ready.value) scheduleThumbs()
  },
  { deep: true },
)

watch(
  () => drive.selectedTopicId,
  () => {
    clearSelection()
    selectionAnchor.value = -1
    searchQuery.value = ''
    categoryFilter.value = 'all'
    searchAll.value = false
  },
)

let openedLinkedFile = false
async function maybeOpenLinkedFile() {
  if (openedLinkedFile) return
  const fileId = typeof route.query.file === 'string' ? route.query.file : ''
  if (!fileId || !ready.value || !drive.allFiles.length) return
  const manifest = drive.allFiles.find((f) => f.id === fileId)
  if (!manifest) return
  openedLinkedFile = true
  if (Number(manifest.folderTopicId) && Number(manifest.folderTopicId) !== drive.selectedTopicId) {
    await drive.selectFolder(manifest.folderTopicId)
  }
  if (isPreviewable(manifest)) openPreview(manifest)
}

watch(
  () => [ready.value, drive.allFiles.length, route.query.file],
  () => {
    maybeOpenLinkedFile().catch(() => {})
  },
)

onMounted(async () => {
  window.addEventListener('click', onGlobalClick)
  window.addEventListener('keydown', onGlobalKey)
  if (auth.isAuthorized) {
    await vault.init()
    if (vault.status === 'unlocked') await drive.init()
  }
  await maybeOpenLinkedFile()
})
onBeforeUnmount(() => {
  window.removeEventListener('click', onGlobalClick)
  window.removeEventListener('keydown', onGlobalKey)
  closePreview()
  revokeThumbs()
  if (thumbTimer) clearTimeout(thumbTimer)
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-7xl gap-6 px-5 py-6" @contextmenu.prevent>
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
            @click.stop="drive.refreshFolders()"
          >
            <RefreshCw class="h-3.5 w-3.5" />
          </button>
        </div>

        <div v-if="ready" class="space-y-1">
          <button
            v-for="folder in drive.activeFolders"
            :key="folder.id"
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-white/5"
            :class="
              !drive.showTrash && folder.id === drive.selectedTopicId
                ? 'bg-white/5 text-foreground'
                : 'text-muted-foreground'
            "
            @click="drive.selectFolder(folder.id)"
            @contextmenu="openFolderMenu($event, folder)"
          >
            <span class="grid h-5 w-5 place-items-center rounded bg-white/5 text-sky-300">
              <HardDrive class="h-3 w-3" />
            </span>
            <span class="truncate">{{ folder.title }}</span>
          </button>
          <button
            type="button"
            class="mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-white/5"
            :class="drive.showTrash ? 'bg-white/5 text-foreground' : 'text-muted-foreground'"
            @click="drive.selectTrash()"
          >
            <span class="grid h-5 w-5 place-items-center rounded bg-white/5 text-red-300">
              <Trash2 class="h-3 w-3" />
            </span>
            <span class="truncate">Trash</span>
            <span
              v-if="drive.trashFiles.length + drive.trashedFolders.length"
              class="ml-auto text-[10px] text-muted-foreground"
            >
              {{ drive.trashFiles.length + drive.trashedFolders.length }}
            </span>
          </button>
          <p
            v-if="!drive.activeFolders.length && drive.status === 'ready'"
            class="px-2 py-2 text-[11px] text-muted-foreground"
          >
            No folders yet. Use + New to create one.
          </p>
        </div>
        <p v-else class="px-2 py-2 text-[11px] text-muted-foreground">
          Unlock the vault to see folders.
        </p>
      </div>
    </aside>

    <section class="min-w-0 flex-1 space-y-5">
      <div class="flex flex-wrap items-center gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h1 class="truncate text-lg font-semibold tracking-tight">
              {{ drive.showTrash ? 'Trash' : drive.selectedFolder?.title || 'My Drive' }}
            </h1>
            <button
              v-if="
                !drive.showTrash && drive.selectedFolder && Number(drive.selectedFolder.id) !== 1
              "
              type="button"
              class="rounded-md p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-300"
              title="Delete folder"
              @click="deleteCurrentFolder"
            >
              <Trash2 class="h-4 w-4" />
            </button>
          </div>
          <p class="text-xs text-muted-foreground">
            <template v-if="drive.showTrash">
              {{ drive.trashFiles.length + drive.trashedFolders.length }} item(s) in trash · kept
              for 30 days
            </template>
            <template v-else>
              {{ visibleFiles.length }} shown · {{ drive.files.length }} items · encrypted on this
              device
            </template>
          </p>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <div class="flex items-center rounded-lg border border-white/10 p-0.5">
            <button
              type="button"
              class="rounded-md p-1.5"
              :class="
                viewMode === 'grid'
                  ? 'bg-white/10 text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              "
              title="Grid view"
              @click="viewMode = 'grid'"
            >
              <LayoutGrid class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="rounded-md p-1.5"
              :class="
                viewMode === 'list'
                  ? 'bg-white/10 text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              "
              title="List view"
              @click="viewMode = 'list'"
            >
              <List class="h-4 w-4" />
            </button>
          </div>

          <AppButton
            v-if="showSelectionUi && visibleFiles.length"
            variant="outline"
            size="md"
            :disabled="!ready || drive.filesLoading"
            @click="selectAllCurrent"
          >
            Select all
          </AppButton>

          <AppButton
            v-if="drive.showTrash"
            variant="outline"
            size="md"
            :disabled="!ready || !(drive.trashFiles.length + drive.trashedFolders.length)"
            @click="emptyTrashNow"
          >
            <Trash2 class="h-4 w-4" />
            Empty trash
          </AppButton>

          <AppButton
            variant="outline"
            size="md"
            :disabled="!ready || drive.filesLoading"
            @click="drive.refreshFiles()"
          >
            <RefreshCw class="h-4 w-4" />
          </AppButton>

          <div v-if="!drive.showTrash" class="relative">
            <AppButton :disabled="!ready" @click.stop="newMenuOpen = !newMenuOpen">
              <Plus class="h-4 w-4" />
              New
            </AppButton>
            <div
              v-if="newMenuOpen"
              class="absolute right-0 z-30 mt-2 w-44 overflow-hidden rounded-xl border border-white/10 bg-background/95 py-1 shadow-xl backdrop-blur"
              @click.stop
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5 disabled:opacity-40"
                :disabled="!drive.selectedTopicId || drive.isBatchRunning"
                @click="pickFile"
              >
                <Upload class="h-4 w-4 text-sky-300" />
                Upload files
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
                @click="openNewFolder"
              >
                <FolderPlus class="h-4 w-4 text-sky-300" />
                New folder
              </button>
            </div>
          </div>

          <input ref="fileInput" type="file" class="hidden" multiple @change="onFilePicked" />
        </div>
      </div>

      <div
        v-if="actionError || drive.error || (vault.error && vault.status !== 'locked')"
        class="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-200"
      >
        {{ actionError || drive.error || vault.error }}
      </div>

      <div
        v-if="ready && drive.selectedTopicId && !drive.showTrash"
        class="flex flex-wrap items-center gap-2"
      >
        <input
          v-model="searchQuery"
          type="search"
          :placeholder="searchAll ? 'Search all files...' : 'Search files...'"
          class="h-9 min-w-[180px] flex-1 rounded-lg border border-input bg-background/60 px-3 text-sm focus-ring"
        />
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input v-model="searchAll" type="checkbox" class="h-3.5 w-3.5 accent-sky-500" />
          All folders
        </label>
        <div class="flex flex-wrap items-center gap-1">
          <button
            v-for="opt in [
              { id: 'all', label: 'All' },
              { id: 'image', label: 'Images' },
              { id: 'video', label: 'Videos' },
              { id: 'audio', label: 'Audio' },
              { id: 'document', label: 'Documents' },
            ]"
            :key="opt.id"
            type="button"
            class="rounded-lg px-2.5 py-1.5 text-xs transition-colors"
            :class="
              categoryFilter === opt.id
                ? 'bg-white/10 text-foreground'
                : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
            "
            @click="categoryFilter = opt.id"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div
        v-if="showNewFolder"
        class="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3"
      >
        <FolderPlus class="h-4 w-4 text-sky-300" />
        <input
          id="new-folder-input"
          v-model="newFolder"
          placeholder="New folder name"
          class="h-9 flex-1 rounded-lg border border-input bg-background/60 px-3 text-sm focus-ring"
          @keydown.enter.prevent="createFolder"
          @keydown.esc="showNewFolder = false"
        />
        <AppButton size="sm" :loading="drive.creatingFolder" @click="createFolder">
          Create
        </AppButton>
        <AppButton size="sm" variant="ghost" @click="showNewFolder = false"> Cancel </AppButton>
        <span v-if="folderError" class="text-xs text-red-300">{{ folderError }}</span>
      </div>

      <AppCard
        v-if="checking"
        :title="restoringSession ? 'Restoring session' : 'Loading drive'"
        :description="
          restoringSession
            ? 'Reconnecting to Telegram in the background'
            : 'Resolving the vault and group'
        "
      >
        <div class="flex items-center gap-3 py-4 text-sm text-muted-foreground">
          <LoaderCircle class="h-4 w-4 animate-spin text-sky-300" />
          {{
            restoringSession ? 'Restoring your Telegram session…' : 'Checking your Telegram drive…'
          }}
        </div>
      </AppCard>

      <template v-else-if="ready">
        <div
          v-if="drive.uploadTask?.error"
          class="flex items-center gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-200"
        >
          <span class="min-w-0 flex-1 truncate">Upload failed: {{ drive.uploadTask.error }}</span>
          <AppButton size="sm" variant="ghost" @click="drive.clearUpload()">Dismiss</AppButton>
        </div>

        <AppCard
          v-if="!drive.selectedTopicId && !drive.showTrash"
          title="Create a folder"
          description="Each folder is a Telegram forum topic in your drive group"
        >
          <p class="text-sm text-muted-foreground">
            Use <strong>+ New → New folder</strong> to create a folder, then upload files into it.
          </p>
        </AppCard>

        <div v-else @contextmenu.prevent="drive.showTrash ? null : openBackgroundMenu($event)">
          <div
            v-if="
              drive.filesLoading &&
              !drive.files.length &&
              !drive.uploadTask?.running &&
              !drive.uploadTask?.error
            "
            class="flex items-center gap-3 py-16 text-sm text-muted-foreground"
          >
            <LoaderCircle class="h-4 w-4 animate-spin text-sky-300" />
            {{ drive.showTrash ? 'Loading trash…' : 'Reading encrypted manifests…' }}
          </div>

          <div
            v-else-if="
              !visibleFiles.length &&
              !(drive.showTrash && drive.trashedFolders.length) &&
              !drive.uploadTask?.running &&
              !drive.uploadTask?.error
            "
            class="rounded-xl border border-dashed border-white/10 px-6 py-16 text-center"
          >
            <HardDrive class="mx-auto h-10 w-10 text-muted-foreground/40" />
            <p class="mt-3 text-sm font-medium">
              {{
                drive.showTrash
                  ? 'Trash is empty'
                  : drive.files.length
                    ? 'No matching files'
                    : 'This folder is empty'
              }}
            </p>
            <p class="mt-1 text-xs text-muted-foreground">
              {{
                drive.showTrash
                  ? 'Deleted files and folders will appear here for 30 days before being removed permanently.'
                  : drive.files.length
                    ? 'Try a different search or category filter.'
                    : 'Use + New → Upload files to add encrypted files.'
              }}
            </p>
          </div>

          <div v-if="drive.showTrash && drive.trashedFolders.length" class="mb-4 space-y-2">
            <div class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Deleted folders
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <div
                v-for="folder in drive.trashedFolders"
                :key="'tf-' + folder.id"
                class="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3"
              >
                <span class="grid h-9 w-9 place-items-center rounded-lg bg-white/5 text-red-300">
                  <HardDrive class="h-4 w-4" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium">{{ folder.title }}</div>
                  <div class="text-[11px] text-muted-foreground">Folder · in trash</div>
                </div>
                <div class="flex items-center gap-1">
                  <button
                    type="button"
                    class="rounded-md p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                    title="Restore folder"
                    @click="restoreFolder(folder)"
                  >
                    <RotateCcw class="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    class="rounded-md p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-300"
                    title="Delete permanently"
                    @click="deleteFolderPermanently(folder)"
                  >
                    <Trash2 class="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="visibleFiles.length && viewMode === 'grid'"
            class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          >
            <div
              v-if="drive.uploadTask?.running || drive.uploadTask?.error"
              class="relative overflow-hidden rounded-xl border"
              :class="
                drive.uploadTask?.error
                  ? 'border-red-500/20 bg-red-500/[0.04]'
                  : 'border-sky-400/20 bg-sky-400/[0.04]'
              "
            >
              <div class="grid aspect-[4/3] w-full place-items-center bg-black/20">
                <LoaderCircle
                  v-if="drive.uploadTask?.running"
                  class="h-8 w-8 animate-spin text-sky-300"
                />
                <X v-else class="h-8 w-8 text-red-300" />
              </div>
              <div class="p-2.5">
                <div class="truncate text-sm font-medium" :title="drive.uploadTask.fileName">
                  {{ drive.uploadTask.fileName || 'Uploading…' }}
                </div>
                <div
                  class="mt-0.5 flex items-center justify-between gap-2 text-[11px]"
                  :class="drive.uploadTask?.error ? 'text-red-300' : 'text-muted-foreground'"
                >
                  <span class="truncate">
                    {{
                      drive.uploadTask?.error
                        ? drive.uploadTask.error
                        : `Uploading…${drive.uploadQueueCount ? ` (${drive.uploadQueueCount} queued)` : ''}`
                    }}
                  </span>
                  <button
                    type="button"
                    class="shrink-0 hover:underline"
                    :class="
                      drive.uploadTask?.error ? 'text-red-200' : 'text-sky-300 hover:text-sky-200'
                    "
                    @click="drive.uploadTask?.error ? drive.clearUpload() : drive.cancelUpload()"
                  >
                    {{ drive.uploadTask?.error ? 'Dismiss' : 'Cancel' }}
                  </button>
                </div>
              </div>
            </div>
            <div
              v-for="item in visibleFiles"
              :key="item.id"
              class="group relative overflow-hidden rounded-xl border bg-white/[0.02] transition-colors hover:bg-white/[0.05]"
              :class="
                isSelected(item.id) ? 'border-sky-400/40 ring-1 ring-sky-400/30' : 'border-white/5'
              "
              @contextmenu="openContextMenu($event, item, 'file')"
            >
              <div v-if="showSelectionUi" class="absolute left-1.5 top-1.5 z-10">
                <button
                  type="button"
                  class="grid h-5 w-5 place-items-center rounded-full border backdrop-blur transition-colors"
                  :class="
                    isSelected(item.id)
                      ? 'border-sky-400 bg-sky-500'
                      : 'border-white/40 bg-black/40 hover:border-white/70'
                  "
                  @click.stop="toggleSelection(item.id)"
                  :aria-pressed="isSelected(item.id)"
                  title="Select"
                >
                  <span v-if="isSelected(item.id)" class="h-2 w-2 rounded-full bg-white"></span>
                </button>
              </div>
              <button
                type="button"
                class="block aspect-[4/3] w-full overflow-hidden bg-black/20"
                @click="openItem(item)"
              >
                <img
                  v-if="thumbUrls[item.id]"
                  :src="thumbUrls[item.id]"
                  :alt="item.name"
                  class="h-full w-full object-cover"
                />
                <span v-else class="grid h-full w-full place-items-center text-sky-300/80">
                  <component :is="iconFor(item.category)" class="h-10 w-10" />
                </span>
              </button>
              <div class="p-2.5">
                <div class="truncate text-sm font-medium" :title="item.name">
                  {{ item.name }}
                </div>
                <div class="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {{ formatDate(item.createdAt) }}
                  <template v-if="searchAll && item.folderTopicId">
                    ·
                    {{ drive.folders.find((f) => f.id === item.folderTopicId)?.title || 'Folder' }}
                  </template>
                </div>
              </div>
              <button
                type="button"
                class="absolute right-1.5 top-1.5 rounded-md bg-black/40 p-1 text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/60 group-hover:opacity-100"
                title="More"
                @click.stop="openContextMenu($event, item, 'file')"
              >
                <MoreVertical class="h-4 w-4" />
              </button>
            </div>
          </div>

          <ul
            v-else
            class="divide-y divide-white/5 rounded-xl border border-white/5 bg-white/[0.01]"
          >
            <li
              v-if="drive.uploadTask?.running || drive.uploadTask?.error"
              class="flex items-center gap-3 px-3 py-2.5"
            >
              <span
                class="grid h-10 w-10 shrink-0 place-items-center rounded-lg"
                :class="
                  drive.uploadTask?.error
                    ? 'bg-red-500/10 text-red-300'
                    : 'bg-sky-400/10 text-sky-300'
                "
              >
                <LoaderCircle v-if="drive.uploadTask?.running" class="h-4 w-4 animate-spin" />
                <X v-else class="h-4 w-4" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">
                  {{ drive.uploadTask.fileName || 'Uploading…' }}
                </div>
                <div
                  class="truncate text-[11px]"
                  :class="drive.uploadTask?.error ? 'text-red-300' : 'text-muted-foreground'"
                >
                  {{
                    drive.uploadTask?.error
                      ? drive.uploadTask.error
                      : `Uploading…${drive.uploadQueueCount ? ` (${drive.uploadQueueCount} queued)` : ''}`
                  }}
                </div>
              </div>
              <button
                type="button"
                class="rounded px-2 py-1 text-xs hover:bg-white/5"
                :class="
                  drive.uploadTask?.error
                    ? 'text-red-200 hover:text-red-100'
                    : 'text-sky-300 hover:text-sky-200'
                "
                @click="drive.uploadTask?.error ? drive.clearUpload() : drive.cancelUpload()"
              >
                {{ drive.uploadTask?.error ? 'Dismiss' : 'Cancel' }}
              </button>
            </li>
            <li
              v-for="item in visibleFiles"
              :key="item.id"
              class="flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.03]"
              :class="isSelected(item.id) ? 'bg-sky-400/[0.06]' : ''"
              @contextmenu="openContextMenu($event, item, 'file')"
            >
              <button
                v-if="showSelectionUi"
                type="button"
                class="grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors"
                :class="
                  isSelected(item.id)
                    ? 'border-sky-400 bg-sky-500'
                    : 'border-white/30 bg-black/30 hover:border-white/60'
                "
                @click.stop="toggleSelection(item.id)"
                :aria-pressed="isSelected(item.id)"
                title="Select"
              >
                <span v-if="isSelected(item.id)" class="h-2 w-2 rounded-full bg-white"></span>
              </button>
              <button
                type="button"
                class="shrink-0 overflow-hidden rounded-lg"
                @click="openItem(item)"
              >
                <img
                  v-if="thumbUrls[item.id]"
                  :src="thumbUrls[item.id]"
                  :alt="item.name"
                  class="h-10 w-10 object-cover"
                />
                <span v-else class="grid h-10 w-10 place-items-center bg-white/5 text-sky-300">
                  <component :is="iconFor(item.category)" class="h-4 w-4" />
                </span>
              </button>
              <button type="button" class="min-w-0 flex-1 text-left" @click="openItem(item)">
                <div class="truncate text-sm font-medium">
                  {{ item.name }}
                </div>
                <div class="truncate text-[11px] text-muted-foreground">
                  {{ formatBytes(item.size) }} · {{ formatDate(item.createdAt) }}
                  <template v-if="searchAll && item.folderTopicId">
                    ·
                    {{ drive.folders.find((f) => f.id === item.folderTopicId)?.title || 'Folder' }}
                  </template>
                </div>
              </button>
              <button
                type="button"
                class="rounded p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
                @click.stop="openContextMenu($event, item, 'file')"
              >
                <MoreVertical class="h-4 w-4" />
              </button>
            </li>
          </ul>
        </div>
      </template>

      <AppCard
        v-else-if="vault.status === 'error'"
        title="Could not open the vault"
        description="Telegram or the drive group returned an error"
      >
        <p class="text-sm text-red-200">
          {{ vault.error || 'Unknown error' }}
        </p>
        <AppButton class="mt-4" variant="outline" @click="vault.init({ force: true })">
          <RefreshCw class="h-4 w-4" />
          Try again
        </AppButton>
      </AppCard>

      <div v-else-if="needsVault" class="py-16 text-center text-sm text-muted-foreground">
        Unlock your drive to continue.
      </div>
    </section>
  </div>

  <!-- Vault modal -->
  <div
    v-if="needsVault && !checking"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
  >
    <div class="w-full max-w-md rounded-xl border border-white/10 bg-background p-5 shadow-2xl">
      <div class="flex items-center gap-2">
        <span class="grid h-9 w-9 place-items-center rounded-lg bg-sky-400/10 text-sky-300"
          ><KeyRound class="h-4 w-4"
        /></span>
        <div>
          <h2 class="text-sm font-semibold">
            {{ vault.status === 'no-vault' ? 'Create your vault' : 'Unlock your drive' }}
          </h2>
          <p class="text-[11px] text-muted-foreground">
            {{
              vault.status === 'no-vault'
                ? 'Set a passphrase to protect your files.'
                : 'Enter your passphrase to continue.'
            }}
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
          <input
            v-model="vaultRevealing"
            type="checkbox"
            class="h-3.5 w-3.5 rounded border-border bg-background"
          />
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
          <RouterLink to="/vault" class="text-xs text-muted-foreground hover:text-foreground"
            >Manage vault</RouterLink
          >
        </div>
      </form>
    </div>
  </div>

  <!-- Context menu -->
  <div
    v-if="contextMenu"
    class="fixed z-[60] w-48 overflow-hidden rounded-xl border border-white/10 bg-background/95 py-1 shadow-xl backdrop-blur"
    :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
    @click.stop
    @contextmenu.prevent
  >
    <template v-if="contextMenu.kind === 'file' && contextMenu.item">
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
        @click="ctxOpen(contextMenu.item)"
      >
        <Eye class="h-4 w-4" /> Open
      </button>
      <template v-if="!drive.showTrash">
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="selectedCount > 1"
          @click="startRename(contextMenu.item)"
        >
          <Pencil class="h-4 w-4" /> Rename
        </button>
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
          @click="ctxToggleSelect(contextMenu.item)"
        >
          <Copy class="h-4 w-4" />
          {{ isSelected(contextMenu.item.id) ? 'Unselect' : 'Select file' }}
        </button>
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
          @click="ctxCopy(contextMenu.item)"
        >
          <Copy class="h-4 w-4" /> Copy
        </button>
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
          @click="ctxCut(contextMenu.item)"
        >
          <Scissors class="h-4 w-4" /> Cut
        </button>
        <button
          v-if="hasClipboard && drive.selectedTopicId"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
          @click="ctxPaste()"
        >
          <ClipboardPaste class="h-4 w-4" /> Paste
        </button>
      </template>
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
        @click="ctxCopyLink(contextMenu.item)"
      >
        <Link2 class="h-4 w-4" /> Copy link
      </button>
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
        @click="ctxDownload(contextMenu.item)"
      >
        <Download class="h-4 w-4" /> Download
      </button>
      <template v-if="drive.showTrash">
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
          @click="ctxRestore(contextMenu.item)"
        >
          <RotateCcw class="h-4 w-4" /> Restore
        </button>
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-300 hover:bg-red-500/10"
          @click="ctxDeletePermanently(contextMenu.item)"
        >
          <Trash2 class="h-4 w-4" /> Delete permanently
        </button>
      </template>
      <button
        v-else
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-300 hover:bg-red-500/10"
        @click="ctxDelete(contextMenu.item)"
      >
        <Trash2 class="h-4 w-4" /> Move to Trash
      </button>
    </template>

    <template v-else-if="contextMenu.kind === 'folder' && contextMenu.item">
      <template v-if="Number(contextMenu.item.id) !== 1">
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
          @click="startRenameFolder(contextMenu.item)"
        >
          <Pencil class="h-4 w-4" /> Rename
        </button>
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-300 hover:bg-red-500/10"
          @click="deleteFolderById(contextMenu.item)"
        >
          <Trash2 class="h-4 w-4" /> Delete
        </button>
      </template>
      <div v-else class="px-3 py-2 text-sm text-muted-foreground">No actions for Home</div>
    </template>

    <template v-else>
      <button
        v-if="!drive.showTrash && hasClipboard && drive.selectedTopicId"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
        @click="ctxPaste()"
      >
        <ClipboardPaste class="h-4 w-4" /> Paste
      </button>
      <button
        v-if="visibleFiles.length"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
        @click="ctxSelectAll()"
      >
        Select all
      </button>
      <div
        v-if="(!hasClipboard || drive.showTrash) && !visibleFiles.length"
        class="px-3 py-2 text-sm text-muted-foreground"
      >
        No actions
      </div>
    </template>
  </div>

  <!-- Rename dialog -->
  <div
    v-if="renameTarget"
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
    @click.self="renameTarget = null"
  >
    <form
      class="w-full max-w-sm rounded-xl border border-white/10 bg-background p-4 shadow-xl"
      @submit.prevent="submitRename"
    >
      <h3 class="text-sm font-semibold">
        {{ renameTarget.kind === 'folder' ? 'Rename folder' : 'Rename file' }}
      </h3>
      <input
        id="rename-input"
        v-model="renameValue"
        class="mt-3 h-10 w-full rounded-lg border border-input bg-background/60 px-3 text-sm focus-ring"
      />
      <div class="mt-4 flex justify-end gap-2">
        <AppButton type="button" variant="ghost" size="sm" @click="renameTarget = null">
          Cancel
        </AppButton>
        <AppButton type="submit" size="sm" :loading="busyFileId === renameTarget?.item?.id">
          Save
        </AppButton>
      </div>
    </form>
  </div>

  <!-- Preview / viewer -->
  <div
    v-if="preview"
    class="fixed inset-0 z-50 flex flex-col bg-black/95"
    @click.self="closePreview"
    @contextmenu.prevent
  >
    <div class="flex items-center gap-3 border-b border-white/10 px-4 py-3">
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium text-white">
          {{ preview.item?.name }}
        </div>
        <div class="text-[11px] text-white/60">
          {{ formatBytes(preview.item?.size || 0) }}
        </div>
      </div>
      <div class="flex items-center gap-1">
        <button
          v-if="previewableInFolder.length > 1"
          type="button"
          class="rounded p-2 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30"
          :disabled="!canPrev()"
          title="Previous"
          @click="goPrev"
        >
          <ChevronLeft class="h-5 w-5" />
        </button>
        <button
          v-if="previewableInFolder.length > 1"
          type="button"
          class="rounded p-2 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30"
          :disabled="!canNext()"
          title="Next"
          @click="goNext"
        >
          <ChevronRight class="h-5 w-5" />
        </button>
        <button
          type="button"
          class="rounded p-2 text-white/70 hover:bg-white/10 hover:text-white"
          title="Download"
          @click="download(preview.item)"
        >
          <Download class="h-5 w-5" />
        </button>
        <button
          type="button"
          class="rounded p-2 text-white/70 hover:bg-white/10 hover:text-white"
          title="Close"
          @click="closePreview"
        >
          <X class="h-5 w-5" />
        </button>
      </div>
    </div>

    <div
      class="relative flex min-h-0 flex-1 items-center justify-center p-4"
      @click.self="closePreview"
    >
      <div v-if="preview.loading" class="flex items-center gap-3 text-sm text-white/70">
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
        class="max-h-full max-w-full object-contain"
        draggable="false"
        @contextmenu.prevent
      />

      <div
        v-else-if="preview.kind === 'video' && preview.url"
        class="flex h-full w-full max-w-5xl flex-col items-center justify-center gap-3"
      >
        <video
          ref="videoRef"
          :src="preview.url"
          class="max-h-[calc(100%-64px)] w-full bg-black object-contain"
          playsinline
          @click="togglePlay"
          @loadedmetadata="onVideoLoaded"
          @timeupdate="onVideoTime"
          @play="videoPlaying = true"
          @pause="videoPlaying = false"
          @ended="videoPlaying = false"
          @contextmenu.prevent
        />
        <div
          class="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2"
        >
          <button
            type="button"
            class="rounded p-1.5 text-white hover:bg-white/10"
            @click="togglePlay"
          >
            <Pause v-if="videoPlaying" class="h-5 w-5" />
            <Play v-else class="h-5 w-5" />
          </button>
          <span class="w-12 text-[11px] text-white/70">{{ fmtTime(videoTime) }}</span>
          <input
            type="range"
            min="0"
            :max="videoDuration || 0"
            step="0.1"
            :value="videoTime"
            class="h-1 flex-1 cursor-pointer accent-sky-400"
            @input="seekVideo"
          />
          <span class="w-12 text-right text-[11px] text-white/70">{{
            fmtTime(videoDuration)
          }}</span>
          <button
            v-if="canNext()"
            type="button"
            class="rounded p-1.5 text-white/80 hover:bg-white/10 hover:text-white"
            title="Next"
            @click="goNext"
          >
            <ChevronRight class="h-5 w-5" />
          </button>
        </div>
      </div>

      <audio
        v-else-if="preview.kind === 'audio' && preview.url"
        :src="preview.url"
        controls
        class="w-full max-w-xl"
      />

      <iframe
        v-else-if="preview.kind === 'pdf' && preview.url"
        :src="preview.url"
        class="h-full w-full max-w-5xl rounded bg-white"
        title="PDF preview"
      />

      <div v-else class="text-sm text-white/70">Preview not available. Use Download.</div>
    </div>
  </div>
</template>
