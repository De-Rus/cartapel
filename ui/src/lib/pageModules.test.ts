import { transform } from 'sucrase'
import { describe, expect, it } from 'vitest'
import * as sxModule from './sx'

const modules = import.meta.glob('../../../demo/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const fetched = { loading: false, refreshing: false, data: { rows: [] }, rows: [], error: null, refetch() {} }
const stubSx: Record<string, unknown> = {}
for (const k of Object.keys(sxModule)) stubSx[k] = (sxModule as Record<string, unknown>)[k]
Object.assign(stubSx, {
  useQuery: () => ({ ...fetched }),
  useSource: () => ({ ...fetched }),
  useTable: () => ({ ...fetched, total: 0 }),
  useQueries: (_api: unknown, names: readonly string[]) => {
    const o: Record<string, unknown> = { $loading: false, $error: null, $refetch() {} }
    for (const n of names) o[n] = { ...fetched }
    return o
  },
  useParam: () => ['', () => {}],
  useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}],
  useEffect: () => {},
  useRef: (v: unknown) => ({ current: v }),
})

describe('demo .tsx page modules', () => {
  const files = Object.keys(modules).map((p) => p.replace(/.*\/demo\//, ''))

  it('finds the page modules', () => {
    expect(files.length).toBeGreaterThanOrEqual(1)
  })

  for (const path of Object.keys(modules)) {
    const name = path.replace(/.*\/demo\//, '')
    it(`${name} transpiles and renders`, () => {
      const { code } = transform(modules[path], {
        transforms: ['typescript', 'jsx', 'imports'],
        jsxPragma: 'h',
        jsxFragmentPragma: 'Fragment',
        production: true,
      })
      const prelude = `const {${Object.keys(stubSx).join(',')}} = __sx;\n`
      const moduleExports: { default?: (p: { api: unknown }) => unknown } = {}
      new Function('__sx', 'exports', 'module', prelude + code)(stubSx, moduleExports, { exports: moduleExports })
      expect(moduleExports.default).toBeTypeOf('function')
      const vnode = moduleExports.default!({ api: { get: async () => ({ rows: [] }), post: async () => ({}) } })
      expect(vnode).toBeTruthy()
    })
  }
})
