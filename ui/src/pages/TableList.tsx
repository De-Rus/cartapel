import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type { ActionMeta, ColumnMeta, ListResponse, Row, TableMeta } from '../api/types'
import { type Condition, encodeCondition } from '../lib/filters'
import { fmtInt } from '../lib/format'
import { useDebounced, useMediaQuery } from '../lib/hooks'
import { isEditableTarget } from '../lib/keys'
import { isEditable } from '../lib/perms'
import { useT } from '../lib/i18n'
import { useMeta, useTable } from '../lib/meta'
import { emptyStateKind, nextPeekIndex } from '../lib/peek'
import { useRowPrefetch } from '../lib/prefetch'
import { detailMode } from '../lib/sections'
import {
  type ColumnState,
  loadColumnState,
  resolveColumns,
  saveColumnState,
  viewQueryFromParams,
} from '../lib/viewState'
import { ActionModal } from '../components/ActionModal'
import { BulkEditModal } from '../components/BulkEditModal'
import { ColumnMenu } from '../components/ColumnMenu'
import { DataTable } from '../components/DataTable'
import { ExportButton } from '../components/ExportButton'
import { FilterBar } from '../components/FilterBar'
import { ImportDrawer } from '../components/ImportDrawer'
import { SavedViews } from '../components/SavedViews'
import { EmptyState } from '../components/EmptyState'
import { RecordPeek } from '../components/RecordPeek'
import { Sheet } from '../components/Sheet'
import { Modal } from '../components/Modal'
import { DetailBody } from './RowDetail'
import { IconDownload, IconFilterOff, IconInbox, IconPlus, IconSearch, IconSliders } from '../components/Icons'
import { useToast } from '../components/Toast'
import { ConfigBuilder } from '../components/ConfigBuilder'
import { GroupTabs } from '../components/GroupTabs'

