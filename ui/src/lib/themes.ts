import type { ThemeConfig, ThemeTokens } from '../api/types'

export interface ThemePreset {
  light: ThemeTokens
  dark: ThemeTokens
}

export type PresetName = 'cartapel' | 'django'

const cartapel: ThemePreset = {
  dark: {
    page: '#0d0d0d',
    surface: '#1a1a19',
    'surface-1': '#1a1a19',
    'surface-2': '#222220',
    'surface-3': '#2a2a28',
    hover: 'rgba(255, 255, 255, 0.04)',
    press: 'rgba(255, 255, 255, 0.08)',
    selected: 'rgba(57, 135, 229, 0.12)',
    border: 'rgba(255, 255, 255, 0.1)',
    ink: '#ffffff',
    sec: '#c3c2b7',
    muted: '#898781',
    gridline: '#2c2c2a',
    accent: '#3987e5',
    'accent-btn': '#2f78d4',
    good: '#0ca30c',
    warning: '#fab219',
    serious: '#ec835a',
    critical: '#d03b3b',
    'delta-good': '#0ca30c',
    s1: '#3987e5',
    s2: '#199e70',
    s3: '#c98500',
    s4: '#008300',
    s5: '#9085e9',
    s6: '#e66767',
    s7: '#d55181',
    s8: '#d95926',
    'badge-blue': '#7ab1ee',
    'badge-green': '#3fbd8a',
    'badge-orange': '#e0a848',
    'badge-red': '#e88585',
    'badge-violet': '#a89bf0',
    'badge-gray': '#a5a49c',
  },
  light: {
    page: '#f9f9f7',
    surface: '#fcfcfb',
    'surface-1': '#fcfcfb',
    'surface-2': '#f2f2ef',
    'surface-3': '#e9e9e5',
    hover: 'rgba(11, 11, 11, 0.035)',
    press: 'rgba(11, 11, 11, 0.07)',
    selected: 'rgba(42, 120, 214, 0.1)',
    border: 'rgba(11, 11, 11, 0.1)',
    ink: '#0b0b0b',
    sec: '#52514e',
    muted: '#6b6a64',
    gridline: '#e1e0d9',
    accent: '#2a78d6',
    'accent-btn': '#2569c0',
    good: '#0ca30c',
    warning: '#fab219',
    serious: '#ec835a',
    critical: '#d03b3b',
    'delta-good': '#006300',
    s1: '#2a78d6',
    s2: '#1baf7a',
    s3: '#eda100',
    s4: '#008300',
    s5: '#4a3aa7',
    s6: '#e34948',
    s7: '#e87ba4',
    s8: '#eb6834',
    'badge-blue': '#2a78d6',
    'badge-green': '#14805b',
    'badge-orange': '#9c6a00',
    'badge-red': '#c03535',
    'badge-violet': '#4a3aa7',
    'badge-gray': '#62615d',
  },
}


