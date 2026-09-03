# cartapel documentation

These Markdown files are the **source of truth** for cartapel's documentation. A
[VitePress](https://vitepress.dev) site renders them into the published docs;
the prose lives here so it can be reviewed, diffed, and versioned like any other
part of the codebase.

## Layout

```
docs/
├── index.md                    # landing page / pitch / 60-second quickstart
├── getting-started.md          # install, first run, bootstrap admin
├── cli.md                      # cartapel serve / user add flags + env vars
├── comparisons.md              # vs Django admin, Retool, Metabase, Directus…
├── architecture.md             # the self-contained bundle, SQLite state, hot-reload
├── roles-and-permissions.md    # config/auth.hcl, the permission matrix
├── security.md                 # secret key, masking, row filters, path confinement
├── theming.md                  # presets, accent colors, design tokens
├── localization.md             # per-viewer language, built-in locales, i18n extract
├── deployment.md               # Docker, env, writable config volume, reverse proxy
├── configuration/
│   ├── overview.md             # HCL, folders = groups, config/
│   ├── sources.md              # Postgres, MySQL, ClickHouse, Grafana, files, S3, HTTP
│   ├── uploads.md              # image { } fields, the upload request, on-disk storage
│   ├── tables.md               # screen.hcl: list / display / detail / edit / permissions / actions
│   ├── fields-and-widgets.md   # the widget library, params, format, color, interpolation
│   ├── detail-views.md         # detail.mode, sections, sidebar, inlines
│   ├── groups-and-nav.md       # _group.hcl, ordering
│   ├── pages-and-queries.md    # pages, queries.hcl, custom widgets
│   └── dashboard.md            # config/dashboard.hcl widgets
└── .vitepress/config.mts       # site nav + theme
```

## Run the site locally

```bash
cd docs
npm install          # or pnpm install
npm run dev          # local dev server with hot reload
npm run build        # static build → .vitepress/dist
npm run preview      # serve the production build
```

If you have no local install, `npx vitepress build docs` (run from the repo
root) works too.

## Publishing

`.github/workflows/docs.yml` builds this site twice on every push to `main`
that touches `docs/**`:

- **<https://docs.cartapel.com/>** — the canonical docs, on Cloudflare Pages,
  built at the domain root (`DOCS_BASE=/`).
- **<https://de-rus.github.io/cartapel/>** — a mirror on GitHub Pages, served
  under `/cartapel/`. It is built with `DOCS_SITE` pointing at the canonical
  host, so its `<link rel="canonical">` and sitemap hand authority to
  docs.cartapel.com rather than competing with it for the same 19 pages.

`robots.txt` is generated per build from `DOCS_SITE` (see `buildEnd` in
`.vitepress/config.mts`) — as a static asset it was shipped to both hosts and
pointed the canonical site at the mirror's sitemap.
