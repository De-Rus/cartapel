import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

export default defineConfig({
  site: 'https://cartapel.com',
  output: 'static',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'always' },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/404'),
      serialize(item) {
        const path = new URL(item.url).pathname
        if (path === '/compare/' || path === '/compare') {
          return {
            ...item,
            changefreq: 'monthly',
            priority: 0.9,
            lastmod: new Date().toISOString(),
          }
        }
        if (path === '/' || path === '') {
          return {
            ...item,
            changefreq: 'weekly',
            priority: 1.0,
            lastmod: new Date().toISOString(),
          }
        }
        return {
          ...item,
          changefreq: 'monthly',
          priority: 0.7,
          lastmod: new Date().toISOString(),
        }
      },
    }),
  ],
})
