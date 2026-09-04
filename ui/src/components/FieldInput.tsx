import { useState } from 'react'
import clsx from 'clsx'
import type { ColumnMeta, Row } from '../api/types'
import { customWidgetName } from '../lib/widgets'
import { useT } from '../lib/i18n'
import { CustomWidget } from './CustomWidget'
import { FkSelect } from './FkSelect'

function toLocalInput(value: unknown): string {
  if (typeof value !== 'string') return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function JsonInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() =>
    value == null ? '' : JSON.stringify(value, null, 2),
  )
  const [invalid, setInvalid] = useState(false)
  return (
    <div>
      <textarea
        className={clsx('input w-full font-mono text-xs leading-5', invalid && 'border-critical')}
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        value={text}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          if (!t.trim()) {
            setInvalid(false)
            onChange(null)
            return
          }
          try {
            onChange(JSON.parse(t))
            setInvalid(false)
          } catch {
            setInvalid(true)
          }
        }}
        spellCheck={false}
      />
      {invalid && <JsonInvalidHint />}
    </div>
  )
}

function JsonInvalidHint() {
  const t = useT()
  return <p className="mt-1 text-xxs text-critical">{t('json_invalid')}</p>
}

export function FieldInput({
  col,
  tableName,
  value,
  row,
  onChange,
}: {
  col: ColumnMeta
  tableName: string
  value: unknown
  row: Row
  onChange: (value: unknown, fkLabel?: string) => void
}) {
  const params = col.params as { colors?: Record<string, string>; currency?: string }
  const custom = customWidgetName(col.widget)
  if (custom) {
    return (
      <CustomWidget
        name={custom}
        row={row}
        params={col.params}
        mode="detail"
        value={value}
        onChange={onChange}
        fallback={<span className="text-sm text-sec">{value == null ? '—' : String(value)}</span>}
      />
    )
  }

  switch (col.widget) {
    case 'toggle':
      return (
        <button
          type="button"
          role="switch"
          aria-checked={!!value}
          className={clsx(
            'relative h-5 w-9 rounded-full border transition-colors',
            value ? 'border-transparent bg-accent' : 'bg-page',
          )}
          onClick={() => onChange(!value)}
        >
          <span
            className={clsx(
              'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all',
              value ? 'left-[18px]' : 'left-0.5',
            )}
          />
        </button>
      )
    case 'textarea':
      return (
        <textarea
          className="input w-full"
          rows={3}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'number':
    case 'money':
    case 'percent':
    case 'duration':
      return (
        <input
          type="number"
          step="any"
          className="input w-full tabular-nums"
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      )
    case 'datetime':
      return (
        <input
          type="datetime-local"
          className="input w-full tabular-nums"
          value={toLocalInput(value)}
          onChange={(e) =>
            onChange(e.target.value ? new Date(e.target.value).toISOString() : null)
          }
        />
      )
    case 'badge': {
      const opts = Object.keys(params.colors ?? {})
      if (opts.length > 0) {
        return (
          <select
            className="input w-full"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value || null)}
          >
            {col.nullable && <option value="">—</option>}
            {opts.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        )
      }
      return (
        <input
          className="input w-full"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    }
    case 'json':
      return <JsonInput value={value} onChange={onChange} />
    case 'code':
      return (
        <textarea
          className="input w-full font-mono text-xs leading-5"
          rows={Math.min(16, Math.max(4, String(value ?? '').split('\n').length + 1))}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      )
    case 'fk':
      return (
        <FkSelect
          table={tableName}
          col={col.name}
          value={value}
          label={(row[`${col.name}__label`] as string | undefined) ?? String(value ?? '')}
          nullable={col.nullable}
          onChange={(v, label) => onChange(v, label)}
        />
      )
    case 'array':
      return (
        <input
          className="input w-full"
          value={Array.isArray(value) ? value.join(', ') : String(value ?? '')}
          placeholder="a, b, c"
          onChange={(e) =>
            onChange(
              e.target.value.trim() === ''
                ? []
                : e.target.value.split(',').map((s) => s.trim()),
            )
          }
        />
      )
    default:
      return (
        <input
          className="input w-full"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}
