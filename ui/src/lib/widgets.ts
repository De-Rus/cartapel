import { ApiError, MOCK } from '../api/client'

import { BASE } from './base'
const API_BASE = `${BASE}/api`

export interface WidgetApi {
  get(path: string): Promise<unknown>
  post(path: string, body?: unknown): Promise<unknown>
}

async function apiFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const clean = path.replace(/^\/+/, '')
  const headers: Record<string, string> = { 'X-Cartapel': '1' }
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

export function loadWidgetModule(moduleFile: string): Promise<void> {
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
    const script = document.createElement('script')
    script.type = 'module'
    script.src = url
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`failed to load ${url}`))
    document.head.appendChild(script)
  })
  moduleCache.set(
    moduleFile,
    p.catch((e) => {
      moduleCache.delete(moduleFile)
      throw e
    }),
  )
  return moduleCache.get(moduleFile) as Promise<void>
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
