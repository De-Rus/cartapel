import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '../api/client'
import { viewMatchesParams } from '../lib/viewState'
import { useT } from '../lib/i18n'
import { useToast } from './Toast'
import { IconPlus, IconX } from './Icons'

export function SavedViews({
  table,
  params,
  hasListState,
  onApply,
  onClear,
}: {
  table: string
  params: URLSearchParams
  hasListState: boolean
  onApply: (query: string) => void
  onClear: () => void
}) {
  const t = useT()
  const qc = useQueryClient()
  const toast = useToast()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  const { data } = useQuery({
    queryKey: ['views', table],
    queryFn: () => api.views(table),
  })
  const views = data?.rows ?? []

  const createMut = useMutation({
    mutationFn: (query: string) =>
      api.createView({ table, name: name.trim(), query, shared: false }),
    onSuccess: () => {
      setNaming(false)
      setName('')
      void qc.invalidateQueries({ queryKey: ['views', table] })
      toast(t('sv_saved'))
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteView(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views', table] }),
  })

  const activeView = views.find((v) => viewMatchesParams(v.query, params))
  const anyActive = hasListState

  const save = () => {
    if (!name.trim()) return
    const q = new URLSearchParams()
    for (const [k, v] of params.entries()) {
      if (k === 'q' || k === 'sort' || k === 'pp' || k.startsWith('f_')) q.append(k, v)
    }
    createMut.mutate(q.toString())
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={onClear}
        className={clsx(
          'rounded-full px-2.5 py-1 text-xxs font-medium',
          !anyActive ? 'bg-surface3 text-ink' : 'text-sec hover:text-ink',
        )}
      >
        {t('sv_all')}
      </button>
      {views.map((v) => {
        const active = v.id === activeView?.id
        return (
          <span
            key={v.id}
            className={clsx(
              'group flex items-center gap-1 rounded-full px-2.5 py-1 text-xxs font-medium',
              active ? 'bg-surface3 text-ink' : 'text-sec hover:text-ink',
            )}
          >
            <button type="button" onClick={() => onApply(v.query)}>
              {v.name}
              {v.shared && <span className="ml-1 text-muted">· {t('sv_shared')}</span>}
            </button>
            {v.own && (
              <button
                type="button"
                className="text-muted opacity-0 hover:text-critical group-hover:opacity-100"
                onClick={() => deleteMut.mutate(v.id)}
                aria-label={t('sv_delete', { name: v.name })}
              >
                <IconX size={10} />
              </button>
            )}
          </span>
        )
      })}
      {naming ? (
        <span className="flex items-center gap-1">
          <input
            autoFocus
            className="input-sm w-28"
            placeholder={t('sv_name_ph')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') setNaming(false)
            }}
          />
          <button type="button" className="btn !px-2 !py-1 text-xxs" onClick={save} disabled={!name.trim()}>
            {t('sv_save')}
          </button>
        </span>
      ) : (
        anyActive && (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="flex items-center gap-1 rounded-full px-2 py-1 text-xxs text-muted hover:text-ink"
          >
            <IconPlus size={10} /> {t('sv_new')}
          </button>
        )
      )}
    </div>
  )
}
