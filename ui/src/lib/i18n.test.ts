/** The language a visitor gets when nobody chose one.
 *
 *  It shipped as Spanish: the public demo, and every fresh install whose config
 *  names no locale, served a Spanish panel wrapped in an English README, English
 *  docs and an English site. It also decides the fallback for a key missing from
 *  another locale, so a stray Spanish word could surface inside an English
 *  panel. */
import { describe, expect, it } from 'vitest'
import { DICTS, makeT } from './i18n'

describe('default locale', () => {
  it('is English when the config names none', () => {
    expect(makeT(null)('login_bad_credentials')).toBe(DICTS.en.login_bad_credentials)
  })

  it('is English for a locale nobody ships', () => {
    expect(makeT('fr')('login_bad_credentials')).toBe(DICTS.en.login_bad_credentials)
  })

  it('still honours a locale that was asked for', () => {
    expect(makeT('es')('login_bad_credentials')).toBe(DICTS.es.login_bad_credentials)
  })
})

/** A missing key falls through to the default locale, so a hole in one
 *  dictionary shows up as another language rather than as a gap. */
describe('the dictionaries', () => {
  it('cover the same keys', () => {
    const es = Object.keys(DICTS.es).sort()
    const en = Object.keys(DICTS.en).sort()

    expect(en).toEqual(es)
  })

  it('translate rather than copy', () => {
    const shared = Object.keys(DICTS.en).filter((k) => DICTS.en[k] === DICTS.es[k])

    // Some strings are legitimately identical ("Dashboard", "OK", "{page} / {pages}").
    expect(shared.length).toBeLessThan(Object.keys(DICTS.en).length / 3)
  })
})

/** `strings` from the config: a flat entry applies everywhere, a locale-keyed
 *  map applies to that locale only and wins over the flat one. */
describe('string overrides', () => {
  it('apply a flat entry in every locale', () => {
    const strings = { logout: 'Bye' }
    expect(makeT('en', strings)('logout')).toBe('Bye')
    expect(makeT('es', strings)('logout')).toBe('Bye')
  })

  it('scope a locale-keyed map to that locale', () => {
    const strings = { es: { logout: 'Chao' } }
    expect(makeT('es', strings)('logout')).toBe('Chao')
    expect(makeT('en', strings)('logout')).toBe(DICTS.en.logout)
  })

  it('let the locale-keyed entry win over the flat one', () => {
    const strings = { logout: 'Bye', es: { logout: 'Chao' } }
    expect(makeT('es', strings)('logout')).toBe('Chao')
    expect(makeT('en', strings)('logout')).toBe('Bye')
  })

  it('keep placeholders working through an override', () => {
    expect(makeT('en', { search_placeholder: 'Find {label}' })('search_placeholder', { label: 'orders' })).toBe('Find orders')
  })
})

describe('every shipped locale', () => {
  it('names itself and covers every English key', async () => {
    const { LOCALES } = await import('../locales')
    const en = Object.keys(LOCALES.en.dict).sort()
    for (const [tag, { name, dict }] of Object.entries(LOCALES)) {
      expect(name, tag).not.toBe('')
      expect(Object.keys(dict).sort(), tag).toEqual(en)
    }
  })

  it('keeps the same placeholders per key', async () => {
    const { LOCALES } = await import('../locales')
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const [tag, { dict }] of Object.entries(LOCALES)) {
      for (const key of Object.keys(LOCALES.en.dict)) {
        expect(holes(dict[key]), `${tag}.${key}`).toEqual(holes(LOCALES.en.dict[key]))
      }
    }
  })
})
