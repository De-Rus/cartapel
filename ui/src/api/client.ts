import type {
  AccessUser,
  ActionResult,
  AuditResponse,
  BulkResult,
  ConfigGet,
  ConfigPublishResult,
  ConfigPut,
  ConfigPutBody,
  ConfigVersionBody,
  ConfigVersionsResponse,
  CreateGroupBody,
  DashboardConfigGet,
  DashboardPreviewResult,
  DashboardResponse,
  DashboardVersionBody,
  DiscoverResponse,
  GroupLayoutBody,
  GroupsLayout,
  GroupWrite,
  ImportResult,
  InlinePageResponse,
  ListResponse,
  Meta,
  OptionItem,
  PatchGroupBody,
  RoleDefinition,
  RolesResponse,
  RoleWrite,
  Row,
  RowResponse,
  SavedView,
  SavedViewsResponse,
  SearchResponse,
  User,
  WidgetConfigData,
} from './types'
import { BASE } from '../lib/base'

const API_BASE = `${BASE}/api`
export const MOCK = !!import.meta.env.VITE_MOCK

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const MOCK_IMG_COLORS = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926']

function mockImageUrl(table: string, col: string, pk: string, label?: string): string {
  let h = 0
  for (const c of `${table}/${col}/${pk}`) h = (h * 31 + c.charCodeAt(0)) >>> 0
  if (h % 7 === 0) return 'data:,'
  const color = MOCK_IMG_COLORS[h % MOCK_IMG_COLORS.length]
  const letters = (label || pk).slice(0, 2).toUpperCase()
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='14' fill='${color}' fill-opacity='0.9'/><text x='32' y='41' font-family='system-ui' font-size='24' font-weight='600' fill='white' text-anchor='middle'>${letters}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function imageUrl(
  table: string,
  col: string,
  pk: string,
  bust?: string | number,
  label?: string,
): string {
  if (MOCK) return mockImageUrl(table, col, pk, label)
  const q = bust !== undefined && bust !== '' ? `?v=${encodeURIComponent(String(bust))}` : ''
  return `${API_BASE}/t/${table}/image/${col}/${encodeURIComponent(pk)}${q}`
}

export async function uploadImage(
  table: string,
  col: string,
  pk: string,
  file: File,
): Promise<{ ok: boolean; bytes: number }> {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 600))
    if (!file.type.startsWith('image/')) throw new ApiError(400, 'el archivo no es una imagen')
    return { ok: true, bytes: file.size }
  }
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${API_BASE}/t/${table}/image/${col}/${encodeURIComponent(pk)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Steward': '1' },
    body: fd,
  })
  if (res.status === 401) {
    if (!window.location.pathname.endsWith('/login')) window.location.assign(`${BASE}/login`)
    throw new ApiError(401, 'sesión expirada')
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
  return data as { ok: boolean; bytes: number }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (MOCK) {
    const { mockRequest } = await import('./mock')
    return mockRequest(method, path, body) as Promise<T>
  }
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') headers['X-Steward'] = '1'
  const res = await fetch(API_BASE + path, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (!window.location.pathname.endsWith('/login')) {
      window.location.assign(`${BASE}/login`)
    }
    throw new ApiError(401, 'sesión expirada')
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
  return data as T
}

export const api = {
  login: (email: string, password: string) =>
    request<User>('POST', '/auth/login', { email, password }),
  logout: () => request<Record<string, never>>('POST', '/auth/logout', {}),
  me: () => request<User>('GET', '/me'),
  meta: () => request<Meta>('GET', '/meta'),
  branding: () => request<Partial<Meta>>('GET', '/public'),
  dashboard: () => request<DashboardResponse>('GET', '/dashboard'),
  pageWidgets: (id: string) =>
    request<DashboardResponse>('GET', `/dash/${id.split('/').map(encodeURIComponent).join('/')}`),
  list: (table: string, qs: string) => request<ListResponse>('GET', `/t/${table}?${qs}`),
  row: (table: string, pk: string) =>
    request<RowResponse>('GET', `/t/${table}/r/${encodeURIComponent(pk)}`),
  inlinePage: (table: string, pk: string, child: string, page: number) =>
    request<InlinePageResponse>(
      'GET',
      `/t/${table}/r/${encodeURIComponent(pk)}/inline/${child}?page=${page}`,
    ),
  patch: (table: string, pk: string, set: Row) =>
    request<{ row: Row }>('PATCH', `/t/${table}/r/${encodeURIComponent(pk)}`, { set }),
  create: (table: string, set: Row) => request<{ row: Row }>('POST', `/t/${table}`, { set }),
  remove: (table: string, pk: string) =>
    request<Record<string, never>>('DELETE', `/t/${table}/r/${encodeURIComponent(pk)}`),
  options: (table: string, col: string, q: string) =>
    request<OptionItem[]>('GET', `/t/${table}/options/${col}?q=${encodeURIComponent(q)}`),
  action: (table: string, name: string, pks: Array<string | number>) =>
    request<ActionResult>('POST', `/t/${table}/action/${name}`, { pks }),
  bulk: (table: string, pks: Array<string | number>, set: Row) =>
    request<BulkResult>('POST', `/t/${table}/bulk`, { pks, set }),
  import: (
    table: string,
    format: 'csv' | 'json',
    data: string,
    mode: 'insert' | 'upsert',
  ) => request<ImportResult>('POST', `/t/${table}/import`, { format, data, mode }),
  audit: (qs: string) => request<AuditResponse>('GET', `/audit?${qs}`),
  rowAudit: (table: string, pk: string) =>
    request<AuditResponse>('GET', `/t/${table}/r/${encodeURIComponent(pk)}/audit`),
  search: (q: string) =>
    request<SearchResponse>('GET', `/search?q=${encodeURIComponent(q)}`),
  views: (table: string) => request<SavedViewsResponse>('GET', `/views?table=${encodeURIComponent(table)}`),
  createView: (v: { table: string; name: string; query: string; shared: boolean }) =>
    request<{ id: number }>('POST', '/views', v),
  deleteView: (id: number) => request<Record<string, never>>('DELETE', `/views/${id}`),

  users: () => request<AccessUser[]>('GET', '/users'),
  createUser: (b: { email: string; password: string; role: string }) =>
    request<AccessUser>('POST', '/users', b),
  updateUser: (id: number, b: { role?: string; password?: string }) =>
    request<AccessUser>('PATCH', `/users/${id}`, b),
  deleteUser: (id: number) => request<Record<string, never>>('DELETE', `/users/${id}`),

  getConfig: (table: string) => request<ConfigGet>('GET', `/config/${table}`),
  putConfig: (table: string, body: ConfigPutBody) =>
    request<ConfigPut>('PUT', `/config/${table}`, body),
  configVersions: (table: string) =>
    request<ConfigVersionsResponse>('GET', `/config/${table}/versions`),
  configVersion: (table: string, id: number) =>
    request<ConfigVersionBody>('GET', `/config/${table}/versions/${id}`),
  publishConfigVersion: (table: string, id: number) =>
    request<ConfigPublishResult>('POST', `/config/${table}/versions/${id}/publish`),

  groups: () => request<GroupsLayout>('GET', '/config/groups'),
  createGroup: (b: CreateGroupBody) => request<GroupWrite>('POST', '/config/groups', b),
  patchGroup: (slug: string, b: PatchGroupBody) =>
    request<GroupWrite>('PATCH', `/config/groups/${encodeURIComponent(slug)}`, b),
  renameGroup: (slug: string, to: string) =>
    request<GroupWrite>('POST', `/config/groups/${encodeURIComponent(slug)}/rename`, { to }),
  deleteGroup: (slug: string) =>
    request<GroupWrite>('DELETE', `/config/groups/${encodeURIComponent(slug)}`),
  putGroupLayout: (body: GroupLayoutBody) => request<GroupWrite>('POST', '/config/groups/layout', body),

  dashboardConfig: () => request<DashboardConfigGet>('GET', '/config/dashboard'),
  putDashboardConfig: (widgets: WidgetConfigData[], columns?: number) =>
    request<ConfigPut>('PUT', '/config/dashboard', { widgets, columns }),
  dashboardPreview: (widget: WidgetConfigData) =>
    request<DashboardPreviewResult>('POST', '/config/dashboard/preview', { widget }),
  dashboardVersions: () => request<ConfigVersionsResponse>('GET', '/config/dashboard/versions'),
  dashboardVersion: (id: number) =>
    request<DashboardVersionBody>('GET', `/config/dashboard/versions/${id}`),
  publishDashboardVersion: (id: number) =>
    request<ConfigPublishResult>('POST', `/config/dashboard/versions/${id}/publish`),

  discover: () => request<DiscoverResponse>('GET', '/config/discover'),

  roles: () => request<RolesResponse>('GET', '/roles'),
  createRole: (b: { name: string; definition: RoleDefinition }) =>
    request<RoleWrite>('POST', '/roles', b),
  updateRole: (name: string, definition: RoleDefinition) =>
    request<RoleWrite>('PATCH', `/roles/${encodeURIComponent(name)}`, { definition }),
  deleteRole: (name: string) =>
    request<RoleWrite>('DELETE', `/roles/${encodeURIComponent(name)}`),
}

export function exportUrl(table: string, format: 'csv' | 'json', qs: string): string {
  const sep = qs ? `&` : ''
  return `${API_BASE}/t/${table}/export?format=${format}${sep}${qs}`
}

export async function downloadExport(
  table: string,
  format: 'csv' | 'json',
  qs: string,
): Promise<void> {
  if (MOCK) {
    const { mockExport } = await import('./mock')
    const { body, filename, mime } = mockExport(table, format, qs)
    const blob = new Blob([body], { type: mime })
    triggerDownload(blob, filename)
    return
  }
  const res = await fetch(exportUrl(table, format, qs), {
    method: 'GET',
    credentials: 'include',
  })
  if (!res.ok) throw new ApiError(res.status, res.statusText)
  const blob = await res.blob()
  triggerDownload(blob, `${table}.${format}`)
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export type { SavedView }
