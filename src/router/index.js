import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { hasStoredSession } from '@/lib/telegram/session'

const routes = [
  { path: '/', redirect: '/drive' },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/drive',
    name: 'drive',
    component: () => import('@/views/DriveView.vue'),
  },
  {
    path: '/vault',
    name: 'vault',
    component: () => import('@/views/VaultView.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { public: true },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  const hadSession = hasStoredSession()

  if (!auth.status || auth.status === 'idle') {
    const initPromise = auth.init()
    // If a session is stored, don't flash the login page on refresh while
    // restore runs in the background. Protected views handle the loading state.
    if (hadSession) {
      initPromise.catch(() => {})
    } else {
      await initPromise
    }
  }

  if (to.meta.public) {
    if (to.name === 'login' && auth.isAuthorized) return { name: 'drive' }
    return true
  }

  if (!auth.isAuthorized) {
    // Allow background restore/retry when a session is still present.
    if (hasStoredSession()) return true
    return { name: 'login', query: to.fullPath === '/drive' ? {} : { next: to.fullPath } }
  }

  return true
})

export default router
