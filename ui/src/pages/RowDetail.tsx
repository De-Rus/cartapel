import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type { ActionMeta, ColumnMeta, InlineData, Row, RowResponse, TableMeta } from '../api/types'
import { fmtInt, interpolate } from '../lib/format'
import { isEditableTarget } from '../lib/keys'
import { isEditable } from '../lib/perms'
import { clampSpan, detailColumns, detailLayout, useTabsLayout, type FieldGroup } from '../lib/sections'
import { useT } from '../lib/i18n'
import { useMeta, useTable } from '../lib/meta'
import { ActionModal } from '../components/ActionModal'
import { CellValue, NUMERIC_WIDGETS } from '../components/CellValue'
import { FieldInput } from '../components/FieldInput'
import { ImageField } from '../components/ImageField'
import { CardSkeleton } from '../components/Skeleton'
import { EmptyState } from '../components/EmptyState'
import { MetaRail } from '../components/MetaRail'
import { IconCheck, IconChevronRight, IconCopy, IconInbox, IconPlus, IconTrash } from '../components/Icons'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'

export { isEditable }

const SECTION_GRID: Record<1 | 2 | 3, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 lg:grid-cols-2',
  3: 'grid-cols-1 lg:grid-cols-3',
}

const SECTION_SPAN: Record<1 | 2 | 3, string> = {
  1: '',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
}

const WIDE_WIDGETS = new Set(['json', 'code', 'textarea', 'html', 'markdown'])

const INLINE_PAGE_SIZE = 50

export function inlineRowHidden(
  createdPk: string,
  child: Pick<InlineData, 'rows' | 'total'> | undefined,
  prevTotal: number,
  pkCol: string,
): boolean {
  if (!child) return false
  const present = child.rows.some((r) => String(r[pkCol]) === createdPk)
  return !present && child.total <= prevTotal
}

function InlineEditCell({
  target,
  col,
  row,
  onCommit,
  saving,
}: {
  target: TableMeta
  col: ColumnMeta
  row: Row
  onCommit: (set: Row) => void
  saving: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState<unknown>(row[col.name])
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (editing) {
      wrapRef.current?.querySelector<HTMLElement>('input, textarea, select')?.focus()
    }
  }, [editing])

  if (!editing) {
    return (
      <button
        type="button"
        className="block w-full rounded-ctl px-1 py-0.5 text-left hover:bg-hover disabled:opacity-60"
        disabled={saving}
        onClick={() => {
          setVal(row[col.name])
          setEditing(true)
        }}
      >
        <CellValue col={col} value={row[col.name]} row={row} mode="list" pkName={target.pk} tableName={target.name} />
      </button>
    )
  }

  const singleLine = !['textarea', 'json', 'code'].includes(col.widget)
  const commit = () => {
    setEditing(false)
    if (JSON.stringify(val ?? null) !== JSON.stringify(row[col.name] ?? null)) {
      onCommit({ [col.name]: val ?? null })
    }
  }
  return (
    <div
      ref={wrapRef}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && singleLine) {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          setEditing(false)
        }
      }}
    >
      <FieldInput col={col} tableName={target.name} value={val} row={row} onChange={(v) => setVal(v)} />
    </div>
  )
}

