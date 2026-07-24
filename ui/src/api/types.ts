export interface User {
  email: string
  role: string
}

export interface FkMeta {
  table: string
  label_col: string
}

export interface ColorRuleMeta {
  op: string
  num?: number
  num2?: number
  str?: string
  class: string
}

export type ColorMeta = { strategy: string } | { rules: ColorRuleMeta[] }

export interface ColumnMeta {
  name: string
  kind: string
  widget: string
  params: Record<string, unknown>
  nullable: boolean
  readonly: boolean
  masked: boolean
  fk: FkMeta | null
  ref_table?: string
  ref_column?: string
  computed?: boolean
  label?: string
  group?: string | null
  format?: string
  prefix?: string
  suffix?: string
  truncate?: number
  display?: string
  href?: string
  color?: ColorMeta
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'between' | 'isnull'

export interface FilterOption {
  value: string
  label: string
  count?: number
}

export interface FilterMeta {
  name: string
  label: string
  type: 'enum' | 'bool' | 'date' | 'custom'
  options: FilterOption[]
  ops?: FilterOp[]
  kind?: string
}

export interface SectionMeta {
  title: string
  fields: string[]
  span?: number | null
  collapsible?: boolean
}

export interface DetailSidebarMeta {
  fields: string[]
}

export interface DetailMeta {
  mode?: string | null
  columns?: number | null
  tabs?: boolean
  stats?: string[]
  sidebar?: DetailSidebarMeta | null
}

export interface ListMeta {
  columns: string[]
  search: string[]
  filters: FilterMeta[]
  default_sort: string
  per_page: number
}

export interface ActionMeta {
  name: string
  label: string
  danger: boolean
  confirm: string
  kind: string
}

export interface InlineMeta {
  table: string
  fk_col: string
  label: string
  columns?: string[]
  can_create?: boolean
  can_delete?: boolean
}

export interface Perms {
  read: boolean
  write: boolean
  create: boolean
  delete: boolean
  actions: string[]
}

export interface TableMeta {
  name: string
  label: string
  label_plural: string
  group: string | null
  pk: string
  read_only: boolean
  columns: ColumnMeta[]
  list: ListMeta
  display_title: string
  inlines: InlineMeta[]
  actions: ActionMeta[]
  perms: Perms
  sections?: SectionMeta[]
  detail?: DetailMeta
  approx_rows?: number | null
  icon?: string | null
}

export interface NavGroup {
  slug?: string | null
  label: string
  icon?: string | null
  nav?: string | null
  tables: string[]
}

export interface PageMeta {
  id: string
  slug: string
  label: string
  module: string | null
  declarative?: boolean
  group: string | null
  icon?: string | null
  roles?: string[] | null
}

export type ThemeTokens = Record<string, string>

export interface ThemeConfig {
  preset?: string | null
  accent?: string | null
  accent_btn?: string | null
  light?: ThemeTokens | null
  dark?: ThemeTokens | null
  mode?: 'light' | 'dark' | 'auto' | null
  logo_light?: string | null
  logo_dark?: string | null
}

export interface Meta {
  brand: string
  base_path: string
  tables: TableMeta[]
  nav?: NavGroup[]
  user: User
  has_dashboard: boolean
  group_nav?: string | null
  pages?: PageMeta[]
  locale?: string | null
  strings?: Record<string, string> | null
  brand_logo?: string | null
  brand_accent?: string | null
  brand_accent_light?: string | null
  theme?: ThemeConfig | null
  roles?: string[]
  can_manage_access?: boolean
}

export interface AccessUser {
  id: number
  email: string
  role: string
  created_at: string
}

export type RoleLevel = 'read' | 'write'
export type RoleSource = 'builtin' | 'config'

export interface RolePerm {
  view?: boolean
  create?: boolean
  update?: boolean
  delete?: boolean
}

export interface RoleDefinition {
  tables: Record<string, RoleLevel>
  actions: string[]
  masked: Record<string, string[]>
  row_filter: Record<string, string>
  perms?: Record<string, RolePerm>
  editable?: Record<string, string[]>
}

export interface RoleInfo {
  name: string
  source: RoleSource
  editable: boolean
  definition: RoleDefinition | null
  user_count: number
  created_at?: string
}

export interface RolesResponse {
  roles: RoleInfo[]
  tables: string[]
  actions: string[]
}

export type RoleWrite =
  | { ok: true; reloaded: boolean }
  | { ok: false; writable: false; hcl: string }

export interface SearchHit {
  table: string
  label: string
  pk: string
  title: string
  sub?: string | null
}

export interface SearchResponse {
  results: SearchHit[]
}

export interface SavedView {
  id: number
  owner_email: string
  table_name: string
  name: string
  query: string
  shared: boolean
  created_at: string
  own: boolean
}

export interface SavedViewsResponse {
  rows: SavedView[]
}

export type Row = Record<string, unknown>

export interface ListResponse {
  rows: Row[]
  total: number
  page: number
  pp: number
  approx?: boolean
}

export interface BulkResult {
  affected: number
}

export interface ImportRowError {
  row: number
  message: string
}

export interface ImportResult {
  inserted: number
  updated: number
  skipped: number
  errors: ImportRowError[]
}

export interface InlineData extends InlineMeta {
  rows: Row[]
  total: number
  cap?: number
}

export interface InlinePageResponse extends InlineMeta {
  rows: Row[]
  total: number
  page: number
  cap: number
}

export interface RowResponse {
  row: Row
  inlines: InlineData[]
}

export interface OptionItem {
  value: string | number
  label: string
}

export interface WidgetSpan {
  w?: number
  h?: number
  category?: string | null
}

export interface StatWidget extends WidgetSpan {
  id: string
  type: 'stat'
  label: string
  value: number
  format: 'number' | 'money' | 'percent' | 'duration'
  compare?: { value: number; label: string } | null
  alert?: 'warn' | 'critical' | null
  currency?: string
  spark?: number[]
  good_when?: 'up' | 'down'
}

export interface ChartPoint {
  t: string
  v: number
}

export interface ChartSeries {
  label: string
  points: ChartPoint[]
}

export interface ChartWidget extends WidgetSpan {
  id: string
  type: 'chart'
  label: string
  kind: 'line' | 'bar' | 'area'
  points: ChartPoint[]
  series?: ChartSeries[]
  format?: string
}

export interface TableColumn {
  key: string
  label?: string | null
  format?: string | null
  align?: 'l' | 'r' | null
  max?: number | null
  badge?: Record<string, string> | null
  /** In-cell dataviz for a numeric column: `bar` = proportional data bar behind
   *  the value; `heat` = cell tinted by magnitude. Scaled per-column over the
   *  visible rows. */
  display?: 'bar' | 'heat' | null
  tone?: 'accent' | 'green' | 'red' | 'orange' | 'blue' | 'violet' | null
}

export interface TableWidget extends WidgetSpan {
  id: string
  type: 'table'
  label: string
  link?: string | null
  columns: string[]
  cols?: TableColumn[] | null
  rows: Row[]
  pk?: string | null
}

export interface IframeWidget extends WidgetSpan {
  id: string
  type: 'iframe'
  label: string
  url: string
}

export type Widget = StatWidget | ChartWidget | TableWidget | IframeWidget

export interface DashboardResponse {
  label?: string
  widgets: Widget[]
  columns?: number | null
}

export interface AuditChange {
  from: unknown
  to: unknown
}

export interface AuditRow {
  id: number
  ts: string
  actor: string
  table_name: string
  pk: string
  action: string
  changes: Record<string, AuditChange> | null
}

export interface AuditResponse {
  rows: AuditRow[]
  total: number
}

export interface ActionResult {
  affected: number
  webhook_status?: number
}

export interface ConfigGet {
  table: string
  hcl: string
  model: Record<string, unknown>
  writable: boolean
}

export type ConfigPutBody =
  | { model: Record<string, unknown>; group?: string }
  | { hcl: string; group?: string }
  | { group?: string }

export type ConfigPut =
  | { ok: true; reloaded: true }
  | { ok: false; writable: false; hcl: string }

export interface GroupInfo {
  slug: string
  label: string
  icon?: string | null
  order: number
  tables: string[]
}

export interface GroupsLayout {
  writable: boolean
  groups: GroupInfo[]
  ungrouped: string[]
  unconfigured: string[]
}

export type GroupWrite =
  | { ok: true; reloaded: boolean }
  | { ok: false; writable: false; hcl?: string }

export interface CreateGroupBody {
  slug: string
  label: string
  icon?: string
  order?: number
}

export interface PatchGroupBody {
  label?: string
  icon?: string | null
  order?: number
  table_order?: string[]
}

export interface LayoutGroupBody {
  slug: string
  tables: string[]
}

export interface GroupLayoutBody {
  groups: LayoutGroupBody[]
  ungrouped: string[]
}

export interface DiscoverTable {
  name: string
  schema: string
  is_view: boolean
  pk: string | null
  column_count: number
}

export interface DiscoverResponse {
  tables: DiscoverTable[]
}

export type WidgetKindData = 'stat' | 'chart' | 'table' | 'iframe'

export interface WidgetConfigData {
  type: WidgetKindData
  label: string
  id?: string
  sql?: string
  compare_sql?: string
  compare_label?: string
  spark?: string
  good_when?: string
  chart?: string
  format?: string
  alert_above?: number
  alert_below?: number
  link?: string
  url?: string
  w?: number
  h?: number
  category?: string
  roles?: string[]
}

export interface DashboardConfigGet {
  writable: boolean
  widgets: WidgetConfigData[]
  columns?: number | null
  hcl: string
}

export interface DashboardPreviewResult {
  widget: Widget | null
}

export interface DashboardVersionBody {
  hcl: string
}

export interface ConfigVersion {
  id: number
  actor: string
  note: string | null
  created_at: string
  published: boolean
  bytes: number
}

export interface ConfigVersionsResponse {
  versions: ConfigVersion[]
}

export interface ConfigVersionBody {
  hcl: string
}

export type ConfigPublishResult =
  | { ok: true; reloaded: true }
  | { ok: false; writable: false; hcl: string }
