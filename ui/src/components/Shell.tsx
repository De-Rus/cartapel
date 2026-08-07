import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '../api/client'
import type { Meta, PageMeta, TableMeta } from '../api/types'
import { fmtCompact, setFormatLocale } from '../lib/format'
import { MetaContext } from '../lib/meta'
import { I18nProvider, makeT, TFn, useT } from '../lib/i18n'
import { pickBrandLogo, resolveBrandLogo } from '../lib/brand'
import { buildSidebarNav, type SidebarGroup } from '../lib/nav'
import { AppIcon } from '../lib/icon'
import { useMediaQuery } from '../lib/hooks'
import { useGlobalKeys } from '../lib/keys'
import { useTablePrefetch } from '../lib/prefetch'
import { applyBrandAccent, useDensity, useIsDark, useTheme } from '../lib/theme'
import { applyThemeConfig } from '../lib/themes'
import { Breadcrumbs } from './Breadcrumbs'
import { CommandPalette, type PaletteMode } from './CommandPalette'
import { KeyboardHelp } from './KeyboardHelp'
import { UserMenu } from './UserMenu'
import { setViewAsRole, viewAsRole } from '../lib/viewAs'
import {
  IconAudit,
  IconChevronDown,
  IconChevronRight,
  IconChevronsLeft,
  IconColumns,
  IconDashboard,
  IconMenu,
  IconSearch,
  IconShield,
  IconSliders,
  IconTable,
  IconUsers,
} from './Icons'

function navCls(active: boolean) {
  return clsx(
    'flex h-8 items-center gap-2.5 rounded-ctl px-2 text-[13px]',
    active
      ? 'bg-surface3 font-medium text-ink shadow-[inset_2px_0_0_var(--accent)]'
      : 'text-sec hover:bg-hover hover:text-ink',
  )
}

function initials(label: string): string {
  return label.slice(0, 2)
}

type NavEntry =
  | { kind: 'table'; key: string; to: string; label: string; group: string | null; rows: number | null }
  | { kind: 'page'; key: string; to: string; label: string; group: string | null; icon?: string | null }

