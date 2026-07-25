import { useEffect, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

const THEME_KEY = 'cartapel.theme'
const DENSITY_KEY = 'cartapel.density'

function readTheme(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

function readDensity(): Density {
  return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable'
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
}

export function applyDensity(density: Density): void {
  document.documentElement.setAttribute('data-density', density)
}

export function initChromePrefs(): void {
  applyTheme(readTheme())
  applyDensity(readDensity())
}

export function useTheme(): [ThemeMode, (m: ThemeMode) => void, () => void] {
  const [mode, setMode] = useState<ThemeMode>(readTheme)
  useEffect(() => {
    applyTheme(mode)
    localStorage.setItem(THEME_KEY, mode)
  }, [mode])
  const cycle = () => setMode((m) => (m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system'))
  return [mode, setMode, cycle]
}

export function useDensity(): [Density, () => void] {
  const [density, setDensity] = useState<Density>(readDensity)
  useEffect(() => {
    applyDensity(density)
    localStorage.setItem(DENSITY_KEY, density)
  }, [density])
  const toggle = () => setDensity((d) => (d === 'comfortable' ? 'compact' : 'comfortable'))
  return [density, toggle]
}

export function applyBrandAccent(accent?: string | null): void {
  if (accent) document.documentElement.style.setProperty('--accent', accent)
}

type ForcedMode = 'light' | 'dark' | 'auto' | null | undefined

function resolveIsDark(forced: ForcedMode): boolean {
  if (forced === 'dark') return true
  if (forced === 'light') return false
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark') return true
  if (attr === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function useIsDark(forced?: ForcedMode): boolean {
  const [dark, setDark] = useState(() => resolveIsDark(forced))
  useEffect(() => {
    const update = () => setDark(resolveIsDark(forced))
    update()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', update)
    const obs = new MutationObserver(update)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      mq.removeEventListener('change', update)
      obs.disconnect()
    }
  }, [forced])
  return dark
}
