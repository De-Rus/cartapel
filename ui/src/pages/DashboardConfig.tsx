import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type {
  ConfigPublishResult,
  ConfigPut,
  Widget,
  WidgetConfigData,
  WidgetKindData,
} from '../api/types'
import { lineDiff, diffStat, type DiffLine } from '../lib/diff'
import { relTime } from '../lib/format'
import { useT, type TFn } from '../lib/i18n'
import { useDirtyGuard } from '../lib/hooks'
import { useMeta } from '../lib/meta'
import { WidgetCard } from './Dashboard'
import { EnumSelect, RoleMultiSelect, TablePicker, type TableLike } from '../components/config/pickers'
import { ReadOnlyNotice } from '../components/config/ReadOnlyNotice'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { IconCheck, IconChevronDown, IconDashboard, IconPlus, IconX } from '../components/Icons'

const KINDS: WidgetKindData[] = ['stat', 'chart', 'table', 'iframe']
const CHART_KINDS = ['line', 'bar', 'area']
const FORMATS = ['number', 'money', 'percent', 'duration']
const GOOD_WHEN = ['up', 'down']

function needsSql(kind: WidgetKindData): boolean {
  return kind === 'stat' || kind === 'chart' || kind === 'table'
}

function serializeDash(widgets: WidgetConfigData[] | null, columns: number | undefined): string {
  return JSON.stringify({ widgets, columns: columns ?? null })
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xxs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  )
}

function numOrUndef(v: string): number | undefined {
  const n = Number(v)
  return v.trim() === '' || Number.isNaN(n) ? undefined : n
}