function InlineAddForm({
  target,
  fkCol,
  onSubmit,
  onCancel,
  pending,
}: {
  target: TableMeta
  fkCol: string
  onSubmit: (set: Row) => void
  onCancel: () => void
  pending: boolean
}) {
  const t = useT()
  const [draft, setDraft] = useState<Row>({})
  const fields = target.columns.filter((c) => isEditable(target, c) && c.name !== fkCol)
  return (
    <form
      className="border-t bg-surface1 px-3 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(draft)
      }}
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((col) => (
          <div key={col.name}>
            <div className="mb-1 text-xxs font-semibold uppercase tracking-wide text-muted">
              {col.label ?? col.name}
              {!col.nullable && <span className="ml-0.5 text-serious">*</span>}
            </div>
            <FieldInput
              col={col}
              tableName={target.name}
              value={draft[col.name]}
              row={draft}
              onChange={(v, fkLabel) =>
                setDraft((d) => ({
                  ...d,
                  [col.name]: v,
                  ...(fkLabel !== undefined ? { [`${col.name}__label`]: fkLabel } : {}),
                }))
              }
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          {t('cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? t('creating') : t('create')}
        </button>
      </div>
    </form>
  )
}

function InlineTable({
  inline,
  parentTable,
  parentPk,
}: {
  inline: InlineData
  parentTable: string
  parentPk: string
}) {
  const meta = useMeta()
  const t = useT()
  const qc = useQueryClient()
  const toast = useToast()
  const target = meta.tables.find((tb) => tb.name === inline.table)
  const [page, setPage] = useState(1)
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [hiddenNotice, setHiddenNotice] = useState(false)

  const pageQuery = useQuery({
    queryKey: ['inline', parentTable, parentPk, inline.table, page],
    queryFn: () => api.inlinePage(parentTable, parentPk, inline.table, page),
    enabled: !!target && page > 1,
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['row', parentTable, parentPk] })
    void qc.invalidateQueries({ queryKey: ['inline', parentTable, parentPk, inline.table] })
    void qc.invalidateQueries({ queryKey: ['list', inline.table] })
  }
  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : t('error'))

  const patchMut = useMutation({
    mutationFn: ({ pk, set }: { pk: string; set: Row }) => api.patch(inline.table, pk, set),
    onSuccess: () => {
      setErr(null)
      invalidate()
    },
    onError: fail,
  })
  const deleteMut = useMutation({
    mutationFn: (pk: string) => api.remove(inline.table, pk),
    onSuccess: () => {
      setErr(null)
      invalidate()
      toast(t('deleted'))
    },
    onError: fail,
  })
  const createMut = useMutation({
    mutationFn: (set: Row) => api.create(inline.table, { ...set, [inline.fk_col]: parentPk }),
    onSuccess: async (res) => {
      setErr(null)
      setAdding(false)
      toast(t('created'))
      const createdPk = String(res.row[target?.pk ?? ''] ?? '')
      const prevTotal = inline.total
      void qc.invalidateQueries({ queryKey: ['inline', parentTable, parentPk, inline.table] })
      void qc.invalidateQueries({ queryKey: ['list', inline.table] })
      await qc.invalidateQueries({ queryKey: ['row', parentTable, parentPk] })
      const fresh = qc.getQueryData<RowResponse>(['row', parentTable, parentPk])
      const child = fresh?.inlines.find(
        (i) => i.table === inline.table && i.fk_col === inline.fk_col,
      )
      setHiddenNotice(inlineRowHidden(createdPk, child, prevTotal, target?.pk ?? ''))
    },
    onError: fail,
  })

  if (!target) return null

  const cols = inline.columns && inline.columns.length ? inline.columns : target.list.columns
  const rows = page === 1 ? inline.rows : pageQuery.data?.rows ?? []
  const total = page === 1 ? inline.total : pageQuery.data?.total ?? inline.total
  const pageSize = pageQuery.data?.cap ?? inline.cap ?? INLINE_PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const showActions = inline.can_delete
  const colSpan = cols.length + (showActions ? 2 : 1)

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-[13px] font-semibold text-ink">
          {inline.label}{' '}
          <span className="font-normal tabular-nums text-muted">({fmtInt(total)})</span>
        </h3>
        <div className="flex items-center gap-3">
          {inline.can_create && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xxs font-semibold text-accent hover:underline"
              onClick={() => {
                setAdding((v) => !v)
                setHiddenNotice(false)
              }}
            >
              <IconPlus size={12} /> {t('inline_add')}
            </button>
          )}
          <Link
            to={`/${inline.table}?f_${inline.fk_col}=${encodeURIComponent(parentPk)}`}
            className="text-xxs text-accent hover:underline"
          >
            {t('show_all')} →
          </Link>
        </div>
      </div>

      {err && <div className="border-b bg-surface1 px-3 py-2 text-xxs text-critical">{err}</div>}
      {hiddenNotice && (
        <div className="border-b bg-surface1 px-3 py-2 text-xxs text-muted">{t('inline_row_hidden')}</div>
      )}

      {adding && (
        <InlineAddForm
          target={target}
          fkCol={inline.fk_col}
          pending={createMut.isPending}
          onSubmit={(set) => createMut.mutate(set)}
          onCancel={() => setAdding(false)}
        />
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xxs font-semibold uppercase tracking-wide text-muted">
              {cols.map((c) => (
                <th key={c} className="whitespace-nowrap px-2.5 py-2">
                  {c}
                </th>
              ))}
              <th className="w-8 px-2.5 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={colSpan}>
                  <EmptyState compact icon={<IconInbox size={24} />} title={t('no_results')} />
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const pk = String(row[target.pk])
              return (
                <tr key={pk} className="data-row border-t hover:bg-hover">
                  {cols.map((c) => {
                    const colMeta = target.columns.find((cm) => cm.name === c)
                    const editable = !!colMeta && isEditable(target, colMeta)
                    return (
                      <td
                        key={c}
                        className={clsx(
                          'data-cell whitespace-nowrap px-2.5',
                          colMeta && NUMERIC_WIDGETS.has(colMeta.widget) && 'text-right tabular-nums',
                        )}
                      >
                        {editable && colMeta ? (
                          <InlineEditCell
                            target={target}
                            col={colMeta}
                            row={row}
                            saving={patchMut.isPending}
                            onCommit={(set) => patchMut.mutate({ pk, set })}
                          />
                        ) : colMeta ? (
                          <CellValue col={colMeta} value={row[c]} row={row} mode="list" pkName={target.pk} tableName={target.name} />
                        ) : (
                          String(row[c] ?? '')
                        )}
                      </td>
                    )
                  })}
                  <td className="w-8 px-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        to={`/${target.name}/${encodeURIComponent(pk)}`}
                        className="text-muted hover:text-ink"
                        aria-label={t('detail_open_full')}
                      >
                        <IconChevronRight size={14} />
                      </Link>
                      {showActions && (
                        <button
                          type="button"
                          className="text-muted hover:text-critical disabled:opacity-40"
                          aria-label={t('inline_delete_row')}
                          disabled={deleteMut.isPending}
                          onClick={() => deleteMut.mutate(pk)}
                        >
                          <IconTrash size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2 text-xxs text-muted">
          <span className="tabular-nums">
            {t('range_of', {
              from: fmtInt((page - 1) * pageSize + (rows.length ? 1 : 0)),
              to: fmtInt((page - 1) * pageSize + rows.length),
              total: fmtInt(total),
            })}
          </span>
          <button
            type="button"
            className="btn"
            disabled={page <= 1 || pageQuery.isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t('prev')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={page >= pageCount || pageQuery.isFetching}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            {t('next')}
          </button>
        </div>
      )}
    </div>
  )
}

function fieldErrorsFrom(err: unknown, cols: ColumnMeta[]): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 400) return {}
  const hits: Record<string, string> = {}
  for (const c of cols) {
    if (err.message.includes(`"${c.name}"`)) hits[c.name] = err.message
  }
  return hits
}

