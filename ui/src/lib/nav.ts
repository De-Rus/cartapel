import type { NavGroup, TableMeta } from '../api/types'

export interface SidebarTable {
  key: string
  to: string
  label: string
  icon: string | null
  rows: number | null
}

export interface SidebarGroup {
  slug: string | null
  label: string
  icon: string | null
  /** `page` = collapse to a single entry linking the first table (tabbed group);
   *  `expanded` = list every table. */
  mode: 'page' | 'expanded'
  section: string | null
  tables: SidebarTable[]
}

export function groupNavMode(g: { nav?: string | null }, groupNavDefault?: string | null): 'page' | 'expanded' {
  return (g.nav ?? groupNavDefault) === 'page' ? 'page' : 'expanded'
}

export function buildSidebarNav(
  nav: NavGroup[] | undefined,
  tables: TableMeta[],
  filter: string,
  groupNavDefault?: string | null,
): SidebarGroup[] | null {
  if (!nav || nav.length === 0) return null
  const byKey = new Map(tables.map((t) => [t.name, t]))
  const f = filter.trim().toLowerCase()
  const groups: SidebarGroup[] = []
  for (const g of nav) {
    const mode = groupNavMode(g, groupNavDefault)
    const items: SidebarTable[] = []
    for (const key of g.tables) {
      const tb = byKey.get(key)
      if (!tb) continue
      // In page mode the group is one entry; filter matches on the group label.
      if (f && mode === 'expanded' && !tb.label_plural.toLowerCase().includes(f)) continue
      items.push({
        key,
        to: `/${key}`,
        label: tb.label_plural,
        icon: tb.icon ?? null,
        rows: tb.approx_rows ?? null,
      })
    }
    if (mode === 'page' && f && !g.label.toLowerCase().includes(f)) continue
    if (items.length === 0) continue
    groups.push({
      slug: g.slug ?? null,
      label: g.label,
      icon: g.icon ?? null,
      mode,
      section: g.section ?? null,
      tables: items,
    })
  }
  return groups
}
