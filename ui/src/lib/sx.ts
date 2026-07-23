// The custom-page SDK — exposed globally as `window.sx` (see main.tsx), so a page
// module served from the config bundle uses it WITHOUT importing: pages are Preact
// components, no build step. `const { definePage, html, useQuery, Page, Stat } = sx`.
import { h, render, Fragment, type ComponentType } from 'preact'
import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks'
import htm from 'htm'
import { withBase } from './base'
import type { WidgetApi } from './widgets'

export const html = htm.bind(h)
export { h, render, Fragment, useState, useEffect, useMemo, useRef, useCallback }

export function toMs(t: unknown): number | null {
  if (t == null || t === '') return null
  if (typeof t === 'number' && Number.isFinite(t)) return t < 1e11 ? t * 1000 : t
  const p = Date.parse(String(t))
  return Number.isFinite(p) ? p : null
}

export const fmt = {
  num: (n: unknown) => (n == null ? '—' : (Number(n) || 0).toLocaleString()),
  compact: (n: unknown) =>
    n == null ? '—' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0),
  money(n: unknown, cur = '$') {
    if (n == null) return '—'
    const x = Number(n) || 0
    return `${x < 0 ? '-' : ''}${cur}${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) < 100 ? 2 : 0 })}`
  },
  pct: (v: unknown, d = 1) => (v == null ? '—' : `${(Number(v) * 100).toFixed(d)}%`),
  bytes(n: unknown) {
    let x = Number(n) || 0
    if (x < 1024) return `${x} B`
    const u = ['KB', 'MB', 'GB', 'TB']
    let i = -1
    do { x /= 1024; i++ } while (x >= 1024 && i < u.length - 1)
    return `${x.toFixed(x >= 100 ? 0 : 1)} ${u[i]}`
  },
  date(t: unknown) {
    const ms = toMs(t)
    return ms == null ? '—' : new Date(ms).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
  },
  datetime(t: unknown) {
    const ms = toMs(t)
    return ms == null
      ? '—'
      : new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  },
  hour(t: unknown) {
    const ms = toMs(t)
    return ms == null ? '—' : new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  },
  day(t: unknown) {
    const ms = toMs(t)
    return ms == null ? '—' : new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  },
  dur(s: unknown) {
    const x = Math.abs(Number(s) || 0)
    if (x < 60) return `${Math.round(x)}s`
    if (x < 3600) return `${Math.round(x / 60)}m`
    if (x < 86400) return `${Math.round(x / 3600)}h`
    return `${Math.round(x / 86400)}d`
  },
  rel(t: unknown) {
    const ms = toMs(t)
    if (ms == null) return '—'
    return `${fmt.dur((Date.now() - ms) / 1000)} ago`
  },
}

export interface Fetched {
  loading: boolean
  refreshing: boolean
  data: any
  rows: any[]
  error: string | null
  refetch: () => void
}
export interface FetchOpts { refreshMs?: number }

function useFetch(api: WidgetApi | undefined, path: string, opts: FetchOpts = {}): Fetched {
  const [tick, setTick] = useState(0)
  const refetch = useCallback(() => setTick((t) => t + 1), [])
  const [state, setState] = useState({ loading: true, refreshing: false, data: null as any, rows: [] as any[], error: null as string | null })
  const lastKey = useRef<string | null>(null)
  useEffect(() => {
    if (!api) return
    let done = false
    const keyChanged = lastKey.current !== path
    lastKey.current = path
    // Same-key refetch keeps stale data on screen (no skeleton flash); a key
    // change (new filters/sub-path) must not present the old dataset as current.
    setState((p) =>
      keyChanged
        ? { loading: true, refreshing: true, data: null, rows: [], error: null }
        : { ...p, loading: p.data == null && p.error == null, refreshing: true },
    )
    api.get(path)
      .then((d) => { if (!done) setState({ loading: false, refreshing: false, data: d, rows: (d as any)?.rows ?? [], error: null }) })
      .catch((e) => { if (!done) setState((p) => ({ loading: false, refreshing: false, data: p.data, rows: p.rows, error: String(e?.message ?? e) })) })
    return () => { done = true }
  }, [api, path, tick])
  useEffect(() => {
    if (!opts.refreshMs) return
    const id = setInterval(refetch, Math.max(2000, opts.refreshMs))
    return () => clearInterval(id)
  }, [opts.refreshMs, refetch])
  return { ...state, refetch }
}

