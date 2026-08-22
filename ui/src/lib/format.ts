import { BASE } from './base'

// Formatters follow the viewer's locale; `useLocale` calls setFormatLocale
// whenever it changes, before anything renders rows.
let nf = new Intl.NumberFormat('en')
let nf2 = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })
let nf1 = new Intl.NumberFormat('en', { maximumFractionDigits: 1 })
let moneyLocale = 'en'

/** Axis formatters live in Chart.tsx but must follow the same locale, so they
 *  are rebuilt from here rather than built once at import. */
const axisSubscribers: Array<(loc: string) => void> = []
export function onFormatLocale(fn: (loc: string) => void): void {
  axisSubscribers.push(fn)
  fn(moneyLocale)
}

export function setFormatLocale(locale: string | null | undefined): void {
  // A config that names no locale gets English, like the rest of the panel —
  // this defaulted to 'es', so an English instance showed 1693,00 US$.
  const loc = locale || 'en'
  if (loc === moneyLocale) return
  moneyLocale = loc
  nf = new Intl.NumberFormat(loc)
  nf2 = new Intl.NumberFormat(loc, { maximumFractionDigits: 2 })
  nf1 = new Intl.NumberFormat(loc, { maximumFractionDigits: 1 })
  dtf = new Intl.DateTimeFormat(loc, DTF_OPTS)
  df = new Intl.DateTimeFormat(loc, DF_OPTS)
  for (const fn of axisSubscribers) fn(loc)
}

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

// K/M/B are the dashboard vernacular in every locale; Intl's compact notation
// spells them out in the instance language ("17,9 mil", "17,9 тыс.") which
// reads as prose, not as a metric. The locale still owns the decimal separator.
/** Axis ticks: short above a thousand, so a label never outgrows its gutter. */
export function fmtTick(n: number): string {
  const abs = Math.abs(n)
  if (abs > 0 && abs < 0.01) return n.toPrecision(2)
  if (abs < 1000) return nf2.format(n)
  if (abs >= 1e9) return nf1.format(n / 1e9) + 'B'
  if (abs >= 1e6) return nf1.format(n / 1e6) + 'M'
  return nf1.format(n / 1e3) + 'K'
}

export function fmtCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs < 10000) return nf2.format(n)
  if (abs >= 1e9) return nf1.format(n / 1e9) + 'B'
  if (abs >= 1e6) return nf1.format(n / 1e6) + 'M'
  return nf1.format(n / 1e3) + 'K'
}

export function fmtMoney(n: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat(moneyLocale, { style: 'currency', currency }).format(n)
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

const DTF_OPTS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}
const DF_OPTS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
}
let dtf = new Intl.DateTimeFormat('es', DTF_OPTS)
let df = new Intl.DateTimeFormat('es', DF_OPTS)

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
    case 'bytes':
      return fmtBytes(value)
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
