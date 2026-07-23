import { defineConfig } from 'vitepress'

export default defineConfig({
  // GitHub Pages project site serves under /steward/. Override with DOCS_BASE=/
  // when deploying to a custom domain (root).
  base: process.env.DOCS_BASE || '/steward/',
  title: 'steward',
  description:
    'A single-binary, code-first admin panel for your existing Postgres. Point the Rust binary at your database and get introspected CRUD, configured with HCL you version like code.',
  lang: 'en-US',
  cleanUrls: true,
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  lastUpdated: true,
  appearance: 'dark',

  head: [['meta', { name: 'theme-color', content: '#f59e0b' }]],

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
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is steward?', link: '/' },
          { text: 'Getting started', link: '/getting-started' },
          { text: 'CLI & environment', link: '/cli' },
        ],
      },
      {
        text: 'Configuration',
        collapsed: false,
        items: [
          { text: 'Overview', link: '/configuration/overview' },
          { text: 'Tables', link: '/configuration/tables' },
          { text: 'Fields & widgets', link: '/configuration/fields-and-widgets' },
          { text: 'Detail views', link: '/configuration/detail-views' },
          { text: 'Groups & navigation', link: '/configuration/groups-and-nav' },
          { text: 'Pages & queries', link: '/configuration/pages-and-queries' },
          { text: 'Dashboard', link: '/configuration/dashboard' },
        ],
      },
      {
        text: 'Access & security',
        items: [
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

    socialLinks: [{ icon: 'github', link: 'https://github.com/' }],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'steward — an admin panel for your existing Postgres.',
    },
  },
})
