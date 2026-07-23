// Tests run without the server's runtime base injection, so pin a stable mount
// prefix for URL-building assertions (see src/lib/base.ts).
const g = globalThis as unknown as { window?: { __STEWARD_BASE__?: string } }
g.window = g.window || {}
g.window.__STEWARD_BASE__ = '/admin'
