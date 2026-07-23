import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '../api/client'
import type { Meta } from '../api/types'
import { BASE } from '../lib/base'
import { fuzzyRank, highlightParts } from '../lib/fuzzy'
import { useDebounced } from '../lib/hooks'
import { useT } from '../lib/i18n'
import { IconBolt, IconClock, IconReturn, IconSearch, IconTable } from './Icons'

export type PaletteMode = 'default' | 'search' | 'table'

interface RecentItem {
  label: string
  sub: string
  to: string
}

const RECENT_KEY = 'steward.recent'

export function pushRecent(item: RecentItem): void {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const list: RecentItem[] = raw ? JSON.parse(raw) : []
    const next = [item, ...list.filter((r) => r.to !== item.to)].slice(0, 8)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

function readRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

type Item =
  | { kind: 'jump'; id: string; primary: string; secondary: string; to: string; ranges: Array<[number, number]> }
  | { kind: 'action'; id: string; primary: string; secondary: string; run: () => void }
  | { kind: 'record'; id: string; primary: string; secondary: string; to: string }
  | { kind: 'recent'; id: string; primary: string; secondary: string; to: string }

interface Group {
  key: string
  label: string
  items: Item[]
}

const KIND_LABEL: Record<Item['kind'], string> = {
  jump: 'Table',
  action: 'Action',
  record: 'Record',
  recent: 'Recent',
}

export function CommandPalette({
  meta,
  open,
  mode,
  currentTable,
  onClose,
}: {
  meta: Meta
  open: boolean
  mode: PaletteMode
  currentTable: string | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const t = useT()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const debouncedQ = useDebounced(q, 180)

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
      const root = document.getElementById('root')
      if (root) root.style.overflow = 'hidden'
      const prev = document.activeElement as HTMLElement | null
      requestAnimationFrame(() => inputRef.current?.focus())
      return () => {
        if (root) root.style.overflow = ''
        prev?.focus?.()
      }
    }
  }, [open])

  const { data: searchData } = useQuery({
    queryKey: ['search', debouncedQ],
    queryFn: () => api.search(debouncedQ),
    enabled: open && debouncedQ.trim().length > 0,
    staleTime: 30_000,
  })

  const jumpTargets = useMemo(() => {
    const tables = meta.tables.map((tb) => ({
      id: `t:${tb.name}`,
      primary: tb.label_plural,
      secondary: tb.group ?? t('group_tables'),
      to: `/${tb.name}`,
    }))
    const pages = (meta.pages ?? []).map((p) => ({
      id: `p:${p.id}`,
      primary: p.label,
      secondary: p.group ?? 'Pages',
      to: `/p/${p.id}`,
    }))
    const extra =
      mode === 'table'
        ? []
        : [
            { id: 'nav:dashboard', primary: t('nav_dashboard'), secondary: '', to: '/' },
            { id: 'nav:audit', primary: t('nav_audit'), secondary: '', to: '/audit' },
          ]
    return [...extra, ...tables, ...pages]
  }, [meta, mode, t])

  const groups = useMemo<Group[]>(() => {
    const query = q.trim()
    const out: Group[] = []

    if (!query) {
      const recent = readRecent()
      if (recent.length && mode !== 'table') {
        out.push({
          key: 'recent',
          label: 'Recent',
          items: recent.map((r, i) => ({
            kind: 'recent' as const,
            id: `recent:${i}`,
            primary: r.label,
            secondary: r.sub,
            to: r.to,
          })),
        })
      }
      out.push({
        key: 'jump',
        label: mode === 'table' ? 'Jump to table' : 'Jump to',
        items: jumpTargets.map((j) => ({ kind: 'jump' as const, ranges: [], ...j })),
      })
      return out
    }

    if (mode !== 'search' && currentTable) {
      const tb = meta.tables.find((x) => x.name === currentTable)
      const acts = (tb?.actions ?? []).filter((a) => tb!.perms.actions.includes(a.name))
      const ranked = fuzzyRank(query, acts, (a) => a.label)
      if (ranked.length) {
        out.push({
          key: 'actions',
          label: 'Actions',
          items: ranked.map((r) => ({
            kind: 'action' as const,
            id: `action:${r.item.name}`,
            primary: `${r.item.label} — ${tb!.label_plural}`,
            secondary: 'Select rows, then run',
            run: () => navigate(`/${currentTable}`),
          })),
        })
      }
    }

    const jumpRanked = fuzzyRank(query, jumpTargets, (j) => j.primary)
    if (jumpRanked.length) {
      out.push({
        key: 'jump',
        label: mode === 'table' ? 'Jump to table' : 'Jump to',
        items: jumpRanked.map((r) => ({
          kind: 'jump' as const,
          ranges: r.match.ranges,
          ...r.item,
        })),
      })
    }

    if (mode !== 'table') {
      const hits = searchData?.results ?? []
      if (hits.length) {
        out.push({
          key: 'records',
          label: 'Records',
          items: hits.map((h, i) => ({
            kind: 'record' as const,
            id: `rec:${h.table}:${h.pk}:${i}`,
            primary: h.title,
            secondary: h.label,
            to: `/${h.table}/${encodeURIComponent(h.pk)}`,
          })),
        })
      }
    }
    return out
  }, [q, mode, currentTable, jumpTargets, searchData, meta, navigate])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  useEffect(() => {
    setActive(0)
  }, [q])

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const runItem = (item: Item, newTab: boolean) => {
    if (item.kind === 'action') {
      item.run()
      onClose()
      return
    }
    if (item.kind === 'record' || item.kind === 'recent') {
      pushRecent({ label: item.primary, sub: item.secondary, to: item.to })
    }
    if (newTab) {
      window.open(`${BASE}${item.to}`, '_blank')
    } else {
      navigate(item.to)
    }
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[active]
      if (item) runItem(item, e.metaKey || e.ctrlKey)
    }
  }

  let runningIndex = -1

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/50"
      style={{ paddingTop: '14vh' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="palette-in flex h-fit max-h-[70vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-card bg-surface1 shadow-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="flex h-[52px] shrink-0 items-center gap-3 px-3.5">
          <IconSearch size={16} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none"
            placeholder={mode === 'table' ? 'Jump to table…' : 'Search or jump to…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={flat[active] ? `palette-item-${active}` : undefined}
          />
          <span className="kbd">Esc</span>
        </div>

        <div
          ref={listRef}
          id="palette-list"
          role="listbox"
          className="min-h-0 flex-1 overflow-y-auto border-t py-2"
        >
          {flat.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-muted">{t('no_results')}</div>
          )}
          {groups.map((g) => (
            <div key={g.key}>
              <div className="px-3 py-1 text-xxs font-semibold uppercase tracking-wide text-muted">
                {g.label}
              </div>
              {g.items.map((item) => {
                runningIndex += 1
                const idx = runningIndex
                const isActive = idx === active
                return (
                  <div
                    key={item.id}
                    id={`palette-item-${idx}`}
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    className={clsx(
                      'flex h-10 cursor-pointer items-center gap-3 px-3',
                      isActive && 'bg-selected',
                    )}
                    style={isActive ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
                    onMouseMove={() => setActive(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      runItem(item, e.metaKey || e.ctrlKey)
                    }}
                  >
                    <span className={clsx('shrink-0', isActive ? 'text-accent' : 'text-muted')}>
                      {item.kind === 'action' ? (
                        <IconBolt size={16} />
                      ) : item.kind === 'recent' ? (
                        <IconClock size={16} />
                      ) : (
                        <IconTable size={16} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">
                        {item.kind === 'jump'
                          ? highlightParts(item.primary, item.ranges).map((p, i) => (
                              <span
                                key={i}
                                style={p.match ? { color: 'var(--accent)', fontWeight: 500 } : undefined}
                              >
                                {p.text}
                              </span>
                            ))
                          : item.primary}
                      </span>
                      {item.secondary && (
                        <span className="block truncate text-xxs text-muted">{item.secondary}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-xxs text-muted">{KIND_LABEL[item.kind]}</span>
                    {isActive && <IconReturn size={13} className="shrink-0 text-muted" />}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="flex h-8 shrink-0 items-center gap-3 border-t bg-surface2 px-3 text-xxs text-muted">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>⌘↵ new tab</span>
        </div>
      </div>
    </div>
  )
}
