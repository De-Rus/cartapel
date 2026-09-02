import { describe, expect, it } from 'vitest'
import en from './en'
import { DICTS, LOCALES, SUPPORTED_LOCALES } from './index'

/** The Italian dictionary landed as a file nobody imported: 560 lines of dead
 *  code, invisible in the language menu. A file in this folder is a promise. */
describe('locale registry', () => {
  it('registers every dictionary file that exists', () => {
    // import.meta.glob rather than fs: the same enumeration the bundler does,
    // and it needs no node types in the UI tsconfig.
    const onDisk = Object.keys(import.meta.glob('./*.ts'))
      .map((path) => path.replace(/^\.\/|\.ts$/g, ''))
      .filter((name) => !['index', 'dict'].includes(name) && !name.endsWith('.test'))

    expect(onDisk.sort()).toEqual([...SUPPORTED_LOCALES].sort())
  })

  it('names each language in the language itself', () => {
    for (const [tag, { name }] of Object.entries(LOCALES)) {
      expect(name, `${tag} has a name`).toBeTruthy()
    }
  })
})

const PLACEHOLDERS = /\{(\w+)\}/g
const placeholders = (s: string) => [...s.matchAll(PLACEHOLDERS)].map((m) => m[1]).sort()

describe.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))('%s dictionary', (locale) => {
  const dict = DICTS[locale]

  /** A missing key silently renders English, so nothing fails until a user
   *  reports a stray "Ungrouped" in an otherwise translated panel. */
  it('covers every key English has', () => {
    const missing = Object.keys(en).filter((k) => !(k in dict))
    expect(missing).toEqual([])
  })

  it('adds no key English does not have', () => {
    const extra = Object.keys(dict).filter((k) => !(k in en))
    expect(extra).toEqual([])
  })

  /** interpolate() replaces {name} by lookup: a renamed or dropped placeholder
   *  reaches the screen as literal braces. */
  it('keeps the same interpolation placeholders', () => {
    const wrong = Object.entries(dict)
      .filter(([k, v]) => k in en && placeholders(v).join() !== placeholders(en[k]).join())
      .map(([k]) => k)
    expect(wrong).toEqual([])
  })
})
