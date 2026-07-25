import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { DiscoverTable } from '../api/types'
import { fmtCompact } from '../lib/format'
import { useT } from '../lib/i18n'
import { AppIcon } from '../lib/icon'
import { useToast } from '../components/Toast'
import { Skeleton } from '../components/Skeleton'

interface PlanGroup {
  slug: string
  label: string
  icon: string
  tables: DiscoverTable[]
}

export default function Setup() {
  const t = useT()
  const toast = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({ queryKey: ['discover'], queryFn: api.discover })
  const [checked, setChecked] = useState<Set<string> | null>(null)
  const [files, setFiles] = useState<Record<string, string> | null>(null)

  const groups: PlanGroup[] = useMemo(() => {
    const m = new Map<string, PlanGroup>()
    for (const tb of data?.tables ?? []) {
      const g = tb.suggested_group ?? { slug: 'tables', label: 'Tables', icon: 'layers' }
      const e = m.get(g.slug) ?? { ...g, tables: [] }
      e.tables.push(tb)
      m.set(g.slug, e)
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [data])

  const sel =
    checked ??
    new Set((data?.tables ?? []).filter((tb) => !tb.noise && tb.pk).map((tb) => tb.name))

  const toggle = (name: string) => {
    const n = new Set(sel)
    if (n.has(name)) n.delete(name)
    else n.add(name)
    setChecked(n)
  }

  const apply = useMutation({
    mutationFn: () =>
      api.applySetup(
        groups
          .map((g) => ({
            slug: g.slug,
            label: g.label,
            icon: g.icon,
            tables: g.tables.filter((tb) => sel.has(tb.name)).map((tb) => tb.name),
          }))
          .filter((g) => g.tables.length > 0),
      ),
    onSuccess: (r) => {
      if (r.ok) {
        toast(t('setup_done', { n: String(r.tables ?? 0) }), 'ok')
        void qc.invalidateQueries()
        navigate('/')
      } else {
        setFiles(r.files ?? {})
      }
    },
    onError: (e) => toast(String(e), 'error'),
  })

  if (isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-2 py-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    )
  }

  if (files) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 py-8">
        <h1 className="text-lg font-semibold text-ink">{t('setup_readonly_title')}</h1>
        <p className="text-[13px] text-muted">{t('setup_readonly_sub')}</p>
        {Object.entries(files).map(([path, contents]) => (
          <div key={path} className="card">
            <div className="flex items-center justify-between border-b px-3 py-1.5">
              <span className="font-mono text-xxs text-sec">{path}</span>
              <button
                type="button"
                className="text-xxs text-accent hover:underline"
                onClick={() => void navigator.clipboard.writeText(contents)}
              >
                {t('copy')}
              </button>
            </div>
            {contents && <pre className="max-h-40 overflow-auto px-3 py-2 text-xxs text-sec">{contents}</pre>}
          </div>
        ))}
      </div>
    )
  }

  const total = (data?.tables ?? []).length
  return (
    <div className="mx-auto max-w-2xl space-y-5 py-8">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t('setup_title')}</h1>
        <p className="mt-1 text-[13px] text-muted">{t('setup_sub', { n: String(total) })}</p>
      </div>

      {groups.map((g) => (
        <div key={g.slug} className="card">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <AppIcon icon={g.icon} size={14} className="text-muted" />
            <span className="text-[13px] font-medium text-ink">{g.label}</span>
            <span className="text-xxs text-muted">{g.tables.filter((tb) => sel.has(tb.name)).length}/{g.tables.length}</span>
          </div>
          <div className="divide-y divide-[color:var(--border)]">
            {g.tables.map((tb) => (
              <label key={tb.name} className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-hover">
                <input
                  type="checkbox"
                  checked={sel.has(tb.name)}
                  onChange={() => toggle(tb.name)}
                  className="accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{tb.name}</span>
                {tb.noise && <span className="text-xxs text-muted">{t('setup_noise')}</span>}
                {tb.is_view && <span className="text-xxs text-muted">view</span>}
                {!tb.pk && <span className="text-xxs text-warning">{t('setup_no_pk')}</span>}
                {tb.approx_rows != null && (
                  <span className="text-xxs tabular-nums text-muted">{fmtCompact(tb.approx_rows)}</span>
                )}
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn btn-primary"
          disabled={apply.isPending || sel.size === 0}
          onClick={() => apply.mutate()}
        >
          {t('setup_write', { n: String(sel.size) })}
        </button>
        <button type="button" className="btn" onClick={() => navigate('/audit')}>
          {t('setup_skip')}
        </button>
      </div>
    </div>
  )
}
