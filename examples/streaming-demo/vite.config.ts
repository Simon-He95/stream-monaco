import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      'stream-monaco': path.resolve(__dirname, '../../src'),
    },
  },
  // Prevent Vite from pre-bundling the local package. If Vite optimizes it into
  // node_modules/.vite/deps, relative worker URLs can be rewritten to that
  // location and may become unreachable. Excluding the package keeps it as
  // source so `new URL('./worker/..', import.meta.url)` resolves correctly.
  optimizeDeps: {
    exclude: ['stream-monaco'],
  },
})
