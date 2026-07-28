import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

export default defineConfig({
  site: 'https://cartapel.com',
  output: 'static',
  build: { inlineStylesheets: 'always' },
  integrations: [sitemap()],
})
