import { ApiError, MOCK } from '../api/client'

import { BASE } from './base'
const API_BASE = `${BASE}/api`

export interface WidgetApi {
  get(path: string): Promise<unknown>
  post(path: string, body?: unknown): Promise<unknown>
}

async function apiFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const clean = path.replace(/^\/+/, '')
  const headers: Record<string, string> = { 'X-Steward': '1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_BASE}/${clean}`, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    if (!window.location.pathname.endsWith('/login')) window.location.assign(`${BASE}/login`)
    throw new ApiError(401, 'unauthorized')
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : res.statusText
    throw new ApiError(res.status, msg)
  }
  return data
}

export const widgetApi: WidgetApi = {
  get: (path) => apiFetch('GET', path),
  post: (path, body) => apiFetch('POST', path, body),
}

const moduleCache = new Map<string, Promise<void>>()

const CACHE_BUST = Date.now()

export function widgetModuleUrl(moduleFile: string): string {
  return `${BASE}/static/${moduleFile}?v=${CACHE_BUST}`
}

export function loadWidgetModule(moduleFile: string, pageSlug?: string): Promise<void> {
  const existing = moduleCache.get(moduleFile)
  if (existing) return existing
  const url = widgetModuleUrl(moduleFile)
  const p = new Promise<void>((resolve, reject) => {
    if (MOCK) {
      import('./mockWidgets')
        .then((m) => {
          m.registerMockModule(moduleFile)
          resolve()
        })
        .catch(reject)
      return
    }
    if (/\.tsx?$/.test(moduleFile)) {
      loadTsxModule(url, pageSlug).then(resolve).catch(reject)
      return
    }
    const script = document.createElement('script')
    script.type = 'module'
    script.src = url
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`failed to load ${url}`))
    document.head.appendChild(script)
  })
  moduleCache.set(moduleFile, p)
  return p
}

/** TSX/TS page modules: fetched as source, transpiled in the browser (sucrase,
 *  lazy chunk), executed with every `sx` export in scope — pages write plain
 *  typed JSX with zero imports and `export default` their component. */
async function loadTsxModule(url: string, pageSlug?: string): Promise<void> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`failed to load ${url}`)
  const source = await res.text()
  const { transform } = await import('sucrase')
  const sx = (window as unknown as { sx: Record<string, unknown> }).sx
  const prelude = `const {${Object.keys(sx).join(',')}} = window.sx;\n`
  const { code } = transform(source, {
    transforms: ['typescript', 'jsx'],
    jsxPragma: 'h',
    jsxFragmentPragma: 'Fragment',
    production: true,
  })
  const blobUrl = URL.createObjectURL(new Blob([prelude + code], { type: 'text/javascript' }))
  try {
    const mod = (await import(/* @vite-ignore */ blobUrl)) as { default?: unknown }
    if (pageSlug && typeof mod.default === 'function') {
      ;(sx.definePage as (slug: string, c: unknown) => void)(pageSlug, mod.default)
    }
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

export function widgetElementName(name: string): string {
  return `sx-widget-${name}`
}

export function pageElementName(slug: string): string {
  return `sx-page-${slug.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
}

export function customWidgetName(widget: string): string | null {
  return widget.startsWith('custom:') ? widget.slice('custom:'.length) : null
}
