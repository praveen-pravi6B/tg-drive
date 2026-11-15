import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

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
    path: '/debug',
    name: 'debug',
    component: () => import('@/views/DebugView.vue'),
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

  if (!auth.status || auth.status === 'idle') {
    await auth.init()
  }

  if (to.meta.public) {
    if (to.name === 'login' && auth.isAuthorized) return { name: 'drive' }
    return true
  }

  if (!auth.isAuthorized) {
    return { name: 'login', query: to.fullPath === '/drive' ? {} : { next: to.fullPath } }
  }

  return true
})

export default router
