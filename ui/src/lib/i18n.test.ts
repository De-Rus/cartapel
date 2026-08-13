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
