import type { ConfigPut, RoleWrite, TableMeta } from '../api/types'

export type Json = unknown

/** One upload block covers image and generic-file fields alike — `widget =
 *  "image"` on the field is what makes it a photo (decoded/resized/re-encoded
 *  to PNG, with `max_px`/`normalize` as widget `params`, not here). */
export interface FileConfigData {
  dir: string
  storage?: string
  name_col?: string
  name_sql?: string
  write_to?: string
  write_key?: Record<string, string>
  write_defaults?: Record<string, string>
  max_bytes?: number
}

export interface FieldConfigData {
  label?: string
  widget?: string
  readonly?: boolean
  masked?: boolean
  sql?: string
  group?: string
  params?: Record<string, Json>
  file?: FileConfigData
}

export interface CustomFilterData {
  label: string
  sql: string
}

export interface ListConfigData {
  columns?: string[]
  search?: string[]
  filters?: string[]
  sort?: string
  per_page?: number
  filter_defs?: Record<string, CustomFilterData>
}

export interface DetailSectionData {
  title: string
  fields?: string[]
}

export interface DetailConfigData {
  mode?: string
  columns?: number
  tabs?: boolean
  stats?: string[]
  sidebar?: { fields?: string[] }
  sections?: DetailSectionData[]
}

export type InlineData = string | { table: string; fk_col?: string; label?: string }

export type ActionKindData = 'update' | 'delete' | 'webhook'

export interface ActionConfigData {
  label: string
  kind: ActionKindData
  url?: string
  method?: string
  confirm?: string
  danger?: boolean
  set?: Record<string, Json>
}

export interface PermissionsData {
  create?: boolean
  delete?: boolean
  write?: boolean
}

export interface TableConfigData {
  label?: string
  label_plural?: string
  list?: ListConfigData
  display?: { title?: string }
  detail?: DetailConfigData
  edit?: { readonly?: string[] }
  relations?: { inlines?: InlineData[] }
  permissions?: PermissionsData
  fields?: Record<string, FieldConfigData>
  actions?: Record<string, ActionConfigData>
}

export const WIDGETS = [
  'text',
  'textarea',
  'number',
  'toggle',
  'badge',
  'pill',
  'tags',
  'datetime',
  'relative_time',
  'json',
  'code',
  'money',
  'percent',
  'duration',
  'bytes',
  'progress',
  'rating',
  'trend',
  'heatcell',
  'link',
  'url',
  'email',
  'phone',
  'avatar',
  'color',
  'country',
  'flag',
  'copyable',
  'truncate',
  'uuid',
  'fk',
  'array',
  'masked',
  'image',
  'file',
] as const

export type Widget = (typeof WIDGETS)[number]

export const BADGE_COLORS = ['blue', 'green', 'orange', 'red', 'violet', 'gray'] as const
export type BadgeColor = (typeof BADGE_COLORS)[number]

export const ACTION_KINDS: ActionKindData[] = ['update', 'delete', 'webhook']

const PARAM_WIDGETS = new Set([
  'badge',
  'pill',
  'tags',
  'relative_time',
  'money',
  'code',
  'progress',
  'rating',
  'heatcell',
  'link',
  'url',
  'avatar',
  'truncate',
])

const STRUCTURED_EDITOR_WIDGETS = new Set(['badge', 'relative_time', 'money', 'code'])

/** Widgets that carry structured params (whether via a dedicated editor or JSON). */
export function widgetHasParams(widget: string | undefined): boolean {
  return !!widget && PARAM_WIDGETS.has(widget)
}

/** Widgets with a purpose-built param editor; the rest fall back to the JSON editor. */
export function widgetHasStructuredEditor(widget: string | undefined): boolean {
  return !!widget && STRUCTURED_EDITOR_WIDGETS.has(widget)
}

export function isCustomWidget(widget: string | undefined): boolean {
  return !!widget && widget.startsWith('custom:')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Drop empty leaves so the JSON we send mirrors the Rust `skip_serializing_if`
 * rules: no `undefined`/`null`, no empty strings, no empty arrays/objects. A
 * `false` boolean is meaningful and kept.
 */
export function prune(value: Json): Json {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value === '' ? undefined : value
  if (Array.isArray(value)) {
    const arr = value.map(prune).filter((v) => v !== undefined)
    return arr.length ? arr : undefined
  }
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value)) {
      const pv = prune(v)
      if (pv !== undefined) out[k] = pv
    }
    return Object.keys(out).length ? out : undefined
  }
  return value
}

