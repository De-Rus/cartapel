# steward documentation

These Markdown files are the **source of truth** for steward's documentation. A
[VitePress](https://vitepress.dev) site renders them into the published docs;
the prose lives here so it can be reviewed, diffed, and versioned like any other
part of the codebase.

## Layout

```
docs/
├── index.md                    # landing page / pitch / 60-second quickstart
├── getting-started.md          # install, first run, bootstrap admin
├── cli.md                      # steward serve / user add flags + env vars
├── architecture.md             # the self-contained bundle, SQLite state, hot-reload
├── roles-and-permissions.md    # config/auth.hcl, the permission matrix
├── security.md                 # secret key, masking, row filters, path confinement
├── deployment.md               # Docker, env, writable config volume, reverse proxy
├── configuration/
│   ├── overview.md             # HCL, folders = groups, config/
│   ├── tables.md               # screen.hcl: list / display / detail / edit / permissions / actions
│   ├── fields-and-widgets.md   # the widget library, params, format, color, interpolation
│   ├── detail-views.md         # detail.mode, sections, sidebar, inlines
│   ├── groups-and-nav.md       # _group.hcl, ordering
│   ├── pages-and-queries.md    # custom pages, queries.hcl, custom widgets
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

A GitHub Pages deploy workflow will be added when steward is extracted into its
own open-source repository. Until then the site is built and previewed locally
from this folder.
