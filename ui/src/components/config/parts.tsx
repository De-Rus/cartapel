import { useState } from 'react'
import clsx from 'clsx'
import { moveItem } from '../../lib/configModel'
import { ColumnPicker, type ColumnLike } from './pickers'

export function Section({
  title,
  hint,
  right,
  children,
}: {
  title: string
  hint?: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          {hint && <div className="text-xxs text-muted">{hint}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

export function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xxs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={clsx(
        'inline-flex items-center gap-2 rounded-ctl border px-2.5 py-1 text-[13px] transition-colors',
        checked ? 'accent-soft border-transparent' : 'text-muted hover:text-sec',
      )}
    >
      <span
        className={clsx(
          'inline-block h-3.5 w-6 rounded-full p-0.5 transition-colors',
          checked ? 'bg-accent' : 'bg-surface3',
        )}
      >
        <span
          className={clsx(
            'block h-2.5 w-2.5 rounded-full bg-white transition-transform',
            checked && 'translate-x-2.5',
          )}
        />
      </span>
      {label}
    </button>
  )
}

export function Chip({
  label,
  active,
  onClick,
  title,
}: {
  label: string
  active: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={clsx(
        'rounded-full border px-2.5 py-1 text-xxs font-medium transition-colors',
        active ? 'accent-soft border-transparent' : 'text-muted hover:text-sec',
      )}
    >
      {label}
    </button>
  )
}

/**
 * A checkbox list whose rows are drag-reorderable. `order` is the full ordered
 * list of keys; `checked` marks which are on. Emits both on change.
 */
export function OrderedChecklist({
  order,
  checked,
  onReorder,
  onToggle,
  labelFor,
}: {
  order: string[]
  checked: Set<string>
  onReorder: (next: string[]) => void
  onToggle: (key: string) => void
  labelFor?: (key: string) => string
}) {
  const [drag, setDrag] = useState<number | null>(null)
  return (
    <div className="card divide-y overflow-hidden">
      {order.map((key, i) => (
        <div
          key={key}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => {
            e.preventDefault()
            if (drag !== null && drag !== i) {
              onReorder(moveItem(order, drag, i))
              setDrag(i)
            }
          }}
          onDragEnd={() => setDrag(null)}
          className={clsx(
            'flex items-center gap-2 px-2.5 py-1.5 text-[13px]',
            drag === i ? 'bg-selected' : 'hover:bg-hover',
          )}
        >
          <span className="cursor-grab select-none text-muted" aria-hidden>
            ⠿
          </span>
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <input
              type="checkbox"
              checked={checked.has(key)}
              onChange={() => onToggle(key)}
              aria-label={key}
            />
            <span className={clsx('truncate font-mono', checked.has(key) ? 'text-sec' : 'text-muted')}>
              {labelFor ? labelFor(key) : key}
            </span>
          </label>
        </div>
      ))}
    </div>
  )
}

/** An editable key→value map (both strings). */
export function KeyValueEditor({
  entries,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  colorValues,
  keyOptions,
}: {
  entries: Record<string, string>
  onChange: (next: Record<string, string>) => void
  keyPlaceholder: string
  valuePlaceholder: string
  colorValues?: readonly string[]
  keyOptions?: readonly ColumnLike[]
}) {
  const [newKey, setNewKey] = useState('')
  const setVal = (k: string, v: string) => onChange({ ...entries, [k]: v })
  const remove = (k: string) => {
    const next = { ...entries }
    delete next[k]
    onChange(next)
  }
  const addKey = (k: string) => {
    const key = k.trim()
    if (!key || key in entries) return
    onChange({ ...entries, [key]: colorValues ? colorValues[0] : '' })
    setNewKey('')
  }
  const availableKeys = keyOptions?.filter((c) => !(c.name in entries))
  return (
    <div className="space-y-1.5">
      {Object.entries(entries).map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <span className="w-28 shrink-0 truncate font-mono text-[13px] text-sec">{k}</span>
          {colorValues ? (
            <select className="input-sm flex-1" value={v} onChange={(e) => setVal(k, e.target.value)}>
              {colorValues.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input-sm flex-1 font-mono"
              value={v}
              placeholder={valuePlaceholder}
              onChange={(e) => setVal(k, e.target.value)}
            />
          )}
          {colorValues && (
            <span
              className="h-4 w-4 shrink-0 rounded-full border"
              style={{ background: `var(--badge-${v})` }}
              aria-hidden
            />
          )}
          <button type="button" className="px-1 text-muted hover:text-critical" onClick={() => remove(k)}>
            ✕
          </button>
        </div>
      ))}
      {/* The add control is a ROW like the ones above it, sharing their key
          column width. Rendered bare it sat on its own, left-aligned against a
          wide empty gutter, reading as a stray dropdown rather than as the next
          line of the list it appends to. */}
      {availableKeys ? (
        <div className="flex items-center gap-1.5">
          <ColumnPicker
            className="input-sm w-28 shrink-0"
            columns={availableKeys}
            value={undefined}
            emptyLabel={keyPlaceholder}
            ariaLabel={keyPlaceholder}
            onChange={(v) => v && addKey(v)}
          />
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            className="input-sm w-28 shrink-0 font-mono"
            value={newKey}
            placeholder={keyPlaceholder}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addKey(newKey)
              }
            }}
          />
          <button type="button" className="btn" onClick={() => addKey(newKey)}>
            +
          </button>
        </div>
      )}
    </div>
  )
}
