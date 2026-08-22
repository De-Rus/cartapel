import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import type { ColumnMeta, Row, TableMeta } from '../api/types'
import { editorString } from '../lib/editing'
import { useRowHeight } from '../lib/hooks'
import { isEditable } from '../lib/perms'
import { useT } from '../lib/i18n'
import { CellValue, NUMERIC_WIDGETS } from './CellValue'
import { FkSelect } from './FkSelect'
import { IconChevronDown, IconChevronRight, IconEye } from './Icons'
import { TableSkeleton } from './Skeleton'

export interface SortInfo {
  dir: 'asc' | 'desc' | null
  index: number
}

interface EditingCell {
  pk: string
  col: string
}

function InlineEditor({
  col,
  tableName,
  initial,
  row,
  onCommit,
  onCancel,
}: {
  col: ColumnMeta
  tableName: string
  initial: unknown
  row: Row
  onCommit: (value: unknown, fkLabel?: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(() => editorString(col, initial))
  const done = useRef(false)
  const commit = (value: unknown, fkLabel?: string) => {
    if (done.current) return
    done.current = true
    onCommit(value, fkLabel)
  }
  const cancel = () => {
    if (done.current) return
    done.current = true
    onCancel()
  }

  if (col.widget === 'fk') {
    return (
      <div className="min-w-40">
        <FkSelect
          table={tableName}
          col={col.name}
          value={initial}
          label={(row[`${col.name}__label`] as string | undefined) ?? String(initial ?? '')}
          nullable={col.nullable}
          onChange={(v, label) => commit(v, label)}
        />
      </div>
    )
  }

  if (col.widget === 'badge') {
    const opts = Object.keys((col.params as { colors?: Record<string, string> }).colors ?? {})
    if (opts.length > 0) {
      return (
        <select
          autoFocus
          className="inline-editor"
          defaultValue={String(initial ?? '')}
          onBlur={cancel}
          onChange={(e) => commit(e.target.value || null)}
          onKeyDown={(e) => e.key === 'Escape' && cancel()}
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
  }

  const numeric = NUMERIC_WIDGETS.has(col.widget)
  return (
    <input
      autoFocus
      type={numeric ? 'number' : 'text'}
      step={numeric ? 'any' : undefined}
      className={clsx('inline-editor', numeric && 'text-right tabular-nums')}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => commit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
    />
  )
}

export function DataTable({
  table,
  columns,
  rows,
  loading,
  isError,
  errorNode,
  emptyNode,
  hasSelection,
  selected,
  onToggleSelect,
  allSelected,
  onToggleAll,
  cursor,
  onOpenRow,
  sortColsLen,
  sortInfo,
  toggleSort,
  widths,
  onResize,
  editingEnabled,
  onInlineCommit,
  editTrigger,
  onPrefetch,
  onPeek,
  peekIndex,
}: {
  table: TableMeta
  columns: string[]
  rows: Row[]
  loading: boolean
  isError: boolean
  errorNode: React.ReactNode
  emptyNode: React.ReactNode
  hasSelection: boolean
  selected: Set<string>
  onToggleSelect: (pk: string, shift: boolean, index: number) => void
  allSelected: boolean
  onToggleAll: () => void
  cursor: number
  onOpenRow: (pk: string) => void
  sortColsLen: number
  sortInfo: (col: string) => SortInfo
  toggleSort: (col: string, additive: boolean) => void
  widths: Record<string, number>
  onResize: (col: string, w: number) => void
  editingEnabled: boolean
  onInlineCommit: (pk: string, col: ColumnMeta, value: unknown, fkLabel?: string) => Promise<boolean>
  editTrigger?: { pk: string; col: string; nonce: number }
  onPrefetch?: (pk: string) => void
  onPeek?: (index: number) => void
  peekIndex?: number
}) {
  const t = useT()
  const rowH = useRowHeight()
  const scrollRef = useRef<HTMLDivElement>(null)
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const [headerH, setHeaderH] = useState(33)
  const [editing, setEditing] = useState<EditingCell | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [errCell, setErrCell] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = theadRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeaderH(el.offsetHeight))
    ro.observe(el)
    setHeaderH(el.offsetHeight)
    return () => ro.disconnect()
  }, [])

  const showRows = !loading && !isError && rows.length > 0
  const virtual = showRows && rows.length > 60

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 8,
    scrollMargin: headerH,
  })

  useEffect(() => {
    if (virtual && cursor >= 0) virtualizer.scrollToIndex(cursor, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, virtual])

  useEffect(() => {
    setEditing(null)
  }, [rows])

  useEffect(() => {
    if (editTrigger && editingEnabled) setEditing({ pk: editTrigger.pk, col: editTrigger.col })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTrigger?.nonce])

  const items = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  const paddingTop = virtual && items.length ? items[0].start - headerH : 0
  const paddingBottom = virtual && items.length ? totalSize - (items[items.length - 1].end - headerH) : 0

  const colMetaOf = (c: string) => table.columns.find((cm) => cm.name === c)

  const startResize = (col: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const th = (e.currentTarget as HTMLElement).closest('th')
    const startW = widths[col] ?? th?.offsetWidth ?? 120
    const move = (ev: MouseEvent) => {
      const w = Math.max(64, startW + (ev.clientX - startX))
      onResize(col, w)
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const commitCell = async (pk: string, col: ColumnMeta, value: unknown, fkLabel?: string) => {
    setEditing(null)
    const key = `${pk}:${col.name}`
    const ok = await onInlineCommit(pk, col, value, fkLabel)
    if (ok) {
      setFlash(key)
      setTimeout(() => setFlash((f) => (f === key ? null : f)), 650)
    } else {
      setErrCell(key)
      setTimeout(() => setErrCell((c) => (c === key ? null : c)), 1200)
    }
  }

  // A table with no single-column primary key (composite key) can't open a
  // record view — its rows are display-only, not clickable.
  const canOpen = !!table.pk
  const renderRow = (row: Row, ri: number) => {
    const pk = String(row[table.pk])
    const isCursor = ri === cursor
    const isPeek = onPeek != null && ri === peekIndex
    const isSel = selected.has(pk)
    return (
      <tr
        key={pk}
        className={clsx(
          'group data-row border-t',
          canOpen && 'cursor-pointer',
          isSel ? 'bg-selected' : isCursor || isPeek ? 'bg-hover' : 'hover:bg-hover',
        )}
        style={{ height: rowH, ...(isCursor || isPeek ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : {}) }}
        onClick={canOpen ? () => onOpenRow(pk) : undefined}
        onMouseEnter={canOpen ? () => onPrefetch?.(pk) : undefined}
      >
        {hasSelection && (
          <td className="data-cell w-px pl-2.5 pr-1" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={isSel}
              onChange={(e) =>
                onToggleSelect(pk, (e.nativeEvent as MouseEvent).shiftKey, ri)
              }
              aria-label={t('select_one', { pk })}
            />
          </td>
        )}
        {columns.map((c) => {
          const cm = colMetaOf(c)
          const numeric = cm && NUMERIC_WIDGETS.has(cm.widget)
          const editable = editingEnabled && cm && isEditable(table, cm)
          const key = `${pk}:${c}`
          const isEditingCell = editing?.pk === pk && editing?.col === c
          return (
            <td
              key={c}
              className={clsx(
                'data-cell whitespace-nowrap',
                c === table.pk ? 'w-px pl-1 pr-2.5 tabular-nums text-muted' : 'px-2.5',
                numeric && 'text-right tabular-nums',
                flash === key && 'flash-good',
                errCell === key && 'ring-1 ring-critical',
                editable && !isEditingCell && 'cursor-text',
              )}
              onDoubleClick={(e) => {
                if (editable && cm) {
                  e.stopPropagation()
                  setEditing({ pk, col: c })
                }
              }}
            >
              {isEditingCell && cm ? (
                <div onClick={(e) => e.stopPropagation()}>
                  <InlineEditor
                    col={cm}
                    tableName={table.name}
                    initial={row[c]}
                    row={row}
                    onCommit={(v, fkLabel) => commitCell(pk, cm, v, fkLabel)}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : cm ? (
                <CellValue col={cm} value={row[c]} row={row} mode="list" pkName={table.pk} tableName={table.name} />
              ) : (
                String(row[c] ?? '')
              )}
            </td>
          )
        })}
        {onPeek && (
          <td className="data-cell px-1" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={clsx(
                'flex h-6 w-6 items-center justify-center rounded-ctl text-muted opacity-0 hover:bg-surface2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100',
                isPeek && 'opacity-100 text-ink',
              )}
              onClick={() => onPeek(ri)}
              aria-label={t('quick_view')}
              title={`${t('quick_view')} (Space)`}
            >
              <IconEye size={14} />
            </button>
          </td>
        )}
      </tr>
    )
  }

  const colSpan = columns.length + (hasSelection ? 1 : 0) + (onPeek ? 1 : 0)

  return (
    <div ref={scrollRef} className="card min-h-0 flex-1 overflow-auto">
      <table className="w-full text-[length:var(--font-data)]" style={{ tableLayout: Object.keys(widths).length ? 'fixed' : 'auto' }}>
        <colgroup>
          {hasSelection && <col style={{ width: 36 }} />}
          {columns.map((c) => (
            <col key={c} style={widths[c] ? { width: widths[c] } : undefined} />
          ))}
          {onPeek && <col style={{ width: 34 }} />}
        </colgroup>
        <thead ref={theadRef} className="sticky-head">
          <tr className="text-left">
            {hasSelection && (
              <th className="w-9 pl-2.5 pr-1 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                  aria-label={t('select_all')}
                />
              </th>
            )}
            {columns.map((c) => {
              const cm = colMetaOf(c)
              const sortable = cm?.widget !== 'image' && !cm?.computed
              const label = cm?.label ?? c
              const { dir, index } = sortInfo(c)
              const active = dir !== null
              return (
                <th
                  key={c}
                  aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                  className={clsx(
                    'group relative select-none whitespace-nowrap py-2 text-xxs font-semibold uppercase tracking-wide',
                    c === table.pk ? 'w-px pl-1 pr-2.5' : 'px-2.5',
                    active ? 'text-ink' : 'text-muted',
                    cm && NUMERIC_WIDGETS.has(cm.widget) && 'text-right',
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-ink"
                      onClick={(e) => toggleSort(c, e.shiftKey)}
                      title={t('sort_tooltip')}
                    >
                      {label}
                      {active &&
                        (dir === 'desc' ? (
                          <IconChevronDown size={10} />
                        ) : (
                          <IconChevronRight size={10} className="-rotate-90" />
                        ))}
                      {active && sortColsLen > 1 && (
                        <span className="text-[9px] tabular-nums text-muted">{index + 1}</span>
                      )}
                    </button>
                  ) : (
                    <span>{label}</span>
                  )}
                  <span
                    className="col-resize absolute right-0 top-0 h-full w-1.5 cursor-col-resize opacity-0 group-hover:opacity-100"
                    onMouseDown={(e) => startResize(c, e)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      onResize(c, 0)
                    }}
                    title={t('resize_tooltip')}
                  />
                </th>
              )
            })}
            {onPeek && <th className="w-[34px] px-1" aria-hidden />}
          </tr>
        </thead>
        <tbody>
          {loading && <TableSkeleton cols={colSpan} />}
          {isError && (
            <tr>
              <td colSpan={colSpan}>{errorNode}</td>
            </tr>
          )}
          {!loading && !isError && rows.length === 0 && (
            <tr>
              <td colSpan={colSpan}>{emptyNode}</td>
            </tr>
          )}
          {showRows && !virtual && rows.map((row, ri) => renderRow(row, ri))}
          {showRows && virtual && (
            <>
              {paddingTop > 0 && <tr aria-hidden style={{ height: paddingTop }} />}
              {items.map((vi) => renderRow(rows[vi.index], vi.index))}
              {paddingBottom > 0 && <tr aria-hidden style={{ height: paddingBottom }} />}
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}
