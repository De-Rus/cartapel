import { useState } from 'react'
import clsx from 'clsx'
import type { FilterMeta, TableMeta } from '../api/types'
import {
  type Condition,
  conditionsFromParams,
  needsValue,
  OP_LABELS,
  opsForKind,
} from '../lib/filters'
import { useClickOutside } from '../lib/hooks'
import { IconFilter, IconX } from './Icons'

function filterOps(f: FilterMeta) {
  if (f.ops && f.ops.length) return f.ops
  if (f.type === 'bool') return ['eq'] as const
  return opsForKind(f.kind)
}

function ValueInput({
  filter,
  cond,
  onChange,
}: {
  filter: FilterMeta | undefined
  cond: Condition
  onChange: (v: string) => void
}) {
  if (!needsValue(cond.op)) return null
  if (filter?.type === 'bool') {
    return (
      <select className="input-sm flex-1" value={cond.value} onChange={(e) => onChange(e.target.value)}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }
  if (filter?.type === 'enum' && filter.options.length && (cond.op === 'eq' || cond.op === 'ne')) {
    return (
      <select className="input-sm flex-1" value={cond.value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {filter.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  const placeholder =
    cond.op === 'between' ? 'a..b' : cond.op === 'in' ? 'a,b,c' : 'value'
  return (
    <input
      className="input-sm flex-1 tabular-nums"
      value={cond.value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function FilterBuilder({
  table,
  entries,
  activeCount,
  onApply,
}: {
  table: TableMeta
  entries: Array<[string, string]>
  activeCount: number
  onApply: (conditions: Condition[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(() => setOpen(false))
  // Defaults-first: with no configured filters, every introspected column is a
  // filter candidate — a fresh (wizard-written) table must still be filterable.
  const filters: FilterMeta[] = table.list.filters.length
    ? table.list.filters
    : table.columns
        .filter((c) => !['json', 'binary'].includes(c.kind))
        .map((c) => ({
          name: c.name,
          label: c.label ?? c.name,
          type: c.kind === 'bool' ? ('bool' as const) : ('custom' as const),
          options: [],
          kind: c.kind,
        }))

  const [conds, setConds] = useState<Condition[]>([])

  const openBuilder = () => {
    const existing = conditionsFromParams(entries).filter((c) =>
      filters.some((f) => f.name === c.col),
    )
    setConds(existing.length ? existing : [])
    setOpen(true)
  }

  const addCondition = () => {
    const f = filters[0]
    if (!f) return
    const ops = filterOps(f)
    setConds((cs) => [...cs, { col: f.name, op: ops[0], value: '' }])
  }

  const update = (i: number, patch: Partial<Condition>) => {
    setConds((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  const apply = () => {
    const valid = conds.filter((c) => !needsValue(c.op) || c.value.trim() !== '')
    onApply(valid)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={clsx('btn', activeCount > 0 && 'text-ink')}
        onClick={() => (open ? setOpen(false) : openBuilder())}
        aria-expanded={open}
      >
        <IconFilter size={13} />
        Filter
        {activeCount > 0 && (
          <span className="ml-0.5 rounded-full bg-selected px-1.5 text-xxs tabular-nums text-accent">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="pop-in absolute left-0 z-30 mt-1 w-[360px] rounded-card bg-surface1 p-3 shadow-menu">
          {conds.length === 0 && (
            <p className="px-1 py-3 text-center text-[13px] text-muted">No conditions yet.</p>
          )}
          <div className="space-y-2">
            {conds.map((c, i) => {
              const f = filters.find((x) => x.name === c.col)
              const ops = f ? filterOps(f) : opsForKind(undefined)
              return (
                <div key={i} className="flex items-center gap-1.5">
                  <select
                    className="input-sm w-28 shrink-0"
                    value={c.col}
                    onChange={(e) => {
                      const nf = filters.find((x) => x.name === e.target.value)
                      const nops = nf ? filterOps(nf) : opsForKind(undefined)
                      update(i, { col: e.target.value, op: nops[0], value: '' })
                    }}
                  >
                    {filters.map((f2) => (
                      <option key={f2.name} value={f2.name}>
                        {f2.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input-sm w-24 shrink-0"
                    value={c.op}
                    onChange={(e) => update(i, { op: e.target.value as Condition['op'] })}
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {OP_LABELS[op]}
                      </option>
                    ))}
                  </select>
                  <ValueInput filter={f} cond={c} onChange={(v) => update(i, { value: v })} />
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 text-muted hover:text-ink"
                    onClick={() => setConds((cs) => cs.filter((_, idx) => idx !== i))}
                    aria-label="Remove condition"
                  >
                    <IconX size={12} />
                  </button>
                </div>
              )
            })}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <button type="button" className="text-[13px] text-accent hover:underline" onClick={addCondition}>
              + Add condition
            </button>
            <button type="button" className="btn btn-primary" onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
