import { createContext, useContext, useMemo } from 'react'
import { DICTS, type Dict } from '../locales'

export type { Dict }
export { DICTS }

/** `strings` from the config: a flat entry overrides a key in every locale, an
 *  entry keyed by a locale code overrides keys in that locale only. */
export type Strings = Record<string, string | Record<string, string>>

// English, because it is also the fallback for a key missing from another
// locale (below) and because a config that names no locale — every fresh
// install, and the public demo — gets this one. It shipped as 'es', so every
// visitor met a Spanish panel wrapped in English docs.
const DEFAULT_LOCALE = 'en'

export type TFn = (key: string, vars?: Record<string, unknown>) => string

function interpolate(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** The per-locale override for `key` wins over the every-locale one, which wins
 *  over the dictionary; a key nobody defines falls through to English, then to
 *  the key itself — a hole shows up as a raw key, never as a blank. */
export function overrideFor(strings: Strings | null | undefined, locale: string, key: string): string | undefined {
  if (!strings) return undefined
  const local = strings[locale]
  if (local && typeof local === 'object') {
    const v = local[key]
    if (typeof v === 'string') return v
  }
  const every = strings[key]
  return typeof every === 'string' ? every : undefined
}

export function makeT(locale?: string | null, overrides?: Strings | null): TFn {
  const loc = locale && DICTS[locale] ? locale : DEFAULT_LOCALE
  return (key, vars) => {
    const template =
      overrideFor(overrides, loc, key) ?? DICTS[loc]?.[key] ?? DICTS[DEFAULT_LOCALE][key] ?? key
    return interpolate(template, vars)
  }
}

const I18nContext = createContext<TFn>(makeT())
const LocaleContext = createContext<string>(DEFAULT_LOCALE)

export function I18nProvider({
  locale,
  strings,
  children,
}: {
  locale?: string | null
  strings?: Strings | null
  children: React.ReactNode
}) {
  const t = useMemo(() => makeT(locale, strings), [locale, strings])
  const resolved = locale && DICTS[locale] ? locale : DEFAULT_LOCALE
  return (
    <I18nContext.Provider value={t}>
      <LocaleContext.Provider value={resolved}>{children}</LocaleContext.Provider>
    </I18nContext.Provider>
  )
}

export function useT(): TFn {
  return useContext(I18nContext)
}

/** The active locale code, e.g. for picking a `labels = { es = "…" }`
 *  per-locale override out of config data client-side — most labels are
 *  already resolved server-side, this is for the rare case (a widget's own
 *  `params`) the backend passes through opaque. */
export function useLocale(): string {
  return useContext(LocaleContext)
}