const VAR_PREFIX = 'v_'
function readVarParams(search: string): string {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const out = new URLSearchParams()
  for (const [k, v] of p) if (k.startsWith(VAR_PREFIX)) out.set(k, v)
  return out.toString()
}
function withVars(path: string, vp: string): string {
  if (!vp) return path
  return `${path}${path.includes('?') ? '&' : '?'}${vp}`
}

/** The current `v_*` template-variable query string, re-rendering on any var
 *  change (URL is the single source of truth). Data hooks fold this in so a var
 *  change re-runs every query. */
export function useVarParams(): string {
  const get = () => readVarParams(window.location.search)
  const [v, setV] = useState(get)
  useEffect(() => {
    const sync = () => setV(get())
    window.addEventListener('popstate', sync)
    window.addEventListener(PARAM_EVENT, sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(PARAM_EVENT, sync)
    }
  }, [])
  return v
}

/** Read/write template-variable values, URL-backed and shareable:
 *  `const [vars, setVar] = useVars(); setVar("venue", "BINANCE")`. */
export function useVars(): [Record<string, string>, (name: string, value: string | null) => void] {
  const vp = useVarParams()
  const values: Record<string, string> = {}
  new URLSearchParams(vp).forEach((v, k) => { values[k.slice(VAR_PREFIX.length)] = v })
  const setVar = useCallback((name: string, value: string | null) => {
    const qs = writeParam(window.location.search, `${VAR_PREFIX}${name}`, value)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs}${window.location.hash}`)
    window.dispatchEvent(new Event(PARAM_EVENT))
  }, [])
  return [values, setVar]
}

export interface VarDef { name: string; label?: string; type?: string; kind?: string; default?: string | null; options: Array<{ value: string; label: string }> }

/** Fetch the in-scope template variables (server-resolved option sets). */
export function useMetaVars(api: WidgetApi | undefined): VarDef[] {
  const { data } = useFetch(api, 'meta')
  return ((data as any)?.variables ?? []) as VarDef[]
}

/** The URL-backed variable bar: one selector per template variable. Mount it at
 *  the top of a page and every `useQuery`/`useSource`/`useTable` below re-runs on
 *  change: `<${VarBar} api=${api} />`. */
export function VarBar({ api, only }: { api: WidgetApi | undefined; only?: string[] }) {
  const defs = useMetaVars(api)
  const [vars, setVar] = useVars()
  const shown = only ? defs.filter((d) => only.includes(d.name)) : defs
  if (!shown.length) return null
  return html`<div class="sx-varbar">${shown.map((d) => {
    const value = vars[d.name] ?? d.default ?? d.options[0]?.value ?? ''
    return html`<label class="sx-var"><span>${d.label ?? d.name}</span>
      <select value=${value} onChange=${(e: any) => setVar(d.name, e.target.value)}>
        ${d.options.map((o) => html`<option value=${o.value} selected=${String(o.value) === String(value)}>${o.label}</option>`)}
      </select></label>`
  })}</div>`
}

/** Fetch from a named `source` by alias (server-side proxy; tokens never reach the
 *  browser): `useSource(api, "cache_coverage")`. Optional sub-path + `{ refreshMs }`. */
export const useSource = (api: WidgetApi | undefined, alias: string, path = '', opts: FetchOpts = {}) =>
  useFetch(api, withVars(`source/${alias}${path ? `/${path.replace(/^\/+/, '')}` : ''}`, useVarParams()), opts)

/** Fetch a named SQL query: `useQuery(api, "name", { refreshMs: 30_000 })`. Current
 *  `v_*` template variables are folded in, so a var change re-runs the query. */
export const useQuery = (api: WidgetApi | undefined, name: string, opts: FetchOpts = {}) =>
  useFetch(api, withVars(`query/${name}`, useVarParams()), opts)

/** Fetch several named queries at once: `const q = useQueries(api, ["a","b"])` →
 *  `q.a.rows`, plus `q.$loading` / `q.$error` / `q.$refetch` across all of them.
 *  The names array must be stable for the life of the page (it maps to hooks). */
export function useQueries(api: WidgetApi | undefined, names: string[], opts: FetchOpts = {}) {
  const initialLen = useRef(names.length)
  if (names.length !== initialLen.current) throw new Error('useQueries: the names array must be stable across renders')
  const out: Record<string, Fetched> & { $loading?: boolean; $error?: string | null; $refetch?: () => void } = {} as any
  const each: Fetched[] = []
  for (const n of names) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const f = useQuery(api, n, opts)
    out[n] = f
    each.push(f)
  }
  out.$loading = each.some((f) => f.loading)
  out.$error = each.find((f) => f.error)?.error ?? null
  out.$refetch = () => each.forEach((f) => f.refetch())
  return out
}

/** Read rows from a steward-configured table with the backend's list API:
 *  `useTable(api, "bots", { pp: 50, sort: "-id", filters: { status: "running" } })`. */
export interface TableOpts extends FetchOpts { page?: number; pp?: number; sort?: string; q?: string; filters?: Record<string, string | number> }
export function useTable(api: WidgetApi | undefined, table: string, opts: TableOpts = {}) {
  const qs = new URLSearchParams()
  if (opts.page != null) qs.set('page', String(opts.page))
  if (opts.pp != null) qs.set('pp', String(opts.pp))
  if (opts.sort) qs.set('sort', opts.sort)
  if (opts.q) qs.set('q', opts.q)
  for (const [k, v] of Object.entries(opts.filters ?? {})) qs.set(`f_${k}`, String(v))
  const s = useFetch(api, withVars(`t/${table}?${qs.toString()}`, useVarParams()), opts)
  return { ...s, total: (s.data as any)?.total ?? 0 }
}

const META_FORMAT: Record<string, Col['format']> = {
  currency: 'money', money: 'money', percent: 'pct', pct: 'pct', number: 'num', num: 'num',
  bytes: 'bytes', duration: 'dur', dur: 'dur', date: 'date', datetime: 'datetime', rel: 'rel',
}

/** The meta descriptor of a steward-configured table (columns, list, pk). */
export function useMetaTable(api: WidgetApi | undefined, slug: string): any {
  const { data } = useFetch(api, 'meta')
  return ((data as any)?.tables ?? []).find((t: any) => t.name === slug) ?? null
}

/** Render a steward-configured table by its slug — the SAME columns, labels,
 *  formats and drill-down a `<slug>.hcl` describes, embeddable in any custom page:
 *  `<${AdminTable} api=${api} slug="bots" pp=${25} sort="-created" />`. This is the
 *  bridge that lets a screen mix auto-tables with bespoke `sx` UI. */
export function AdminTable({ api, slug, pp = 50, sort, cap }: { api: WidgetApi | undefined; slug: string; pp?: number; sort?: string; cap?: number }) {
  const meta = useMetaTable(api, slug)
  const t = useTable(api, slug, { pp, sort })
  if (!meta) return html`<div class="sx-card"><${Skeleton} h=${160} style="border-radius:12px" /></div>`
  const byName: Record<string, any> = {}
  for (const c of meta.columns ?? []) byName[c.name] = c
  const cols: Col[] = (meta.list?.columns ?? []).map((name: string) => {
    const c = byName[name] ?? { name, label: name }
    const col: Col = { key: name, label: c.label ?? name }
    if (c.format && META_FORMAT[c.format]) col.format = META_FORMAT[c.format]
    return col
  })
  const pk = meta.pk
  return html`<${DataTable} rows=${t.rows} cols=${cols} cap=${cap} loading=${t.loading} error=${t.error}
    link=${pk ? (row: any) => `${slug}/${encodeURIComponent(row[pk] ?? '')}` : undefined} />`
}

const PARAM_EVENT = 'sx:params'
export function readParam(search: string, key: string): string | null {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(key)
}
export function writeParam(search: string, key: string, value: string | null | undefined, def?: string): string {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  if (value == null || value === '' || value === def) p.delete(key)
  else p.set(key, value)
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** URL-backed page state — shareable and reload-proof:
 *  `const [tf, setTf] = useParam("tf", "1h")`. */
export function useParam(key: string, def = ''): [string, (v: string | null) => void] {
  const get = () => readParam(window.location.search, key) ?? def
  const [value, setValue] = useState(get)
  useEffect(() => {
    const sync = () => setValue(get())
    window.addEventListener('popstate', sync)
    window.addEventListener(PARAM_EVENT, sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(PARAM_EVENT, sync)
    }
  }, [key, def])
  const set = useCallback((v: string | null) => {
    const qs = writeParam(window.location.search, key, v, def)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs}${window.location.hash}`)
    window.dispatchEvent(new Event(PARAM_EVENT))
  }, [key, def])
  return [value, set]
}

