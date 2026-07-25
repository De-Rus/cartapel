import { defineConfig } from 'vitepress'

const SITE = 'https://de-rus.github.io/steward/'

export default defineConfig({
  // GitHub Pages project site serves under /steward/. Override with DOCS_BASE=/
  // when deploying to a custom domain (root).
  base: process.env.DOCS_BASE || '/steward/',
  title: 'steward',
  titleTemplate: ':title · steward — Postgres admin panel',
  description:
    'Open-source, single-binary admin panel for your existing Postgres. A Django-admin alternative in one Rust binary: introspected CRUD, roles, audit and dashboards, configured with HCL you version like code.',
  lang: 'en-US',
  cleanUrls: true,
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  lastUpdated: true,
  appearance: 'dark',
  sitemap: { hostname: SITE },

  head: [
    ['meta', { name: 'theme-color', content: '#f59e0b' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'steward' }],
    ['meta', { property: 'og:title', content: 'steward — an admin panel for your existing Postgres' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'One Rust binary, config as code. Introspected CRUD, roles, audit log and SQL dashboards for any Postgres database.',
      },
    ],
    ['meta', { property: 'og:url', content: SITE }],
    ['meta', { property: 'og:image', content: `${SITE}og.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE}og.png` }],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'steward',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS, Docker',
        description:
          'Open-source, single-binary admin panel for PostgreSQL — introspected CRUD, roles, audit log and SQL dashboards, configured as code.',
        license: 'https://opensource.org/licenses/MIT',
        url: SITE,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        codeRepository: 'https://github.com/De-Rus/steward',
      }),
    ],
    [
      'meta',
      {
        name: 'keywords',
        content:
          'postgres admin panel, django admin alternative, database admin ui, rust admin panel, retool alternative, open source admin panel, postgres crud',
      },
    ],
  ],

  transformPageData(pageData) {
    const path = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')
    const canonical = SITE + path
    const title = pageData.frontmatter.layout === 'home' ? 'steward — Postgres admin panel' : `${pageData.title} · steward`
    pageData.frontmatter.head ??= []
    pageData.frontmatter.head.push(
      ['link', { rel: 'canonical', href: canonical }],
      ['meta', { property: 'og:title', content: title }],
      ...(pageData.description
        ? [['meta', { property: 'og:description', content: pageData.description }] as [string, Record<string, string>]]
        : []),
    )
  },

  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    languages: ['hcl', 'bash', 'rust', 'sql', 'json', 'toml'],
    lineNumbers: false,
  },

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Configuration', link: '/configuration/overview' },
      { text: 'Deploy', link: '/deployment' },
      { text: 'Live demo (demo/demo)', link: 'https://steward-demo-derus.fly.dev' },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'What is steward?', link: '/' },
          { text: 'Getting started', link: '/getting-started' },
          { text: 'CLI & environment', link: '/cli' },
        ],
      },
      {
        text: 'Basics',
        collapsed: false,
        items: [
          { text: 'Configuration layout', link: '/configuration/overview' },
          { text: 'Tables & lists', link: '/configuration/tables' },
          { text: 'Detail views', link: '/configuration/detail-views' },
          { text: 'Groups & navigation', link: '/configuration/groups-and-nav' },
          { text: 'Dashboard', link: '/configuration/dashboard' },
        ],
      },
      {
        text: 'Advanced',
        collapsed: false,
        items: [
          { text: 'Fields & widgets', link: '/configuration/fields-and-widgets' },
          { text: 'Custom pages & queries', link: '/configuration/pages-and-queries' },
          { text: 'Theming', link: '/theming' },
          { text: 'Localization', link: '/localization' },
          { text: 'Roles & permissions', link: '/roles-and-permissions' },
          { text: 'Security model', link: '/security' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Deployment', link: '/deployment' },
          { text: 'Architecture', link: '/architecture' },
        ],
      },
    ],

    outline: { level: [2, 3], label: 'On this page' },

    search: { provider: 'local' },

    socialLinks: [{ icon: 'github', link: 'https://github.com/de-rus/steward' }],

    editLink: {
      pattern: 'https://github.com/De-Rus/steward/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'steward — an admin panel for your existing Postgres.',
    },
  },
})
