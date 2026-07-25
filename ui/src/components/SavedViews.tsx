import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '../api/client'
import { viewMatchesParams } from '../lib/viewState'
import { useT } from '../lib/i18n'
import { useToast } from './Toast'
import { IconFilterOff, IconLink, IconPlus, IconX } from './Icons'

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
  const [shared, setShared] = useState(false)

  const { data } = useQuery({
    queryKey: ['views', table],
    queryFn: () => api.views(table),
  })
  const views = data?.rows ?? []

  const createMut = useMutation({
    mutationFn: (query: string) =>
      api.createView({ table, name: name.trim(), query, shared }),
    onSuccess: () => {
      setNaming(false)
      setName('')
      setShared(false)
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
      {views.map((v) => {
        const active = v.id === activeView?.id
        return (
          <span
            key={v.id}
            className={clsx(
              'group flex h-6 items-center gap-1 rounded-full px-2.5 text-xxs font-medium',
              active ? 'bg-surface3 text-ink' : 'text-sec hover:bg-surface2 hover:text-ink',
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
          <button
            type="button"
            className={clsx(
              'rounded-full border px-2 py-1 text-xxs',
              shared ? 'border-accent text-ink' : 'text-muted hover:text-ink',
            )}
            onClick={() => setShared(!shared)}
            title={t('sv_shared_hint')}
          >
            {t('sv_shared_toggle')}
          </button>
          <button type="button" className="btn !px-2 !py-1 text-xxs" onClick={save} disabled={!name.trim()}>
            {t('sv_save')}
          </button>
        </span>
      ) : (
        anyActive && (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="flex h-6 items-center gap-1 rounded-full border border-transparent px-2 text-xxs text-muted hover:border-[color:var(--border)] hover:bg-surface2 hover:text-ink"
          >
            <IconPlus size={10} /> {t('sv_save_view')}
          </button>
        )
      )}
      {anyActive && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(window.location.href)
            toast(t('sv_link_copied'))
          }}
          title={t('sv_link')}
          aria-label={t('sv_link')}
          className="flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-surface2 hover:text-ink"
        >
          <IconLink size={12} />
        </button>
      )}
      {anyActive && (
        <button
          type="button"
          onClick={onClear}
          title={t('clear_filters')}
          aria-label={t('clear_filters')}
          className="flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-surface2 hover:text-ink"
        >
          <IconFilterOff size={12} />
        </button>
      )}
    </div>
  )
}
