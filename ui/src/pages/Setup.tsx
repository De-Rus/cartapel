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

interface GroupDef {
  slug: string
  label: string
  icon: string
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default function Setup() {
  const t = useT()
  const toast = useToast()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({ queryKey: ['discover'], queryFn: api.discover })
  const [checked, setChecked] = useState<Set<string> | null>(null)
  const [assign, setAssign] = useState<Record<string, string>>({})
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [extra, setExtra] = useState<GroupDef[]>([])
  const [files, setFiles] = useState<Record<string, string> | null>(null)

  const tables = useMemo(() => data?.tables ?? [], [data])

  const groupDefs: GroupDef[] = useMemo(() => {
    const m = new Map<string, GroupDef>()
    for (const tb of tables) {
      const g = tb.suggested_group ?? { slug: 'tables', label: 'Tables', icon: 'layers' }
      if (!m.has(g.slug)) m.set(g.slug, g)
    }
    for (const g of extra) if (!m.has(g.slug)) m.set(g.slug, g)
    return [...m.values()]
  }, [tables, extra])

  const slugOf = (tb: DiscoverTable) => assign[tb.name] ?? tb.suggested_group?.slug ?? 'tables'
  const labelOf = (g: GroupDef) => labels[g.slug] ?? g.label

  const grouped = useMemo(() => {
    const m = new Map<string, DiscoverTable[]>()
    for (const tb of tables) {
      const s = slugOf(tb)
      m.set(s, [...(m.get(s) ?? []), tb])
    }
    return groupDefs
      .map((g) => ({ ...g, tables: m.get(g.slug) ?? [] }))
      .filter((g) => g.tables.length > 0)
      .sort((a, b) => labelOf(a).localeCompare(labelOf(b)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, groupDefs, assign, labels])

  const sel = checked ?? new Set(tables.filter((tb) => !tb.noise && tb.pk).map((tb) => tb.name))

  const toggle = (name: string) => {
    const n = new Set(sel)
    if (n.has(name)) n.delete(name)
    else n.add(name)
    setChecked(n)
  }

  const moveTo = (tb: DiscoverTable, slug: string) => {
    if (slug === '__new__') {
      const label = window.prompt(t('setup_new_group'))?.trim()
      if (!label) return
      const s = slugify(label) || 'group'
      setExtra((e) => (e.some((g) => g.slug === s) ? e : [...e, { slug: s, label, icon: 'layers' }]))
      setLabels((l) => ({ ...l, [s]: label }))
      setAssign((a) => ({ ...a, [tb.name]: s }))
    } else {
      setAssign((a) => ({ ...a, [tb.name]: slug }))
    }
  }

  const apply = useMutation({
    mutationFn: () =>
      api.applySetup(
        grouped
          .map((g) => ({
            slug: g.slug,
            label: labelOf(g),
            icon: g.icon,
            tables: g.tables.filter((tb) => sel.has(tb.name)).map((tb) => tb.name),
          }))
          .filter((g) => g.tables.length > 0),
      ),
    onSuccess: async (r) => {
      if (r.ok) {
        toast(t('setup_done', { n: String(r.tables ?? 0) }), 'ok')
        // Dashboard redirects back here while meta still says "no tables" —
        // refetch meta BEFORE navigating so the new panel is what renders.
        await qc.refetchQueries({ queryKey: ['meta'] })
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

  return (
    <div className="mx-auto max-w-2xl space-y-5 py-8">
      <div>
        <h1 className="text-lg font-semibold text-ink">{t('setup_title')}</h1>
        <p className="mt-1 text-[13px] text-muted">{t('setup_sub', { n: String(tables.length) })}</p>
      </div>

      {grouped.map((g) => (
        <div key={g.slug} className="card">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <AppIcon icon={g.icon} size={14} className="text-muted" />
            <input
              className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none"
              value={labelOf(g)}
              onChange={(e) => setLabels((l) => ({ ...l, [g.slug]: e.target.value }))}
            />
            <span className="text-xxs text-muted">
              {g.tables.filter((tb) => sel.has(tb.name)).length}/{g.tables.length}
            </span>
          </div>
          <div className="divide-y divide-[color:var(--border)]">
            {g.tables.map((tb) => (
              <div key={tb.name} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-hover">
                <input
                  type="checkbox"
                  checked={sel.has(tb.name)}
                  onChange={() => toggle(tb.name)}
                  className="accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{tb.name}</span>
                {tb.noise && <span className="text-xxs text-muted">{t('setup_noise')}</span>}
                {tb.is_view && <span className="text-xxs text-muted">{t('cfg_disc_view')}</span>}
                {!tb.pk && <span className="text-xxs text-warning">{t('setup_no_pk')}</span>}
                {tb.approx_rows != null && (
                  <span className="text-xxs tabular-nums text-muted">{fmtCompact(tb.approx_rows)}</span>
                )}
                <select
                  className="h-6 rounded-ctl border bg-page px-1 text-xxs text-sec"
                  value={slugOf(tb)}
                  onChange={(e) => moveTo(tb, e.target.value)}
                >
                  {groupDefs.map((gd) => (
                    <option key={gd.slug} value={gd.slug}>
                      {labelOf(gd)}
                    </option>
                  ))}
                  <option value="__new__">{t('setup_new_group_opt')}</option>
                </select>
              </div>
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
