import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import type { ColumnMeta, Row } from '../api/types'
import {
  ageSeconds,
  applyAffix,
  applyFormat,
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  interpolate,
  interpolateHref,
  isIdColumn,
  relTime,
  truncateUuid,
} from '../lib/format'
import { colorClass, isCssColor } from '../lib/cellColor'
import { customWidgetName } from '../lib/widgets'
import { useLocale } from '../lib/i18n'
import { CustomWidget } from './CustomWidget'
import { IconCheck, IconCopy } from './Icons'
import { ImageThumb } from './ImageField'
import { JsonTree } from './JsonTree'
import { RemoteGate } from './RemoteValue'

export const NUMERIC_WIDGETS = new Set(['number', 'money', 'percent', 'duration', 'bytes', 'trend', 'heatcell'])

/** A `table` widget column: a bare field name (label = the name), or an
 *  object with an explicit `label` and/or per-locale `labels` overrides —
 *  the same `label`/`labels` shape a `field { }` block uses. */
type TableColumnParam = string | { field: string; label?: string; labels?: Record<string, string> }

function resolveTableColumn(c: TableColumnParam, locale: string): { field: string; label: string } {
  if (typeof c === 'string') return { field: c, label: c }
  const label = c.labels?.[locale] ?? c.label ?? c.field
  return { field: c.field, label }
}

const BADGE_VARS: Record<string, string> = {
  blue: 'var(--badge-blue)',
  green: 'var(--badge-green)',
  orange: 'var(--badge-orange)',
  red: 'var(--badge-red)',
  violet: 'var(--badge-violet)',
  gray: 'var(--badge-gray)',
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function safeImageSrc(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)
  if (!scheme) return raw.startsWith('//') ? null : raw
  const s = scheme[1].toLowerCase()
  if (s === 'https' || s === 'http') return raw
  if (raw.slice(0, 11).toLowerCase() === 'data:image/') return raw
  return null
}

function Empty() {
  return <span className="text-muted">—</span>
}

/// `show` picks what rides next to the bar: the raw value (a count against a
/// ceiling reads as "3", not "0%"), the percentage, both, or nothing.
function progressLabel(
  n: number,
  max: number,
  pct: number,
  params: Record<string, unknown>,
): string {
  switch (params.show) {
    case 'none':
      return ''
    case 'value':
      return fmtNumber(n)
    case 'ratio':
      return `${fmtNumber(n)} / ${fmtNumber(max)}`
    default:
      return `${Math.round(pct)}%`
  }
}

export function Badge({
  value,
  colors,
  labels,
  fallback,
}: {
  value: string
  colors: Record<string, string>
  labels?: Record<string, string>
  fallback?: string
}) {
  const c = BADGE_VARS[colors[value] ?? fallback ?? 'gray'] ?? BADGE_VARS.gray
  return (
    <span className="badge" style={{ '--badge-c': c } as React.CSSProperties}>
      {labels?.[value] ?? value}
    </span>
  )
}

function CopyCell({ value, display }: { value: string; display: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={value}
      className="inline-flex items-center gap-1 font-mono text-[12px] text-sec hover:text-ink"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {display}
      {copied ? (
        <IconCheck size={11} className="text-good" />
      ) : (
        <IconCopy size={11} className="text-muted" />
      )}
    </button>
  )
}

function RelativeTime({ value, warnAfter }: { value: string; warnAfter: number }) {
  const age = ageSeconds(value)
  const cls =
    warnAfter > 0 && age > warnAfter * 4
      ? 'text-critical'
      : warnAfter > 0 && age > warnAfter
        ? 'text-warning'
        : 'text-sec'
  return (
    <span className={clsx('tabular-nums', cls)} title={fmtDateTime(value)}>
      {relTime(value)}
    </span>
  )
}

function flagEmoji(code: string): string | null {
  const cc = code.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(cc)) return null
  return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65))
}