function ListInner({ table }: { table: TableMeta }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const t = useT()
  const [sp, setSp] = useSearchParams()

  const [qInput, setQInput] = useState(sp.get('q') ?? '')
  const dq = useDebounced(qInput, 300)

  const patch = useCallback(
    (mut: (p: URLSearchParams) => void, resetPage = true) => {
      setSp(
        (prev) => {
          const p = new URLSearchParams(prev)
          mut(p)
          if (resetPage) p.delete('page')
          return p
        },
        { replace: true },
      )
    },
    [setSp],
  )

  useEffect(() => {
    const current = sp.get('q') ?? ''
    if (dq !== current) {
      patch((p) => {
        if (dq) p.set('q', dq)
        else p.delete('q')
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq])

  const sort = sp.get('sort') ?? table.list.default_sort
  const sortCols = useMemo(() => sort.split(',').filter(Boolean), [sort])
  const page = Math.max(1, Number(sp.get('page') ?? 1))
  const pp = Math.max(1, Number(sp.get('pp') ?? table.list.per_page))

  const apiQs = useMemo(() => {
    const p = new URLSearchParams()
    const q = sp.get('q')
    if (q) p.set('q', q)
    p.set('sort', sort)
    p.set('page', String(page))
    p.set('pp', String(pp))
    for (const [k, v] of sp.entries()) {
      if (k.startsWith('f_')) p.append(k, v)
    }
    return p.toString()
  }, [sp, sort, page, pp])

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['list', table.name, apiQs],
    queryFn: () => api.list(table.name, apiQs),
  })

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(-1)
  const [peekOpen, setPeekOpen] = useState(false)
  const anchor = useRef(-1)
  const rowPrefetch = useRowPrefetch(qc, table.name)
  useEffect(() => {
    setSelected(new Set())
    setCursor(-1)
    setPeekOpen(false)
    anchor.current = -1
  }, [apiQs])

  const [pendingAction, setPendingAction] = useState<ActionMeta | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const meta = useMeta()

  const [colState, setColState] = useState<ColumnState>(() => loadColumnState(table.name))
  const updateColState = useCallback(
    (next: ColumnState) => {
      setColState(next)
      saveColumnState(table.name, next)
    },
    [table.name],
  )
  const columns = useMemo(() => resolveColumns(table.list.columns, colState), [table.list.columns, colState])
  const resizeCol = useCallback(
    (col: string, w: number) => {
      const widths = { ...colState.widths }
      if (w <= 0) delete widths[col]
      else widths[col] = w
      updateColState({ ...colState, widths })
    },
    [colState, updateColState],
  )

  const actions = table.actions.filter((a) => table.perms.actions.includes(a.name))
  const canBulk = table.perms.write && !table.read_only
  const hasSelection = actions.length > 0 || canBulk
  const rows = data?.rows ?? []
  const pks = useMemo(() => rows.map((r) => String(r[table.pk])), [rows, table.pk])
  const allSelected = pks.length > 0 && pks.every((pk) => selected.has(pk))
  const isMobile = useMediaQuery('(max-width: 600px)')
  const editingEnabled = canBulk && !isMobile

  const toggleSelectAt = useCallback(
    (pk: string, shift: boolean, index: number) => {
      setSelected((s) => {
        const n = new Set(s)
        if (shift && anchor.current >= 0) {
          const [a, b] = [anchor.current, index].sort((x, y) => x - y)
          const want = !n.has(pk)
          for (let i = a; i <= b; i++) {
            const p = pks[i]
            if (p == null) continue
            if (want) n.add(p)
            else n.delete(p)
          }
        } else {
          if (n.has(pk)) n.delete(pk)
          else n.add(pk)
          anchor.current = index
        }
        return n
      })
    },
    [pks],
  )

  const commitInline = useCallback(
    async (pk: string, col: ColumnMeta, value: unknown, fkLabel?: string): Promise<boolean> => {
      const key: [string, string, string] = ['list', table.name, apiQs]
      const prev = qc.getQueryData<ListResponse>(key)
      const patchRow = (r: Row): Row => {
        const next: Row = { ...r, [col.name]: value }
        if (fkLabel !== undefined) next[`${col.name}__label`] = fkLabel
        return next
      }
      if (prev) {
        qc.setQueryData<ListResponse>(key, {
          ...prev,
          rows: prev.rows.map((r) => (String(r[table.pk]) === pk ? patchRow(r) : r)),
        })
      }
      try {
        await api.patch(table.name, pk, { [col.name]: value } as Row)
        void qc.invalidateQueries({ queryKey: ['row', table.name, pk] })
        return true
      } catch (e) {
        if (prev) qc.setQueryData(key, prev)
        toast(e instanceof ApiError ? e.message : t('error'), 'error')
        return false
      }
    },
    [qc, table.name, table.pk, apiQs, toast, t],
  )

  const toggleSort = (col: string, additive: boolean) => {
    patch((p) => {
      const cur = (p.get('sort') ?? table.list.default_sort).split(',').filter(Boolean)
      const idx = cur.findIndex((c) => c === col || c === `-${col}`)
      let next: string[]
      if (additive) {
        next = [...cur]
        if (idx < 0) next.push(col)
        else if (next[idx] === col) next[idx] = `-${col}`
        else next.splice(idx, 1)
      } else {
        next = idx >= 0 && cur[idx] === col ? [`-${col}`] : [col]
      }
      if (next.length) p.set('sort', next.join(','))
      else p.delete('sort')
    })
  }

  const sortState = (col: string): { dir: 'asc' | 'desc' | null; index: number } => {
    const i = sortCols.findIndex((c) => c === col || c === `-${col}`)
    if (i < 0) return { dir: null, index: -1 }
    return { dir: sortCols[i].startsWith('-') ? 'desc' : 'asc', index: i }
  }

  const activeFilters = [...sp.entries()].filter(([k]) => k.startsWith('f_'))

  const applyConditions = (conds: Condition[]) => {
    patch((p) => {
      for (const k of [...p.keys()]) if (k.startsWith('f_')) p.delete(k)
      for (const c of conds) {
        const [k, v] = encodeCondition(c)
        p.append(k, v)
      }
    })
  }

  const applyViewQuery = (query: string) => {
    patch((p) => {
      for (const k of [...p.keys()]) {
        if (k === 'q' || k === 'sort' || k === 'pp' || k.startsWith('f_')) p.delete(k)
      }
      const incoming = new URLSearchParams(query)
      for (const [k, v] of incoming.entries()) p.append(k, v)
    })
    setQInput(new URLSearchParams(query).get('q') ?? '')
  }

  const clearListState = () => {
    patch((p) => {
      for (const k of [...p.keys()]) {
        if (k === 'q' || k === 'sort' || k.startsWith('f_')) p.delete(k)
      }
    })
    setQInput('')
  }

  const listQuery = viewQueryFromParams(sp)
  const hasListState = listQuery !== '' && listQuery !== viewQueryFromParams(new URLSearchParams(`sort=${table.list.default_sort}&pp=${table.list.per_page}`))

  const runAction = async (action: ActionMeta) => {
    const res = await api.action(table.name, action.name, [...selected])
    toast(t('rows_affected', { count: fmtInt(res.affected) }))
    setSelected(new Set())
    await qc.invalidateQueries({ queryKey: ['list', table.name] })
  }

  const mode = detailMode(table.detail)
  const openPk = sp.get('open')

  const setOpen = useCallback(
    (pk: string | null, replace = false) => {
      setSp(
        (prev) => {
          const p = new URLSearchParams(prev)
          if (pk == null) p.delete('open')
          else p.set('open', pk)
          return p
        },
        { replace },
      )
    },
    [setSp],
  )

  const openRow = (pk: string) => {
    if (mode === 'page') {
      navigate(`/${table.name}/${encodeURIComponent(pk)}`, {
        state: { siblings: pks, from: sp.toString() },
      })
    } else {
      setOpen(pk)
    }
  }

  const [editReq, setEditReq] = useState<{ pk: string; col: string; nonce: number }>()
  const firstEditableCol = useMemo(
    () => columns.find((c) => {
      const cm = table.columns.find((x) => x.name === c)
      return cm && isEditable(table, cm)
    }),
    [columns, table],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || rows.length === 0) return
      if (peekOpen || openPk) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => {
          const next = Math.min(rows.length - 1, c + 1)
          if (e.shiftKey && hasSelection && pks[next]) toggleSelectAt(pks[next], false, next)
          return next
        })
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => {
          const next = Math.max(0, c < 0 ? 0 : c - 1)
          if (e.shiftKey && hasSelection && pks[next]) toggleSelectAt(pks[next], false, next)
          return next
        })
      } else if (e.key === ' ') {
        e.preventDefault()
        setCursor((c) => (c < 0 ? 0 : c))
        setPeekOpen(true)
      } else if (e.key === 'Enter' && cursor >= 0) {
        e.preventDefault()
        openRow(pks[cursor])
      } else if (e.key === 'e' && cursor >= 0 && editingEnabled && firstEditableCol) {
        e.preventDefault()
        setEditReq((r) => ({ pk: pks[cursor], col: firstEditableCol, nonce: (r?.nonce ?? 0) + 1 }))
      } else if (e.key === 'x' && cursor >= 0 && hasSelection) {
        e.preventDefault()
        toggleSelectAt(pks[cursor], false, cursor)
      } else if (e.key === 'Escape' && cursor >= 0) {
        setCursor(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, cursor, pks, hasSelection, editingEnabled, firstEditableCol, toggleSelectAt, peekOpen, openPk])

  useEffect(() => {
    if (cursor >= 0 && pks[cursor]) rowPrefetch.schedule(pks[cursor])
  }, [cursor, pks, rowPrefetch])

  const from = data ? (data.total === 0 ? 0 : (page - 1) * pp + 1) : 0
  const to = data ? Math.min(page * pp, data.total) : 0
  const approx = data?.approx ?? false

  return (
    <div className="space-y-3">
      <GroupTabs table={table.name} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <IconSearch size={14} className="pointer-events-none absolute left-2.5 top-2 text-muted" />
          <input
            name="q"
            className="input-sm w-56 !pl-8"
            placeholder={t('search_placeholder', { label: table.label_plural.toLowerCase() })}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
        </div>
        <ColumnMenu
          table={table}
          state={colState}
          onChange={updateColState}
          onReset={() => updateColState({ order: [], hidden: [], widths: {} })}
        />
        <ExportButton table={table.name} qs={apiQs} />
        {table.perms.create && (
          <button type="button" className="btn" onClick={() => setImportOpen(true)}>
            <IconDownload size={13} className="rotate-180" /> {t('import')}
          </button>
        )}
        {meta.can_manage_access && (
          <button type="button" className="btn" onClick={() => setConfigOpen(true)}>
            <IconSliders size={13} /> {t('cfg_customize')}
          </button>
        )}
        <div className="flex-1" />
        {table.perms.create && (
          <Link to={`/${table.name}/new`} className="btn btn-primary">
            <IconPlus size={13} /> {t('new_record', { label: table.label })}
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <FilterBar table={table} entries={activeFilters} onApply={applyConditions} />
        <div className="min-w-4 flex-1" />
        <SavedViews
          table={table.name}
          params={sp}
          hasListState={hasListState}
          onApply={applyViewQuery}
          onClear={clearListState}
        />
      </div>

      {hasSelection && selected.size > 0 && (
        <div className="card pop-in flex items-center gap-2 px-3 py-2">
          <span className="text-[13px] tabular-nums text-sec">
            {selected.size === 1 ? t('selected_one') : t('selected', { count: fmtInt(selected.size) })}
          </span>
          <button type="button" className="text-xxs text-muted hover:text-ink" onClick={() => setSelected(new Set())}>
            {t('clear_all')}
          </button>
          <div className="flex-1" />
          {canBulk && (
            <button className="btn" onClick={() => setBulkOpen(true)}>
              {t('edit_n', { count: fmtInt(selected.size) })}
            </button>
          )}
          {actions.map((a) => (
            <button
              key={a.name}
              className={clsx('btn', a.danger && 'text-critical hover:text-critical')}
              onClick={() => setPendingAction(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      <DataTable
        table={table}
        columns={columns}
        rows={rows}
        loading={isLoading}
        isError={isError}
        errorNode={
          <div className="px-3 py-10 text-center text-critical">
            <div>{error instanceof Error ? error.message : t('error')}</div>
            <button className="btn mt-3" onClick={() => qc.invalidateQueries({ queryKey: ['list', table.name] })}>
              {t('retry')}
            </button>
          </div>
        }
        emptyNode={(() => {
          const kind = emptyStateKind({
            filtered: activeFilters.length > 0 || !!sp.get('q'),
            canCreate: table.perms.create,
          })
          if (kind === 'filtered') {
            return (
              <EmptyState
                icon={<IconFilterOff size={30} />}
                title={t('no_matches')}
                description={t('no_matches_hint')}
                action={
                  <button className="btn" onClick={clearListState}>
                    {t('clear_filters')}
                  </button>
                }
              />
            )
          }
          if (kind === 'first-run') {
            return (
              <EmptyState
                icon={<IconInbox size={30} />}
                title={t('no_rows_yet', { label: table.label_plural })}
                description={t('no_rows_hint')}
                action={
                  <Link to={`/${table.name}/new`} className="btn btn-primary">
                    <IconPlus size={13} /> {t('new_record', { label: table.label })}
                  </Link>
                }
              />
            )
          }
          return (
            <EmptyState
              icon={<IconInbox size={30} />}
              title={t('no_rows_yet', { label: table.label_plural })}
            />
          )
        })()}
        hasSelection={hasSelection}
        selected={selected}
        onToggleSelect={toggleSelectAt}
        allSelected={allSelected}
        onToggleAll={() => setSelected(allSelected ? new Set() : new Set(pks))}
        cursor={cursor}
        onOpenRow={openRow}
        sortColsLen={sortCols.length}
        sortInfo={sortState}
        toggleSort={toggleSort}
        widths={colState.widths}
        onResize={resizeCol}
        editingEnabled={editingEnabled}
        onInlineCommit={commitInline}
        editTrigger={editReq}
        onPrefetch={(pk) => rowPrefetch.schedule(pk)}
        onPeek={(index) => {
          setCursor(index)
          setPeekOpen(true)
        }}
        peekIndex={peekOpen ? cursor : undefined}
      />

      <div className="flex items-center gap-3 text-[13px] text-muted">
        <span className="tabular-nums">
          {data
            ? approx
              ? t('range_of', { from: fmtInt(from), to: fmtInt(to), total: `~${fmtInt(data.total)}` })
              : t('range_of', { from: fmtInt(from), to: fmtInt(to), total: fmtInt(data.total) })
            : '…'}
        </span>
        <div className="flex-1" />
        <select
          className="input-sm"
          value={pp}
          onChange={(e) => patch((p) => p.set('pp', e.target.value))}
          aria-label={t('per_page', { n: pp })}
        >
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>
              {t('per_page', { n })}
            </option>
          ))}
        </select>
        <button className="btn" disabled={page <= 1} onClick={() => patch((p) => p.set('page', String(page - 1)), false)}>
          {t('prev')}
        </button>
        <button
          className="btn"
          disabled={!data || to >= data.total}
          onClick={() => patch((p) => p.set('page', String(page + 1)), false)}
        >
          {t('next')}
        </button>
      </div>

      {openPk && mode === 'drawer' && (
        <Sheet title={table.label} width={720} onClose={() => setOpen(null)}>
          <DetailBody
            table={table}
            pk={openPk}
            variant="drawer"
            siblings={pks}
            onNavigate={(next) => setOpen(next, true)}
            onDeleted={() => setOpen(null)}
          />
        </Sheet>
      )}

      {openPk && mode === 'modal' && (
        <Modal title={table.label} onClose={() => setOpen(null)}>
          <div className="max-h-[80vh] overflow-auto">
            <DetailBody
              table={table}
              pk={openPk}
              variant="modal"
              siblings={pks}
              onNavigate={(next) => setOpen(next, true)}
              onDeleted={() => setOpen(null)}
            />
          </div>
        </Modal>
      )}

      {peekOpen && cursor >= 0 && pks[cursor] && (
        <RecordPeek
          table={table}
          pk={pks[cursor]}
          index={cursor}
          total={rows.length}
          atStart={cursor <= 0}
          atEnd={cursor >= rows.length - 1}
          onClose={() => setPeekOpen(false)}
          onPrev={() => setCursor((c) => nextPeekIndex(c, -1, rows.length))}
          onNext={() => setCursor((c) => nextPeekIndex(c, 1, rows.length))}
          onOpenFull={() => {
            setPeekOpen(false)
            openRow(pks[cursor])
          }}
        />
      )}

      {pendingAction && (
        <ActionModal
          action={pendingAction}
          count={selected.size}
          onClose={() => setPendingAction(null)}
          onConfirm={() => runAction(pendingAction)}
        />
      )}

      {bulkOpen && (
        <BulkEditModal
          table={table}
          pks={[...selected]}
          onClose={() => setBulkOpen(false)}
          onDone={(affected) => {
            setBulkOpen(false)
            setSelected(new Set())
            toast(t('rows_updated', { count: fmtInt(affected) }))
            void qc.invalidateQueries({ queryKey: ['list', table.name] })
          }}
        />
      )}

      {importOpen && (
        <ImportDrawer
          table={table}
          onClose={() => setImportOpen(false)}
          onDone={() => void qc.invalidateQueries({ queryKey: ['list', table.name] })}
        />
      )}

      {configOpen && (
        <ConfigBuilder table={table} sampleRows={rows.slice(0, 5)} onClose={() => setConfigOpen(false)} />
      )}
    </div>
  )
}

export default function TableList() {
  const { table: tableName } = useParams()
  const table = useTable(tableName)
  const t = useT()
  if (!table) {
    return <div className="p-8 text-center text-muted">{t('unknown_table')}</div>
  }
  return <ListInner key={table.name} table={table} />
}
