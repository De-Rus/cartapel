# cartapel ui

Meta-driven SPA for the cartapel admin panel: every table, column, widget, filter,
action and permission is rendered from `GET /manage/api/meta` — nothing is
hardcoded per deployment. Vite + React 18 + TypeScript + Tailwind, hand-rolled
SVG charts, dark-first theming via CSS custom properties. The Rust binary embeds
`dist/` and serves it under the configured base path (`/manage` by default).

## Dev

```bash
pnpm install
pnpm dev         # proxies /manage/api → http://localhost:8686
pnpm dev:mock    # no backend needed — realistic in-memory fixtures (VITE_MOCK=1)
pnpm build       # tsc -b && vite build → dist/
pnpm test        # vitest run
```
