import { useMemo, useState, useEffect } from 'react'
import clsx from 'clsx'

import { AppIcon } from '../../lib/icon'
import { useClickOutside } from '../../lib/hooks'
import { useT } from '../../lib/i18n'
import { IconChevronDown, IconPlus, IconSearch, IconX } from '../Icons'

export interface PickerOption {
  value: string
  label: string
}

export interface ColumnLike {
  name: string
  label?: string
}

export interface TableLike {
  name: string
  label?: string
}

export const HTTP_METHODS: readonly PickerOption[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(
  (m) => ({ value: m, label: m }),
)

export const CURRENCIES: readonly PickerOption[] = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'CNY',
  'HKD',
  'SGD',
  'SEK',
  'NOK',
  'MXN',
  'BRL',
  'INR',
].map((c) => ({ value: c, label: c }))

export const CODE_LANGS: readonly PickerOption[] = [
  'sql',
  'json',
  'js',
  'ts',
  'python',
  'rust',
  'bash',
  'yaml',
  'html',
  'css',
  'go',
  'toml',
  'markdown',
].map((l) => ({ value: l, label: l }))

// Loaded lazily — the lucide name map is ~550KB and must stay out of the entry.
let iconNamesCache: string[] | null = null
function useIconNames(): readonly string[] {
  const [names, setNames] = useState<readonly string[]>(iconNamesCache ?? [])
  useEffect(() => {
    if (iconNamesCache) return
    void import('lucide-react/dynamic').then((m) => {
      iconNamesCache = Object.keys(m.dynamicIconImports)
      setNames(iconNamesCache)
    })
  }, [])
  return names
}

