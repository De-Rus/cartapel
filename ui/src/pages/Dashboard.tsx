import { useMemo } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '../api/client'
import type {
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
import { useMeta } from '../lib/meta'
import { VarBar, useVarQuery } from '../components/VarBar'
import { Badge, CellValue, NUMERIC_WIDGETS } from '../components/CellValue'
import { Chart, Sparkline } from '../components/Chart'
import { EmptyState } from '../components/EmptyState'
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
    default:
      return 'grid-cols-1 md:grid-cols-2 xl:grid-cols-4'
  }
}

function spanClass(w: Widget, columns: number): string {
  const want = w.w ?? (w.type === 'stat' ? 1 : 2)
  const cols = Math.min(want, columns)
  const base =
    cols >= 4
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

function DeclaredTable({ w }: { w: QueryTableWidget }) {
  const t = useT()
  const cols = w.cols ?? []

  const scales = useMemo(() => {
    const m: Record<string, { min: number; max: number }> = {}
    for (const c of cols) {
      if (c.display !== 'bar' && c.display !== 'heat') continue
      const nums = w.rows.map((r) => Number(r[c.key])).filter((n) => Number.isFinite(n))
      if (nums.length) m[c.key] = { min: Math.min(...nums, 0), max: Math.max(...nums) }
    }
    return m
  }, [cols, w.rows])

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
          {w.rows.map((row: Row, i) => {
            const href = rowHref(w, row)
            return (
              <tr key={i} className={clsx('border-t', href && 'cursor-pointer hover:bg-hover')}>
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
                      className={clsx('h-9 px-2', c.align === 'r' && 'text-right tabular-nums')}
                    >
                      {inner}
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

function TruncatedNote({ w }: { w: QueryTableWidget }) {
  const t = useT()
  if (!w.total) return null
  return (
    <div className="px-2 pt-1.5 text-xxs text-muted">
      {t('showing_of', { shown: String(w.rows.length), total: String(w.total) })}
    </div>
  )
}

function QueryTable({ w }: { w: QueryTableWidget }) {
  const meta = useMeta()
  const t = useT()
  if (w.cols && w.cols.length > 0)
    return (
      <>
        <DeclaredTable w={w} />
        <TruncatedNote w={w} />
      </>
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
  return (
    <CardFrame
      label={w.label}
      action={
        <a href={w.url} target="_blank" rel="noreferrer" className="text-xxs text-muted hover:text-ink">
          ↗
        </a>
      }
    >
      <iframe
        src={w.url}
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
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
          {stats.map((w) => (
            <WidgetCard key={w.id} w={w} />
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className={clsx('grid gap-3', gridColsClass(columns))}>
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

export default function Dashboard() {
  const meta = useMeta()
  const vq = useVarQuery()
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', vq],
    queryFn: () => api.dashboard(vq),
    enabled: meta.has_dashboard,
    placeholderData: (prev) => prev,
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
      <VarBar />
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
  })

  if (!known) return <Navigate to="/" replace />
  if (isLoading) return <LoadingGrid />
  return (
    <div className="space-y-4">
      {data?.label && <h1 className="text-lg font-semibold text-ink">{data.label}</h1>}
      <VarBar />
      <DashboardView widgets={data?.widgets ?? []} columns={data?.columns ?? DEFAULT_COLS} />
    </div>
  )
}