type CellParams = Record<string, unknown> & {
  colors?: Record<string, string>
  currency?: string
  warn_after?: number
  max?: number
  warn_at?: number
  color?: string
  icon?: string
  href?: string
  new_tab?: boolean
  size?: number
  rounded?: boolean
  chars?: number
  min?: number
}

type CellValueProps = {
  col: ColumnMeta
  value: unknown
  row: Row
  mode: 'list' | 'detail'
  pkName?: string
  tableName?: string
}

/** A `remote` field has no value in the row payload — it has to be fetched
 *  first. Gate on that here, once, and hand the fetched value to
 *  `CellValueBody` so every widget (badge, money, date, plain text…) renders
 *  it exactly like it would a normal column's value. */
export function CellValue(props: CellValueProps) {
  const { col, row, mode, pkName, tableName } = props
  if (col.remote) {
    if (!tableName || !pkName) return <Empty />
    return (
      <RemoteGate
        table={tableName}
        col={col.name}
        pk={String(row[pkName] ?? '')}
        auto={mode === 'detail' || !col.remote_lazy}
      >
        {(fetched) => <CellValueBody {...props} value={fetched} />}
      </RemoteGate>
    )
  }
  return <CellValueBody {...props} />
}

function CellValueBody({ col, value, row, mode, pkName, tableName }: CellValueProps) {
  const locale = useLocale()
  if (col.widget === 'image') {
    if (!tableName || !pkName) return <Empty />
    return <ImageThumb table={tableName} col={col} pk={String(row[pkName] ?? '')} row={row} />
  }
  const custom = customWidgetName(col.widget)
  if (custom) {
    return (
      <CustomWidget
        name={custom}
        row={row}
        params={col.params}
        mode={mode}
        fallback={value == null ? <Empty /> : <span>{String(value)}</span>}
      />
    )
  }

  const cls = colorClass(value, col.color)
  const wrap = (node: React.ReactNode) => (cls ? <span className={cls}>{node}</span> : <>{node}</>)
  const relLink = (node: React.ReactNode) =>
    col.ref_table && value != null ? (
      <Link
        to={`/${col.ref_table}/${encodeURIComponent(String(value))}`}
        className="hover:text-accent hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {node}
      </Link>
    ) : (
      node
    )

  if (col.display) return wrap(<span>{interpolate(col.display, row)}</span>)
  if (value === null || value === undefined) return <Empty />

  const params = col.params as CellParams
  const fmt = (builtin: string, raw: unknown = value) =>
    col.format
      ? applyFormat(raw, {
          format: col.format,
          prefix: col.prefix,
          suffix: col.suffix,
          truncate: col.truncate,
          currency: params.currency,
        })
      : applyAffix(builtin, col)

  return wrap(relLink(renderWidget()))

  function renderWidget(): React.ReactNode {
    switch (col.widget) {
      case 'toggle':
        return value ? (
          <IconCheck size={14} className="text-good" />
        ) : (
          <span className="text-muted">—</span>
        )
      case 'badge':
      case 'pill':
        return (
          <Badge
            value={String(value)}
            colors={params.colors ?? {}}
            labels={params.labels as Record<string, string> | undefined}
            fallback={params.fallback as string | undefined}
          />
        )
      case 'tags': {
        const items = Array.isArray(value)
          ? value
          : String(value)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        return (
          <span className="flex flex-wrap gap-1">
            {items.map((v, i) => (
              <Badge key={i} value={String(v)} colors={params.colors ?? {}} />
            ))}
          </span>
        )
      }
      case 'number': {
        if (!col.format && isIdColumn(col.name, { pk: pkName, kind: col.kind, fk: !!col.fk })) {
          return <span className="tabular-nums">{String(value)}</span>
        }
        return <span className="tabular-nums">{fmt(fmtNumber(Number(value)))}</span>
      }
      case 'money':
        return <span className="tabular-nums">{fmt(fmtMoney(Number(value), params.currency))}</span>
      case 'percent': {
        const n = Number(value)
        return (
          <span className={clsx('tabular-nums', mode === 'list' && n < 0 && 'text-serious')}>
            {fmt(fmtPercent(n))}
          </span>
        )
      }
      case 'duration':
        return <span className="tabular-nums">{fmt(fmtDuration(Number(value)))}</span>
      case 'bytes':
        return <span className="tabular-nums">{fmt(fmtBytes(Number(value)))}</span>
      case 'trend': {
        const n = Number(value)
        const tcls = n > 0 ? 'text-good' : n < 0 ? 'text-critical' : 'text-muted'
        const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '—'
        const body = col.format ? fmt('', Math.abs(n)) : fmtNumber(Math.abs(n))
        return (
          <span className={clsx('inline-flex items-center gap-0.5 tabular-nums', tcls)}>
            <span aria-hidden>{arrow}</span>
            {body}
          </span>
        )
      }
      case 'heatcell': {
        const n = Number(value)
        const min = Number(params.min ?? 0)
        const max = Number(params.max ?? 100)
        const t = max > min ? clamp((n - min) / (max - min), 0, 1) : 0
        const pct = Math.round(t * 70)
        return (
          <span
            className="rounded px-1.5 tabular-nums"
            style={{ background: `color-mix(in srgb, var(--accent) ${pct}%, transparent)` }}
          >
            {col.format ? fmt('') : fmtNumber(n)}
          </span>
        )
      }
      case 'progress': {
        const n = Number(value)
        const max = Number(params.max ?? 100)
        const pct = max > 0 ? clamp((n / max) * 100, 0, 100) : 0
        const warnAt = params.warn_at
        const named = params.color ? BADGE_VARS[params.color] : undefined
        const bar =
          warnAt != null && n >= Number(warnAt) ? 'var(--warning)' : named ?? 'var(--accent)'
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className="relative inline-block h-1.5 w-16 overflow-hidden rounded-full bg-surface3">
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${Math.round(pct)}%`, background: bar }}
              />
            </span>
            <span className="tabular-nums text-xxs text-muted">{progressLabel(n, max, pct, params)}</span>
          </span>
        )
      }
      case 'rating': {
        const n = Number(value)
        const max = Math.max(1, Math.round(Number(params.max ?? 5)))
        const icon = typeof params.icon === 'string' && params.icon ? params.icon : '★'
        const filled = clamp(Math.round(n), 0, max)
        return (
          <span className="inline-flex items-center gap-px" title={`${n} / ${max}`} aria-label={`${n} / ${max}`}>
            {Array.from({ length: max }, (_, i) => (
              <span key={i} className={i < filled ? 'text-warning' : 'text-muted opacity-40'}>
                {icon}
              </span>
            ))}
          </span>
        )
      }
      case 'link':
      case 'url': {
        const template = col.href ?? (typeof params.href === 'string' ? params.href : String(value))
        const href = interpolateHref(template, row)
        const label = applyAffix(String(value), col)
        if (href === '#') return <span>{label}</span>
        const newTab = !!params.new_tab
        return (
          <a
            href={href}
            className="text-accent hover:underline"
            target={newTab ? '_blank' : undefined}
            rel={newTab ? 'noopener noreferrer' : undefined}
            onClick={(e) => e.stopPropagation()}
          >
            {label}
          </a>
        )
      }
      case 'email': {
        const v = String(value)
        return (
          <a
            href={interpolateHref('mailto:{v}', { v })}
            className="text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {v}
          </a>
        )
      }
      case 'phone': {
        const v = String(value)
        return (
          <a
            href={interpolateHref('tel:{v}', { v })}
            className="text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {v}
          </a>
        )
      }
      case 'avatar': {
        const size = clamp(Number(params.size ?? 24), 12, 96)
        const rounded = params.rounded !== false
        const src = safeImageSrc(value)
        if (!src) return <span className="text-muted">{String(value)}</span>
        return (
          <img
            src={src}
            alt=""
            width={size}
            height={size}
            loading="lazy"
            referrerPolicy="no-referrer"
            className={clsx('inline-block object-cover', rounded ? 'rounded-full' : 'rounded-md')}
            style={{ width: size, height: size }}
          />
        )
      }
      case 'color': {
        const s = String(value)
        if (!isCssColor(s)) return <span className="font-mono text-[12px]">{s}</span>
        return (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3.5 w-3.5 shrink-0 rounded border"
              style={{ background: s }}
            />
            <span className="font-mono text-[12px] text-muted">{s}</span>
          </span>
        )
      }
      case 'country':
      case 'flag': {
        const code = String(value)
        const emoji = flagEmoji(code)
        return (
          <span className="inline-flex items-center gap-1">
            {emoji && (
              <span aria-hidden className="text-[15px] leading-none">
                {emoji}
              </span>
            )}
            <span>{code.toUpperCase()}</span>
          </span>
        )
      }
      case 'copyable': {
        const v = String(value)
        const short = col.truncate && v.length > col.truncate ? `${v.slice(0, col.truncate)}…` : v
        return <CopyCell value={v} display={short} />
      }
      case 'truncate': {
        const v = String(value)
        const chars = Math.max(1, Math.round(Number(params.chars ?? col.truncate ?? 40)))
        const short = v.length > chars ? `${v.slice(0, chars)}…` : v
        return <span title={v}>{short}</span>
      }
      case 'datetime':
        return <span className="tabular-nums text-sec">{fmt(fmtDateTime(String(value)))}</span>
      case 'relative_time':
        return <RelativeTime value={String(value)} warnAfter={Number(params.warn_after ?? 0)} />
      case 'uuid':
        return <CopyCell value={String(value)} display={truncateUuid(String(value))} />
      case 'json':
        if (mode === 'detail') return <JsonTree value={value} />
        return (
          <span className="font-mono text-[12px] text-muted">
            {JSON.stringify(value).slice(0, 40)}
            {JSON.stringify(value).length > 40 ? '…' : ''}
          </span>
        )
      case 'table': {
        const rows = Array.isArray(value) ? (value as unknown[]) : []
        if (!rows.length) return <Empty />
        const declared = params.columns as TableColumnParam[] | undefined
        const cols =
          declared?.map((c) => resolveTableColumn(c, locale)) ??
          (typeof rows[0] === 'object' && rows[0] !== null
            ? Object.keys(rows[0] as object).map((f) => ({ field: f, label: f }))
            : [])
        if (!cols.length) return <Empty />
        return (
          <table className="w-full text-[12px]">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.field} className="pr-3 text-left font-medium text-muted">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c.field} className="pr-3 text-sec">
                      {String((r as Record<string, unknown>)?.[c.field] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      case 'code':
        if (mode === 'detail')
          return (
            <pre className="max-h-72 overflow-auto rounded-ctl border bg-page p-3 font-mono text-xs leading-5 text-sec">
              {String(value)}
            </pre>
          )
        return (
          <span className="font-mono text-[12px] text-muted">
            {String(value).split('\n')[0].slice(0, 48)}…
          </span>
        )
      case 'fk': {
        const label = (row[`${col.name}__label`] as string | undefined) ?? String(value)
        return <span>{label}</span>
      }
      case 'array': {
        const items = Array.isArray(value) ? value : [value]
        return (
          <span className="flex flex-wrap gap-1">
            {items.map((v, i) => (
              <span key={i} className="rounded-full border px-1.5 py-px text-xxs text-sec">
                {String(v)}
              </span>
            ))}
          </span>
        )
      }
      case 'binary': {
        const size =
          value && typeof value === 'object' && '__bytes__' in value
            ? Number((value as { __bytes__: number }).__bytes__)
            : NaN
        return (
          <span className="text-muted">{Number.isNaN(size) ? 'binario' : fmtBytes(size)}</span>
        )
      }
      case 'masked':
        return <span className="font-mono text-[12px] text-muted">{String(value)}</span>
      case 'textarea': {
        const s = String(value)
        if (mode === 'detail') return <span className="whitespace-pre-wrap text-sec">{s}</span>
        return <span>{s.length > 80 ? `${s.slice(0, 80)}…` : s}</span>
      }
      default:
        return <span>{applyAffix(String(value), col)}</span>
    }
  }
}
