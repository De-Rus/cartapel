import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type { GroupsLayout, GroupWrite } from '../api/types'
import { useClickOutside, useDirtyGuard } from '../lib/hooks'
import { useT, type TFn } from '../lib/i18n'
import { Modal } from '../components/Modal'
import { ReadOnlyNotice } from '../components/config/ReadOnlyNotice'
import { useToast } from '../components/Toast'
import { IconColumns, IconDots, IconPlus, IconTrash } from '../components/Icons'
import { IconPicker } from '../components/config/pickers'

const DND_TABLE = 'application/x-cartapel-table'
const DND_DISCOVER = 'application/x-cartapel-discover'
const DND_COLUMN = 'application/x-cartapel-column'

interface Col {
  slug: string
  label: string
  icon: string | null
  order: number
  tables: string[]
}
export interface Board {
  groups: Col[]
  ungrouped: string[]
}

export function toBoard(data: GroupsLayout): Board {
  return {
    groups: data.groups.map((g) => ({
      slug: g.slug,
      label: g.label,
      icon: g.icon ?? null,
      order: g.order,
      tables: [...g.tables],
    })),
    ungrouped: [...data.ungrouped],
  }
}

export function placementKey(b: Board): string {
  return JSON.stringify({
    groups: b.groups.map((g) => [g.slug, g.tables]),
    ungrouped: b.ungrouped,
  })
}

function universe(b: Board): Set<string> {
  const s = new Set<string>()
  for (const g of b.groups) for (const t of g.tables) s.add(t)
  for (const t of b.ungrouped) s.add(t)
  return s
}

export function mergeBoard(staged: Board, data: GroupsLayout): Board {
  const fresh = toBoard(data)
  const stagedUniverse = universe(staged)
  const freshUniverse = universe(fresh)
  const stagedByGroup = new Map(staged.groups.map((g) => [g.slug, g.tables]))
  const placed = new Set<string>()

  const groups = fresh.groups.map((g) => {
    const kept = (stagedByGroup.get(g.slug) ?? []).filter((tb) => freshUniverse.has(tb))
    const added = g.tables.filter((tb) => !stagedUniverse.has(tb))
    const tables = [...kept, ...added]
    tables.forEach((tb) => placed.add(tb))
    return { ...g, tables }
  })

  const ungrouped: string[] = []
  for (const tb of staged.ungrouped) {
    if (freshUniverse.has(tb) && !placed.has(tb)) {
      ungrouped.push(tb)
      placed.add(tb)
    }
  }
  for (const tb of freshUniverse) if (!placed.has(tb)) ungrouped.push(tb)

  return { groups, ungrouped }
}

function TableCard({
  name,
  onDragStart,
}: {
  name: string
  onDragStart: (e: React.DragEvent) => void
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="group flex cursor-grab select-none items-center gap-2 rounded-ctl border bg-surface2 px-3 py-2 text-[13px] text-sec transition-colors hover:border-accent hover:bg-hover hover:text-ink"
    >
      <span className="text-muted transition-colors group-hover:text-sec" aria-hidden>
        ⠿
      </span>
      <span className="truncate font-mono">{name}</span>
    </div>
  )
}

function GroupMenu({
  slug,
  t,
  onRename,
  onDelete,
}: {
  slug: string
  t: TFn
  onRename: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(() => setOpen(false))
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={t('cfg_group_menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-ctl text-muted transition-colors hover:bg-hover hover:text-ink"
        onClick={() => setOpen((o) => !o)}
      >
        <IconDots size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="pop-in absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-card bg-surface1 py-1 shadow-menu"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-hover"
            onClick={() => {
              setOpen(false)
              onRename()
            }}
          >
            <span className="text-[13px] text-sec">{t('cfg_group_rename')}</span>
            <span className="font-mono text-xxs text-muted">{slug}</span>
          </button>
          <div className="my-1 border-t" />
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-sec hover:bg-hover hover:text-critical"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            <IconTrash size={14} />
            {t('cfg_groups_delete')}
          </button>
        </div>
      )}
    </div>
  )
}

