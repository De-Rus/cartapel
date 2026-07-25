import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, ApiError } from '../api/client'
import type { AuditChange, AuditRow } from '../api/types'
import { fmtDateTime, relTime } from '../lib/format'
import { useT } from '../lib/i18n'
import { Skeleton } from './Skeleton'
import { useToast } from './Toast'

function dotColor(action: string): string {
  if (action.startsWith('action:')) return 'var(--warning)'
  if (action === 'create') return 'var(--accent)'
  if (action === 'delete') return 'var(--critical)'
  if (action === 'revert') return 'var(--good)'
  return 'var(--muted)'
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  return s.length > 20 ? `${s.slice(0, 20)}…` : s
}

function Changes({ changes }: { changes: Record<string, AuditChange> | null }) {
  if (!changes) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {Object.entries(changes).map(([k, c]) => (
        <span key={k} className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px]">
          <span className="text-muted">{k}</span>
          <span className="text-serious line-through decoration-[color:var(--muted)]">{fmtVal(c.from)}</span>
          <span className="text-muted">→</span>
          <span className="font-medium text-ink">{fmtVal(c.to)}</span>
        </span>
      ))}
    </div>
  )
}

const REVERTABLE = new Set(['update', 'revert'])

function Entry({ r, table, pk }: { r: AuditRow; table: string; pk: string }) {
  const t = useT()
  const toast = useToast()
  const qc = useQueryClient()
  const revert = useMutation({
    mutationFn: (auditId: number) => api.revert(table, pk, auditId),
    onSuccess: (data) => {
      const undoId = data.audit_id
      toast(
        t('audit_reverted'),
        undoId
          ? { kind: 'ok', action: { label: t('audit_undo'), onClick: () => revert.mutate(undoId) } }
          : 'ok',
      )
      void qc.invalidateQueries({ queryKey: ['row', table, pk] })
      void qc.invalidateQueries({ queryKey: ['rowAudit', table, pk] })
      void qc.invalidateQueries({ queryKey: ['list', table] })
      void qc.invalidateQueries({ queryKey: ['audit'] })
    },
    onError: (e) =>
      toast(
        e instanceof ApiError && e.status === 409 ? t('audit_revert_conflict') : String(e),
        'error',
      ),
  })
  const revertable = REVERTABLE.has(r.action) && r.changes && Object.keys(r.changes).length > 0
  return (
    <li className="group relative pb-4 pl-5 last:pb-0">
      <span
        className="absolute left-0 top-1 h-2 w-2 rounded-full ring-2 ring-[color:var(--surface)]"
        style={{ background: dotColor(r.action) }}
      />
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] text-ink">{r.action}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          {revertable && (
            <button
              type="button"
              disabled={revert.isPending}
              onClick={() => revert.mutate(r.id)}
              className="pointer-events-none text-xxs text-accent opacity-0 transition-opacity hover:underline focus-visible:pointer-events-auto focus-visible:opacity-100 disabled:opacity-50 group-hover:pointer-events-auto group-hover:opacity-100"
            >
              {t('audit_revert')}
            </button>
          )}
          <span className="text-xxs tabular-nums text-muted" title={fmtDateTime(r.ts)}>
            {relTime(r.ts)}
          </span>
        </span>
      </div>
      <div className="text-xxs text-muted">{r.actor}</div>
      <Changes changes={r.changes} />
    </li>
  )
}

export function AuditTimeline({ table, pk }: { table: string; pk: string }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['rowAudit', table, pk],
    queryFn: () => api.rowAudit(table, pk),
  })

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    )
  }

  const rows = data?.rows ?? []
  if (rows.length === 0) {
    return <p className="text-xxs text-muted">{t('audit_empty')}</p>
  }
  const shown = expanded ? rows : rows.slice(0, 5)

  return (
    <div>
      <ol className={clsx('relative', 'before:absolute before:left-[3.5px] before:top-1 before:h-full before:w-px before:bg-[color:var(--border)]')}>
        {shown.map((r) => (
          <Entry key={r.id} r={r} table={table} pk={pk} />
        ))}
      </ol>
      {rows.length > 5 && (
        <button
          type="button"
          className="mt-1 text-xxs text-accent hover:underline"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? t('show_less') : t('show_all')}
        </button>
      )}
    </div>
  )
}
