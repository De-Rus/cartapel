import { BASE } from './base'
const nf = new Intl.NumberFormat('es')
const nf2 = new Intl.NumberFormat('es', { maximumFractionDigits: 2 })
const nfCompact = new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 })

export function fmtInt(n: number): string {
  return nf.format(n)
}

export function fmtNumber(n: number): string {
  return Number.isInteger(n) ? nf.format(n) : nf2.format(n)
}

export function isIdColumn(
  name: string,
  opts: { pk?: string; kind?: string; fk?: boolean } = {},
): boolean {
  return (
    name === opts.pk || name === 'id' || name.endsWith('_id') || (opts.kind === 'int' && !!opts.fk)
  )
}

export function fmtCompact(n: number): string {
  return Math.abs(n) >= 10000 ? nfCompact.format(n) : nf2.format(n)
}

export function fmtMoney(n: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('es', { style: 'currency', currency }).format(n)
  } catch {
    return `${nf2.format(n)} ${currency}`
  }
}

export function fmtPercent(n: number): string {
  return `${nf2.format(n)} %`
}

export function fmtDuration(seconds: number): string {
  const s = Math.abs(seconds)
  if (s < 1) return `${Math.round(s * 1000)} ms`
  if (s < 60) return `${nf2.format(seconds)} s`
  const units: Array<[string, number]> = [
    ['d', 86400],
    ['h', 3600],
    ['min', 60],
    ['s', 1],
  ]
  const parts: string[] = []
  let rest = Math.round(s)
  for (const [label, size] of units) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)} ${label}`)
      rest %= size
      if (parts.length === 2) break
    }
  }
  return parts.join(' ') || '0 s'
}

export function fmtRelative(value: unknown): string {
  if (value == null || value === '') return ''
  const ms =
    typeof value === 'number' ? (value > 1e12 ? value : value * 1000) : Date.parse(String(value))
  if (Number.isNaN(ms)) return String(value)
  const secs = (Date.now() - ms) / 1000
  return secs < 0 ? fmtDateTime(String(value)) : `${fmtDuration(secs)} ago`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  for (const u of units) {
    v /= 1024
    if (v < 1024) return `${nf2.format(Math.round(v * 10) / 10)} ${u}`
  }
  return `${nf2.format(v)} PB`
}

const dtf = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const df = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export function fmtDateTime(isoStr: string): string {
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return isoStr
  return dtf.format(d).replace(',', '')
}

export function fmtDate(isoStr: string): string {
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return isoStr
  return df.format(d)
}

export function ageSeconds(isoStr: string): number {
  return (Date.now() - Date.parse(isoStr)) / 1000
}

export function relTime(isoStr: string): string {
  const secs = ageSeconds(isoStr)
  if (Number.isNaN(secs)) return isoStr
  const abs = Math.abs(secs)
  let text: string
  if (abs < 45) text = `${Math.max(1, Math.round(abs))} s`
  else if (abs < 3600) text = `${Math.round(abs / 60)} min`
  else if (abs < 86400) text = `${Math.round(abs / 3600)} h`
  else if (abs < 86400 * 60) text = `${Math.round(abs / 86400)} d`
  else text = `${Math.round(abs / (86400 * 30))} meses`
  return secs >= 0 ? `hace ${text}` : `en ${text}`
}

export function truncateUuid(v: string): string {
  return v.length > 8 ? `${v.slice(0, 4)}…` : v
}

export function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''))
}

export function fmtByFormat(value: number, format?: string, currency?: string): string {
  switch (format) {
    case 'money':
      return fmtMoney(value, currency ?? 'USD')
    case 'percent':
      return fmtPercent(value)
    case 'duration':
      return fmtDuration(value)
    default:
      return fmtCompact(value)
  }
}

export interface FormatOpts {
  format?: string
  prefix?: string
  suffix?: string
  truncate?: number
  currency?: string
}

export function applyAffix(
  s: string,
  opts: { prefix?: string; suffix?: string; truncate?: number },
): string {
  let out = s
  if (opts.prefix) out = opts.prefix + out
  if (opts.suffix) out = out + opts.suffix
  if (opts.truncate && opts.truncate > 0 && out.length > opts.truncate) {
    out = `${out.slice(0, opts.truncate)}…`
  }
  return out
}

export function applyFormat(value: unknown, opts: FormatOpts = {}): string {
  let s: string
  switch (opts.format) {
    case 'currency':
    case 'money':
      s = fmtMoney(Number(value), opts.currency ?? 'USD')
      break
    case 'percent':
    case 'pct':
      s = fmtPercent(Number(value))
      break
    case 'number':
    case 'num':
      s = fmtNumber(Number(value))
      break
    case 'bytes':
      s = fmtBytes(Number(value))
      break
    case 'duration':
    case 'dur':
      s = fmtDuration(Number(value))
      break
    case 'date':
      s = fmtDate(String(value))
      break
    case 'datetime':
      s = fmtDateTime(String(value))
      break
    case 'rel':
      s = fmtRelative(value)
      break
    default:
      s = String(value ?? '')
  }
  return applyAffix(s, opts)
}

const HREF_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:'])

export function interpolateHref(template: string, row: Record<string, unknown>): string {
  const raw = template
    .replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(row[k] ?? '')))
    .trim()
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)
  if (scheme) return HREF_SCHEMES.has(`${scheme[1].toLowerCase()}:`) ? raw : '#'
  if (raw.startsWith('//')) return '#'
  if (raw.startsWith('/')) return `${BASE}${raw}` // in-app absolute path → keep it inside the mount prefix
  if (raw.startsWith('#') || raw.startsWith('?')) return raw
  return '#'
}