function GroupColumn({
  col,
  t,
  over,
  dropHandlers,
  onColumnDrop,
  onCardDragStart,
  onColumnDragStart,
  onPatch,
  onRename,
  onDelete,
}: {
  col: Col
  t: TFn
  over: boolean
  dropHandlers: React.ComponentProps<'div'>
  onColumnDrop: (fromSlug: string) => void
  onCardDragStart: (name: string) => (e: React.DragEvent) => void
  onColumnDragStart: (e: React.DragEvent) => void
  onPatch: (patch: { label?: string; icon?: string | null }) => void
  onRename: () => void
  onDelete: () => void
}) {
  const [label, setLabel] = useState(col.label)
  const [icon, setIcon] = useState(col.icon ?? '')
  useEffect(() => setLabel(col.label), [col.label])
  useEffect(() => setIcon(col.icon ?? ''), [col.icon])

  return (
    <div
      className={clsx(
        'flex w-72 shrink-0 flex-col rounded-card border bg-surface1 transition-colors',
        over && 'ring-2 ring-accent',
      )}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_COLUMN)) e.preventDefault()
      }}
      onDrop={(e) => {
        const from = e.dataTransfer.getData(DND_COLUMN)
        if (from) {
          e.preventDefault()
          onColumnDrop(from)
        }
      }}
    >
      <div
        draggable
        onDragStart={onColumnDragStart}
        title={t('cfg_group_reorder')}
        className="flex cursor-grab items-center gap-2 border-b px-3 py-2.5"
      >
        <IconPicker
          compact
          value={icon || undefined}
          ariaLabel={t('cfg_group_icon')}
          onChange={(v) => {
            setIcon(v ?? '')
            if ((v ?? null) !== (col.icon ?? null)) onPatch({ icon: v ?? null })
          }}
        />
        <input
          className="min-w-0 flex-1 cursor-text rounded-ctl border border-transparent bg-transparent px-1.5 py-1 text-[13px] font-medium text-ink transition-colors hover:bg-hover focus:border-accent focus:bg-page focus:outline-none"
          value={label}
          aria-label={t('cfg_group_label')}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label.trim() && label !== col.label && onPatch({ label: label.trim() })}
        />
        <GroupMenu slug={col.slug} t={t} onRename={onRename} onDelete={onDelete} />
      </div>
      <div
        {...dropHandlers}
        className={clsx(
          'flex min-h-[96px] flex-1 flex-col gap-2 p-3 transition-colors',
          over && 'bg-selected',
        )}
      >
        {col.tables.length === 0 && (
          <div className="flex flex-1 items-center justify-center rounded-ctl border border-dashed bg-surface2 px-3 py-6 text-center text-xxs text-muted">
            {t('cfg_groups_col_empty')}
          </div>
        )}
        {col.tables.map((name) => (
          <TableCard key={name} name={name} onDragStart={onCardDragStart(name)} />
        ))}
      </div>
    </div>
  )
}

