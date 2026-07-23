import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// base is '/' so assets are referenced from the root, independent of the mount
// path; the panel's mount prefix is injected at RUNTIME (see src/lib/base.ts).
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8686',
        changeOrigin: true,
      },
    },
  },
  test: {
    setupFiles: ['./src/test-setup.ts'],
  },
})
