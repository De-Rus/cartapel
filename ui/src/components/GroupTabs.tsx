import { NavLink } from 'react-router-dom'
import clsx from 'clsx'
import { useMeta } from '../lib/meta'
import { groupNavMode } from '../lib/nav'

export function GroupTabs({ table }: { table: string | undefined }) {
  const meta = useMeta()
  if (!table) return null
  const group = meta.nav?.find((g) => g.tables.includes(table))
  if (!group || groupNavMode(group, meta.group_nav) !== 'page' || group.tables.length < 2) return null
  const byName = new Map(meta.tables.map((t) => [t.name, t]))
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1 border-b pb-px">
      {group.tables.map((name) => {
        const tb = byName.get(name)
        if (!tb) return null
        return (
          <NavLink
            key={name}
            to={`/${name}`}
            className={({ isActive }) =>
              clsx(
                '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
                isActive
                  ? 'border-accent text-ink'
                  : 'border-transparent text-muted hover:text-ink',
              )
            }
          >
            {tb.label_plural}
          </NavLink>
        )
      })}
    </div>
  )
}
