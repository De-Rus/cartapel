import { defineConfig } from 'vitepress'

const SITE = process.env.DOCS_SITE || 'https://de-rus.github.io/cartapel/'

export default defineConfig({
  // GitHub Pages project site serves under /cartapel/. Override with DOCS_BASE=/
  // when deploying to a custom domain (root).
  base: process.env.DOCS_BASE || '/cartapel/',
  title: 'cartapel',
  titleTemplate: ':title · cartapel — database admin panel',
  description:
    'Open-source, single-binary admin panel for your existing Postgres, MySQL or MariaDB. A Django-admin alternative in one Rust binary: introspected CRUD, roles, audit and dashboards, configured with HCL you version like code.',
  lang: 'en-US',
  cleanUrls: true,
  // A contributor doc (repo layout, local dev commands), not a page for
  // readers of the published site — it was building to a live, unlinked
  // /README on both hosts and getting into the sitemap.
  srcExclude: ['README.md'],
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  lastUpdated: true,
  appearance: 'dark',
  sitemap: { hostname: SITE },

  head: [
    ['meta', { name: 'theme-color', content: '#f59e0b' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'cartapel' }],
    ['meta', { property: 'og:title', content: 'cartapel — an admin panel for your existing database' }],
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
        name: 'cartapel',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS, Docker',
        description:
          'Open-source, single-binary admin panel for PostgreSQL, MySQL and MariaDB — introspected CRUD, roles, audit log and SQL dashboards, configured as code.',
        license: 'https://opensource.org/licenses/MIT',
        url: SITE,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        codeRepository: 'https://github.com/De-Rus/cartapel',
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

  // robots.txt has to be generated, not shipped as a static asset: the same
  // build output is published to two hosts, and a hard-coded Sitemap line meant
  // the canonical site advertised its mirror's sitemap.
  async buildEnd(config) {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(
      join(config.outDir, 'robots.txt'),
      `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`,
    )
  },

  transformPageData(pageData) {
    const path = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')
    // A page may point its canonical elsewhere — comparisons.md is a summary of
    // the fuller comparison on cartapel.com and must not compete with it.
    const canonical = (pageData.frontmatter.canonical as string | undefined) ?? SITE + path
    // The root page sets its own title/titleTemplate (see index.md's frontmatter)
    // for the <title> tag; this only controls the social-preview og:title, which
    // wants the fuller marketing line regardless of what the tab shows.
    const title = path === '' ? 'cartapel — database admin panel' : `${pageData.title} · cartapel`
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
    logo: {
      light: '/logo-mark-light.png',
      dark: '/logo-mark.png',
    },

    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Configuration', link: '/configuration/overview' },
      { text: 'Deploy', link: '/deployment' },
      { text: 'Live demo', link: 'https://demo.cartapel.com' },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Getting started', link: '/getting-started' },
          { text: 'vs the alternatives', link: '/comparisons' },
          { text: 'CLI & environment', link: '/cli' },
        ],
      },
      {
        text: 'Basics',
        collapsed: false,
        items: [
          { text: 'Configuration layout', link: '/configuration/overview' },
          { text: 'Data sources', link: '/configuration/sources' },
          { text: 'Uploads & file storage', link: '/configuration/uploads' },
          { text: 'Tables & lists', link: '/configuration/tables' },
          { text: 'Detail views', link: '/configuration/detail-views' },
          { text: 'Groups & navigation', link: '/configuration/groups-and-nav' },
          { text: 'Dashboard', link: '/configuration/dashboard' },
          { text: 'Panel types', link: '/configuration/panel-types' },
          { text: 'Grafana panels', link: '/configuration/grafana-panels' },
        ],
      },
      {
        text: 'Advanced',
        collapsed: false,
        items: [
          { text: 'Fields & widgets', link: '/configuration/fields-and-widgets' },
          { text: 'Widgets', link: '/configuration/widgets' },
          { text: 'Remote fields', link: '/configuration/remote-fields' },
          { text: 'Pages & queries', link: '/configuration/pages-and-queries' },
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

    // h3s used to all list in the right rail too — on a page with several
    // widget-category subsections that made "On this page" longer than some
    // pages' actual content. h2 only; h3s stay as in-page anchors, just not
    // in the outline.
    outline: { level: 2, label: 'On this page' },

    search: { provider: 'local' },

    socialLinks: [{ icon: 'github', link: 'https://github.com/de-rus/cartapel' }],

    editLink: {
      pattern: 'https://github.com/De-Rus/cartapel/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'cartapel — an admin panel for your existing database.',
    },
  },
})