function CopyPk({ pk }: { pk: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-mono text-[12px] text-muted hover:text-ink"
      onClick={() => {
        void navigator.clipboard.writeText(pk)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      title={pk}
    >
      {pk}
      {copied ? <IconCheck size={11} className="text-good" /> : <IconCopy size={11} />}
    </button>
  )
}

function CollapsibleCard({
  title,
  spanClass,
  children,
}: {
  title: string
  spanClass: string
  children: React.ReactNode
}) {
  return (
    <details open className={clsx('card group', spanClass)}>
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-[13px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
        {title}
        <IconChevronRight size={14} className="text-muted transition-transform group-open:rotate-90" />
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  )
}

interface DetailBodyProps {
  table: TableMeta
  pk: string
  variant: 'page' | 'drawer' | 'modal'
  siblings?: string[]
  from?: string
  initialTab?: string
  onNavigate?: (pk: string) => void
  onTabChange?: (title: string) => void
  onDeleted?: () => void
}

export function DetailBody({
  table,
  pk,
  variant,
  siblings = [],
  from,
  initialTab = '',
  onNavigate,
  onTabChange,
  onDeleted,
}: DetailBodyProps) {
  const tableName = table.name
  const qc = useQueryClient()
  const toast = useToast()
  const t = useT()
  const overlay = variant !== 'page'

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['row', tableName, pk],
    queryFn: () => api.row(tableName, pk),
  })

  const [draft, setDraft] = useState<Row | null>(null)
  const [pendingAction, setPendingAction] = useState<ActionMeta | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [flashFields, setFlashFields] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useState(initialTab)
  const [editing, setEditing] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraft(null)
    setEditing(false)
  }, [pk])

  const sibIndex = siblings.indexOf(pk)
  const goSibling = (dir: -1 | 1) => {
    const n = sibIndex + dir
    if (sibIndex < 0 || n < 0 || n >= siblings.length) return
    onNavigate?.(siblings[n])
  }

  const row = data?.row
  const effective = draft ?? row ?? {}

  const diff = useMemo(() => {
    if (!row || !draft) return {}
    const d: Row = {}
    for (const c of table.columns) {
      if (!isEditable(table, c)) continue
      if (JSON.stringify(draft[c.name] ?? null) !== JSON.stringify(row[c.name] ?? null)) {
        d[c.name] = draft[c.name] ?? null
      }
    }
    return d
  }, [table, row, draft])
  const dirty = Object.keys(diff).length > 0

  const saveMut = useMutation({
    mutationFn: () => api.patch(tableName, pk, diff),
    onSuccess: (res) => {
      const changed = new Set(Object.keys(diff))
      qc.setQueryData(['row', tableName, pk], { ...data!, row: { ...effective, ...res.row } })
      void qc.invalidateQueries({ queryKey: ['list', tableName] })
      void qc.invalidateQueries({ queryKey: ['rowAudit', tableName, pk] })
      setDraft(null)
      setEditing(false)
      setFlashFields(changed)
      setTimeout(() => setFlashFields(new Set()), 650)
      toast(t('saved'))
    },
  })

  const deleteMut = useMutation({
    mutationFn: () => api.remove(tableName, pk),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['list', tableName] })
      toast(t('deleted'))
      onDeleted?.()
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e), 'error'),
  })

  const doSave = () => {
    if (dirty && !saveMut.isPending) saveMut.mutate()
  }

  const layout = useMemo(() => detailLayout(table), [table])
  const groups = layout.groups
  const useTabs = useTabsLayout(table.detail, groups.length)
  const cols = detailColumns(table.detail)
  const currentTab = useTabs && groups.some((g) => g.title === activeTab) ? activeTab : groups[0]?.title ?? ''

  const selectTab = (title: string) => {
    setActiveTab(title)
    onTabChange?.(title)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        doSave()
      } else if (meta && e.key === '[') {
        e.preventDefault()
        goSibling(-1)
      } else if (meta && e.key === ']') {
        e.preventDefault()
        goSibling(1)
      } else if (meta && /^[1-9]$/.test(e.key) && useTabs) {
        const g = groups[Number(e.key) - 1]
        if (g) {
          e.preventDefault()
          selectTab(g.title)
        }
      } else if (e.key === 'Escape' && dirty && !overlay && !isEditableTarget(e.target)) {
        barRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saveMut.isPending, diff, sibIndex, siblings, useTabs, groups, overlay])

  if (isLoading) {
    return overlay ? (
      <CardSkeleton />
    ) : (
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="h-6" />
        <CardSkeleton />
      </div>
    )
  }
  if (isError || !row) {
    return (
      <div className={clsx('text-center text-critical', overlay ? 'py-8' : 'p-8')}>
        {error instanceof Error ? error.message : t('row_not_found')}
      </div>
    )
  }

  const fieldErrors = fieldErrorsFrom(saveMut.error, table.columns)
  const actions = table.actions.filter((a) => table.perms.actions.includes(a.name))
  const title = interpolate(table.display_title, row)
  const sidebarFields = layout.sidebarFields
    .map((name) => table.columns.find((c) => c.name === name))
    .filter((c): c is ColumnMeta => !!c)

  const canWrite = table.perms.write && !table.read_only
  const heroBadge = table.columns.find((c) => c.widget === 'badge')
  const statCols = (table.detail?.stats ?? [])
    .map((name) => table.columns.find((c) => c.name === name))
    .filter((c): c is ColumnMeta => !!c)
  const cancelEdit = () => {
    setDraft(null)
    setEditing(false)
    saveMut.reset()
  }

  const setField = (col: ColumnMeta, value: unknown, fkLabel?: string) => {
    setDraft((d) => {
      const base = { ...(d ?? row) }
      base[col.name] = value
      if (fkLabel !== undefined) base[`${col.name}__label`] = fkLabel
      return base
    })
    saveMut.reset()
  }

  const renderField = (col: ColumnMeta) => {
    const editable = isEditable(table, col)
    const wide = WIDE_WIDGETS.has(col.widget)
    const label = col.label ?? col.name
    return (
      <div
        key={col.name}
        className={clsx('min-w-0', wide && 'md:col-span-2', flashFields.has(col.name) && 'flash-good rounded-ctl')}
      >
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted">{label}</span>
          {editable && !col.nullable && !col.computed && <span className="text-[11px] text-serious">*</span>}
          {col.computed && (
            <span className="rounded bg-surface2 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted">
              {t('computed_badge')}
            </span>
          )}
        </div>
        {col.widget === 'image' ? (
          <ImageField
            table={tableName}
            col={col}
            pk={pk}
            row={effective}
            canUpload={
              !!(col.params as { uploadable?: boolean }).uploadable &&
              table.perms.write &&
              !table.read_only &&
              !col.readonly
            }
          />
        ) : editable ? (
          <>
            <FieldInput
              col={col}
              tableName={tableName}
              value={effective[col.name]}
              row={effective}
              onChange={(v, fkLabel) => setField(col, v, fkLabel)}
            />
            {fieldErrors[col.name] && <p className="mt-1 text-xxs text-critical">{fieldErrors[col.name]}</p>}
          </>
        ) : (
          <div className="min-h-[24px] text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere]">
            <CellValue col={col} value={effective[col.name]} row={effective} mode="detail" pkName={table.pk} tableName={tableName} />
          </div>
        )}
      </div>
    )
  }

  const fieldGrid = (columns: ColumnMeta[]) => (
    <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">{columns.map(renderField)}</div>
  )

  const readField = (col: ColumnMeta) => {
    const wide = WIDE_WIDGETS.has(col.widget) || col.widget === 'image'
    const label = col.label ?? col.name
    return (
      <div
        key={col.name}
        className={clsx(
          'border-b py-2.5 last:border-0',
          !wide && 'grid grid-cols-[minmax(0,140px)_1fr] items-baseline gap-4',
          flashFields.has(col.name) && 'flash-good',
        )}
      >
        <div className={clsx('flex items-center gap-1.5 text-[12.5px] text-muted', wide && 'mb-1.5')}>
          {label}
          {col.computed && (
            <span className="rounded bg-surface2 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted">
              {t('computed_badge')}
            </span>
          )}
        </div>
        <div className="min-w-0 text-[13.5px] leading-relaxed text-ink [overflow-wrap:anywhere]">
          {col.widget === 'image' ? (
            <ImageField table={tableName} col={col} pk={pk} row={effective} canUpload={false} />
          ) : (
            <CellValue col={col} value={effective[col.name]} row={effective} mode="detail" pkName={table.pk} tableName={tableName} />
          )}
        </div>
      </div>
    )
  }

  const sectionBody = (columns: ColumnMeta[]) =>
    editing ? (
      <div className="p-5">{fieldGrid(columns)}</div>
    ) : (
      <div className="px-5">{columns.map(readField)}</div>
    )

  const sectionCard = (g: FieldGroup) => {
    const spanClass = SECTION_SPAN[clampSpan(g.span, cols) as 1 | 2 | 3]
    if (g.collapsible) {
      return (
        <CollapsibleCard key={g.title || 'all'} title={g.title} spanClass={spanClass}>
          {editing ? fieldGrid(g.columns) : g.columns.map(readField)}
        </CollapsibleCard>
      )
    }
    return (
      <section
        key={g.title || 'all'}
        className={clsx('overflow-hidden rounded-card border bg-surface1', spanClass)}
      >
        {g.title && (
          <div className="border-b bg-surface2/40 px-5 py-2.5">
            <h3 className="text-xxs font-semibold uppercase tracking-wider text-sec">{g.title}</h3>
          </div>
        )}
        {sectionBody(g.columns)}
      </section>
    )
  }

  const fieldsArea = useTabs ? (
    <div className="card overflow-hidden">
      <div className="flex gap-1 border-b px-3">
        {groups.map((g) => (
          <button
            key={g.title}
            type="button"
            onClick={() => selectTab(g.title)}
            className={clsx(
              'relative -mb-px border-b-2 px-2 py-2 text-[13px]',
              g.title === currentTab
                ? 'border-accent text-ink'
                : 'border-transparent text-sec hover:text-ink',
            )}
          >
            {g.title}
          </button>
        ))}
      </div>
      {sectionBody(groups.find((g) => g.title === currentTab)?.columns ?? [])}
    </div>
  ) : (
    <div className={clsx('grid gap-4', SECTION_GRID[cols])}>{groups.map(sectionCard)}</div>
  )

  const sidebar = (
    <div className="space-y-4">
      {sidebarFields.length > 0 && (
        <div className="overflow-hidden rounded-card border bg-surface1">
          <div className="border-b bg-surface2/40 px-4 py-2.5">
            <h3 className="text-xxs font-semibold uppercase tracking-wider text-sec">
              {layout.metaSidebar ? t('detail_meta') : t('detail_summary')}
            </h3>
          </div>
          <dl className="divide-y">
            {sidebarFields.map((col) => (
              <div key={col.name} className="px-4 py-2">
                <dt className="mb-0.5 text-[11px] text-muted">{col.label ?? col.name}</dt>
                <dd className="text-[13px] text-ink [overflow-wrap:anywhere]">
                  <CellValue col={col} value={effective[col.name]} row={effective} mode="detail" pkName={table.pk} tableName={tableName} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <MetaRail
        table={table}
        pk={pk}
        row={effective}
        actions={actions}
        onAction={(a) => setPendingAction(a)}
        onDelete={table.perms.delete ? () => setConfirmDelete(true) : undefined}
      />
    </div>
  )

  const siblingsNav =
    siblings.length > 1 && sibIndex >= 0 ? (
      <div className="ml-1 flex items-center gap-0.5">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-ctl text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
          onClick={() => goSibling(-1)}
          disabled={sibIndex <= 0}
          title="⌘["
          aria-label={t('prev')}
        >
          <IconChevronRight size={15} className="rotate-180" />
        </button>
        <span className="text-xxs tabular-nums text-muted">
          {sibIndex + 1}/{siblings.length}
        </span>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-ctl text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
          onClick={() => goSibling(1)}
          disabled={sibIndex >= siblings.length - 1}
          title="⌘]"
          aria-label={t('next')}
        >
          <IconChevronRight size={15} />
        </button>
      </div>
    ) : null

  const inlines = data.inlines.map((inline) => (
    <InlineTable
      key={`${inline.table}-${inline.fk_col}`}
      inline={inline}
      parentTable={tableName}
      parentPk={pk}
    />
  ))

  const errorBanner =
    saveMut.isError && Object.keys(fieldErrors).length === 0 ? (
      <span className="max-w-xs truncate text-[13px] text-critical">
        {saveMut.error instanceof Error ? saveMut.error.message : t('error')}
      </span>
    ) : null

  const modals = (
    <>
      {pendingAction && (
        <ActionModal
          action={pendingAction}
          count={1}
          onClose={() => setPendingAction(null)}
          onConfirm={async () => {
            const res = await api.action(tableName, pendingAction.name, [pk])
            toast(t('rows_affected', { count: fmtInt(res.affected) }))
            await qc.invalidateQueries({ queryKey: ['row', tableName, pk] })
            await qc.invalidateQueries({ queryKey: ['list', tableName] })
            await qc.invalidateQueries({ queryKey: ['rowAudit', tableName, pk] })
          }}
        />
      )}

      {confirmDelete && (
        <Modal title={`${t('delete')} · ${table.label}`} onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-sec">{t('delete_confirm', { title: title || pk })}</p>
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              {t('cancel')}
            </button>
            <button className="btn btn-danger" onClick={() => deleteMut.mutate()} disabled={deleteMut.isPending}>
              {deleteMut.isPending ? t('deleting') : t('delete')}
            </button>
          </div>
        </Modal>
      )}
    </>
  )

  if (overlay) {
    return (
      <div className="flex min-h-0 flex-col gap-5">
        <div className="sticky top-0 z-10 -mx-5 -mt-5 flex flex-wrap items-center gap-2 border-b bg-surface1 px-5 py-3 sm:-mx-6 sm:px-6">
          <h2 className="min-w-0 truncate text-[15px] font-semibold text-ink">{title || pk}</h2>
          <CopyPk pk={pk} />
          {siblingsNav}
          <div className="flex-1" />
          {canWrite &&
            (editing ? (
              <button type="button" className="btn" onClick={cancelEdit}>
                {t('cancel')}
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => setEditing(true)}>
                {t('edit')}
              </button>
            ))}
          <Link to={`/${tableName}/${encodeURIComponent(pk)}`} className="text-xxs text-accent hover:underline">
            {t('detail_open_full')} →
          </Link>
        </div>

        {fieldsArea}
        {inlines}
        {sidebar}

        {dirty && (
          <div className="sticky bottom-0 -mx-5 -mb-5 flex items-center gap-3 border-t bg-surface1 px-5 py-3 sm:-mx-6 sm:px-6">
            <span className="text-[13px] text-sec">
              {Object.keys(diff).length === 1
                ? t('unsaved_changes_one')
                : t('unsaved_changes', { count: fmtInt(Object.keys(diff).length) })}
            </span>
            {errorBanner}
            <div className="flex-1" />
            <button className="btn" onClick={() => setDraft(null)} disabled={saveMut.isPending}>
              {t('discard')}
            </button>
            <button className="btn btn-primary" onClick={doSave} disabled={saveMut.isPending}>
              {saveMut.isPending ? t('saving') : `${t('save')} ⌘S`}
            </button>
          </div>
        )}

        {modals}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl pb-16">
      <div className="mb-3 flex items-center gap-1.5 text-[13px] text-muted">
        <Link to={from ? `/${tableName}?${from}` : `/${tableName}`} className="shrink-0 hover:text-ink">
          {table.label_plural}
        </Link>
        <IconChevronRight size={13} className="shrink-0 opacity-50" />
        <span className="truncate text-sec">{title || pk}</span>
      </div>

      <div className="mb-4 overflow-hidden rounded-card border bg-surface1">
        <div className="flex flex-wrap items-start gap-4 px-5 py-4">
          <div className="min-w-0">
            <div className="mb-1.5 text-xxs font-semibold uppercase tracking-wider text-muted">{table.label}</div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-ink">{title || pk}</h1>
              {heroBadge && (
                <CellValue
                  col={heroBadge}
                  value={effective[heroBadge.name]}
                  row={effective}
                  mode="detail"
                  pkName={table.pk}
                  tableName={tableName}
                />
              )}
              <CopyPk pk={pk} />
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            {siblingsNav}
            {canWrite &&
              (editing ? (
                <button type="button" className="btn" onClick={cancelEdit} disabled={saveMut.isPending}>
                  {t('cancel')}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
                  {t('edit')}
                </button>
              ))}
          </div>
        </div>
        {statCols.length > 0 && (
          <div className="flex flex-wrap gap-x-9 gap-y-3 border-t bg-surface2/30 px-5 py-3.5">
            {statCols.map((col) => (
              <div key={col.name} className="min-w-[60px]">
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {col.label ?? col.name}
                </div>
                <div className="text-[15px] font-semibold text-ink">
                  <CellValue
                    col={col}
                    value={effective[col.name]}
                    row={effective}
                    mode="detail"
                    pkName={table.pk}
                    tableName={tableName}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-6 wide:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-4">
          {fieldsArea}
          {inlines}
        </div>

        <aside className="wide:sticky wide:top-4 wide:self-start">{sidebar}</aside>
      </div>

      {dirty && (
        <div
          ref={barRef}
          tabIndex={-1}
          className="bar-in fixed bottom-4 left-1/2 z-30 flex items-center gap-3 rounded-card bg-surface1 px-4 py-2.5 shadow-modal outline-none"
        >
          <span className="text-[13px] text-sec">
            {Object.keys(diff).length === 1
              ? t('unsaved_changes_one')
              : t('unsaved_changes', { count: fmtInt(Object.keys(diff).length) })}
          </span>
          {errorBanner}
          <button className="btn" onClick={() => setDraft(null)} disabled={saveMut.isPending}>
            {t('discard')}
          </button>
          <button className="btn btn-primary" onClick={doSave} disabled={saveMut.isPending}>
            {saveMut.isPending ? t('saving') : `${t('save')} ⌘S`}
          </button>
        </div>
      )}

      {modals}
    </div>
  )
}

export default function RowDetail() {
  const { table: tableName, pk = '' } = useParams()
  const table = useTable(tableName)
  const navigate = useNavigate()
  const location = useLocation()
  const t = useT()

  const siblings = useMemo<string[]>(() => {
    const s = (location.state as { siblings?: unknown } | null)?.siblings
    return Array.isArray(s) ? s.map(String) : []
  }, [location.state])
  const from = (location.state as { from?: string } | null)?.from

  if (!table) return <div className="p-8 text-center text-muted">{t('unknown_table')}</div>

  return (
    <DetailBody
      key={`${table.name}/${pk}`}
      table={table}
      pk={pk}
      variant="page"
      siblings={siblings}
      from={from}
      initialTab={decodeURIComponent(location.hash.slice(1))}
      onNavigate={(next) =>
        navigate(`/${table.name}/${encodeURIComponent(next)}`, { state: { siblings, from } })
      }
      onTabChange={(title) =>
        navigate(`${location.pathname}#${encodeURIComponent(title)}`, { replace: true })
      }
      onDeleted={() => navigate(`/${table.name}`)}
    />
  )
}
