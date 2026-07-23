import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    proxy: {
      '/admin/api': {
        target: 'http://localhost:8686',
        changeOrigin: true,
      },
    },
  },
})