export function hrefFor(link: string | ((row: any) => string), row: any): string {
  const path = typeof link === 'function' ? link(row) : link.replace(/\{([^}]+)\}/g, (_, k) => encodeURIComponent(String(row?.[k] ?? '')))
  return withBase(path)
}

/** SPA-navigate to a steward path: `nav("bots/42")` opens that row's detail view. */
export function nav(path: string) {
  const to = withBase(path)
  window.history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export const TONES = ['green', 'red', 'orange', 'blue', 'violet', 'gray'] as const
export type Tone = (typeof TONES)[number] | 'accent'
const toneVar = (t?: string) => (t === 'accent' || !t ? 'var(--accent, #3987e5)' : `var(--badge-${TONES.includes(t as any) ? t : 'gray'}, #a5a49c)`)

export function niceMax(n: number): number {
  if (n <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(n)))
  const u = n / p
  const nice = u <= 1 ? 1 : u <= 2 ? 2 : u <= 5 ? 5 : 10
  return nice * p
}

export function autoCols(rows: any[]): Col[] {
  const first = rows.find((r) => r && typeof r === 'object')
  if (!first) return []
  return Object.keys(first).map((key) => {
    const v = first[key]
    const numeric = rows.slice(0, 20).every((r) => r?.[key] == null || typeof r[key] === 'number')
    const timey = /(_at|_ts|_ms|^ts$|^t$)$/.test(key) && toMs(v) != null
    return {
      key,
      label: key.replace(/_/g, ' '),
      align: numeric && !timey ? 'r' : 'l',
      render: timey ? (r: any) => html`<span class="dim">${fmt.rel(r[key])}</span>` : numeric ? (r: any) => fmt.num(r[key]) : undefined,
    }
  })
}

