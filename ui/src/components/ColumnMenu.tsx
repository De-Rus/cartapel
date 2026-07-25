import { useState } from 'react'
import clsx from 'clsx'
import { useT } from '../lib/i18n'
import type { TableMeta } from '../api/types'
import { useClickOutside } from '../lib/hooks'
import type { ColumnState } from '../lib/viewState'
import { IconColumns } from './Icons'

function reorder<T>(list: T[], from: number, to: number): T[] {
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function ColumnMenu({
  table,
  state,
  onChange,
  onReset,
}: {
  table: TableMeta
  state: ColumnState
  onChange: (next: ColumnState) => void
  onReset: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [drag, setDrag] = useState<number | null>(null)
  const ref = useClickOutside(() => setOpen(false))

  const base = table.list.columns
  const ordered = state.order.length
    ? [...state.order.filter((c) => base.includes(c)), ...base.filter((c) => !state.order.includes(c))]
    : base
  const hidden = new Set(state.hidden)

  const setOrder = (next: string[]) => onChange({ ...state, order: next })
  const toggleHidden = (col: string) => {
    const h = new Set(state.hidden)
    if (h.has(col)) h.delete(col)
    else h.add(col)
    onChange({ ...state, hidden: [...h] })
  }

  const hiddenCount = ordered.filter((c) => hidden.has(c)).length

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <IconColumns size={13} />
        {t('col_button')}
        {hiddenCount > 0 && <span className="text-xxs text-muted">({hiddenCount})</span>}
      </button>
      {open && (
        <div
          role="menu"
          className="pop-in absolute right-0 z-30 mt-1 w-64 overflow-hidden rounded-card bg-surface1 py-1 shadow-menu"
        >
          <div className="max-h-80 overflow-auto py-1">
            {ordered.map((col, i) => (
              <div
                key={col}
                draggable
                onDragStart={() => setDrag(i)}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (drag !== null && drag !== i) {
                    setOrder(reorder(ordered, drag, i))
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
                <label className="flex flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!hidden.has(col)}
                    onChange={() => toggleHidden(col)}
                    aria-label={col}
                  />
                  <span className={clsx('truncate', hidden.has(col) ? 'text-muted' : 'text-sec')}>{col}</span>
                </label>
              </div>
            ))}
          </div>
          <div className="my-1 border-t" />
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left text-[13px] text-sec hover:bg-hover hover:text-ink"
            onClick={() => {
              onReset()
              setOpen(false)
            }}
          >
            {t('col_reset')}
          </button>
        </div>
      )}
    </div>
  )
}
