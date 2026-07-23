// The URL prefix the panel is mounted under — a single, RUNTIME source of truth.
//
// The server injects the live `--base-path` / `STEWARD_BASE_PATH` into the page
// as `window.__STEWARD_BASE__` (see index.html + the server's SPA handler), so a
// single build/image serves under any prefix — no rebuild to change it. In dev
// and tests the placeholder is never substituted, so it falls back to the root.
declare global {
  interface Window {
    __STEWARD_BASE__?: string
  }
}

const raw = typeof window !== 'undefined' ? window.__STEWARD_BASE__ : undefined
export const BASE = raw && !raw.includes('%') ? raw.replace(/\/+$/, '') : ''
