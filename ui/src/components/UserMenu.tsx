import clsx from 'clsx'
import type { User } from '../api/types'
import { useClickOutside } from '../lib/hooks'
import { useT } from '../lib/i18n'
import { useMeta } from '../lib/meta'
import { type Density, type ThemeMode } from '../lib/theme'
import { setViewAsRole, viewAsRole } from '../lib/viewAs'
import { IconEye, IconLogout, IconMonitor, IconMoon, IconRows, IconSun } from './Icons'

function initials(email: string): string {
  return email.slice(0, 2).toUpperCase()
}

export function UserMenu({
  user,
  open,
  onToggle,
  onClose,
  theme,
  onCycleTheme,
  density,
  onToggleDensity,
  onHelp,
  onLogout,
  collapsed,
}: {
  user: User
  open: boolean
  onToggle: () => void
  onClose: () => void
  theme: ThemeMode
  onCycleTheme: () => void
  density: Density
  onToggleDensity: () => void
  onHelp: () => void
  onLogout: () => void
  collapsed: boolean
}) {
  const t = useT()
  const meta = useMeta()
  const ref = useClickOutside(onClose)
  const asRole = viewAsRole()
  const otherRoles = (meta.roles ?? []).filter((r) => r !== 'admin')

  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconMonitor

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-ctl px-2 py-1.5 text-left text-[13px] text-sec hover:bg-hover hover:text-ink"
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.email}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface3 text-[10px] font-semibold text-ink">
          {initials(user.email)}
        </span>
        {!collapsed && <span className="min-w-0 flex-1 truncate">{user.email}</span>}
      </button>

      {open && (
        <div
          role="menu"
          className="pop-in absolute bottom-full left-0 z-40 mb-1 w-56 overflow-hidden rounded-card bg-surface1 py-1 shadow-menu"
        >
          <div className="px-3 py-2">
            <div className="truncate text-[13px] text-ink">{user.email}</div>
            <div className="text-xxs text-muted">{user.role}</div>
          </div>
          <div className="my-1 border-t" />
          <MenuRow onClick={onCycleTheme}>
            <ThemeIcon size={14} className="text-muted" />
            <span className="flex-1">{t('menu_theme')}</span>
            <span className="text-xxs capitalize text-muted">{theme}</span>
          </MenuRow>
          <MenuRow onClick={onToggleDensity}>
            <IconRows size={14} className="text-muted" />
            <span className="flex-1">{t('menu_density')}</span>
            <span className="text-xxs capitalize text-muted">{t(density === 'compact' ? 'density_compact' : 'density_comfortable')}</span>
          </MenuRow>
          <MenuRow onClick={onHelp}>
            <span className="kbd">?</span>
            <span className="flex-1">{t('menu_shortcuts')}</span>
          </MenuRow>
          {asRole ? (
            <MenuRow onClick={() => setViewAsRole(null)}>
              <IconEye size={14} className="text-muted" />
              <span className="flex-1">{t('view_as_exit')}</span>
              <span className="text-xxs text-muted">{asRole}</span>
            </MenuRow>
          ) : (
            user.role === 'admin' &&
            otherRoles.map((r) => (
              <MenuRow key={r} onClick={() => setViewAsRole(r)}>
                <IconEye size={14} className="text-muted" />
                <span className="flex-1">{t('view_as')}</span>
                <span className="text-xxs text-muted">{r}</span>
              </MenuRow>
            ))
          )}
          <div className="my-1 border-t" />
          <MenuRow onClick={onLogout} danger>
            <IconLogout size={14} />
            <span className="flex-1">{t('logout')}</span>
          </MenuRow>
        </div>
      )}
    </div>
  )
}

function MenuRow({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-hover',
        danger ? 'text-critical' : 'text-sec hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}
