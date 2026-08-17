import { useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '../api/client'
import type {
  DashboardResponse,
  QueryTableWidget,
  Row,
  ScreenTableWidget,
  StatWidget,
  TableColumn,
  TableWidget,
  Widget,
} from '../api/types'
import { applyFormat, fmtByFormat, fmtDateTime, fmtPercent } from '../lib/format'
import { useT } from '../lib/i18n'
import { useResolvedTheme } from '../lib/theme'
import { useMeta } from '../lib/meta'
import { VarBar, useVarQuery } from '../components/VarBar'
import { Badge, CellValue, NUMERIC_WIDGETS } from '../components/CellValue'
import { Chart, Sparkline } from '../components/Chart'
import { EmptyState } from '../components/EmptyState'
import { applyFilters, filterOptions } from '../lib/panelFilter'
import { Skeleton } from '../components/Skeleton'
import { IconAlert, IconArrowDown, IconArrowUp, IconDashboard, IconInbox, IconWarn } from '../components/Icons'

const DEFAULT_COLS = 4

function gridColsClass(columns: number): string {
  switch (columns) {
    case 1:
      return 'grid-cols-1'
    case 2:
      return 'grid-cols-1 md:grid-cols-2'
    case 3:
      return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
    case 5:
      return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-5'
    case 6:
      return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-6'
    default:
      return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-4'
  }
}

function spanClass(w: Widget, columns: number): string {
  const want = w.w ?? (w.type === 'stat' ? 1 : 2)
  const cols = Math.min(want, columns)
  const base =
    cols >= 6
      ? 'md:col-span-2 xl:col-span-6'
      : cols === 5
        ? 'md:col-span-2 xl:col-span-5'
        : cols === 4
          ? 'md:col-span-2 xl:col-span-4'
          : cols === 3
            ? 'md:col-span-2 xl:col-span-3'
            : cols === 2
              ? 'md:col-span-2 xl:col-span-2'
              : ''
  const rows = w.h === 2 ? 'xl:row-span-2' : ''
  return clsx(base, rows)
}

function deltaText(w: StatWidget, abs: number, pct: number | null): string {
  return pct !== null ? fmtPercent(pct) : fmtByFormat(abs, w.format, w.currency)
}

function Stat({ w }: { w: StatWidget }) {
  const t = useT()
  const prev = w.compare?.value
  const abs = prev != null ? w.value - prev : null
  const up = abs != null && abs >= 0
  const favorable = up === ((w.good_when ?? 'up') === 'up')
  const pct = prev != null && prev !== 0 ? (Math.abs(w.value - prev) / Math.abs(prev)) * 100 : null
  const deltaColor = favorable ? 'var(--delta-good)' : 'var(--critical)'
  const valueCls =
    w.alert === 'critical' ? 'text-critical' : w.alert === 'warn' ? 'text-warning' : 'text-ink'
  const sparkColor =
    w.alert === 'critical'
      ? 'var(--critical)'
      : w.alert === 'warn'
        ? 'var(--warning)'
        : abs !== null
          ? deltaColor
          : 'var(--s1)'
  const hasSpark = !!(w.spark && w.spark.length > 1)
  const hasDelta = abs !== null && !!w.compare
  return (
    <div className="card card-interactive relative flex h-full min-h-[126px] flex-col overflow-hidden p-5">
      {w.alert && (
        <span
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: w.alert === 'critical' ? 'var(--critical)' : 'var(--warning)' }}
        />
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="text-xxs font-semibold uppercase tracking-[0.08em] text-muted">{w.label}</div>
        {w.alert && (
          <span
            className={clsx(
              'flex shrink-0 items-center gap-1 text-xxs font-medium',
              w.alert === 'critical' ? 'text-critical' : 'text-warning',
            )}
          >
            {w.alert === 'critical' ? <IconAlert size={12} /> : <IconWarn size={12} />}
            {w.alert === 'critical' ? t('alert_critical') : t('alert_warn')}
          </span>
        )}
      </div>

      <div className={clsx('mt-3 text-[32px] font-semibold leading-none tracking-tight tabular-nums', valueCls)}>
        {fmtByFormat(w.value, w.format, w.currency)}
      </div>

      <div className="mt-auto pt-3">
        {hasSpark ? (
          <Sparkline values={w.spark!} color={sparkColor} height={34} />
        ) : (
          hasDelta && (
            <div className="flex items-center gap-1.5 text-xxs tabular-nums">
              <span
                className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium"
                style={{ color: deltaColor, background: `color-mix(in srgb, ${deltaColor} 14%, transparent)` }}
              >
                {up ? <IconArrowUp size={11} /> : <IconArrowDown size={11} />}
                {deltaText(w, Math.abs(abs!), pct)}
              </span>
              <span className="text-muted">
                {t('cfg_dash_vs')} {w.compare!.label}
              </span>
            </div>
          )
        )}
        {hasSpark && hasDelta && (
          <div className="mt-1.5 flex items-center gap-1.5 text-xxs tabular-nums">
            <span className="font-medium" style={{ color: deltaColor }}>
              {up ? '↑' : '↓'} {deltaText(w, Math.abs(abs!), pct)}
            </span>
            <span className="text-muted">
              {t('cfg_dash_vs')} {w.compare!.label}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function rowHref(w: QueryTableWidget, row: Row): string | null {
  if (!w.link || !w.pk || row[w.pk] == null) return null
  return `/${w.link}/${encodeURIComponent(String(row[w.pk]))}`
}

const TONE_VAR: Record<string, string> = {
  accent: 'var(--s1)',
  green: 'var(--badge-green)',
  red: 'var(--badge-red)',
  orange: 'var(--badge-orange)',
  blue: 'var(--badge-blue)',
  violet: 'var(--badge-violet)',
}

function DeclaredCell({ col, value, frac }: { col: TableColumn; value: unknown; frac: number | null }) {
  if (col.badge && value != null) {
    return <Badge value={String(value)} colors={col.badge} />
  }
  const text = value == null ? '—' : col.format ? applyFormat(value, { format: col.format }) : String(value)
  const tone = TONE_VAR[col.tone ?? 'accent'] ?? 'var(--s1)'

  if (col.display === 'bar' && frac != null) {
    return (
      <div className="relative flex h-6 items-center justify-end">
        <div
          className="absolute inset-y-0 right-0 rounded-[3px]"
          style={{
            width: `${Math.max(3, frac * 100)}%`,
            background: `linear-gradient(90deg, color-mix(in srgb, ${tone} 8%, transparent), color-mix(in srgb, ${tone} 26%, transparent))`,
          }}
        />
        <span className="relative z-10 pr-1 tabular-nums">{text}</span>
      </div>
    )
  }

  if (col.display === 'heat' && frac != null) {
    return (
      <span
        className="inline-flex min-w-[2.75rem] items-center justify-end rounded-[4px] px-1.5 py-0.5 tabular-nums"
        style={{
          background: `color-mix(in srgb, ${tone} ${Math.round(12 + frac * 58)}%, transparent)`,
          color: frac > 0.55 ? 'var(--on-accent)' : 'var(--ink)',
        }}
      >
        {text}
      </span>
    )
  }

  if (col.wrap) {
    return (
      <span
        className="block whitespace-pre-wrap break-words leading-snug"
        style={col.max ? { maxWidth: col.max } : undefined}
      >
        {text}
      </span>
    )
  }
  if (col.max) {
    return (
      <span
        className="inline-block overflow-hidden text-ellipsis whitespace-nowrap align-bottom text-muted"
        style={{ maxWidth: col.max }}
        title={String(value ?? '')}
      >
        {text}
      </span>
    )
  }
  return <>{text}</>
}

/** Every field of one row, in full — what the columns left out. */
function ExpandedRow({ row, span }: { row: Row; span: number }) {
  const entries = Object.entries(row).filter(([k]) => k !== '__series')
  return (
    <tr className="border-t bg-surface-2/40">
      <td colSpan={span} className="px-3 py-2">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12.5px]">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-xxs font-medium uppercase tracking-wide text-muted pt-0.5">{k}</dt>
              <dd className="whitespace-pre-wrap break-all font-mono text-[12px] leading-snug">
                {v == null ? '—' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      </td>
    </tr>
  )
}

function DeclaredTable({ w }: { w: QueryTableWidget }) {
  const t = useT()
  const cols = w.cols ?? []
  const paged = useSearchAndPage(w.rows, w.pp, w.search ?? undefined, w.filter_by)

  const scales = useMemo(() => {
    const m: Record<string, { min: number; max: number }> = {}
    for (const c of cols) {
      if (c.display !== 'bar' && c.display !== 'heat') continue
      const nums = w.rows.map((r) => Number(r[c.key])).filter((n) => Number.isFinite(n))
      if (nums.length) m[c.key] = { min: Math.min(...nums, 0), max: Math.max(...nums) }
    }
    return m
  }, [cols, w.rows])

  const [open, setOpen] = useState<number | null>(null)
  const fracOf = (c: TableColumn, v: unknown): number | null => {
    const s = scales[c.key]
    if (!s) return null
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    const span = s.max - s.min || 1
    return Math.min(1, Math.max(0, (n - s.min) / span))
  }

  return (
    <div className="-mx-1 overflow-x-auto">
      <PanelControls paged={paged} search={w.search ?? false} cols={cols} />
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-xxs font-medium uppercase tracking-wide text-muted">
            {cols.map((c) => (
              <th
                key={c.key}
                className={clsx('px-2 py-1.5 font-medium', c.align === 'r' && 'text-right')}
              >
                {c.label ?? c.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {w.rows.length === 0 && (
            <tr>
              <td colSpan={cols.length}>
                <EmptyState compact icon={<IconInbox size={22} />} title={t('no_data')} />
              </td>
            </tr>
          )}
          {paged.slice.map((row: Row, i) => {
            const href = rowHref(w, row)
            const expandable = !href && !!w.expand
            const isOpen = expandable && open === i
            return [
              <tr
                key={i}
                className={clsx('border-t', (href || expandable) && 'cursor-pointer hover:bg-hover', isOpen && 'bg-hover')}
                onClick={expandable ? () => setOpen(isOpen ? null : i) : undefined}
              >
                {cols.map((c) => {
                  const frac = c.display ? fracOf(c, row[c.key]) : null
                  const cell = <DeclaredCell col={c} value={row[c.key]} frac={frac} />
                  const inner = href ? (
                    <Link to={href} className="block">
                      {cell}
                    </Link>
                  ) : (
                    cell
                  )
                  return (
                    <td
                      key={c.key}
                      className={clsx('h-9 px-2', c.align === 'r' && 'text-right tabular-nums', c.wrap && 'py-1.5 align-top')}
                    >
                      {inner}
                    </td>
                  )
                })}
              </tr>,
              isOpen ? <ExpandedRow key={`${i}-x`} row={row} span={cols.length} /> : null,
            ]
          })}
        </tbody>
      </table>
      <TableFooter w={w} paged={paged} />
    </div>
  )
}

function TableFooter({
  w,
  paged,
}: {
  w: QueryTableWidget
  paged: ReturnType<typeof useSearchAndPage>
}) {
  const t = useT()
  const total = w.total ?? w.rows.length
  const narrowed = paged.matched !== w.rows.length || w.total != null
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="px-2 pt-1.5 text-xxs text-muted">
        {narrowed ? t('showing_of', { shown: String(paged.matched), total: String(total) }) : null}
      </div>
      <Pager page={paged.page} pages={paged.pages} setPage={paged.setPage} />
    </div>
  )
}



const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function fmtLoose(v: unknown): string {
  if (v == null) return '\u2014'
  if (typeof v === 'string' && ISO_LIKE.test(v)) return fmtDateTime(v)
  return String(v)
}

/// `panel { table = "<slug>" }` — the panel shows the configured screen's own
/// list, so its columns, widgets, formats and permissions are the ones the
/// table already declares rather than a guess from result-row keys.
function ScreenTable({ w }: { w: ScreenTableWidget }) {
  const meta = useMeta()
  const t = useT()
  const slug = w.table
  const table = meta.tables.find((tb) => tb.name === slug)
  const pp = w.pp ?? 10
  const qs = new URLSearchParams({ pp: String(pp) })
  if (w.sort) qs.set('sort', w.sort)
  const { data, isPending, error } = useQuery({
    queryKey: ['panel-table', slug, qs.toString()],
    queryFn: () => api.list(slug, qs.toString()),
  })
  if (!table) return <div className="p-3 text-xs text-muted">{t('unknown_table')}</div>
  if (error) return <div className="p-3 text-xs text-critical">{String(error)}</div>
  if (isPending) return <div className="p-3 text-xs text-muted">…</div>
  const cols = table.columns.filter((c) => table.list.columns.includes(c.name))
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-xxs font-medium uppercase tracking-wide text-muted">
            {cols.map((c) => (
              <th key={c.name} className="px-2 py-1.5 font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(data?.rows ?? []).map((row, i) => (
            <tr key={i} className="border-t border-line/60">
              {cols.map((c) => (
                <td key={c.name} className="px-2 py-1.5">
                  <CellValue col={c} row={row} value={row[c.name]} mode="list" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WidgetTable({ w }: { w: TableWidget }) {
  return w.table !== undefined ? <ScreenTable w={w} /> : <QueryTable w={w} />
}

/// Panel tables can carry thousands of rows (a listing does), so they search
/// and page in place rather than scrolling forever. `pp` sets the page size;
/// `search = true` adds the box. Both work on the rows the panel already has.
function useSearchAndPage(
  rows: Row[],
  pp?: number | null,
  searchable?: boolean,
  filterBy?: string[] | null,
) {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const size = Math.max(1, pp ?? 50)
  const needle = q.trim().toLowerCase()

  const options = useMemo(() => filterOptions(rows, filterBy), [rows, filterBy])
  const kept = useMemo(() => applyFilters(rows, picked), [rows, picked])

  const matched = useMemo(() => {
    if (!searchable || !needle) return kept
    return kept.filter((r) =>
      Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(needle)),
    )
  }, [kept, needle, searchable])
  const pages = Math.max(1, Math.ceil(matched.length / size))
  const current = Math.min(page, pages - 1)
  return {
    slice: matched.slice(current * size, current * size + size),
    matched: matched.length,
    page: current,
    pages,
    setPage,
    q,
    setQ: (v: string) => {
      setQ(v)
      setPage(0)
    },
    options,
    picked,
    pick: (key: string, v: string) => {
      setPicked((p) => ({ ...p, [key]: v }))
      setPage(0)
    },
  }
}

/// A panel's own controls: the dropdowns `filter_by` asked for, then the search
/// box. Both narrow this panel alone — a page-wide control is a `variable`.
export function PanelControls({
  paged,
  search,
  cols,
}: {
  paged: ReturnType<typeof useSearchAndPage>
  search: boolean
  cols?: TableColumn[]
}) {
  const t = useT()
  const keys = Object.keys(paged.options)
  if (!keys.length && !search) return null
  // A control must name its column the way the header does, or the same data
  // appears under two names on one screen.
  const labelOf = (key: string) =>
    cols?.find((c) => c.key === key)?.label ?? key.replace(/_/g, ' ')
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5">
      {keys.map((key) => (
        <select
          key={key}
          value={paged.picked[key] ?? ''}
          onChange={(e) => paged.pick(key, e.target.value)}
          className="rounded border border-line bg-surface px-1.5 py-1 text-xs text-ink focus:border-accent focus:outline-none"
        >
          <option value="">{t('filter_all', { label: labelOf(key) })}</option>
          {paged.options[key].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ))}
      {search && (
        <div className="min-w-[8rem] flex-1">
          <SearchBox value={paged.q} onChange={paged.setQ} />
        </div>
      )}
    </div>
  )
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT()
  return (
    <div>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('search_rows')}
        className="w-full rounded border border-line bg-surface px-2 py-1 text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none"
      />
    </div>
  )
}

function Pager({
  page,
  pages,
  setPage,
}: {
  page: number
  pages: number
  setPage: (n: number) => void
}) {
  const t = useT()
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-end gap-2 px-2 pt-1.5 text-xxs text-muted">
      <button
        type="button"
        className="rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-40"
        onClick={() => setPage(page - 1)}
        disabled={page === 0}
      >
        ‹
      </button>
      <span className="tabular-nums">{t('page_of', { page: String(page + 1), pages: String(pages) })}</span>
      <button
        type="button"
        className="rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-40"
        onClick={() => setPage(page + 1)}
        disabled={page + 1 >= pages}
      >
        ›
      </button>
    </div>
  )
}

function QueryTable({ w }: { w: QueryTableWidget }) {
  const meta = useMeta()
  const t = useT()
  if (w.cols && w.cols.length > 0)
    return (
      <DeclaredTable w={w} />
    )
  const table = meta.tables.find((tb) => tb.name === w.link)
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-xxs font-medium uppercase tracking-wide text-muted">
            {w.columns.map((c) => (
              <th key={c} className="px-2 py-1.5 font-medium">
                {c.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {w.rows.length === 0 && (
            <tr>
              <td colSpan={w.columns.length}>
                <EmptyState compact icon={<IconInbox size={22} />} title={t('no_data')} />
              </td>
            </tr>
          )}
          {w.rows.map((row: Row, i) => {
            const href = rowHref(w, row)
            return (
              <tr key={i} className={clsx('border-t', href && 'cursor-pointer hover:bg-hover')}>
                {w.columns.map((c) => {
                  const colMeta = table?.columns.find((cm) => cm.name === c)
                  const cell = colMeta ? (
                    <CellValue col={colMeta} value={row[c]} row={row} mode="list" pkName={table?.pk ?? w.pk ?? ''} tableName={w.link ?? ''} />
                  ) : (
                    fmtLoose(row[c])
                  )
                  return (
                    <td
                      key={c}
                      className={clsx(
                        'h-9 px-2',
                        colMeta && NUMERIC_WIDGETS.has(colMeta.widget) && 'text-right tabular-nums',
                      )}
                    >
                      {href ? (
                        <Link to={href} className="block">
                          {cell}
                        </Link>
                      ) : (
                        cell
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CardFrame({
  label,
  action,
  interactive,
  children,
}: {
  label: string
  action?: React.ReactNode
  interactive?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={clsx('card flex h-full flex-col p-4', interactive && 'card-interactive')}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-[13px] font-medium text-sec">{label}</div>
        {action}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

export function WidgetCard({ w }: { w: Widget }) {
  if (w.type === 'stat') return <Stat w={w} />
  if (w.type === 'chart') {
    return (
      <CardFrame label={w.label}>
        <Chart kind={w.kind} points={w.points} series={w.series} format={w.format} />
      </CardFrame>
    )
  }
  if (w.type === 'table') {
    return (
      <CardFrame
        label={w.label}
        interactive={!!w.link}
        action={
          w.link ? (
            <Link to={`/${w.link}`} className="text-xxs text-muted hover:text-ink">
              {w.link} →
            </Link>
          ) : undefined
        }
      >
        <WidgetTable w={w} />
      </CardFrame>
    )
  }
  return <IframePanel w={w} />
}

/// `{{theme}}` in an iframe url becomes the viewer's actual theme, so embedded
/// content (a Grafana panel, say) follows the admin instead of staying stuck on
/// whichever theme the config author happened to write.
function IframePanel({ w }: { w: { label: string; url?: string | null } }) {
  const theme = useResolvedTheme()
  const src = (w.url ?? '').replace(/\{\{\s*theme\s*\}\}/g, theme)
  return (
    <CardFrame
      label={w.label}
      action={
        <a href={src} target="_blank" rel="noreferrer" className="text-xxs text-muted hover:text-ink">
          ↗
        </a>
      }
    >
      <iframe
        key={theme}
        src={src}
        title={w.label}
        className="h-72 w-full rounded-ctl border bg-page"
        sandbox="allow-scripts allow-same-origin"
      />
    </CardFrame>
  )
}

function DashboardGrid({ widgets, columns = DEFAULT_COLS }: { widgets: Widget[]; columns?: number }) {
  const stats = widgets.filter((w) => w.type === 'stat')
  const rest = widgets.filter((w) => w.type !== 'stat')
  return (
    <div className="space-y-3">
      {stats.length > 0 && (
        // Stat tiles share the page grid so `w` means the same thing on a tile
        // as on a table. An auto-fit track was stretching a lone tile across the
        // whole page — a single number rendered a metre wide reads as broken.
        <div className={clsx('grid grid-flow-row-dense gap-3', gridColsClass(columns))}>
          {stats.map((w) => (
            <div key={w.id} className={spanClass(w, columns)}>
              <WidgetCard w={w} />
            </div>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className={clsx('grid grid-flow-row-dense gap-3', gridColsClass(columns))}>
          {rest.map((w) => (
            <div key={w.id} className={spanClass(w, columns)}>
              <WidgetCard w={w} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function groupWidgets(widgets: Widget[]): Array<{ title: string | null; items: Widget[] }> {
  const order: string[] = []
  const byCat = new Map<string, Widget[]>()
  for (const w of widgets) {
    const key = w.category ?? ''
    if (!byCat.has(key)) {
      byCat.set(key, [])
      order.push(key)
    }
    byCat.get(key)!.push(w)
  }
  return order.map((key) => ({ title: key || null, items: byCat.get(key)! }))
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={`s${i}`} className="card flex min-h-[132px] flex-col justify-between p-4">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={`c${i}`} className="card p-4 md:col-span-2">
          <Skeleton className="mb-4 h-2.5 w-28" />
          <Skeleton className="h-40 w-full" />
        </div>
      ))}
    </div>
  )
}

function DashboardView({ widgets, columns = DEFAULT_COLS }: { widgets: Widget[]; columns?: number }) {
  const t = useT()
  if (widgets.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={<IconDashboard size={30} />}
          title={t('dashboard_ready')}
          description={t('dashboard_ready_hint')}
        />
      </div>
    )
  }

  if (!widgets.some((w) => w.category)) return <DashboardGrid widgets={widgets} columns={columns} />

  return (
    <div className="space-y-8">
      {groupWidgets(widgets).map((g, i) => (
        <section key={g.title ?? `_${i}`}>
          {g.title && (
            <div className="mb-3 flex items-center gap-3">
              <h2 className="text-xxs font-semibold uppercase tracking-[0.08em] text-muted">
                {g.title}
              </h2>
              <div className="h-px flex-1 bg-gridline" />
            </div>
          )}
          <DashboardGrid widgets={g.items} columns={columns} />
        </section>
      ))}
    </div>
  )
}

/// `refresh = "30s"` on a page or the dashboard turns it into a live view.
///
/// The interval is read from the response, so it must be a callback — reading
/// the query's own `data` while building its options is a use-before-init.
/// Never polls a hidden tab: a forgotten dashboard is otherwise a load
/// generator pointed at production, re-running every panel's SQL forever.
const livePolling = {
  refetchInterval: (query: { state: { data?: DashboardResponse } }) => {
    const secs = query.state.data?.refresh_secs
    return secs ? secs * 1000 : false
  },
  refetchIntervalInBackground: false,
}

export default function Dashboard() {
  const meta = useMeta()
  const vq = useVarQuery()
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', vq],
    queryFn: () => api.dashboard(vq),
    enabled: meta.has_dashboard,
    placeholderData: (prev) => prev,
    ...livePolling,
  })

  if (meta.tables.length === 0 && meta.can_manage_access) {
    return <Navigate to="/_setup" replace />
  }
  if (!meta.has_dashboard) {
    const first = meta.tables[0]
    return <Navigate to={first ? `/${first.name}` : '/audit'} replace />
  }
  if (isLoading) return <LoadingGrid />
  return (
    <div className="space-y-4">
      <VarBar only={data?.variables} />
      {error ? (
        <div className="card p-4 text-[13px] text-critical">{String(error)}</div>
      ) : (
        <DashboardView widgets={data?.widgets ?? []} columns={data?.columns ?? DEFAULT_COLS} />
      )}
    </div>
  )
}

export function PageDashboard() {
  const { '*': id = '' } = useParams()
  const meta = useMeta()
  const vq = useVarQuery()
  const known = meta.pages?.some((p) => p.id === id)
  const { data, isLoading } = useQuery({
    queryKey: ['page-widgets', id, vq],
    queryFn: () => api.pageWidgets(id, vq),
    enabled: known,
    placeholderData: (prev) => prev,
    ...livePolling,
  })

  if (!known) return <Navigate to="/" replace />
  if (isLoading) return <LoadingGrid />
  return (
    <div className="space-y-4">
      {(data?.label || (data?.variables?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          {data?.label ? <h1 className="text-lg font-semibold text-ink">{data.label}</h1> : <span />}
          <VarBar only={data?.variables} />
        </div>
      )}
      <DashboardView widgets={data?.widgets ?? []} columns={data?.columns ?? DEFAULT_COLS} />
    </div>
  )
}
