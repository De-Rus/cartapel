import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserLocale, matchLocale, pickLocale, requestLocale, storeLocale } from './locale'

/** The tests run without a DOM: give the module a storage and a browser to
 *  read from, and decide the browser's languages per test. */
const store = new Map<string, string>()
const shimStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
}
function speak(...languages: string[]) {
  Object.defineProperty(globalThis, 'navigator', { value: { languages, language: languages[0] }, configurable: true })
}

beforeEach(() => {
  store.clear()
  Object.defineProperty(globalThis, 'localStorage', { value: shimStorage, configurable: true })
  speak('fr-FR', 'fr')
})
afterEach(() => store.clear())

describe('matchLocale', () => {
  it('takes a shipped tag as is', () => {
    expect(matchLocale('es')).toBe('es')
  })
  it('folds a regional tag onto its language', () => {
    expect(matchLocale('es-MX')).toBe('es')
    expect(matchLocale('en_GB')).toBe('en')
    expect(matchLocale('EN')).toBe('en')
  })
  it('ignores a language nobody ships', () => {
    expect(matchLocale('fr')).toBeNull()
    expect(matchLocale('')).toBeNull()
    expect(matchLocale(null)).toBeNull()
  })
})

describe('browserLocale', () => {
  it('walks the preference list to the first shipped language', () => {
    expect(browserLocale(['fr-FR', 'fr', 'es-ES', 'en'])).toBe('es')
  })
  it('is nothing when no preference is shipped', () => {
    expect(browserLocale(['fr', 'de'])).toBeNull()
  })
  it('reads the browser by default', () => {
    speak('es-MX')
    expect(browserLocale()).toBe('es')
  })
})

/** Precedence: the viewer's own pick, then the browser, then the instance
 *  default, then English. The API header carries only the first two, so the
 *  server lands on the same instance default the panel does. */
describe('pickLocale', () => {
  it('falls back to the instance default when the browser speaks something else', () => {
    expect(pickLocale('es')).toBe('es')
    expect(requestLocale()).toBeNull()
  })
  it('takes the browser language over the instance default', () => {
    speak('en-GB')
    expect(pickLocale('es')).toBe('en')
    expect(requestLocale()).toBe('en')
  })
  it('prefers the stored pick over everything', () => {
    speak('en')
    storeLocale('es')
    expect(pickLocale('en')).toBe('es')
    expect(requestLocale()).toBe('es')
  })
  it('drops a stored value nobody ships', () => {
    store.set('cartapel.locale', 'fr')
    expect(requestLocale()).toBeNull()
    expect(pickLocale('es')).toBe('es')
  })
  it('is English when nothing says otherwise', () => {
    expect(pickLocale('klingon')).toBe('en')
    expect(pickLocale(null)).toBe('en')
  })
  it('forgets the pick when told to', () => {
    storeLocale('es')
    storeLocale(null)
    expect(requestLocale()).toBeNull()
  })
})
