import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useClickOutside, useDebounced } from '../lib/hooks'
import { useT } from '../lib/i18n'
import { IconChevronDown, IconX } from './Icons'

export function FkSelect({
  table,
  col,
  value,
  label,
  nullable,
  onChange,
}: {
  table: string
  col: string
  value: unknown
  label: string
  nullable: boolean
  onChange: (value: unknown, label: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const dq = useDebounced(q, 250)
  const ref = useClickOutside(() => setOpen(false))

  const { data: options, isFetching } = useQuery({
    queryKey: ['options', table, col, dq],
    queryFn: () => api.options(table, col, dq),
    enabled: open,
    staleTime: 30_000,
  })

  useEffect(() => setActive(0), [dq, open])

  const pick = (o: { value: unknown; label: string }) => {
    onChange(o.value, o.label)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="input flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className={value == null ? 'text-muted' : ''}>
          {value == null ? t('fk_unassigned') : label}
        </span>
        <span className="flex items-center gap-1">
          {value != null && nullable && (
            <span
              role="button"
              tabIndex={0}
              className="text-muted hover:text-ink"
              onClick={(e) => {
                e.stopPropagation()
                onChange(null, '')
              }}
            >
              <IconX size={12} />
            </span>
          )}
          <IconChevronDown size={13} className="text-muted" />
        </span>
      </button>
      {open && (
        <div className="card absolute z-20 mt-1 w-full overflow-hidden shadow-lg">
          <input
            autoFocus
            className="w-full border-b bg-surface px-2.5 py-2 text-[13px] text-ink outline-none"
            placeholder={t('fk_search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              const n = options?.length ?? 0
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, n - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const o = options?.[active]
                if (o) pick(o)
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
              }
            }}
          />
          <div className="max-h-56 overflow-auto py-1">
            {isFetching && (
              <div className="px-2.5 py-1.5 text-[13px] text-muted">{t('fk_searching')}</div>
            )}
            {!isFetching && (options?.length ?? 0) === 0 && (
              <div className="px-2.5 py-1.5 text-[13px] text-muted">{t('fk_no_results')}</div>
            )}
            {options?.map((o, i) => (
              <button
                key={String(o.value)}
                type="button"
                className={clsx(
                  'block w-full px-2.5 py-1.5 text-left text-[13px]',
                  i === active ? 'bg-page text-ink' : 'text-sec hover:bg-page hover:text-ink',
                )}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