export function filterOptions(
  options: readonly PickerOption[],
  query: string,
  limit?: number,
): PickerOption[] {
  const q = query.trim().toLowerCase()
  const matched = q
    ? options.filter((o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
    : [...options]
  return limit != null ? matched.slice(0, limit) : matched
}

export function filterIconNames(names: readonly string[], query: string, limit = 120): string[] {
  const q = query.trim().toLowerCase()
  const matched = q ? names.filter((n) => n.includes(q)) : names
  return matched.slice(0, limit)
}

export function toggleValue(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function columnOption(c: ColumnLike): PickerOption {
  const label = c.label && c.label !== c.name ? `${c.name} · ${c.label}` : c.name
  return { value: c.name, label }
}

function tableOption(tb: TableLike): PickerOption {
  const label = tb.label && tb.label !== tb.name ? `${tb.label} · ${tb.name}` : tb.name
  return { value: tb.name, label }
}

export function EnumSelect({
  value,
  onChange,
  options,
  ariaLabel,
  emptyLabel,
  className,
}: {
  value: string | undefined
  onChange: (value: string | undefined) => void
  options: readonly PickerOption[]
  ariaLabel?: string
  emptyLabel?: string
  className?: string
}) {
  const missing = value != null && value !== '' && !options.some((o) => o.value === value)
  return (
    <select
      className={clsx('input-sm', className)}
      aria-label={ariaLabel}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {missing && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function ColumnPicker({
  columns,
  value,
  onChange,
  ariaLabel,
  emptyLabel,
  className,
}: {
  columns: readonly ColumnLike[]
  value: string | undefined
  onChange: (value: string | undefined) => void
  ariaLabel?: string
  emptyLabel?: string
  className?: string
}) {
  const options = useMemo(() => columns.map(columnOption), [columns])
  return (
    <EnumSelect
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel={ariaLabel}
      emptyLabel={emptyLabel}
      className={className}
    />
  )
}

export function TablePicker({
  tables,
  value,
  onChange,
  ariaLabel,
  emptyLabel,
  className,
}: {
  tables: readonly TableLike[]
  value: string | undefined
  onChange: (value: string | undefined) => void
  ariaLabel?: string
  emptyLabel?: string
  className?: string
}) {
  const options = useMemo(() => tables.map(tableOption), [tables])
  return (
    <EnumSelect
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel={ariaLabel}
      emptyLabel={emptyLabel}
      className={className}
    />
  )
}

function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  searchable,
  ariaLabel,
}: {
  options: readonly PickerOption[]
  value: readonly string[]
  onChange: (next: string[]) => void
  placeholder: string
  searchable?: boolean
  ariaLabel?: string
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useClickOutside(() => setOpen(false))
  const shown = searchable ? filterOptions(options, q) : [...options]
  const labelFor = (v: string) => options.find((o) => o.value === v)?.label ?? v

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        className="input-sm flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex min-w-0 flex-1 flex-wrap gap-1">
          {value.length === 0 ? (
            <span className="text-muted">{placeholder}</span>
          ) : (
            value.map((v) => (
              <span
                key={v}
                className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-xxs text-sec"
              >
                {labelFor(v)}
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={t('cfg_remove')}
                  className="text-muted hover:text-critical"
                  onClick={(e) => {
                    e.stopPropagation()
                    onChange(value.filter((x) => x !== v))
                  }}
                >
                  <IconX size={10} />
                </span>
              </span>
            ))
          )}
        </span>
        <IconChevronDown size={13} className="shrink-0 text-muted" />
      </button>
      {open && (
        <div
          className="card absolute z-30 mt-1 w-full overflow-hidden shadow-lg"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          {searchable && (
            <input
              autoFocus
              className="w-full border-b bg-surface px-2.5 py-2 text-[13px] text-ink outline-none"
              placeholder={t('picker_search')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
          <div className="max-h-56 overflow-auto py-1">
            {shown.length === 0 && (
              <div className="px-2.5 py-1.5 text-[13px] text-muted">{t('picker_no_results')}</div>
            )}
            {shown.map((o) => {
              const on = value.includes(o.value)
              return (
                <button
                  key={o.value}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-sec hover:bg-page hover:text-ink"
                  onClick={() => onChange(toggleValue(value, o.value))}
                >
                  <span
                    className={clsx(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      on && 'accent-soft border-transparent',
                    )}
                    aria-hidden
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span className="truncate">{o.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export function ColumnMultiSelect({
  columns,
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  columns: readonly ColumnLike[]
  value: readonly string[]
  onChange: (next: string[]) => void
  placeholder?: string
  ariaLabel?: string
}) {
  const t = useT()
  const options = useMemo(() => columns.map(columnOption), [columns])
  return (
    <MultiSelect
      options={options}
      value={value}
      onChange={onChange}
      searchable
      placeholder={placeholder ?? t('picker_pick_columns')}
      ariaLabel={ariaLabel}
    />
  )
}

export function RoleMultiSelect({
  roles,
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  roles: readonly string[]
  value: readonly string[]
  onChange: (next: string[]) => void
  placeholder?: string
  ariaLabel?: string
}) {
  const t = useT()
  const options = useMemo(() => roles.map((r) => ({ value: r, label: r })), [roles])
  return (
    <MultiSelect
      options={options}
      value={value}
      onChange={onChange}
      searchable
      placeholder={placeholder ?? t('picker_pick_roles')}
      ariaLabel={ariaLabel}
    />
  )
}

export function IconPicker({
  value,
  onChange,
  ariaLabel,
  compact,
}: {
  value: string | undefined
  onChange: (value: string | undefined) => void
  ariaLabel?: string
  compact?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useClickOutside(() => setOpen(false))
  const names = filterIconNames(useIconNames(), q)

  return (
    <div ref={ref} className={clsx('relative', compact && 'shrink-0')}>
      {compact ? (
        <button
          type="button"
          aria-label={ariaLabel ?? t('picker_pick_icon')}
          aria-expanded={open}
          className={clsx(
            'flex h-8 w-8 items-center justify-center rounded-ctl border bg-surface2 transition-colors hover:border-accent hover:text-ink',
            value ? 'text-sec' : 'text-muted',
          )}
          onClick={() => setOpen((o) => !o)}
        >
          {value ? <AppIcon icon={value} size={16} /> : <IconPlus size={14} />}
        </button>
      ) : (
        <button
          type="button"
          aria-label={ariaLabel ?? t('picker_pick_icon')}
          aria-expanded={open}
          className="input-sm flex w-full items-center justify-between gap-2 text-left"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {value ? (
              <>
                <AppIcon icon={value} size={15} className="shrink-0 text-sec" />
                <span className="truncate font-mono text-[13px]">{value}</span>
              </>
            ) : (
              <span className="text-muted">{t('picker_pick_icon')}</span>
            )}
          </span>
          <span className="flex items-center gap-1">
            {value && (
              <span
                role="button"
                tabIndex={0}
                aria-label={t('cfg_remove')}
                className="text-muted hover:text-critical"
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(undefined)
                }}
              >
                <IconX size={12} />
              </span>
            )}
            <IconChevronDown size={13} className="text-muted" />
          </span>
        </button>
      )}
      {open && (
        <div
          className="card absolute z-30 mt-1 w-72 overflow-hidden shadow-lg"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          <div className="relative border-b">
            <IconSearch size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-muted" />
            <input
              autoFocus
              className="w-full bg-surface py-2 pl-8 pr-2.5 text-[13px] text-ink outline-none"
              placeholder={t('picker_search')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-auto p-1.5">
            {names.length === 0 && (
              <div className="col-span-8 px-2.5 py-1.5 text-[13px] text-muted">
                {t('picker_no_results')}
              </div>
            )}
            {names.map((n) => (
              <button
                key={n}
                type="button"
                title={n}
                aria-label={n}
                className={clsx(
                  'flex h-7 w-7 items-center justify-center rounded-ctl hover:bg-page',
                  value === n ? 'accent-soft' : 'text-sec',
                )}
                onClick={() => {
                  onChange(n)
                  setOpen(false)
                }}
              >
                <AppIcon icon={n} size={15} />
              </button>
            ))}
          </div>
          {compact && value && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 border-t px-3 py-2 text-left text-[13px] text-muted hover:bg-page hover:text-critical"
              onClick={() => {
                onChange(undefined)
                setOpen(false)
              }}
            >
              <IconX size={12} />
              {t('cfg_remove')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