export function sortRows(rows: any[], key: string, dir: 1 | -1): any[] {
  return rows.slice().sort((a, b) => {
    const x = a?.[key]
    const y = b?.[key]
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) return (nx - ny) * dir
    return String(x).localeCompare(String(y)) * dir
  })
}

export const Card = (p: any) => html`<div class="sx-card ${p.class || ''}" style=${p.style || ''}>${p.children}</div>`

export const Section = (p: any) =>
  html`<div class="sx-sec-h"><h2>${p.title}</h2>${p.actions ? html`<div class="sx-sec-a">${p.actions}</div>` : null}</div>${p.children}`

export const Grid = (p: any) => html`<div class="sx-grid" style=${`grid-template-columns:${p.cols || '1.4fr 1fr'};${p.style || ''}`}>${p.children}</div>`

export const Pill = (p: any) => {
  const c = toneVar(p.tone)
  return html`<span class="sx-pill" style=${`color:${c};background:color-mix(in oklab, ${c} 15%, transparent)`}>${p.children}</span>`
}

export const Bar = (p: any) => {
  const max = Number(p.max) || 1
  const v = Math.max(0, Math.min(1, (Number(p.value) || 0) / max))
  const tone = p.warnAt != null && Number(p.value) >= Number(p.warnAt) ? 'orange' : p.tone || 'accent'
  return html`<span class="sx-bar" title=${`${p.value} / ${max}`}><span style=${`width:${(v * 100).toFixed(1)}%;background:${toneVar(tone)}`} /></span>`
}

export function Spark({ data, y = 'y', tone }: any) {
  const vals: number[] = (data ?? []).map((d: any) => (typeof d === 'number' ? d : Number(d?.[y]) || 0))
  if (vals.length < 2) return null
  const max = Math.max(...vals, 1)
  const min = Math.min(...vals, 0)
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 26}`).join(' ')
  return html`<svg class="sx-spark" viewBox="0 0 100 30" preserveAspectRatio="none">
    <polyline points=${pts} fill="none" stroke=${toneVar(tone)} stroke-width="2" vector-effect="non-scaling-stroke" />
  </svg>`
}

export const Stat = (p: any) => {
  const deltaTone = p.delta == null ? '' : Number(p.delta) >= 0 ? 'up' : 'down'
  return html`<div class="sx-card sx-tile">
    <div class="sx-k">${p.label ?? p.k}</div>
    <div class="sx-v ${p.tone || ''}">${p.value ?? p.v}</div>
    ${p.delta != null
      ? html`<div class="sx-delta ${deltaTone}">${Number(p.delta) >= 0 ? '▲' : '▼'} ${p.deltaLabel ?? fmt.pct(Math.abs(Number(p.delta)))}</div>`
      : null}
    ${p.hint ? html`<div class="sx-hint">${p.hint}</div>` : null}
    ${p.spark ? html`<${Spark} data=${p.spark} y=${p.sparkY || 'y'} tone=${p.tone === 'down' ? 'red' : p.tone === 'up' ? 'green' : 'accent'} />` : null}
  </div>`
}

export function Tiles({ items, children }: any) {
  return html`<div class="sx-tiles">${items ? items.map((t: any) => html`<${Stat} ...${t} />`) : children}</div>`
}

export function Chips({ value, options, onChange }: { value: any; options: Array<{ value: any; label: string } | string>; onChange: (v: any) => void }) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
  return html`<div class="sx-chips">${opts.map((o) => html`
    <button class="sx-chip ${String(value ?? '') === String(o.value ?? '') ? 'on' : ''}" onClick=${() => onChange(o.value)}>${o.label}</button>`)}</div>`
}

export const Empty = (p: any) => html`<div class="sx-empty">${p.children ?? 'Nothing here.'}</div>`
export const ErrorState = (p: any) => html`<div class="sx-err">${String(p.error ?? p.children ?? 'Something went wrong.')}</div>`
export const Skeleton = (p: any) => html`<div class="sx-skel" style=${`height:${p.h || 96}px;${p.style || ''}`} />`

export interface Col {
  key?: string
  label?: string
  align?: 'l' | 'r'
  render?: (row: any) => any
  format?: 'num' | 'compact' | 'money' | 'pct' | 'bytes' | 'date' | 'datetime' | 'rel' | 'dur'
  badge?: Record<string, string>
  link?: string | ((row: any) => string)
  max?: number
  width?: string
}

function cellValue(c: Col, row: any) {
  const raw = c.key ? row?.[c.key] : undefined
  if (c.render) return c.render(row)
  if (c.badge) {
    const tone = c.badge[String(raw)] ?? 'gray'
    return raw == null ? '—' : html`<${Pill} tone=${tone}>${String(raw)}<//>`
  }
  if (c.max != null) return html`<${Bar} value=${raw} max=${c.max} />`
  if (c.format) {
    const f = (fmt as any)[c.format]
    return html`<span class=${c.format === 'rel' || c.format === 'date' || c.format === 'datetime' ? 'dim' : ''}>${f(raw)}</span>`
  }
  if (raw == null) return html`<span class="dim">—</span>`
  if (typeof raw === 'number') return fmt.num(raw)
  return String(raw)
}