function PreviewPane({ widget }: { widget: WidgetConfigData }) {
  const t = useT()
  const [result, setResult] = useState<Widget | null>(null)
  const mut = useMutation({
    mutationFn: () => api.dashboardPreview(widget),
    onSuccess: (r) => setResult(r.widget),
  })
  useEffect(() => {
    mut.mutate()
    // run once on mount; manual refresh afterwards
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xxs font-medium uppercase tracking-wide text-muted">{t('cfg_dash_preview')}</span>
        <button
          type="button"
          className="text-xxs text-muted hover:text-ink"
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
        >
          {mut.isPending ? t('running') : t('cfg_dash_preview_run')}
        </button>
      </div>
      {mut.isError ? (
        <div className="rounded-ctl border bg-surface2 px-2.5 py-2 text-xxs text-critical">
          {mut.error instanceof ApiError
            ? mut.error.message.includes('preview is disabled')
              ? t('cfg_dash_preview_off')
              : mut.error.message
            : t('cfg_dash_preview_failed')}
        </div>
      ) : result ? (
        <WidgetCard w={result} />
      ) : (
        <div className="rounded-ctl border border-dashed px-2.5 py-4 text-center text-xxs text-muted">
          {t('cfg_dash_preview_hint')}
        </div>
      )}
    </div>
  )
}

function WidgetEditor({
  widget,
  index,
  count,
  tables,
  roles,
  t,
  onChange,
  onMove,
  onRemove,
}: {
  widget: WidgetConfigData
  index: number
  count: number
  tables: TableLike[]
  roles: string[]
  t: TFn
  onChange: (w: WidgetConfigData) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const set = (patch: Partial<WidgetConfigData>) => onChange({ ...widget, ...patch })

  return (
    <div className="card p-3">
      <div className="flex items-center gap-2">
        <div className="relative">
          <select
            className="input-sm appearance-none pr-6 font-medium"
            value={widget.type}
            onChange={(e) => set({ type: e.target.value as WidgetKindData })}
            aria-label={t('cfg_dash_kind')}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`cfg_dash_kind_${k}`)}
              </option>
            ))}
          </select>
          <IconChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted" />
        </div>
        <input
          className="input-sm min-w-0 flex-1 font-medium"
          value={widget.label}
          placeholder={t('cfg_dash_label')}
          aria-label={t('cfg_dash_label')}
          onChange={(e) => set({ label: e.target.value })}
        />
        <button
          type="button"
          className="rounded-ctl p-1 text-muted hover:text-ink disabled:opacity-30"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={t('cfg_dash_up')}
        >
          ↑
        </button>
        <button
          type="button"
          className="rounded-ctl p-1 text-muted hover:text-ink disabled:opacity-30"
          onClick={() => onMove(1)}
          disabled={index === count - 1}
          aria-label={t('cfg_dash_down')}
        >
          ↓
        </button>
        <button
          type="button"
          className="rounded-ctl p-1 text-muted hover:text-critical"
          onClick={onRemove}
          aria-label={t('cfg_dash_remove')}
        >
          <IconX size={15} />
        </button>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('cfg_dash_id')}>
              <input
                className="input-sm w-full font-mono"
                value={widget.id ?? ''}
                onChange={(e) => set({ id: e.target.value || undefined })}
              />
            </Field>
            {widget.type !== 'iframe' && (
              <Field label={t('cfg_dash_format')}>
                <EnumSelect
                  className="w-full"
                  value={widget.format ?? undefined}
                  emptyLabel={t('cfg_field_default')}
                  options={FORMATS.map((f) => ({ value: f, label: t(`cfg_dash_format_${f}`) }))}
                  onChange={(v) => set({ format: v })}
                />
              </Field>
            )}
          </div>

          {needsSql(widget.type) && (
            <Field label={t('cfg_dash_sql')}>
              <textarea
                className="input-sm min-h-[64px] w-full font-mono"
                value={widget.sql ?? ''}
                onChange={(e) => set({ sql: e.target.value || undefined })}
              />
            </Field>
          )}

          {widget.type === 'stat' && (
            <>
              <Field label={t('cfg_dash_compare_sql')}>
                <textarea
                  className="input-sm min-h-[44px] w-full font-mono"
                  value={widget.compare_sql ?? ''}
                  onChange={(e) => set({ compare_sql: e.target.value || undefined })}
                />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label={t('cfg_dash_compare_label')}>
                  <input
                    className="input-sm w-full"
                    value={widget.compare_label ?? ''}
                    onChange={(e) => set({ compare_label: e.target.value || undefined })}
                  />
                </Field>
                <Field label={t('cfg_dash_alert_above')}>
                  <input
                    className="input-sm w-full tabular-nums"
                    inputMode="decimal"
                    value={widget.alert_above ?? ''}
                    onChange={(e) => set({ alert_above: numOrUndef(e.target.value) })}
                  />
                </Field>
                <Field label={t('cfg_dash_alert_below')}>
                  <input
                    className="input-sm w-full tabular-nums"
                    inputMode="decimal"
                    value={widget.alert_below ?? ''}
                    onChange={(e) => set({ alert_below: numOrUndef(e.target.value) })}
                  />
                </Field>
              </div>
              <Field label={t('cfg_dash_spark')}>
                <textarea
                  className="input-sm min-h-[44px] w-full font-mono"
                  value={widget.spark ?? ''}
                  placeholder={t('cfg_dash_spark_hint')}
                  onChange={(e) => set({ spark: e.target.value || undefined })}
                />
              </Field>
              <Field label={t('cfg_dash_good_when')}>
                <EnumSelect
                  className="w-full"
                  value={widget.good_when ?? 'up'}
                  options={GOOD_WHEN.map((g) => ({ value: g, label: t(`cfg_dash_good_when_${g}`) }))}
                  onChange={(v) => set({ good_when: v && v !== 'up' ? v : undefined })}
                />
              </Field>
            </>
          )}

          {widget.type === 'chart' && (
            <Field label={t('cfg_dash_chart')}>
              <EnumSelect
                className="w-full"
                value={widget.chart ?? 'line'}
                options={CHART_KINDS.map((c) => ({ value: c, label: t(`cfg_dash_chart_${c}`) }))}
                onChange={(v) => set({ chart: v ?? 'line' })}
              />
            </Field>
          )}

          {widget.type === 'table' && (
            <Field label={t('cfg_dash_link')}>
              <TablePicker
                className="w-full"
                tables={tables}
                value={widget.link ?? undefined}
                emptyLabel="—"
                ariaLabel={t('cfg_dash_link')}
                onChange={(v) => set({ link: v })}
              />
            </Field>
          )}

          {widget.type === 'iframe' && (
            <Field label={t('cfg_dash_url')}>
              <input
                className="input-sm w-full font-mono"
                value={widget.url ?? ''}
                placeholder="https://…"
                onChange={(e) => set({ url: e.target.value || undefined })}
              />
            </Field>
          )}

          <div className="grid grid-cols-3 gap-3">
            <Field label={t('cfg_dash_span')}>
              <EnumSelect
                className="w-full"
                value={widget.w != null ? String(widget.w) : undefined}
                emptyLabel={t('cfg_dash_auto')}
                options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
                onChange={(v) => set({ w: v ? Number(v) : undefined })}
              />
            </Field>
            <Field label={t('cfg_dash_rows')}>
              <EnumSelect
                className="w-full"
                value={widget.h != null ? String(widget.h) : undefined}
                emptyLabel={t('cfg_dash_auto')}
                options={[1, 2].map((n) => ({ value: String(n), label: String(n) }))}
                onChange={(v) => set({ h: v ? Number(v) : undefined })}
              />
            </Field>
            <Field label={t('cfg_dash_category')}>
              <input
                className="input-sm w-full"
                value={widget.category ?? ''}
                onChange={(e) => set({ category: e.target.value || undefined })}
              />
            </Field>
          </div>

          <Field label={t('cfg_dash_roles')}>
            <RoleMultiSelect
              roles={roles}
              value={widget.roles ?? []}
              ariaLabel={t('cfg_dash_roles')}
              onChange={(r) => set({ roles: r.length ? r : undefined })}
            />
          </Field>
        </div>

        <PreviewPane widget={widget} />
      </div>
    </div>
  )
}

