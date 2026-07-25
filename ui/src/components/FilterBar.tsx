import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { FilterMeta, TableMeta } from '../api/types'
import {
  type Condition,
  conditionsFromParams,
  needsValue,
  opsForKind,
} from '../lib/filters'
import { useClickOutside } from '../lib/hooks'
import { useT } from '../lib/i18n'
import { IconPlus, IconX } from './Icons'

function filterOps(f: FilterMeta) {
  if (f.ops && f.ops.length) return f.ops
  if (f.type === 'bool') return ['eq'] as const
  return opsForKind(f.kind)
}

function candidates(table: TableMeta): FilterMeta[] {
  if (table.list.filters.length) return table.list.filters
  return table.columns
    .filter((c) => !['json', 'binary'].includes(c.kind))
    .map((c) => ({
      name: c.name,
      label: c.label ?? c.name,
      type: c.kind === 'bool' ? ('bool' as const) : ('custom' as const),
      options: [],
      kind: c.kind,
    }))
}

function ValueInput({
  filter,
  cond,
  autoFocus,
  onChange,
  onCommit,
}: {
  filter: FilterMeta | undefined
  cond: Condition
  autoFocus?: boolean
  onChange: (v: string) => void
  onCommit: () => void
}) {
  const t = useT()
  if (!needsValue(cond.op)) return null
  if (filter?.type === 'bool') {
    return (
      <select className="input-sm w-full" value={cond.value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }
  if (filter?.type === 'enum' && filter.options.length && (cond.op === 'eq' || cond.op === 'ne')) {
    return (
      <select className="input-sm w-full" value={cond.value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {filter.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  if (filter?.type === 'date' && cond.op === 'eq') {
    return (
      <select className="input-sm w-full" value={cond.value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        <option value="today">{t('date_today')}</option>
        <option value="7d">{t('date_7d')}</option>
        <option value="30d">{t('date_30d')}</option>
        <option value="90d">{t('date_90d')}</option>
      </select>
    )
  }
  const placeholder =
    cond.op === 'between' ? 'a..b' : cond.op === 'in' ? 'a,b,c' : t('flt_value_ph')
  return (
    <input
      className="input-sm w-full tabular-nums"
      value={cond.value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit()
      }}
    />
  )
}

function ChipEditor({
  filter,
  cond,
  isNew,
  onChange,
  onRemove,
  onClose,
}: {
  filter: FilterMeta | undefined
  cond: Condition
  isNew: boolean
  onChange: (c: Condition) => void
  onRemove: () => void
  onClose: () => void
}) {
  const t = useT()
  const ref = useClickOutside(onClose)
  const ops = filter ? filterOps(filter) : opsForKind(undefined)
  return (
    <div ref={ref} className="pop-in absolute left-0 top-full z-30 mt-1 w-60 rounded-card bg-surface1 p-2.5 shadow-menu">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xxs font-semibold uppercase tracking-wide text-muted">
          {filter?.label ?? cond.col}
        </span>
        <button
          type="button"
          className="text-xxs text-muted hover:text-critical"
          onClick={onRemove}
        >
          {t('flt_remove')}
        </button>
      </div>
      <div className="space-y-1.5">
        <select
          className="input-sm w-full"
          value={cond.op}
          onChange={(e) => {
            const op = e.target.value as Condition['op']
            onChange({ ...cond, op, ...(needsValue(op) ? {} : { value: '' }) })
          }}
        >
          {ops.map((op) => (
            <option key={op} value={op}>
              {t(`flt_op_${op}`)}
            </option>
          ))}
        </select>
        <ValueInput
          filter={filter}
          cond={cond}
          autoFocus={isNew}
          onChange={(value) => onChange({ ...cond, value })}
          onCommit={onClose}
        />
      </div>
    </div>
  )
}

function AddFilter({
  options,
  onPick,
  onClose,
}: {
  options: FilterMeta[]
  onPick: (f: FilterMeta) => void
  onClose: () => void
}) {
  const t = useT()
  const ref = useClickOutside(onClose)
  const [q, setQ] = useState('')
  const shown = options.filter((f) => f.label.toLowerCase().includes(q.toLowerCase()) || f.name.includes(q.toLowerCase()))
  return (
    <div ref={ref} className="pop-in absolute left-0 top-full z-30 mt-1 w-52 rounded-card bg-surface1 p-1.5 shadow-menu">
      <input
        autoFocus
        className="input-sm mb-1 w-full"
        placeholder={t('flt_search_prop')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown.length > 0) onPick(shown[0])
          if (e.key === 'Escape') onClose()
        }}
      />
      <div className="max-h-56 overflow-auto">
        {shown.map((f) => (
          <button
            key={f.name}
            type="button"
            className="block w-full rounded-ctl px-2 py-1 text-left text-[13px] text-sec hover:bg-surface2 hover:text-ink"
            onClick={() => onPick(f)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Notion-style filter chips: each active condition is a chip whose popover
 *  edits operator + value LIVE; "+ Filtro" opens a searchable property picker.
 *  A condition missing its value stays a local draft and never hits the URL. */
export function FilterBar({
  table,
  entries,
  onApply,
}: {
  table: TableMeta
  entries: Array<[string, string]>
  onApply: (conditions: Condition[]) => void
}) {
  const t = useT()
  const filters = candidates(table)
  const applied = conditionsFromParams(entries)
  const [draft, setDraft] = useState<Condition | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const appliedKey = entries.map(([k, v]) => `${k}=${v}`).join('&')
  const lastKey = useRef(appliedKey)
  useEffect(() => {
    if (lastKey.current !== appliedKey) {
      lastKey.current = appliedKey
      setEditing((e) => (e !== null && e >= applied.length ? null : e))
    }
  }, [appliedKey, applied.length])

  const valid = (c: Condition) => !needsValue(c.op) || c.value.trim() !== ''

  const applyAt = (i: number, c: Condition) => {
    const next = applied.map((x, idx) => (idx === i ? c : x))
    if (valid(c)) onApply(next)
  }

  const removeAt = (i: number) => {
    setEditing(null)
    onApply(applied.filter((_, idx) => idx !== i))
  }

  const fm = (col: string) => filters.find((f) => f.name === col)
  // A raw-SQL filter_def is an on/off toggle — no operator, no value editor.
  const isToggle = (f: FilterMeta | undefined) => f?.type === 'custom' && !f.kind
  const chipValue = (c: Condition) =>
    !needsValue(c.op) ? '' : c.value === '__null__' ? t('filter_empty') : c.value

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {applied.map((c, i) => (
        <span key={`${c.col}-${i}`} className="relative">
          <button
            type="button"
            className={clsx(
              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xxs',
              editing === i ? 'border-accent text-ink' : 'text-sec hover:text-ink',
            )}
            onClick={() => {
              if (!isToggle(fm(c.col))) setEditing(editing === i ? null : i)
            }}
          >
            <span className="text-muted">{fm(c.col)?.label ?? c.col}</span>
            {!isToggle(fm(c.col)) && <span className="text-muted">{t(`flt_op_${c.op}`)}</span>}
            {!isToggle(fm(c.col)) && chipValue(c) && <span className="font-medium">{chipValue(c)}</span>}
            <span
              role="button"
              tabIndex={-1}
              aria-label={t('flt_remove')}
              className="ml-0.5 text-muted hover:text-ink"
              onClick={(e) => {
                e.stopPropagation()
                removeAt(i)
              }}
            >
              <IconX size={10} />
            </span>
          </button>
          {editing === i && (
            <ChipEditor
              filter={fm(c.col)}
              cond={c}
              isNew={false}
              onChange={(nc) => applyAt(i, nc)}
              onRemove={() => removeAt(i)}
              onClose={() => setEditing(null)}
            />
          )}
        </span>
      ))}

      {draft && (
        <span className="relative">
          <button type="button" className="flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xxs text-sec">
            <span className="text-muted">{fm(draft.col)?.label ?? draft.col}</span>
            <span className="text-muted">{t(`flt_op_${draft.op}`)}</span>
          </button>
          <ChipEditor
            filter={fm(draft.col)}
            cond={draft}
            isNew
            onChange={(nc) => {
              if (valid(nc)) {
                setDraft(null)
                onApply([...applied, nc])
                setEditing(applied.length)
              } else {
                setDraft(nc)
              }
            }}
            onRemove={() => setDraft(null)}
            onClose={() => {
              if (!valid(draft)) setDraft(null)
            }}
          />
        </span>
      )}

      <span className="relative">
        <button
          type="button"
          className="flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xxs text-muted hover:text-ink"
          onClick={() => setAdding(!adding)}
        >
          <IconPlus size={10} /> {t('flt_add_filter')}
        </button>
        {adding && (
          <AddFilter
            options={filters}
            onPick={(f) => {
              setAdding(false)
              if (isToggle(f)) {
                onApply([...applied, { col: f.name, op: 'eq', value: '1' }])
                return
              }
              const ops = filterOps(f)
              setDraft({ col: f.name, op: ops[0], value: '' })
            }}
            onClose={() => setAdding(false)}
          />
        )}
      </span>

      {applied.length > 0 && (
        <button
          type="button"
          className="text-xxs text-muted hover:text-ink"
          onClick={() => onApply([])}
        >
          {t('clear_all')}
        </button>
      )}
    </div>
  )
}