// The classic Django-admin palette: light body, blue-teal chrome, its familiar
// green/amber/red status colors. Dark mode is a faithful translation of
// Django 4's dark admin.
const django: ThemePreset = {
  light: {
    page: '#f8f8f8',
    surface: '#ffffff',
    'surface-1': '#ffffff',
    'surface-2': '#f5f5f5',
    'surface-3': '#eeeeee',
    hover: 'rgba(65, 118, 144, 0.06)',
    press: 'rgba(65, 118, 144, 0.12)',
    selected: 'rgba(121, 174, 200, 0.18)',
    border: '#e0e0e0',
    ink: '#333333',
    sec: '#555555',
    muted: '#888888',
    gridline: '#eaeaea',
    accent: '#417690',
    'accent-btn': '#417690',
    good: '#70bf2b',
    warning: '#efb80b',
    serious: '#e87e1e',
    critical: '#ba2121',
    'delta-good': '#3d7a09',
    band: '#417690',
    'band-ink': '#ffffff',
    'band-border': '#417690',
    s1: '#417690',
    s2: '#70bf2b',
    s3: '#efb80b',
    s4: '#205067',
    s5: '#79aec8',
    s6: '#ba2121',
    s7: '#e87e1e',
    s8: '#6c8ea0',
    'badge-blue': '#417690',
    'badge-green': '#3d7a09',
    'badge-orange': '#9a6a00',
    'badge-red': '#ba2121',
    'badge-violet': '#5b4d8f',
    'badge-gray': '#666666',
  },
  dark: {
    page: '#121212',
    surface: '#1c1c1c',
    'surface-1': '#1c1c1c',
    'surface-2': '#242424',
    'surface-3': '#2d2d2d',
    hover: 'rgba(121, 174, 200, 0.08)',
    press: 'rgba(121, 174, 200, 0.14)',
    selected: 'rgba(121, 174, 200, 0.16)',
    border: '#353535',
    ink: '#eeeeee',
    sec: '#c5c5c5',
    muted: '#9a9a9a',
    gridline: '#2e2e2e',
    accent: '#79aec8',
    'accent-btn': '#417690',
    good: '#70bf2b',
    warning: '#efb80b',
    serious: '#e87e1e',
    critical: '#d4534f',
    'delta-good': '#70bf2b',
    band: '#264b5d',
    'band-ink': '#f5f5f5',
    'band-border': '#264b5d',
    s1: '#79aec8',
    s2: '#70bf2b',
    s3: '#efb80b',
    s4: '#417690',
    s5: '#b0c8d4',
    s6: '#d4534f',
    s7: '#e87e1e',
    s8: '#6c8ea0',
    'badge-blue': '#79aec8',
    'badge-green': '#8ed44f',
    'badge-orange': '#f0c14b',
    'badge-red': '#e88585',
    'badge-violet': '#a89bf0',
    'badge-gray': '#a5a5a5',
  },
}

export const PRESETS: Record<PresetName, ThemePreset> = { cartapel, django }

export function presetOf(name: string | null | undefined): PresetName {
  return name === 'django' ? 'django' : 'cartapel'
}

export function resolveTheme(cfg: ThemeConfig): ThemePreset {
  const base = PRESETS[presetOf(cfg.preset)]
  const light: ThemeTokens = { ...base.light }
  const dark: ThemeTokens = { ...base.dark }
  if (cfg.accent) {
    light.accent = cfg.accent
    dark.accent = cfg.accent
  }
  if (cfg.accent_btn) {
    light['accent-btn'] = cfg.accent_btn
    dark['accent-btn'] = cfg.accent_btn
  }
  if (cfg.light) Object.assign(light, cfg.light)
  if (cfg.dark) Object.assign(dark, cfg.dark)
  return { light, dark }
}

const ACCENT_HOVER = '--accent-hover:color-mix(in srgb, var(--accent) 88%, black);'

function decls(tokens: ThemeTokens): string {
  return Object.entries(tokens)
    .map(([k, v]) => `--${k}:${v};`)
    .join('')
}

export function themeCss(cfg: ThemeConfig): string {
  const { light, dark } = resolveTheme(cfg)
  const mode = cfg.mode ?? 'auto'
  if (mode === 'light') return `:root{color-scheme:light;${decls(light)}${ACCENT_HOVER}}`
  if (mode === 'dark') return `:root{color-scheme:dark;${decls(dark)}${ACCENT_HOVER}}`
  return [
    `:root{${decls(dark)}${ACCENT_HOVER}}`,
    `@media (prefers-color-scheme:light){:root:not([data-theme]){${decls(light)}}}`,
    `:root[data-theme='light']{${decls(light)}}`,
    `:root[data-theme='dark']{${decls(dark)}}`,
  ].join('')
}

const STYLE_ID = 'cartapel-theme-vars'

export function applyThemeConfig(cfg?: ThemeConfig | null): void {
  if (!cfg) return
  const root = document.documentElement
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = themeCss(cfg)
  const mode = cfg.mode ?? 'auto'
  if (mode === 'light' || mode === 'dark') root.removeAttribute('data-theme')
}
