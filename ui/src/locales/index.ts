import type { Dict } from './dict'
import en from './en'
import es from './es'

export type { Dict }

/** Every UI language the panel ships, keyed by its BCP-47 tag. `name` is the
 *  language's own name — what the selector shows, so a reader who cannot read
 *  the current language can still find their own. */
export const LOCALES: Record<string, { name: string; dict: Dict }> = {
  en: { name: 'English', dict: en },
  es: { name: 'Español', dict: es },
}

export const SUPPORTED_LOCALES: string[] = Object.keys(LOCALES)

export const DICTS: Record<string, Dict> = Object.fromEntries(
  Object.entries(LOCALES).map(([k, v]) => [k, v.dict]),
)
