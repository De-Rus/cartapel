// Type declarations for the `sx` page SDK (window.sx) — the zero-import API
// available to screen modules (`screen.hcl` with `module = "<name>.tsx"`).
// Drop this file next to your modules and add to tsconfig / a triple-slash
// reference for editor autocompletion:  /// <reference path="./sx.d.ts" />
// Served by every cartapel instance at {base}/sx.d.ts.

type VNode = any
type ComponentType<P = any> = (props: P) => VNode

interface SxFetched<T = any> {
  loading: boolean
  refreshing: boolean
  data: T | null
  rows: any[]
  error: string | null
  refetch: () => void
}

interface SxFetchOpts {
  refreshMs?: number
}

interface SxTableOpts extends SxFetchOpts {
  page?: number
  pp?: number
  sort?: string
  q?: string
  filters?: Record<string, string | number>
}

interface SxWidgetApi {
  get(path: string): Promise<unknown>
  post(path: string, body?: unknown): Promise<unknown>
}

interface SxVarDef {
  name: string
  label?: string
  type?: string
  kind?: string
  default?: string | null
  options: Array<{ value: string; label: string }>
}

interface SxCol {
  key: string
  label?: string
  align?: 'left' | 'right'
  render?: (value: any, row: any) => VNode
}

declare const sx: {
  /** Register a screen module: `sx.definePage('summary', ({ api }) => html`…`)`. */
  definePage(slug: string, Component: ComponentType<{ api: SxWidgetApi }>): void

  /** htm-bound JSX-in-template-literals: `html`<div>${x}</div>``. */
  html(strings: TemplateStringsArray, ...values: any[]): VNode
  h(type: any, props?: any, ...children: any[]): VNode
  Fragment: ComponentType
  render(vnode: VNode, parent: Element): void

  useState<T>(initial: T | (() => T)): [T, (v: T | ((p: T) => T)) => void]
  useEffect(fn: () => void | (() => void), deps?: any[]): void
  useMemo<T>(fn: () => T, deps?: any[]): T
  useRef<T>(initial: T): { current: T }
  useCallback<T extends (...a: any[]) => any>(fn: T, deps?: any[]): T

  /** Fetch a registered `source` alias: `sx.useSource(api, 'metrics', 'jobs')`. */
  useSource(api: SxWidgetApi | undefined, alias: string, path?: string, opts?: SxFetchOpts): SxFetched
  /** Fetch a named SQL query from queries.hcl; current template variables travel along. */
  useQuery(api: SxWidgetApi | undefined, name: string, opts?: SxFetchOpts): SxFetched
  /** One hook per name; the names array must be stable across renders. The
   *  result also carries $loading / $error / $refetch aggregates. */
  useQueries(
    api: SxWidgetApi | undefined,
    names: string[],
    opts?: SxFetchOpts,
  ): Record<string, SxFetched> & { $loading: boolean; $error: string | null; $refetch: () => void }
  /** Page a configured table: `sx.useTable(api, 'bots', { pp: 50, sort: '-id' })`. */
  useTable(
    api: SxWidgetApi | undefined,
    table: string,
    opts?: SxTableOpts,
  ): SxFetched<{ rows: any[]; total: number; page: number; pp: number }>
  useMetaTable(api: SxWidgetApi | undefined, slug: string): any

  /** Template variables (URL-backed `v_*` params). */
  useVars(): [Record<string, string>, (name: string, value: string | null) => void]
  useVarParams(): string
  useMetaVars(api: SxWidgetApi | undefined): SxVarDef[]
  VarBar: ComponentType<{ api: SxWidgetApi | undefined; only?: string[] }>

  /** URL params + SPA navigation. */
  useParam(key: string, def?: string): [string, (v: string | null) => void]
  readParam(search: string, key: string): string | null
  writeParam(search: string, key: string, value: string | null | undefined, def?: string): string
  nav(path: string): void
  hrefFor(link: string | ((row: any) => string), row: any): string

  /** Layout + display components. */
  Page: ComponentType<{ title: any; sub?: any; actions?: any; loading?: boolean; error?: string | null; children?: any }>
  Card: ComponentType
  Section: ComponentType
  Grid: ComponentType<{ cols?: string }>
  Stat: ComponentType
  Pill: ComponentType
  Bar: ComponentType
  Spark: ComponentType<{ data: any[]; y?: string; tone?: string }>
  Tiles: ComponentType<{ items: any[] }>
  Chips: ComponentType<{ value: any; options: Array<{ value: any; label: string } | string>; onChange: (v: any) => void }>
  DataTable: ComponentType<any>
  Table: ComponentType<any>
  Chart: ComponentType<any>
  AdminTable: ComponentType<{ api: SxWidgetApi | undefined; slug: string; pp?: number; sort?: string; cap?: number }>
  Empty: ComponentType
  ErrorState: ComponentType<{ error?: any }>
  Skeleton: ComponentType<{ h?: number }>

  fmt: {
    num(n: unknown): string
    compact(n: unknown): string
    money(n: unknown, cur?: string): string
    pct(v: unknown, d?: number): string
    bytes(n: unknown): string
    date(t: unknown): string
    datetime(t: unknown): string
    hour(t: unknown): string
    day(t: unknown): string
    dur(s: unknown): string
    rel(t: unknown): string
  }
  toMs(t: unknown): number | null
  niceMax(n: number): number
  autoCols(rows: any[]): SxCol[]
  sortRows(rows: any[], key: string, dir: 1 | -1): any[]
  TONES: readonly ['green', 'red', 'orange', 'blue', 'violet', 'gray']
}
