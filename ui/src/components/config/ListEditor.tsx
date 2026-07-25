import { useMemo } from 'react'
import type { TableMeta } from '../../api/types'
import type { ListConfigData, TableConfigData } from '../../lib/configModel'
import { allColumnNames } from '../../lib/configModel'
import { useT } from '../../lib/i18n'
import { Chip, Labeled, OrderedChecklist, Section } from './parts'

const PER_PAGE = [25, 50, 100, 200]

export function ListEditor({
  meta,
  model,
  onChange,
}: {
  meta: TableMeta
  model: TableConfigData
  onChange: (m: TableConfigData) => void
}) {
  const t = useT()
  const cols = useMemo(() => allColumnNames(meta), [meta])
  const list: ListConfigData = model.list ?? {}

  const setList = (patch: Partial<ListConfigData>) => {
    const next = { ...list, ...patch }
    onChange({ ...model, list: next })
  }

  const columns = list.columns ?? []
  const order = useMemo(
    () => [...columns.filter((c) => cols.includes(c)), ...cols.filter((c) => !columns.includes(c))],
    [columns, cols],
  )
  const shown = new Set(columns)

  const toggleColumn = (col: string) => {
    // Re-checking restores the column at its display position, not the end.
    setList({
      columns: shown.has(col)
        ? columns.filter((c) => c !== col)
        : order.filter((c) => shown.has(c) || c === col),
    })
  }
  const reorderColumns = (nextOrder: string[]) => {
    setList({ columns: nextOrder.filter((c) => shown.has(c)) })
  }

  const search = new Set(list.search ?? [])
  const toggleSearch = (col: string) => {
    const next = new Set(search)
    if (next.has(col)) next.delete(col)
    else next.add(col)
    setList({ search: [...next] })
  }

  const filters = new Set(list.filters ?? [])
  const toggleFilter = (col: string) => {
    const next = new Set(filters)
    if (next.has(col)) next.delete(col)
    else next.add(col)
    setList({ filters: [...next] })
  }

  const sortRaw = list.sort ?? ''
  const primary = sortRaw.split(',')[0] ?? ''
  const sortCol = primary.replace(/^-/, '')
  const sortDir: 'asc' | 'desc' = primary.startsWith('-') ? 'desc' : 'asc'
  const setSort = (col: string, dir: 'asc' | 'desc') => {
    if (!col) setList({ sort: undefined })
    else setList({ sort: dir === 'desc' ? `-${col}` : col })
  }

  return (
    <div className="space-y-6">
      <Section title={t('cfg_list_columns')} hint={t('cfg_list_columns_hint')}>
        <OrderedChecklist
          order={order}
          checked={shown}
          onReorder={reorderColumns}
          onToggle={toggleColumn}
        />
      </Section>

      <Section title={t('cfg_list_search')}>
        <div className="flex flex-wrap gap-1.5">
          {cols.map((c) => (
            <Chip key={c} label={c} active={search.has(c)} onClick={() => toggleSearch(c)} />
          ))}
        </div>
      </Section>

      <Section title={t('cfg_list_filters')}>
        <div className="flex flex-wrap gap-1.5">
          {cols.map((c) => (
            <Chip key={c} label={c} active={filters.has(c)} onClick={() => toggleFilter(c)} />
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-2 gap-4">
        <Labeled label={t('cfg_list_sort')}>
          <div className="flex gap-1.5">
            <select
              className="input-sm flex-1"
              value={sortCol}
              onChange={(e) => setSort(e.target.value, sortDir)}
            >
              <option value="">{t('cfg_list_sort_none')}</option>
              {cols.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              className="input-sm"
              value={sortDir}
              disabled={!sortCol}
              onChange={(e) => setSort(sortCol, e.target.value as 'asc' | 'desc')}
            >
              <option value="asc">{t('cfg_asc')}</option>
              <option value="desc">{t('cfg_desc')}</option>
            </select>
          </div>
        </Labeled>

        <Labeled label={t('cfg_per_page')}>
          <select
            className="input-sm w-full"
            value={list.per_page ?? ''}
            onChange={(e) => setList({ per_page: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">{t('cfg_field_default')}</option>
            {PER_PAGE.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Labeled>
      </div>
    </div>
  )
}