function SidebarGroups({
  tables,
  pages,
  t,
  rail,
  filter,
  onHoverTable,
}: {
  tables: TableMeta[]
  pages: PageMeta[]
  t: TFn
  rail: boolean
  filter: string
  onHoverTable?: (name: string) => void
}) {
  const groups = useMemo(() => {
    const entries: NavEntry[] = [
      ...tables.map(
        (tb): NavEntry => ({
          kind: 'table',
          key: `t:${tb.name}`,
          to: `/${tb.name}`,
          label: tb.label_plural,
          group: tb.group,
          rows: tb.approx_rows ?? null,
        }),
      ),
      ...pages.map(
        (p): NavEntry => ({
          kind: 'page',
          key: `p:${p.id}`,
          to: `/p/${p.id}`,
          label: p.label,
          group: p.group,
          icon: p.icon ?? 'layout-dashboard',
        }),
      ),
    ]
    const f = filter.trim().toLowerCase()
    const filtered = f ? entries.filter((e) => e.label.toLowerCase().includes(f)) : entries
    const m = new Map<string, NavEntry[]>()
    for (const e of filtered) {
      const g = e.group ?? t('group_tables')
      const arr = m.get(g) ?? []
      arr.push(e)
      m.set(g, arr)
    }
    return [...m.entries()]
  }, [tables, pages, t, filter])

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  return (
    <>
      {groups.map(([group, items]) => {
        const isCollapsed = collapsed.has(group)
        const solo = items.length === 1 && items[0].label.toLowerCase() === group.toLowerCase()
        if (solo) {
          const e = items[0]
          return (
            <div key={group} className="mt-4">
              <NavLink
                to={e.to}
                title={rail ? e.label : undefined}
                className={({ isActive }) => clsx(navCls(isActive), rail && 'justify-center')}
              >
                {e.kind === 'page' && e.icon ? (
                  <AppIcon
                    icon={e.icon}
                    size={15}
                    className={clsx('w-[15px] shrink-0 text-center leading-none', rail ? 'block' : 'hidden wide:block')}
                  />
                ) : (
                  <IconTable size={15} className={clsx('shrink-0 text-muted', rail ? 'block' : 'hidden wide:block')} />
                )}
                {!rail && <span className="hidden truncate wide:block">{e.label}</span>}
                {rail && !(e.kind === 'page' && e.icon) && (
                  <span className="text-xxs font-semibold uppercase">{initials(e.label)}</span>
                )}
              </NavLink>
            </div>
          )
        }
        return (
          <div key={group} className="mt-4">
            {!rail && (
              <button
                type="button"
                className="mb-1 flex w-full items-center gap-1 px-2 text-left text-xxs font-semibold uppercase tracking-wider text-muted hover:text-sec"
                onClick={() =>
                  setCollapsed((s) => {
                    const n = new Set(s)
                    if (n.has(group)) n.delete(group)
                    else n.add(group)
                    return n
                  })
                }
              >
                {isCollapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                {group}
              </button>
            )}
            <div
              className={clsx(
                'space-y-0.5',
                !rail && 'wide:ml-3.5 wide:border-l wide:border-[color:var(--border)] wide:pl-1.5',
                !rail && isCollapsed && 'hidden',
              )}
            >
              {items.map((e) => (
                <NavLink
                  key={e.key}
                  to={e.to}
                  title={rail ? e.label : undefined}
                  onMouseEnter={e.kind === 'table' ? () => onHoverTable?.(e.to.slice(1)) : undefined}
                  className={({ isActive }) => clsx(navCls(isActive), rail && 'justify-center')}
                >
                  {e.kind === 'page' && e.icon ? (
                    <AppIcon
                      icon={e.icon}
                      size={15}
                      className={clsx('w-[15px] shrink-0 text-center leading-none', rail ? 'block' : 'hidden wide:block')}
                    />
                  ) : (
                    <IconTable size={15} className={clsx('shrink-0 text-muted', rail ? 'block' : 'hidden wide:block')} />
                  )}
                  {!rail && <span className="hidden truncate wide:block">{e.label}</span>}
                  {rail && !(e.kind === 'page' && e.icon) && (
                    <span className="text-xxs font-semibold uppercase">{initials(e.label)}</span>
                  )}
                  {!rail && e.kind === 'table' && e.rows != null && (
                    <span className="ml-auto hidden text-xxs tabular-nums text-muted wide:block">
                      {fmtCompact(e.rows)}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

function AccessNav({ t, rail }: { t: TFn; rail: boolean }) {
  const items: Array<{ to: string; label: string; icon: React.ReactNode }> = [
    { to: '/_access/users', label: t('access_users'), icon: <IconUsers size={15} /> },
    { to: '/_access/roles', label: t('access_roles'), icon: <IconShield size={15} /> },
  ]
  return (
    <div className="mt-4 border-t pt-3">
      {!rail && (
        <div className="mb-1 flex items-center gap-1 px-2 text-xxs font-semibold uppercase tracking-wider text-muted">
          <IconShield size={10} className="text-accent" />
          <span className="hidden wide:block">{t('access_group')}</span>
        </div>
      )}
      <div className="space-y-0.5">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            title={it.label}
            className={({ isActive }) => clsx(navCls(isActive), rail ? 'justify-center' : 'wide:justify-start justify-center')}
          >
            <span className="shrink-0 text-muted">{it.icon}</span>
            {!rail && <span className="hidden truncate wide:block">{it.label}</span>}
          </NavLink>
        ))}
      </div>
    </div>
  )
}

function ConfigNav({ t, rail }: { t: TFn; rail: boolean }) {
  const items: Array<{ to: string; label: string; icon: React.ReactNode }> = [
    { to: '/_config/groups', label: t('config_groups'), icon: <IconColumns size={15} /> },
    { to: '/_config/dashboard', label: t('config_dashboard'), icon: <IconDashboard size={15} /> },
    { to: '/_config/discover', label: t('config_discover'), icon: <IconSearch size={15} /> },
  ]
  return (
    <div className="mt-4 border-t pt-3">
      {!rail && (
        <div className="mb-1 flex items-center gap-1 px-2 text-xxs font-semibold uppercase tracking-wider text-muted">
          <IconSliders size={10} className="text-accent" />
          <span className="hidden wide:block">{t('config_group')}</span>
        </div>
      )}
      <div className="space-y-0.5">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            title={it.label}
            className={({ isActive }) => clsx(navCls(isActive), rail ? 'justify-center' : 'wide:justify-start justify-center')}
          >
            <span className="shrink-0 text-muted">{it.icon}</span>
            {!rail && <span className="hidden truncate wide:block">{it.label}</span>}
          </NavLink>
        ))}
      </div>
    </div>
  )
}

function BrandMark({
  logo,
  name,
  size,
  onBand = false,
}: {
  logo: string | null
  name?: string | null
  size: 'sidebar' | 'login'
  onBand?: boolean
}) {
  const brand = (name ?? '').trim() || 'cartapel'
  const inkCls = onBand ? 'text-[color:var(--band-ink)]' : 'text-ink'
  if (logo) {
    // Full lockups already include the wordmark — don't duplicate the name.
    const h = size === 'sidebar' ? 'h-10' : 'h-14'
    return (
      <img
        src={logo}
        alt={brand}
        className={clsx(h, 'mx-auto block w-auto max-w-full object-contain')}
      />
    )
  const cls =
    size === 'sidebar'
      ? 'text-[15px] font-medium lowercase tracking-[0.3em]'
      : 'text-xl font-medium lowercase tracking-[0.35em]'
  return <span className={clsx(cls, inkCls)}>{brand}</span>
}

export { BrandMark }

const NAV_EXPANDED_KEY = 'cartapel.navExpanded'

// Groups are collapsed by default; the persisted set holds the ones the user
// has opened. The active group is auto-expanded regardless.
function useExpandedGroups(): [Set<string>, (label: string) => void] {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(NAV_EXPANDED_KEY)
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  const toggle = (label: string) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(label)) n.delete(label)
      else n.add(label)
      try {
        localStorage.setItem(NAV_EXPANDED_KEY, JSON.stringify([...n]))
      } catch {
        /* ignore */
      }
      return n
    })
  }
  return [expanded, toggle]
}

function TableNav({
  groups,
  rail,
  filter,
  expanded,
  onToggle,
  onHoverTable,
}: {
  groups: SidebarGroup[]
  rail: boolean
  filter: string
  expanded: Set<string>
  onToggle: (label: string) => void
  onHoverTable?: (name: string) => void
}) {
  const filtering = filter.trim().length > 0
  const { pathname } = useLocation()
  const activeGroup = groups.find((g) => g.tables.some((e) => e.to === pathname))?.label
  return (
    <>
      {groups.map((g) => {
        if (g.mode === 'page' && g.tables.length > 0) {
          const active = g.tables.some((e) => e.to === pathname)
          const to = g.tables[0].to
          return (
            <div key={g.label} className="mt-1">
              <NavLink
                to={to}
                title={rail ? g.label : undefined}
                onMouseEnter={() => onHoverTable?.(g.tables[0].key)}
                className={clsx(navCls(active), rail && 'justify-center')}
              >
                {g.icon ? (
                  <AppIcon
                    icon={g.icon}
                    size={15}
                    className={clsx('w-[15px] shrink-0 text-center leading-none', rail ? 'block' : 'hidden wide:block')}
                  />
                ) : (
                  <IconTable size={15} className={clsx('shrink-0 text-muted', rail ? 'block' : 'hidden wide:block')} />
                )}
                {!rail && <span className="hidden truncate wide:block">{g.label}</span>}
                {rail && !g.icon && <span className="text-xxs font-semibold uppercase">{initials(g.label)}</span>}
              </NavLink>
            </div>
          )
        }
        const isOpen = filtering || expanded.has(g.label) || g.label === activeGroup
        const isCollapsed = !isOpen
        return (
          <div key={g.label} className="mt-4">
            {!rail && (
              <button
                type="button"
                className="mb-1 flex w-full items-center gap-1 px-2 text-left text-xxs font-semibold uppercase tracking-wider text-muted hover:text-sec"
                onClick={() => onToggle(g.label)}
              >
                {isCollapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                {g.icon && <AppIcon icon={g.icon} size={12} className="shrink-0 leading-none" />}
                <span className="truncate">{g.label}</span>
              </button>
            )}
            <div
              className={clsx(
                'space-y-0.5',
                !rail && 'wide:ml-3.5 wide:border-l wide:border-[color:var(--border)] wide:pl-1.5',
                !rail && isCollapsed && 'hidden',
              )}
            >
              {g.tables.map((e) => (
                <NavLink
                  key={e.key}
                  to={e.to}
                  title={rail ? e.label : undefined}
                  onMouseEnter={() => onHoverTable?.(e.key)}
                  className={({ isActive }) => clsx(navCls(isActive), rail && 'justify-center')}
                >
                  {e.icon ? (
                    <AppIcon
                      icon={e.icon}
                      size={15}
                      className={clsx('w-[15px] shrink-0 text-center leading-none', rail ? 'block' : 'hidden wide:block')}
                    />
                  ) : (
                    <IconTable size={15} className={clsx('shrink-0 text-muted', rail ? 'block' : 'hidden wide:block')} />
                  )}
                  {!rail && <span className="hidden truncate wide:block">{e.label}</span>}
                  {rail && !e.icon && (
                    <span className="text-xxs font-semibold uppercase">{initials(e.label)}</span>
                  )}
                  {!rail && e.rows != null && (
                    <span className="ml-auto hidden text-xxs tabular-nums text-muted wide:block">
                      {fmtCompact(e.rows)}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

function SidebarNav({
  meta,
  t,
  rail,
  filter,
  onHoverTable,
}: {
  meta: Meta
  t: TFn
  rail: boolean
  filter: string
  onHoverTable?: (name: string) => void
}) {
  const groups = useMemo(
    () => buildSidebarNav(meta.nav, meta.tables, filter, meta.group_nav),
    [meta.nav, meta.tables, filter, meta.group_nav],
  )
  const [expanded, toggle] = useExpandedGroups()
  if (groups === null) {
    return (
      <SidebarGroups tables={meta.tables} pages={meta.pages ?? []} t={t} rail={rail} filter={filter} onHoverTable={onHoverTable} />
    )
  }
  return (
    <>
      <TableNav groups={groups} rail={rail} filter={filter} expanded={expanded} onToggle={toggle} onHoverTable={onHoverTable} />
      <SidebarGroups tables={[]} pages={meta.pages ?? []} t={t} rail={rail} filter={filter} />
    </>
  )
}

function MobileDrawer({
  meta,
  logo,
  t,
  onClose,
}: {
  meta: Meta
  logo: string | null
  t: TFn
  onClose: () => void
}) {
  const navGroups = buildSidebarNav(meta.nav, meta.tables, '', meta.group_nav)
  return (
    <div className="fixed inset-0 z-50 flex" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-black/50" />
      <aside className="sheet-in-left relative flex h-full w-64 flex-col border-r bg-surface1 px-3 py-4" aria-label="Primary">
        <div className="mb-3 flex min-h-10 items-center justify-center px-2">
          <BrandMark logo={logo} name={meta.brand} size="sidebar" />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto">
          {meta.has_dashboard && (
            <div className="space-y-0.5">
              <NavLink to="/" end onClick={onClose} className={({ isActive }) => navCls(isActive)}>
                <IconDashboard size={15} className="shrink-0" />
                <span>{t('nav_dashboard')}</span>
              </NavLink>
            </div>
          )}
          {navGroups ? (
            navGroups.map((g) => (
              <div key={g.label} className="mt-4">
                <div className="mb-1 flex items-center gap-1 px-2 text-xxs font-semibold uppercase tracking-wider text-muted">
                  {g.icon && <AppIcon icon={g.icon} size={12} className="shrink-0 leading-none" />}
                  <span className="truncate">{g.label}</span>
                </div>
                <div className="space-y-0.5">
                  {g.tables.map((e) => (
                    <NavLink
                      key={e.key}
                      to={e.to}
                      onClick={onClose}
                      className={({ isActive }) => navCls(isActive)}
                    >
                      {e.icon ? (
                        <AppIcon icon={e.icon} size={15} className="w-[15px] shrink-0 text-center leading-none" />
                      ) : (
                        <IconTable size={15} className="shrink-0 text-muted" />
                      )}
                      <span className="truncate">{e.label}</span>
                    </NavLink>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="mt-4 space-y-0.5">
              {meta.tables.map((tb) => (
                <NavLink
                  key={tb.name}
                  to={`/${tb.name}`}
                  onClick={onClose}
                  className={({ isActive }) => navCls(isActive)}
                >
                  <IconTable size={15} className="shrink-0 text-muted" />
                  <span className="truncate">{tb.label_plural}</span>
                </NavLink>
              ))}
            </div>
          )}
          <div className="mt-4 space-y-0.5">
            {(meta.pages ?? []).map((p) => (
              <NavLink
                key={p.id}
                to={`/p/${p.id}`}
                onClick={onClose}
                className={({ isActive }) => navCls(isActive)}
              >
                {p.icon ? (
                  <AppIcon icon={p.icon} size={15} className="w-[15px] shrink-0 text-center leading-none" />
                ) : (
                  <span className="w-[15px] shrink-0 text-center leading-none">•</span>
                )}
                <span className="truncate">{p.label}</span>
              </NavLink>
            ))}
          </div>
          {meta.can_manage_access && (
            <div className="mt-4 border-t pt-3">
              <div className="mb-1 flex items-center gap-1 px-2 text-xxs font-semibold uppercase tracking-wider text-muted">
                <IconShield size={10} className="text-accent" />
                {t('access_group')}
              </div>
              <NavLink to="/_access/users" onClick={onClose} className={({ isActive }) => navCls(isActive)}>
                <IconUsers size={15} className="shrink-0 text-muted" />
                <span className="truncate">{t('access_users')}</span>
              </NavLink>
              <NavLink to="/_access/roles" onClick={onClose} className={({ isActive }) => navCls(isActive)}>
                <IconShield size={15} className="shrink-0 text-muted" />
                <span className="truncate">{t('access_roles')}</span>
              </NavLink>
            </div>
          )}
          {meta.can_manage_access && (
            <div className="mt-4 border-t pt-3">
              <div className="mb-1 flex items-center gap-1 px-2 text-xxs font-semibold uppercase tracking-wider text-muted">
                <IconSliders size={10} className="text-accent" />
                {t('config_group')}
              </div>
              <NavLink to="/_config/groups" onClick={onClose} className={({ isActive }) => navCls(isActive)}>
                <IconColumns size={15} className="shrink-0 text-muted" />
                <span className="truncate">{t('config_groups')}</span>
              </NavLink>
              <NavLink to="/_config/dashboard" onClick={onClose} className={({ isActive }) => navCls(isActive)}>
                <IconDashboard size={15} className="shrink-0 text-muted" />
                <span className="truncate">{t('config_dashboard')}</span>
              </NavLink>
              <NavLink to="/_config/discover" onClick={onClose} className={({ isActive }) => navCls(isActive)}>
                <IconSearch size={15} className="shrink-0 text-muted" />
                <span className="truncate">{t('config_discover')}</span>
              </NavLink>
            </div>
          )}
          <div className="mt-4 border-t pt-3">
            <NavLink to="/audit" onClick={onClose} className={({ isActive }) => navCls(isActive)}>
              <IconAudit size={15} className="shrink-0" />
              <span>{t('nav_audit')}</span>
            </NavLink>
          </div>
        </nav>
      </aside>
    </div>
  )
}

const SIDEBAR_KEY = 'cartapel.sidebar'

function ShellChrome({ meta }: { meta: Meta }) {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const t = useT()
  const isDark = useIsDark(meta.theme?.mode)
  const logo = pickBrandLogo(meta, isDark)
  const mark = resolveBrandLogo(meta.brand_logo) ?? logo

  const [theme, , cycleTheme] = useTheme()
  const [density, toggleDensity] = useDensity()

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1')
  const [navFilter, setNavFilter] = useState('')
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const isMobile = useMediaQuery('(max-width: 600px)')
  const [mobileNav, setMobileNav] = useState(false)
  useEffect(() => {
    setMobileNav(false)
  }, [location.pathname])

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('default')
  const [helpOpen, setHelpOpen] = useState(false)

  const currentTable = useMemo(() => {
    const seg = location.pathname.split('/').filter(Boolean)
    const name = seg[0]
    return meta.tables.some((tb) => tb.name === name) ? name : null
  }, [location.pathname, meta.tables])

  const resolveTable = useCallback(
    (name: string) => meta.tables.find((tb) => tb.name === name),
    [meta.tables],
  )
  const tablePrefetch = useTablePrefetch(qc, resolveTable)

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  const openPalette = (mode: PaletteMode = 'default') => {
    setPaletteMode(mode)
    setPaletteOpen(true)
  }

  useGlobalKeys({
    openPalette,
    goDashboard: () => navigate('/'),
    goAudit: () => navigate('/audit'),
    showHelp: () => setHelpOpen(true),
  })

  const logout = async () => {
    try {
      await api.logout()
    } finally {
      qc.clear()
      navigate('/login')
    }
  }

  const rail = collapsed

  return (
    <div className="flex h-full">
      <aside
        className={clsx(
          'flex shrink-0 flex-col border-r px-2 py-4',
          isMobile && 'hidden',
          rail ? 'w-14' : 'w-14 wide:w-60 wide:px-3',
        )}
        aria-label="Primary"
      >
        <div className="mb-3 flex min-h-10 items-center justify-center px-2">
          {rail ? (
            mark ? (
              <img src={mark} alt="" className="h-6 w-auto object-contain" />
            ) : (
              <span className="text-[15px] font-medium text-ink">s</span>
            )
          ) : (
            <>
              <div className="hidden w-full justify-center wide:flex">
                <BrandMark logo={logo} name={meta.brand} size="sidebar" />
              </div>
              <div className="flex justify-center wide:hidden">
                {mark ? (
                  <img src={mark} alt="" className="h-6 w-auto object-contain" />
                ) : (
                  <span className="text-[15px] font-medium text-ink">s</span>
                )}
              </div>
            </>
          )}
        </div>

        {!rail && (
          <div className="mb-2 hidden px-1 wide:block">
            <input
              name="nav-filter"
              className="input-sm w-full"
              placeholder={t('nav_filter_placeholder')}
              value={navFilter}
              onChange={(e) => setNavFilter(e.target.value)}
              aria-label={t('nav_filter_aria')}
            />
          </div>
        )}

        <nav className="min-h-0 flex-1 overflow-y-auto">
          {meta.has_dashboard && (
            <div className="space-y-0.5">
              <NavLink to="/" end className={({ isActive }) => clsx(navCls(isActive), rail && 'justify-center')} title={t('nav_dashboard')}>
                <IconDashboard size={15} className="shrink-0" />
                {!rail && <span className="hidden wide:block">{t('nav_dashboard')}</span>}
              </NavLink>
            </div>
          )}
          <SidebarNav
            meta={meta}
            t={t}
            rail={rail}
            filter={navFilter}
            onHoverTable={(name) => tablePrefetch.schedule(name)}
          />
          {meta.can_manage_access && <AccessNav t={t} rail={rail} />}
          {meta.can_manage_access && <ConfigNav t={t} rail={rail} />}
          <div className="mt-4 border-t pt-3">
            <NavLink to="/audit" className={({ isActive }) => clsx(navCls(isActive), rail && 'justify-center')} title={t('nav_audit')}>
              <IconAudit size={15} className="shrink-0" />
              {!rail && <span className="hidden wide:block">{t('nav_audit')}</span>}
            </NavLink>
          </div>
        </nav>

        <div className="mt-2 border-t pt-2">
          <div className="mb-1 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="hidden h-7 w-7 items-center justify-center rounded-ctl text-muted hover:bg-hover hover:text-ink wide:flex"
              title={rail ? t('sidebar_expand') : t('sidebar_collapse')}
              aria-label={rail ? t('sidebar_expand') : t('sidebar_collapse')}
            >
              <IconChevronsLeft size={15} className={rail ? 'rotate-180' : ''} />
            </button>
          </div>
          <UserMenu
            user={meta.user}
            open={userMenuOpen}
            onToggle={() => setUserMenuOpen((o) => !o)}
            onClose={() => setUserMenuOpen(false)}
            theme={theme}
            onCycleTheme={cycleTheme}
            density={density}
            onToggleDensity={toggleDensity}
            onHelp={() => {
              setUserMenuOpen(false)
              setHelpOpen(true)
            }}
            onLogout={logout}
            collapsed={rail}
          />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {viewAsRole() && (
          <div className="flex items-center justify-center gap-2 bg-[color:var(--warning)] px-3 py-1 text-center text-xxs font-medium text-[color:var(--band)]">
            {t('view_as_banner', { role: viewAsRole()! })}
            <button type="button" className="underline" onClick={() => setViewAsRole(null)}>
              {t('view_as_exit')}
            </button>
          </div>
        )}
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4" role="banner">
          {isMobile && (
            <button
              type="button"
              className="btn !px-2"
              onClick={() => setMobileNav(true)}
              aria-label={t('nav_open')}
            >
              <IconMenu size={16} />
            </button>
          )}
          <Breadcrumbs meta={meta} />
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => openPalette('default')}
            className="hidden items-center gap-2 rounded-ctl border bg-surface2 px-2.5 py-1 text-[13px] text-muted hover:text-ink sm:flex"
            aria-label={t('palette_open_aria')}
          >
            <IconSearch size={14} />
            <span className="min-w-28 text-left">{t('search')}</span>
            <span className="kbd ml-2">⌘K</span>
          </button>
          <button
            type="button"
            onClick={() => openPalette('default')}
            className="btn !px-2 sm:hidden"
            aria-label={t('palette_open_aria')}
          >
            <IconSearch size={15} />
          </button>
        </header>
        <main
          className="min-h-0 flex-1 overflow-auto p-4"
          aria-label={currentTable ?? undefined}
        >
          <Outlet />
        </main>
      </div>

      {isMobile && mobileNav && (
        <MobileDrawer meta={meta} logo={logo} t={t} onClose={() => setMobileNav(false)} />
      )}

      <CommandPalette
        meta={meta}
        open={paletteOpen}
        mode={paletteMode}
        currentTable={currentTable}
        onClose={() => setPaletteOpen(false)}
      />
      {helpOpen && <KeyboardHelp onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

export default function Shell() {
  const { data: meta, isLoading, error } = useQuery({
    queryKey: ['meta'],
    queryFn: api.meta,
    staleTime: Infinity,
  })

  useEffect(() => {
    applyThemeConfig(meta?.theme)
    if (meta?.brand_accent) applyBrandAccent(meta.brand_accent)
  }, [meta?.theme, meta?.brand_accent])

  if (isLoading) {
    const t = makeT()
    return <div className="flex h-full items-center justify-center text-muted">{t('loading')}</div>
  }
  if (error || !meta) {
    const t = makeT()
    return (
      <div className="flex h-full items-center justify-center">
        <div className="card px-6 py-4 text-sm text-critical">
          {error instanceof Error ? error.message : t('meta_load_failed')}
        </div>
      </div>
    )
  }

  setFormatLocale(meta.locale)
  return (
    <MetaContext.Provider value={meta}>
      <I18nProvider locale={meta.locale} strings={meta.strings}>
        <ShellChrome meta={meta} />
      </I18nProvider>
    </MetaContext.Provider>
  )
}
