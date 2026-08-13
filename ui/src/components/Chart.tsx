import { useMemo, useState } from 'react'
import type { ChartPoint, ChartSeries } from '../api/types'
import { fmtByFormat, fmtCompact, fmtDateTime, onFormatLocale } from '../lib/format'
import { useElementWidth } from '../lib/hooks'
import { useT } from '../lib/i18n'
import { EmptyState } from './EmptyState'
import { IconInbox } from './Icons'

const HEIGHT = 190
const PAD = { l: 46, r: 10, t: 10, b: 22 }
const RAMP = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8']
const MAX_BAR = 34

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * p >= v) return m * p
  }
  return 10 * p
}

function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`
}

// Built once at import with a hardcoded locale, these were the one place the
// instance's language could not reach.
let dayFmt = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' })
let hourFmt = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' })
onFormatLocale((loc) => {
  dayFmt = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short' })
  hourFmt = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' })
})

export function Chart({
  kind,
  points,
  series,
  format,
}: {
  kind: 'line' | 'bar' | 'area'
  points: ChartPoint[]
  series?: ChartSeries[]
  format?: string
}) {
  const t = useT()
  const [wrapRef, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const multi = series && series.length > 1
  const lines = useMemo<ChartSeries[]>(
    () => (multi ? series! : [{ label: '', points }]),
    [multi, series, points],
  )

  const isTime = points.length > 0 && !Number.isNaN(Date.parse(points[0].t))
  const labelAt = (i: number): string =>
    isTime ? '' : points[i].t

  const model = useMemo(() => {
    if (points.length === 0 || width < 60) return null
    const iw = width - PAD.l - PAD.r
    const ih = HEIGHT - PAD.t - PAD.b
    const allVals = lines.flatMap((s) => s.points.map((p) => p.v))
    const yMax = niceMax(Math.max(...allVals, 0))
    const y = (v: number) => PAD.t + ih - (v / yMax) * ih
    const n = points.length
    const band = iw / n
    const x = (i: number) => (kind === 'bar' ? PAD.l + band * i + band / 2 : PAD.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1)))
    const spanMs = Date.parse(points[n - 1].t) - Date.parse(points[0].t)
    const timeFmt = spanMs >= 3 * 86400_000 ? dayFmt : hourFmt
    const yTicks = [0, 1, 2, 3].map((k) => (yMax * k) / 3)
    const xTicks = isTime
      ? (() => {
          const c = Math.max(2, Math.min(5, Math.floor(iw / 90)))
          return Array.from({ length: c }, (_, k) => Math.round(((n - 1) * k) / (c - 1)))
        })()
      : Array.from({ length: n }, (_, i) => i)
    return { iw, ih, yMax, y, x, band, timeFmt, yTicks, xTicks, n }
  }, [points, width, kind, lines, isTime])

  if (points.length === 0) {
    return (
      <div className="flex h-[190px] items-center justify-center">
        <EmptyState compact icon={<IconInbox size={22} />} title={t('no_data')} />
      </div>
    )
  }

  if (!multi && points.length === 1) {
    return (
      <div className="flex h-[190px] flex-col items-center justify-center gap-1">
        <div className="text-[34px] font-semibold leading-none tabular-nums text-ink">
          {fmtByFormat(points[0].v, format)}
        </div>
        <div className="text-xxs text-muted">
          {isTime ? fmtDateTime(points[0].t) : points[0].t}
        </div>
      </div>
    )
  }

  const baseline = HEIGHT - PAD.b

  const linePathFor = (s: ChartSeries) =>
    model
      ? s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${model.x(i).toFixed(1)},${model.y(p.v).toFixed(1)}`).join(' ')
      : ''

  return (
    <div ref={wrapRef} className="relative">
      {multi && (
        <div className="mb-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {lines.map((s, i) => (
            <span key={s.label} className="flex items-center gap-1 text-xxs text-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: `var(${RAMP[i % RAMP.length]})` }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      {model && (
        <svg
          width={width}
          height={HEIGHT}
          onMouseLeave={() => setHover(null)}
          role="img"
        >
          <defs>
            <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--s1)" stopOpacity="0.95" />
              <stop offset="100%" stopColor="var(--s1)" stopOpacity="0.55" />
            </linearGradient>
          </defs>
          {model.yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={width - PAD.r} y1={model.y(v)} y2={model.y(v)} stroke="var(--gridline)" strokeWidth={1} />
              <text
                x={PAD.l - 8}
                y={model.y(v) + 3.5}
                textAnchor="end"
                fontSize={11}
                fill="var(--muted)"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {fmtCompact(v)}
              </text>
            </g>
          ))}
          {model.xTicks.map((i) => (
            <text
              key={i}
              x={model.x(i)}
              y={HEIGHT - 6}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {isTime ? model.timeFmt.format(new Date(points[i].t)) : labelAt(i)}
            </text>
          ))}

          {kind === 'area' && !multi && (
            <path
              d={`${linePathFor(lines[0])} L${model.x(model.n - 1).toFixed(1)},${baseline} L${model.x(0).toFixed(1)},${baseline} Z`}
              fill="var(--s1)"
              fillOpacity={0.12}
            />
          )}
          {(kind === 'line' || kind === 'area') &&
            lines.map((s, si) => (
              <path
                key={si}
                d={linePathFor(s)}
                fill="none"
                stroke={`var(${RAMP[si % RAMP.length]})`}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            ))}
          {kind === 'bar' &&
            points.map((p, i) => {
              const bw = Math.min(MAX_BAR, Math.max(3, model.band - 8))
              const h = Math.max(0, baseline - model.y(p.v))
              return (
                <path
                  key={i}
                  d={barPath(model.x(i) - bw / 2, model.y(p.v), bw, h, 4)}
                  fill="url(#barGrad)"
                  fillOpacity={hover === null || hover === i ? 1 : 0.4}
                />
              )
            })}

          {hover !== null && (
            <>
              <line
                x1={model.x(hover)}
                x2={model.x(hover)}
                y1={PAD.t}
                y2={baseline}
                stroke="var(--muted)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {kind !== 'bar' &&
                lines.map((s, si) => (
                  <circle
                    key={si}
                    cx={model.x(hover)}
                    cy={model.y(s.points[hover]?.v ?? 0)}
                    r={3.5}
                    fill={`var(${RAMP[si % RAMP.length]})`}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                ))}
            </>
          )}

          {points.map((_, i) => (
            <rect
              key={i}
              x={model.x(i) - model.band / 2}
              y={0}
              width={model.band}
              height={HEIGHT}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
      )}
      {model && hover !== null && (
        <div
          className="chart-tip card px-2.5 py-1.5 text-xs shadow-pop"
          style={{
            left: Math.min(Math.max(model.x(hover), 60), width - 60),
            top: kind === 'bar' ? model.y(points[hover].v) : model.y(lines[0].points[hover]?.v ?? 0),
          }}
        >
          {multi ? (
            <>
              {lines.map((s, si) => (
                <div key={si} className="flex items-center gap-1.5 tabular-nums text-ink">
                  <span className="h-2 w-2 rounded-full" style={{ background: `var(${RAMP[si % RAMP.length]})` }} />
                  <span className="text-muted">{s.label}</span>
                  <span className="ml-auto font-medium">{fmtByFormat(s.points[hover]?.v ?? 0, format)}</span>
                </div>
              ))}
              <div className="mt-0.5 tabular-nums text-muted">
                {isTime ? fmtDateTime(points[hover].t) : points[hover].t}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium tabular-nums text-ink">{fmtByFormat(points[hover].v, format)}</div>
              <div className="tabular-nums text-muted">
                {isTime ? fmtDateTime(points[hover].t) : points[hover].t}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function Sparkline({ values, color = 'var(--s1)', height = 32 }: { values: number[]; color?: string; height?: number }) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>()
  if (values.length < 2) return <div ref={wrapRef} style={{ height }} />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = width || 120
  const x = (i: number) => (w * i) / (values.length - 1)
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4)
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(values.length - 1).toFixed(1)},${height} L0,${height} Z`
  const lastX = x(values.length - 1)
  const lastY = y(values[values.length - 1])
  return (
    <div ref={wrapRef} style={{ height }}>
      {width > 0 && (
        <svg width={w} height={height} role="img" aria-hidden>
          <path d={area} fill={color} fillOpacity={0.1} stroke="none" />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={lastX} cy={lastY} r={2} fill={color} />
        </svg>
      )}
    </div>
  )
}
