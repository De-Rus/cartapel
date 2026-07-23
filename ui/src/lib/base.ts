// The URL prefix the panel is mounted under, as a single source of truth.
//
// It is derived from Vite's `base` (`import.meta.env.BASE_URL`, e.g. "/admin/").
// To serve the panel under a different prefix, change `base` in vite.config.ts
// AND pass the server the matching `--base-path` / `STEWARD_BASE_PATH`. An empty
// string means the panel is served at the root.
export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '')