/** The workhorse table. Columns are optional (inferred from the rows), sorting is
 *  built in, `link` turns rows into drill-downs: `"bots/{id}"` or a function. */
export function DataTable(p: {
  rows: any[]
  cols?: Col[]
  cap?: number
  loading?: boolean
  error?: string | null
  empty?: any
  link?: string | ((row: any) => string)
  sortable?: boolean
  sort?: string
  class?: string
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(() =>
    p.sort ? { key: p.sort.replace(/^-/, ''), dir: p.sort.startsWith('-') ? -1 : 1 } : null,
  )
  const rows = p.rows ?? []
  if (p.loading) return html`<div class="sx-card"><${Skeleton} h=${132} style="border-radius:12px" /></div>`
  if (p.error && !rows.length) return html`<div class="sx-card"><${ErrorState} error=${p.error} /></div>`
  const cols = p.cols?.length ? p.cols : autoCols(rows)
  if (!rows.length) return html`<div class="sx-card">${p.empty ?? html`<${Empty} />`}</div>`
  const sortable = p.sortable !== false
  const sorted = sort ? sortRows(rows, sort.key, sort.dir) : rows
  const shown = p.cap ? sorted.slice(0, p.cap) : sorted
  const clickHeader = (c: Col) => {
    if (!sortable || !c.key) return
    setSort((s) => (s && s.key === c.key ? (s.dir === -1 ? null : { key: c.key!, dir: -1 }) : { key: c.key!, dir: 1 }))
  }
  return html`<div class="sx-card ${p.class || ''}">
    <table class="sx-t">
      <thead><tr>${cols.map((c) => html`
        <th class="${c.align === 'r' ? 'r' : ''} ${sortable && c.key ? 'sortable' : ''}" style=${c.width ? `width:${c.width}` : ''} onClick=${() => clickHeader(c)}>
          ${c.label ?? c.key ?? ''}${sort && c.key === sort.key ? html`<span class="sx-sort">${sort.dir === 1 ? '▲' : '▼'}</span>` : null}
        </th>`)}</tr></thead>
      <tbody>${shown.map((row) => {
        const href = p.link ? hrefFor(p.link, row) : null
        return html`<tr class=${href ? 'linked' : ''} onClick=${href ? () => nav(href) : undefined}>
          ${cols.map((c) => html`<td class=${c.align === 'r' ? 'r mono' : ''}>${cellValue(c, row)}</td>`)}
        </tr>`
      })}</tbody>
    </table>
    ${p.cap && rows.length > p.cap ? html`<div class="sx-note">Showing ${fmt.num(p.cap)} of ${fmt.num(rows.length)}.</div>` : null}
    ${p.error ? html`<div class="sx-note sx-stale">Refresh failed — showing the last good data.</div>` : null}
  </div>`
}

export const Table = DataTable

/** SVG chart — `kind` bar | line | area, hover tooltip, nice axis ticks.
 *  `<${Chart} rows=${q.rows} x="t" y="n" kind="bar" height=${180} />` */
export function Chart(p: {
  rows: any[]
  x?: string
  y?: string
  kind?: 'bar' | 'line' | 'area'
  height?: number
  tone?: Tone
  format?: (v: unknown) => string
  xfmt?: (v: unknown) => string
  loading?: boolean
  error?: string | null
}) {
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const rows = p.rows ?? []
  if (p.loading) return html`<div class="sx-card"><${Skeleton} h=${p.height || 180} style="border-radius:12px" /></div>`
  if (p.error && !rows.length) return html`<div class="sx-card"><${ErrorState} error=${p.error} /></div>`
  const xk = p.x || 'x'
  const yk = p.y || 'y'
  if (!rows.length) return html`<div class="sx-card"><${Empty}>No data.<//></div>`
  const H = p.height || 180
  const pad = { t: 10, b: 22 }
  const innerH = H - pad.t - pad.b
  const vals = rows.map((r) => Number(r?.[yk]) || 0)
  const hi = niceMax(Math.max(...vals, 0))
  const lo = Math.min(...vals) < 0 ? -niceMax(-Math.min(...vals)) : 0
  const span = hi - lo
  const color = toneVar(p.tone)
  const yfmt = p.format || fmt.compact
  const xfmt = p.xfmt || ((v: unknown) => (toMs(v) != null && typeof v !== 'number' ? fmt.day(v) : String(v)))
  const ticks = lo < 0 ? [lo, 0, hi] : [0, hi / 2, hi]
  const yPos = (v: number) => pad.t + innerH - ((v - lo) / span) * innerH
  const kind = p.kind || 'bar'
  const n = rows.length
  const move = (e: MouseEvent) => {
    const el = svgRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const i = Math.floor(((e.clientX - r.left) / r.width) * n)
    setHover(i >= 0 && i < n ? i : null)
  }
  const linePts = vals.map((v, i) => `${n === 1 ? 50 : (i / (n - 1)) * 100},${((hi - v) / span) * 100}`).join(' ')
  const zeroY = ((hi - 0) / span) * 100
  return html`<div class="sx-card sx-chartcard">
    <div class="sx-chart" style=${`height:${H}px`} onMouseMove=${move} onMouseLeave=${() => setHover(null)}>
      <svg width="100%" height=${H} ref=${svgRef}>
        ${ticks.map((t) => html`
          <line x1="0" x2="100%" y1=${yPos(t)} y2=${yPos(t)} class="sx-grid-line ${t === 0 && lo < 0 ? 'zero' : ''}" />
          <text x="4" y=${yPos(t) - 4} class="sx-axis">${yfmt(t)}</text>`)}
        ${kind === 'bar'
          ? vals.map((v, i) => {
              const bw = Math.max(100 / n - 0.6, 0.4)
              const bh = Math.max((Math.abs(v) / span) * innerH, v !== 0 ? 2 : 0)
              return html`<rect
                x=${`${(i / n) * 100 + (100 / n - bw) / 2}%`}
                y=${v >= 0 ? yPos(0) - bh : yPos(0)}
                width=${`${bw}%`}
                height=${bh}
                rx="2"
                fill=${v < 0 ? toneVar('red') : color}
                opacity=${hover === i ? 1 : 0.75}
              />`
            })
          : html`<svg x="0" y=${pad.t} width="100%" height=${innerH} viewBox="0 0 100 100" preserveAspectRatio="none">
              ${kind === 'area' ? html`<polygon points=${`0,${zeroY} ${linePts} 100,${zeroY}`} fill=${color} opacity="0.14" />` : null}
              <polyline points=${linePts} fill="none" stroke=${color} stroke-width="2" vector-effect="non-scaling-stroke" />
            </svg>`}
        <text x="4" y=${H - 6} class="sx-axis">${xfmt(rows[0]?.[xk])}</text>
        <text x="100%" dx="-4" y=${H - 6} class="sx-axis" text-anchor="end">${xfmt(rows[n - 1]?.[xk])}</text>
      </svg>
      ${hover != null && rows[hover]
        ? html`<div class="sx-tip" style=${`left:calc(12px + ${(hover + 0.5) / n} * (100% - 24px))`}>
            <div class="sx-tip-x">${xfmt(rows[hover][xk])}</div>
            <div class="sx-tip-y">${(p.format || fmt.num)(rows[hover][yk])}</div>
          </div>`
        : null}
    </div>
    ${p.error ? html`<div class="sx-note sx-stale">Refresh failed — showing the last good data.</div>` : null}
  </div>`
}

/** Page shell: title, subtitle, optional toolbar, and automatic loading / error
 *  states: `<${Page} title="Ops" loading=${q.$loading} error=${q.$error}>…<//>`. */
export function Page(p: { title: any; sub?: any; actions?: any; loading?: boolean; error?: string | null; children?: any }) {
  return html`<div class="sx-page">
    <div class="sx-head">
      <div><h1>${p.title}</h1>${p.sub ? html`<p class="sub">${p.sub}</p>` : null}</div>
      ${p.actions ? html`<div class="sx-actions">${p.actions}</div>` : null}
    </div>
    ${p.loading
      ? html`<div class="sx-tiles">${[0, 1, 2, 3].map(() => html`<${Skeleton} h=${86} />`)}</div><${Skeleton} h=${220} style="margin-top:16px" />`
      : html`${p.error ? html`<div class="sx-banner">${String(p.error)}</div>` : null}${p.children}`}
  </div>`
}

export const components: Record<string, ComponentType<any>> = {}
export const define = (name: string, C: ComponentType<any>) => { components[name] = C }

/** Register a custom page as a Preact component. steward mounts `sx-page-<slug>`;
 *  the component receives `{ api }` and re-renders reactively. */
const pageRegistry: Record<string, ComponentType<any>> = {}

export function definePage(slug: string, Component: ComponentType<{ api: WidgetApi }>) {
  ensureStyles()
  const tag = `sx-page-${slug.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  // customElements.define is once-only; the registry indirection lets a reloaded
  // module swap the implementation for future mounts.
  pageRegistry[tag] = Component
  if (customElements.get(tag)) return
  class SxPage extends HTMLElement {
    private _api: WidgetApi | undefined
    set api(v: WidgetApi) { this._api = v; this.paint() }
    connectedCallback() { this.paint() }
    disconnectedCallback() { render(null, this) }
    private paint() { render(h(pageRegistry[tag] as any, { api: this._api }), this) }
  }
  customElements.define(tag, SxPage)
}

let stylesInjected = false
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const s = document.createElement('style')
  s.textContent = `
    .sx-page { padding: 22px 26px 60px; max-width: 1240px; margin: 0 auto; color: var(--ink, #e6e6e6);
               font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; animation: sx-in .18s ease-out; }
    @keyframes sx-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
    .sx-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .sx-page h1 { font-size: 19px; font-weight: 650; margin: 0 0 2px; letter-spacing: -.01em; }
    .sx-page .sub { color: var(--muted, #8a8a8a); font-size: 12.5px; margin: 0 0 22px; }
    .sx-actions { display: flex; gap: 8px; align-items: center; }
    .sx-sec-h { display: flex; align-items: baseline; justify-content: space-between; margin: 26px 0 10px; }
    .sx-page h2, .sx-sec-h h2 { font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .07em;
                  color: var(--sec, #9a9a9a); margin: 26px 0 10px; }
    .sx-sec-h h2 { margin: 0; }
    .sx-card { background: var(--surface, #17181b); border: 1px solid var(--border, #2a2b30); border-radius: 12px; overflow: hidden; }
    .sx-grid { display: grid; gap: 16px; align-items: start; }
    @media (max-width: 860px) { .sx-grid { grid-template-columns: 1fr !important; } }
    .sx-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .sx-tile { padding: 14px 16px; }
    .sx-tile .sx-k { color: var(--muted, #8a8a8a); font-size: 11.5px; font-weight: 550; }
    .sx-tile .sx-v { font-size: 26px; font-weight: 660; margin-top: 4px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
    .sx-tile .sx-v.up, .sx-tile .sx-v.ok, .sx-tile .sx-v.green { color: var(--badge-green, #57b16a); }
    .sx-tile .sx-v.down, .sx-tile .sx-v.warn, .sx-tile .sx-v.red { color: var(--badge-red, #e0645a); }
    .sx-tile .sx-v.orange { color: var(--badge-orange, #e0a848); }
    .sx-delta { font-size: 11px; font-weight: 600; margin-top: 2px; }
    .sx-delta.up { color: var(--badge-green, #57b16a); } .sx-delta.down { color: var(--badge-red, #e0645a); }
    .sx-hint { color: var(--muted, #8a8a8a); font-size: 11px; margin-top: 2px; }
    .sx-spark { display: block; width: 100%; height: 30px; margin-top: 8px; opacity: .9; }
    table.sx-t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    table.sx-t th { text-align: left; font-weight: 600; color: var(--muted, #8a8a8a); padding: 9px 14px;
                    border-bottom: 1px solid var(--border, #2a2b30); font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
                    user-select: none; white-space: nowrap; }
    table.sx-t th.sortable { cursor: pointer; }
    table.sx-t th.sortable:hover { color: var(--ink, #e6e6e6); }
    .sx-sort { margin-left: 4px; font-size: 9px; }
    table.sx-t th.r, table.sx-t td.r { text-align: right; }
    table.sx-t td { padding: 8px 14px; border-bottom: 1px solid var(--surface-3, #202127); vertical-align: middle; }
    table.sx-t tr:last-child td { border-bottom: 0; }
    table.sx-t tr.linked { cursor: pointer; }
    table.sx-t tr.linked:hover td { background: var(--surface-2, #1d1e22); }
    .sx-t .mono, .sx-page .mono { font-variant-numeric: tabular-nums; }
    .sx-page .dim { color: var(--muted, #8a8a8a); }
    .sx-note { color: var(--muted, #8a8a8a); font-size: 11.5px; padding: 10px 14px; }
    .sx-varbar { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 18px; padding: 12px 14px;
                 background: var(--surface, #17181b); border: 1px solid var(--border, #2a2b30); border-radius: 10px; }
    .sx-var { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; }
    .sx-var > span { color: var(--muted, #8a8a8a); font-weight: 550; }
    .sx-var select { font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 7px; color: var(--ink, #e6e6e6);
                     background: var(--surface-2, #1d1e22); border: 1px solid var(--border, #2a2b30); cursor: pointer; }
    .sx-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 26px 0 10px; }
    .sx-chip { font: inherit; font-size: 11.5px; font-weight: 550; padding: 4px 11px; border-radius: 999px; cursor: pointer;
               background: var(--surface, #17181b); border: 1px solid var(--border, #2a2b30); color: var(--sec, #9a9a9a);
               transition: color .12s, background .12s; }
    .sx-chip:hover { color: var(--ink, #e6e6e6); }
    .sx-chip.on { background: var(--accent, #4a7); border-color: transparent; color: #fff; }
    .sx-pill { display: inline-flex; align-items: center; gap: .35em; padding: .1em .55em; border-radius: 999px;
               font-size: 11px; font-weight: 600; white-space: nowrap; }
    .sx-bar { display: inline-block; width: 72px; height: 6px; border-radius: 3px; background: var(--surface-3, #202127);
              overflow: hidden; vertical-align: middle; }
    .sx-bar > span { display: block; height: 100%; border-radius: 3px; }
    .sx-err { color: var(--badge-red, #e0645a); font-size: 12.5px; padding: 12px 16px; }
    .sx-banner { color: var(--badge-red, #e0645a); font-size: 12px; padding: 8px 12px; margin: 0 0 14px;
                 border: 1px solid color-mix(in oklab, var(--badge-red, #e0645a) 35%, transparent);
                 background: color-mix(in oklab, var(--badge-red, #e0645a) 8%, transparent); border-radius: 8px; }
    .sx-stale { color: var(--badge-orange, #e0a848); border-top: 1px solid var(--surface-3, #202127); }
    .sx-grid-line.zero { stroke: var(--muted, #8a8a8a); }
    .sx-empty { color: var(--muted, #8a8a8a); font-size: 12.5px; padding: 14px 16px; }
    .sx-skel { border-radius: 12px; background: linear-gradient(100deg, var(--surface, #17181b) 40%,
               var(--surface-2, #1d1e22) 50%, var(--surface, #17181b) 60%); background-size: 200% 100%;
               animation: sx-shimmer 1.4s ease-in-out infinite; border: 1px solid var(--border, #2a2b30); }
    @keyframes sx-shimmer { to { background-position: -200% 0; } }
    .sx-chartcard { overflow: visible; }
    .sx-chart { position: relative; padding: 10px 12px 6px; }
    .sx-chart svg { display: block; overflow: visible; }
    .sx-grid-line { stroke: var(--surface-3, #202127); stroke-width: 1; }
    .sx-axis { fill: var(--muted, #8a8a8a); font-size: 10px; }
    .sx-tip { position: absolute; top: 6px; transform: translateX(-50%); pointer-events: none;
              background: var(--surface-2, #1d1e22); border: 1px solid var(--border, #2a2b30); border-radius: 8px;
              padding: 5px 9px; font-size: 11px; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,.25); z-index: 5; }
    .sx-tip-x { color: var(--muted, #8a8a8a); }
    .sx-tip-y { font-weight: 650; font-variant-numeric: tabular-nums; }
  `
  document.head.appendChild(s)
}
