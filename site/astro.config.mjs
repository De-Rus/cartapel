import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://cartapel.com',
  output: 'static',
  build: { inlineStylesheets: 'always' },
})
