import { useCallback, useEffect, useState } from 'react'
import { setFormatLocale } from './format'
import { LOCALES, SUPPORTED_LOCALES } from '../locales'

const KEY = 'cartapel.locale'

/** A supported tag for `candidate`: exact (`pt-BR`) first, then its language
 *  (`pt`), else nothing. */
export function matchLocale(candidate: string | null | undefined): string | null {
  if (!candidate) return null
  const c = candidate.trim()
  if (!c) return null
  if (LOCALES[c]) return c
  const lower = c.toLowerCase()
  const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === lower)
  if (exact) return exact
  const lang = lower.split(/[-_]/)[0]
  return SUPPORTED_LOCALES.find((l) => l.toLowerCase() === lang) ?? null
}

export function storedLocale(): string | null {
  try {
    return matchLocale(localStorage.getItem(KEY))
  } catch {
    return null
  }
}

export function storeLocale(locale: string | null): void {
  try {
    if (locale) localStorage.setItem(KEY, locale)
    else localStorage.removeItem(KEY)
  } catch {
    /* storage may be unavailable; the pick still applies for this page */
  }
}

export function browserLocale(languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]): string | null {
  for (const l of languages) {
    const m = matchLocale(l)
    if (m) return m
  }
  return null
}

/** The locale the API is asked to render labels in. Null means "the instance
 *  default" — the server falls back to its configured `locale`, which is also
 *  what `pickLocale` lands on once the meta says which one that is. */
export function requestLocale(): string | null {
  return storedLocale() ?? browserLocale()
}

/** The locale the panel renders in: the viewer's explicit pick, else the
 *  browser's language when it is one we ship, else the instance default, else
 *  English. */
export function pickLocale(instanceDefault?: string | null): string {
  return requestLocale() ?? matchLocale(instanceDefault) ?? 'en'
}

export function localeName(locale: string): string {
  return LOCALES[locale]?.name ?? locale
}

/** The effective locale plus a setter that persists the pick. Cycling walks the
 *  shipped locales in order, like the theme toggle. */
export function useLocale(instanceDefault?: string | null): [string, (l: string) => void, () => void] {
  const [locale, setLocaleState] = useState<string>(() => pickLocale(instanceDefault))
  useEffect(() => {
    setLocaleState(pickLocale(instanceDefault))
  }, [instanceDefault])
  useEffect(() => {
    setFormatLocale(locale)
    document.documentElement.lang = locale
  }, [locale])
  const setLocale = useCallback((l: string) => {
    const m = matchLocale(l) ?? 'en'
    storeLocale(m)
    setLocaleState(m)
  }, [])
  const cycle = useCallback(() => {
    const i = SUPPORTED_LOCALES.indexOf(locale)
    setLocale(SUPPORTED_LOCALES[(i + 1) % SUPPORTED_LOCALES.length])
  }, [locale, setLocale])
  return [locale, setLocale, cycle]
}
