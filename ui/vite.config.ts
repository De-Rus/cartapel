import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// base is '/' so assets are referenced from the root, independent of the mount
// path; the panel's mount prefix is injected at RUNTIME (see src/lib/base.ts).
export default defineConfig({
  base: '/',
  // Asset URLs are resolved against the runtime mount prefix so ONE build serves
  // under any path — including a sub-path on a shared domain, where the proxy
  // only forwards `{base}/*` (assets must live under the prefix, not at the root).
  // JS-referenced assets (lazy chunks, workers) go through window.__stewardAsset;
  // the HTML entry is emitted root-absolute and the server rewrites it to
  // `{base}/assets/…` at serve time; CSS url()s stay relative to the stylesheet.
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === 'js') {
        return { runtime: `window.__stewardAsset(${JSON.stringify(filename)})` }
      }
      if (hostType === 'html') {
        return '/' + filename
      }
      return { relative: true }
    },
  },
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