const rowBg = (op: DiffLine['op']): string | undefined => {
  if (op === 'add') return 'color-mix(in srgb, var(--good) 15%, transparent)'
  if (op === 'del') return 'color-mix(in srgb, var(--critical) 15%, transparent)'
  return undefined
}
const sign = (op: DiffLine['op']): string => (op === 'add' ? '+' : op === 'del' ? '−' : ' ')

function DashboardHistory({
  onPublished,
  onReadOnly,
}: {
  onPublished: () => void
  onReadOnly: (hcl: string) => void
}) {
  const t = useT()
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [pubError, setPubError] = useState<string | null>(null)

  const versionsQ = useQuery({ queryKey: ['dashboardVersions'], queryFn: api.dashboardVersions })
  const versions = useMemo(() => versionsQ.data?.versions ?? [], [versionsQ.data])
  const published = versions.find((v) => v.published) ?? null

  useEffect(() => {
    if (versions.length && !versions.some((v) => v.id === selectedId)) setSelectedId(versions[0].id)
  }, [versions, selectedId])

  const selected = versions.find((v) => v.id === selectedId) ?? null
  const selectedBodyQ = useQuery({
    queryKey: ['dashboardVersion', selectedId],
    queryFn: () => api.dashboardVersion(selectedId as number),
    enabled: selectedId != null,
  })
  const publishedBodyQ = useQuery({
    queryKey: ['dashboardVersion', published?.id],
    queryFn: () => api.dashboardVersion(published?.id as number),
    enabled: published != null,
  })
  const selectedHcl = selectedBodyQ.data?.hcl ?? ''
  const publishedHcl = publishedBodyQ.data?.hcl ?? ''
  const diff = useMemo(() => lineDiff(publishedHcl, selectedHcl), [publishedHcl, selectedHcl])
  const stat = diffStat(diff)

  const publish = useMutation({
    mutationFn: (id: number) => api.publishDashboardVersion(id),
    onSuccess: (res: ConfigPublishResult) => {
      setConfirming(false)
      if (res.ok) {
        onPublished()
        void qc.invalidateQueries({ queryKey: ['dashboardVersions'] })
      } else {
        onReadOnly(res.hcl)
      }
    },
    onError: (e) => {
      setConfirming(false)
      setPubError(e instanceof ApiError ? e.message : t('error'))
    },
  })

  if (versionsQ.isLoading) return <div className="text-[13px] text-muted">{t('cfg_hist_loading')}</div>
  if (versionsQ.isError) return <div className="text-[13px] text-critical">{t('cfg_hist_load_failed')}</div>
  if (!versions.length) return <div className="text-[13px] text-muted">{t('cfg_hist_empty')}</div>

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <ul className="shrink-0 space-y-1 sm:w-56">
        {versions.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => {
                setSelectedId(v.id)
                setPubError(null)
              }}
              className={clsx(
                'w-full rounded-ctl border px-2.5 py-2 text-left transition-colors',
                v.id === selectedId ? 'border-accent bg-surface2' : 'border-transparent hover:bg-hover',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-ink">{relTime(v.created_at)}</span>
                {v.published && (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-good"
                    style={{ background: 'color-mix(in srgb, var(--good) 15%, transparent)' }}
                  >
                    {t('cfg_hist_published')}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-xxs text-muted">{v.actor}</div>
            </button>
          </li>
        ))}
      </ul>

      <div className="min-w-0 flex-1 space-y-2">
        {selected && (
          <>
            <div className="flex items-center gap-2">
              {!selected.published && (stat.added > 0 || stat.removed > 0) && (
                <span className="text-xxs font-medium">
                  <span className="text-good">+{stat.added}</span>{' '}
                  <span className="text-critical">−{stat.removed}</span>
                </span>
              )}
              <div className="flex-1" />
              {selected.published ? (
                <span className="inline-flex items-center gap-1 text-xxs text-muted">
                  <IconCheck size={12} className="text-good" /> {t('cfg_hist_is_published')}
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setPubError(null)
                    setConfirming(true)
                  }}
                >
                  {t('cfg_hist_publish')}
                </button>
              )}
            </div>
            {pubError && (
              <div className="rounded-ctl border bg-surface2 px-2.5 py-1.5 text-xxs text-critical">{pubError}</div>
            )}
            <pre className="max-h-[46vh] overflow-auto rounded-card border bg-page font-mono text-[12px] leading-relaxed">
              {diff.map((l, i) => (
                <div
                  key={i}
                  className={clsx('flex gap-2 px-2', l.op === 'add' ? 'text-good' : l.op === 'del' ? 'text-critical' : 'text-sec')}
                  style={{ background: rowBg(l.op) }}
                >
                  <span className="select-none opacity-60">{sign(l.op)}</span>
                  <span className="whitespace-pre-wrap break-all">{l.text}</span>
                </div>
              ))}
            </pre>
          </>
        )}
      </div>

      {confirming && selected && (
        <Modal title={t('cfg_hist_publish_confirm_title')} onClose={() => setConfirming(false)}>
          <p className="text-[13px] text-sec">
            {t('cfg_hist_publish_confirm', { time: relTime(selected.created_at), actor: selected.actor })}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={publish.isPending}>
              {t('cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => publish.mutate(selected.id)}
              disabled={publish.isPending}
            >
              {publish.isPending ? t('cfg_hist_publishing') : t('cfg_hist_publish')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

export default function DashboardConfig() {
  const t = useT()
  const meta = useMeta()
  const qc = useQueryClient()
  const toast = useToast()
  const tables = useMemo<TableLike[]>(
    () => meta.tables.map((tb) => ({ name: tb.name, label: tb.label })),
    [meta.tables],
  )
  const roles = useMemo(() => meta.roles ?? [], [meta.roles])

  const { data, isLoading, isError } = useQuery({ queryKey: ['dashboardConfig'], queryFn: api.dashboardConfig })

  const [tab, setTab] = useState<'edit' | 'history'>('edit')
  const [widgets, setWidgets] = useState<WidgetConfigData[] | null>(null)
  const [columns, setColumns] = useState<number | undefined>(undefined)
  const [baseline, setBaseline] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [readonlyHcl, setReadonlyHcl] = useState<string | null>(null)

  const stateRef = useRef({ widgets, columns, baseline })
  stateRef.current = { widgets, columns, baseline }

  useEffect(() => {
    if (!data) return
    const { widgets: cur, columns: curCols, baseline: base } = stateRef.current
    const serverKey = serializeDash(data.widgets, data.columns ?? undefined)
    const isDirty = cur != null && serializeDash(cur, curCols) !== base
    if (isDirty && serverKey !== base) {
      toast(t('cfg_dash_history_dirty'))
      setBaseline(serverKey)
      return
    }
    setWidgets(data.widgets)
    setColumns(data.columns ?? undefined)
    setBaseline(serverKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const dirty = widgets != null && serializeDash(widgets, columns) !== baseline
  useDirtyGuard(dirty)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['dashboardConfig'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
    void qc.invalidateQueries({ queryKey: ['dashboardVersions'] })
  }

  const save = useMutation({
    mutationFn: () => api.putDashboardConfig(widgets!, columns),
    onSuccess: (res: ConfigPut) => {
      if (res.ok) {
        toast(t('cfg_dash_saved'))
        setReadonlyHcl(null)
        setBaseline(serializeDash(widgets, columns))
        invalidate()
      } else {
        setReadonlyHcl(res.hcl)
      }
    },
    onError: (e) => setSaveError(e instanceof ApiError ? e.message : t('error')),
  })

  if (isLoading) return <div className="card px-4 py-10 text-center text-muted">{t('loading')}</div>
  if (isError || !widgets || !data) {
    return <div className="card px-4 py-10 text-center text-critical">{t('cfg_dash_load_failed')}</div>
  }

  const setWidget = (i: number, w: WidgetConfigData) =>
    setWidgets((ws) => (ws ? ws.map((x, k) => (k === i ? w : x)) : ws))
  const removeWidget = (i: number) => setWidgets((ws) => (ws ? ws.filter((_, k) => k !== i) : ws))
  const moveWidget = (i: number, dir: -1 | 1) =>
    setWidgets((ws) => {
      if (!ws) return ws
      const j = i + dir
      if (j < 0 || j >= ws.length) return ws
      const next = [...ws]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const addWidget = () =>
    setWidgets((ws) => [...(ws ?? []), { type: 'stat', label: '' }])

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <IconDashboard size={20} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold text-ink">{t('cfg_dash_title')}</h1>
          <p className="text-[13px] text-muted">{t('cfg_dash_subtitle')}</p>
        </div>
        {tab === 'edit' && (
          <>
            <label className="flex items-center gap-2 self-center text-xxs font-medium uppercase tracking-wide text-muted">
              {t('cfg_dash_columns')}
              <EnumSelect
                value={columns != null ? String(columns) : undefined}
                emptyLabel={t('cfg_dash_auto')}
                ariaLabel={t('cfg_dash_columns')}
                options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
                onChange={(v) => setColumns(v ? Number(v) : undefined)}
              />
            </label>
            <button className="btn" onClick={addWidget}>
              <IconPlus size={14} /> {t('cfg_dash_add')}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setSaveError(null)
                setReadonlyHcl(null)
                save.mutate()
              }}
              disabled={!dirty || save.isPending}
            >
              {save.isPending ? t('saving') : t('save')}
            </button>
          </>
        )}
      </div>

      <div className="flex gap-1 border-b">
        {(['edit', 'history'] as const).map((tb) => (
          <button
            key={tb}
            type="button"
            onClick={() => setTab(tb)}
            className={clsx(
              'border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
              tab === tb ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-sec',
            )}
          >
            {tb === 'edit' ? t('cfg_dash_tab_edit') : t('cfg_dash_tab_history')}
          </button>
        ))}
      </div>

      {readonlyHcl !== null ? (
        <ReadOnlyNotice hcl={readonlyHcl} file="dashboard.hcl" onBack={() => setReadonlyHcl(null)} />
      ) : tab === 'history' ? (
        <DashboardHistory
          onPublished={() => {
            toast(t('cfg_hist_published_toast'))
            invalidate()
          }}
          onReadOnly={setReadonlyHcl}
        />
      ) : (
        <div className="space-y-3">
          {saveError && <div className="text-xxs text-critical">{saveError}</div>}
          {widgets.length === 0 && (
            <div className="card px-4 py-10 text-center text-muted">{t('cfg_dash_empty')}</div>
          )}
          {widgets.map((w, i) => (
            <WidgetEditor
              key={i}
              widget={w}
              index={i}
              count={widgets.length}
              tables={tables}
              roles={roles}
              t={t}
              onChange={(nw) => setWidget(i, nw)}
              onMove={(dir) => moveWidget(i, dir)}
              onRemove={() => removeWidget(i)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
