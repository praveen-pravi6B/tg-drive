import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    vue(),
    // GramJS is written for Node and imports builtins such as crypto, util,
    // stream and events. These need real browser implementations, not Vite's
    // empty externals.
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    // GramJS and a few of its dependencies expect a Node-style global.
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['telegram', 'buffer', 'process/browser'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
  server: {
    port: 5173,
    host: true,
  },
})