function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => jsonEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => k in b && jsonEqual(a[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

/**
 * Compare two visual models by their pruned API form so cosmetic empties (an
 * empty array vs an absent one) never register as a change.
 */
export function modelChanged(a: TableConfigData, b: TableConfigData): boolean {
  return !jsonEqual(modelToApi(a) as Json, modelToApi(b) as Json)
}

/**
 * Hydrate the editor model from the backend's structured `model` JSON. The
 * payload already mirrors `TableConfigData`, so there is nothing to parse — we
 * just adopt it (defaulting a missing/empty payload to an empty model).
 */
export function modelFromApi(model: unknown): TableConfigData {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return {}
  const src = model as Record<string, unknown>
  const m = { ...(model as TableConfigData) } as TableConfigData & Record<string, unknown>
  // The backend serializes with HCL block names (`field`/`action`/`filter_def`,
  // and `detail.section`); the visual model uses the plural/`*s` forms.
  if (src.field && !m.fields) m.fields = src.field as TableConfigData['fields']
  if (src.action && !m.actions) m.actions = src.action as TableConfigData['actions']
  delete m.field
  delete m.action
  if (m.list) {
    const l = m.list as ListConfigData & Record<string, unknown>
    if (l.filter_def && !l.filter_defs) l.filter_defs = l.filter_def as ListConfigData['filter_defs']
    delete l.filter_def
  }
  const d = src.detail
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const { section, sections, ...rest } = d as Record<string, unknown>
    m.detail = {
      ...(rest as DetailConfigData),
      ...(section || sections ? { sections: (section ?? sections) as DetailSectionData[] } : {}),
    }
  }
  return m
}

/**
 * Produce the JSON to send as `{ model }`. The backend owns HCL serialization,
 * so we only strip empty leaves to match its `skip_serializing_if` semantics.
 */
export function modelToApi(data: TableConfigData): TableConfigData {
  const pruned = (prune(data as Json) ?? {}) as TableConfigData & Record<string, unknown>
  // Inverse of modelFromApi: emit the backend's HCL block names.
  if (pruned.fields) {
    pruned.field = pruned.fields
    delete pruned.fields
  }
  if (pruned.actions) {
    pruned.action = pruned.actions
    delete pruned.actions
  }
  if (pruned.list) {
    const l = pruned.list as ListConfigData & Record<string, unknown>
    if (l.filter_defs) {
      l.filter_def = l.filter_defs
      delete l.filter_defs
    }
  }
  if (pruned.detail && typeof pruned.detail === 'object' && 'sections' in (pruned.detail as object)) {
    const { sections, ...rest } = pruned.detail as Record<string, unknown>
    pruned.detail = { ...rest, ...(sections ? { section: sections } : {}) } as DetailConfigData
  }
  return pruned
}

/**
 * Derive a rich, editable model from a table's live meta. Used both to seed the
 * mock GET template and as a fallback when the server returns a bare config.
 */
export function modelFromMeta(meta: TableMeta): TableConfigData {
  const fields: Record<string, FieldConfigData> = {}
  for (const c of meta.columns) {
    const fc: FieldConfigData = {}
    if (c.label) fc.label = c.label
    if (c.widget && c.widget !== 'text') fc.widget = c.widget
    if (c.readonly) fc.readonly = true
    if (c.masked) fc.masked = true
    if (c.params && Object.keys(c.params).length) fc.params = { ...(c.params as Record<string, Json>) }
    if (Object.keys(fc).length) fields[c.name] = fc
  }

  const actions: Record<string, ActionConfigData> = {}
  for (const a of meta.actions) {
    const ac: ActionConfigData = {
      label: a.label,
      kind: (ACTION_KINDS.includes(a.kind as ActionKindData) ? a.kind : 'update') as ActionKindData,
    }
    if (a.confirm) ac.confirm = a.confirm
    if (a.danger) ac.danger = true
    actions[a.name] = ac
  }

  const model: TableConfigData = {
    label: meta.label,
    label_plural: meta.label_plural,
    list: {
      columns: meta.list.columns,
      search: meta.list.search,
      filters: meta.list.filters.map((f) => f.name),
      sort: meta.list.default_sort,
      per_page: meta.list.per_page,
    },
    display: { title: meta.display_title },
    detail: {
      mode: meta.detail?.mode ?? undefined,
      columns: meta.detail?.columns ?? undefined,
      tabs: meta.detail?.tabs || undefined,
      stats: meta.detail?.stats?.length ? meta.detail.stats : undefined,
      sidebar: meta.detail?.sidebar?.fields?.length ? { fields: meta.detail.sidebar.fields } : undefined,
      sections: meta.sections?.map((s) => ({ title: s.title, fields: s.fields })),
    },
    permissions: {
      create: meta.perms.create,
      write: meta.perms.write,
      delete: meta.perms.delete,
    },
    fields: Object.keys(fields).length ? fields : undefined,
    actions: Object.keys(actions).length ? actions : undefined,
  }
  return model
}

/**
 * A successful PUT either hot-reloaded the live config (`applied`) or the config
 * dir is read-only, so nothing was written and the validated HCL comes back for
 * the user to commit to their repo (`readonly`).
 */
export type SaveOutcome = { kind: 'applied' } | { kind: 'readonly'; hcl: string }

export function interpretPut(res: ConfigPut | RoleWrite): SaveOutcome {
  return res.ok ? { kind: 'applied' } : { kind: 'readonly', hcl: res.hcl }
}

/** The full column vocabulary for a table (real + computed), preserving order. */
export function allColumnNames(meta: TableMeta): string[] {
  return meta.columns.map((c) => c.name)
}

/** Normalize an inline entry to its long form for editing. */
export function inlineTable(i: InlineData): string {
  return typeof i === 'string' ? i : i.table
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list
  const next = [...list]
  const [m] = next.splice(from, 1)
  next.splice(to, 0, m)
  return next
}

/** Read a numeric param, tolerating string values from the config payload. */
export function numParam(params: Record<string, Json> | undefined, key: string): number | undefined {
  const v = params?.[key]
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return undefined
}

export function strParam(params: Record<string, Json> | undefined, key: string): string | undefined {
  const v = params?.[key]
  return typeof v === 'string' ? v : undefined
}

/** Badge value→color map from params.colors, tolerating shapes. */
export function badgeColors(params: Record<string, Json> | undefined): Record<string, string> {
  const c = params?.colors
  if (isPlainObject(c)) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(c)) if (typeof v === 'string') out[k] = v
    return out
  }
  return {}
}

/** Immutably set (or clear) a single param key on a field's params map. */
export function withParam(
  params: Record<string, Json> | undefined,
  key: string,
  value: Json,
): Record<string, Json> | undefined {
  const next: Record<string, Json> = { ...(params ?? {}) }
  if (value === undefined || value === '' || value === null) delete next[key]
  else next[key] = value
  return Object.keys(next).length ? next : undefined
}