function CreateGroupModal({
  onClose,
  onCreated,
  onReadOnly,
}: {
  onClose: () => void
  onCreated: () => void
  onReadOnly: (res: GroupWrite) => void
}) {
  const t = useT()
  const [slug, setSlug] = useState('')
  const [label, setLabel] = useState('')
  const [icon, setIcon] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mut = useMutation({
    mutationFn: () =>
      api.createGroup({ slug: slug.trim(), label: label.trim(), icon: icon.trim() || undefined }),
    onSuccess: (res) => {
      if (!res.ok) {
        onReadOnly(res)
        return
      }
      onCreated()
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  })

  return (
    <Modal title={t('cfg_group_create')} onClose={onClose}>
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xxs font-medium uppercase tracking-wide text-muted">{t('cfg_group_slug')}</span>
          <input
            className="input w-full font-mono"
            value={slug}
            autoFocus
            placeholder="market-data"
            onChange={(e) => setSlug(e.target.value)}
          />
          <span className="text-xxs text-muted">{t('cfg_group_slug_hint')}</span>
        </label>
        <label className="block space-y-1">
          <span className="text-xxs font-medium uppercase tracking-wide text-muted">{t('cfg_group_label')}</span>
          <input
            className="input w-full"
            value={label}
            placeholder="Market data"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xxs font-medium uppercase tracking-wide text-muted">{t('cfg_group_icon')}</span>
          <IconPicker value={icon || undefined} ariaLabel={t('cfg_group_icon')} onChange={(v) => setIcon(v ?? '')} />
          <span className="text-xxs text-muted">{t('cfg_group_icon_hint')}</span>
        </label>
        {error && <p className="text-[13px] text-critical">{error}</p>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={onClose} disabled={mut.isPending}>
          {t('cancel')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            setError(null)
            mut.mutate()
          }}
          disabled={mut.isPending || !slug.trim() || !label.trim()}
        >
          {mut.isPending ? t('saving') : t('cfg_group_create')}
        </button>
      </div>
    </Modal>
  )
}

function RenameGroupModal({
  slug,
  onClose,
  onRenamed,
  onReadOnly,
}: {
  slug: string
  onClose: () => void
  onRenamed: () => void
  onReadOnly: (res: GroupWrite) => void
}) {
  const t = useT()
  const [to, setTo] = useState(slug)
  const [error, setError] = useState<string | null>(null)
  const mut = useMutation({
    mutationFn: () => api.renameGroup(slug, to.trim()),
    onSuccess: (res) => {
      if (!res.ok) {
        onReadOnly(res)
        return
      }
      onRenamed()
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  })
  return (
    <Modal title={t('cfg_group_rename')} onClose={onClose}>
      <label className="block space-y-1">
        <span className="text-xxs font-medium uppercase tracking-wide text-muted">{t('cfg_group_rename_to')}</span>
        <input
          className="input w-full font-mono"
          value={to}
          autoFocus
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
      {error && <p className="mt-2 text-[13px] text-critical">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={onClose} disabled={mut.isPending}>
          {t('cancel')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            setError(null)
            mut.mutate()
          }}
          disabled={mut.isPending || !to.trim() || to.trim() === slug}
        >
          {mut.isPending ? t('saving') : t('save')}
        </button>
      </div>
    </Modal>
  )
}

export default function ConfigGroups() {
  const t = useT()
  const qc = useQueryClient()
  const toast = useToast()

  const { data, isLoading, isError } = useQuery({ queryKey: ['groups'], queryFn: api.groups })

  const [board, setBoard] = useState<Board | null>(null)
  const [baseline, setBaseline] = useState('')
  const [over, setOver] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [readonlyHcl, setReadonlyHcl] = useState<string | null>(null)

  const stateRef = useRef({ board, baseline })
  stateRef.current = { board, baseline }

  useEffect(() => {
    if (!data) return
    const { board: cur, baseline: base } = stateRef.current
    const serverKey = placementKey(toBoard(data))
    const isDirty = cur != null && placementKey(cur) !== base
    setBoard(cur && isDirty ? mergeBoard(cur, data) : toBoard(data))
    setBaseline(serverKey)
  }, [data])

  const dirty = board != null && placementKey(board) !== baseline
  useDirtyGuard(dirty)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['groups'] })
    void qc.invalidateQueries({ queryKey: ['meta'] })
  }

  const handleWrite = (res: GroupWrite): boolean => {
    if (res.ok) return true
    if (res.hcl) setReadonlyHcl(res.hcl)
    else toast(t('cfg_groups_readonly_hint'), 'error')
    return false
  }

  const adopt = useMutation({
    mutationFn: ({ name, group }: { name: string; group?: string }) =>
      api.putConfig(name, group ? { group } : {}),
    onSuccess: (res, vars) => {
      if (handleWrite(res)) {
        toast(t('cfg_groups_added', { name: vars.name }))
        void qc.invalidateQueries({ queryKey: ['discover'] })
        invalidate()
      }
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : t('error'), 'error'),
  })

  const saveLayout = useMutation({
    mutationFn: () =>
      api.putGroupLayout({
        groups: board!.groups.map((g) => ({ slug: g.slug, tables: g.tables })),
        ungrouped: board!.ungrouped,
      }),
    onSuccess: (res) => {
      if (handleWrite(res)) {
        toast(t('cfg_groups_saved'))
        setBaseline(placementKey(board!))
        invalidate()
      }
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : t('error'), 'error'),
  })

  const patchMeta = useMutation({
    mutationFn: ({ slug, patch }: { slug: string; patch: { label?: string; icon?: string | null } }) =>
      api.patchGroup(slug, patch),
    onSuccess: (res) => handleWrite(res) && invalidate(),
    onError: (e) => toast(e instanceof ApiError ? e.message : t('error'), 'error'),
  })

  const reorder = useMutation({
    mutationFn: (orders: Array<{ slug: string; order: number }>) =>
      Promise.all(orders.map((o) => api.patchGroup(o.slug, { order: o.order }))),
    onSuccess: (results) => {
      const bad = results.find((r) => !r.ok)
      if (bad && !bad.ok) handleWrite(bad)
      invalidate()
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : t('error'), 'error'),
  })

  const del = useMutation({
    mutationFn: (slug: string) => api.deleteGroup(slug),
    onSuccess: (res) => handleWrite(res) && invalidate(),
    onError: (e) =>
      setDeleteError(
        e instanceof ApiError && e.status === 409
          ? t('cfg_groups_delete_nonempty')
          : e instanceof ApiError
            ? e.message
            : t('error'),
      ),
  })

  const moveTable = (name: string, target: string) => {
    setBoard((b) => {
      if (!b) return b
      const groups = b.groups.map((g) => ({ ...g, tables: g.tables.filter((x) => x !== name) }))
      const ungrouped = b.ungrouped.filter((x) => x !== name)
      if (target === 'ungrouped') ungrouped.push(name)
      else {
        const g = groups.find((x) => x.slug === target)
        if (g) g.tables = [...g.tables, name]
      }
      return { groups, ungrouped }
    })
  }

  const reorderColumns = (fromSlug: string, toSlug: string) => {
    if (fromSlug === toSlug || !board) return
    const groups = [...board.groups]
    const from = groups.findIndex((g) => g.slug === fromSlug)
    const to = groups.findIndex((g) => g.slug === toSlug)
    if (from < 0 || to < 0) return
    const [moved] = groups.splice(from, 1)
    groups.splice(to, 0, moved)
    const renumbered = groups.map((g, i) => ({ ...g, order: i }))
    setBoard({ ...board, groups: renumbered })
    reorder.mutate(renumbered.map((g) => ({ slug: g.slug, order: g.order })))
  }

  const cardDragStart = (name: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DND_TABLE, name)
    e.dataTransfer.effectAllowed = 'move'
  }
  const discoverDragStart = (name: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DND_DISCOVER, name)
    e.dataTransfer.effectAllowed = 'copy'
  }

  const dropTarget = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DND_TABLE) || e.dataTransfer.types.includes(DND_DISCOVER)) {
        e.preventDefault()
        setOver(target)
      }
    },
    onDragLeave: () => setOver((o) => (o === target ? null : o)),
    onDrop: (e: React.DragEvent) => {
      const discovered = e.dataTransfer.getData(DND_DISCOVER)
      const table = e.dataTransfer.getData(DND_TABLE)
      setOver(null)
      if (discovered) {
        e.preventDefault()
        adopt.mutate({ name: discovered, group: target === 'ungrouped' ? undefined : target })
      } else if (table) {
        e.preventDefault()
        moveTable(table, target)
      }
    },
  })

  if (isLoading) return <div className="card px-4 py-10 text-center text-muted">{t('loading')}</div>
  if (isError || !board || !data) {
    return <div className="card px-4 py-10 text-center text-critical">{t('cfg_groups_load_failed')}</div>
  }

  const cols = [...board.groups].sort((a, b) => a.order - b.order)

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <IconColumns size={20} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold text-ink">{t('cfg_groups_title')}</h1>
          <p className="text-[13px] text-muted">{t('cfg_groups_subtitle')}</p>
        </div>
        <button className="btn" onClick={() => setCreating(true)}>
          <IconPlus size={14} /> {t('cfg_groups_new')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => saveLayout.mutate()}
          disabled={!dirty || saveLayout.isPending}
        >
          {saveLayout.isPending ? t('saving') : t('cfg_groups_save_layout')}
        </button>
      </div>

      {readonlyHcl !== null && (
        <ReadOnlyNotice hcl={readonlyHcl} file="groups.hcl" onBack={() => setReadonlyHcl(null)} />
      )}

      {dirty && (
        <div className="rounded-ctl border border-warning/40 bg-warning/10 px-3 py-2 text-xxs text-warning">
          {t('cfg_groups_dirty')}
        </div>
      )}

      <div className="-mx-0.5 flex gap-4 overflow-x-auto px-0.5 pb-3">
        {cols.map((col) => (
          <GroupColumn
            key={col.slug}
            col={col}
            t={t}
            over={over === col.slug}
            dropHandlers={dropTarget(col.slug)}
            onColumnDrop={(from) => reorderColumns(from, col.slug)}
            onColumnDragStart={(e) => {
              e.dataTransfer.setData(DND_COLUMN, col.slug)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onCardDragStart={cardDragStart}
            onPatch={(patch) => patchMeta.mutate({ slug: col.slug, patch })}
            onRename={() => setRenaming(col.slug)}
            onDelete={() => {
              setDeleteError(null)
              del.mutate(col.slug)
            }}
          />
        ))}

        <div className="flex w-72 shrink-0 flex-col rounded-card border border-dashed bg-surface1">
          <div className="border-b border-dashed px-3 py-2.5">
            <div className="text-[13px] font-medium text-sec">{t('cfg_groups_ungrouped')}</div>
            <div className="text-xxs text-muted">{t('cfg_groups_ungrouped_hint')}</div>
          </div>
          <div
            {...dropTarget('ungrouped')}
            className={clsx(
              'flex min-h-[96px] flex-1 flex-col gap-2 p-3 transition-colors',
              over === 'ungrouped' && 'bg-selected',
            )}
          >
            {board.ungrouped.length === 0 && (
              <div className="flex flex-1 items-center justify-center rounded-ctl border border-dashed bg-surface2 px-3 py-6 text-center text-xxs text-muted">
                {t('cfg_groups_col_empty')}
              </div>
            )}
            {board.ungrouped.map((name) => (
              <TableCard key={name} name={name} onDragStart={cardDragStart(name)} />
            ))}
          </div>
        </div>
      </div>

      <div className="card p-3">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">{t('cfg_groups_discover')}</span>
        </div>
        <p className="mb-2 text-xxs text-muted">{t('cfg_groups_discover_hint')}</p>
        {data.unconfigured.length === 0 ? (
          <div className="text-xxs text-muted">{t('cfg_groups_discover_empty')}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {data.unconfigured.map((name) => (
              <div
                key={name}
                draggable
                onDragStart={discoverDragStart(name)}
                className="flex cursor-grab select-none items-center gap-1.5 rounded-full border border-dashed bg-surface2 px-2.5 py-1 text-xxs font-mono text-sec hover:text-ink"
              >
                <span className="text-muted" aria-hidden>
                  +
                </span>
                {name}
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CreateGroupModal
          onClose={() => setCreating(false)}
          onReadOnly={(res) => {
            setCreating(false)
            handleWrite(res)
          }}
          onCreated={() => {
            setCreating(false)
            toast(t('cfg_groups_saved'))
            invalidate()
          }}
        />
      )}
      {renaming && (
        <RenameGroupModal
          slug={renaming}
          onClose={() => setRenaming(null)}
          onReadOnly={(res) => {
            setRenaming(null)
            handleWrite(res)
          }}
          onRenamed={() => {
            setRenaming(null)
            invalidate()
          }}
        />
      )}
      {deleteError && (
        <Modal title={t('cfg_groups_delete')} onClose={() => setDeleteError(null)}>
          <p className="text-[13px] text-critical">{deleteError}</p>
          <div className="mt-4 flex justify-end">
            <button className="btn" onClick={() => setDeleteError(null)}>
              {t('cancel')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
