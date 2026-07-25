import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../api/client'
import type { DiscoverTable } from '../api/types'
import { useT } from '../lib/i18n'
import { useToast } from '../components/Toast'
import { IconCheck, IconSearch } from '../components/Icons'

function AddRow({ table, onAdded }: { table: DiscoverTable; onAdded: () => void }) {
  const t = useT()
  const toast = useToast()
  const { data: layout } = useQuery({ queryKey: ['groups'], queryFn: api.groups })
  const groups = layout?.groups ?? []
  const [group, setGroup] = useState('')

  const mut = useMutation({
    mutationFn: () => api.putConfig(table.name, group ? { group } : {}),
    onSuccess: (res) => {
      if (res.ok) {
        toast(t('cfg_disc_added', { name: table.name }))
        onAdded()
      } else {
        toast(t('cfg_groups_readonly_hint'), 'error')
      }
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : t('error'), 'error'),
  })

  return (
    <div className="flex items-center gap-2">
      <select
        className="input-sm w-40"
        value={group}
        onChange={(e) => setGroup(e.target.value)}
        aria-label={t('cfg_disc_pick_group')}
      >
        <option value="">{t('cfg_disc_ungrouped_option')}</option>
        {groups.map((g) => (
          <option key={g.slug} value={g.slug}>
            {g.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => mut.mutate()}
        disabled={mut.isPending}
      >
        {mut.isPending ? t('saving') : t('cfg_disc_add')}
      </button>
    </div>
  )
}

export default function DiscoverTables() {
  const t = useT()
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery({ queryKey: ['discover'], queryFn: api.discover })

  const onAdded = () => {
    void qc.invalidateQueries({ queryKey: ['discover'] })
    void qc.invalidateQueries({ queryKey: ['groups'] })
    void qc.invalidateQueries({ queryKey: ['meta'] })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-start gap-3">
        <IconSearch size={20} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold text-ink">{t('cfg_disc_title')}</h1>
          <p className="text-[13px] text-muted">{t('cfg_disc_subtitle')}</p>
        </div>
      </div>

      {isLoading && <div className="card px-4 py-10 text-center text-muted">{t('loading')}</div>}
      {isError && <div className="card px-4 py-10 text-center text-critical">{t('cfg_disc_load_failed')}</div>}
      {data?.tables.length === 0 && (
        <div className="card px-4 py-10 text-center text-muted">{t('cfg_disc_empty')}</div>
      )}

      {data && data.tables.length > 0 && (
        <div className="card divide-y overflow-hidden">
          {data.tables.map((tb) => (
            <div key={`${tb.schema}.${tb.name}`} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[14px] font-medium text-ink">{tb.name}</span>
                  {tb.is_view && (
                    <span className="rounded-full border px-2 py-px text-xxs font-medium text-muted">
                      {t('cfg_disc_view')}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xxs text-muted">
                  <span>
                    {t('cfg_disc_col_schema')}: <span className="font-mono">{tb.schema}</span>
                  </span>
                  <span>
                    {t('cfg_disc_col_pk')}:{' '}
                    {tb.pk ? (
                      <span className="inline-flex items-center gap-1 font-mono">
                        <IconCheck size={11} className="text-good" />
                        {tb.pk}
                      </span>
                    ) : (
                      <span className="text-serious">{t('cfg_disc_no_pk')}</span>
                    )}
                  </span>
                  <span>
                    {t('cfg_disc_col_cols')}: <span className="tabular-nums">{tb.column_count}</span>
                  </span>
                  {tb.approx_rows != null && tb.approx_rows >= 0 && (
                    <span>
                      {t('cfg_disc_col_rows')}: <span className="tabular-nums">~{tb.approx_rows.toLocaleString()}</span>
                    </span>
                  )}
                </div>
              </div>
              <AddRow table={tb} onAdded={onAdded} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
