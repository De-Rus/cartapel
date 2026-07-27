import { transform } from 'sucrase'
import { describe, expect, it } from 'vitest'
import * as sxModule from './sx'

// The demo bundle is declarative — every screen it ships is HCL — so the
// fixtures live here: this guards the scripted-page pipeline itself (TS+JSX
// transpile, the injected sx prelude, the default export contract).
const modules: Record<string, string> = {
  'page.tsx': `
    export default function Ops({ api }) {
      const orders = useTable(api, 'orders', { pp: 5 })
      return (
        <Page title="Ops" sub="fixture">
          <Tiles items={[{ label: 'Orders', value: fmt.num(orders.total) }]} />
          <Section title="Recent" />
          <AdminTable api={api} slug="orders" pp={5} />
        </Page>
      )
    }
  `,
  'templated.tsx': `
    export default function Templated({ api }) {
      const q = useQuery(api, 'something')
      return html\`<\${Page} title="Templated"><\${Chart} rows=\${q.rows} x="t" y="v" /><//>\`
    }
  `,
}

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

// The demo bundle is declarative: every screen it ships is HCL. This guards any
// .tsx module that does appear — the escape hatch must keep working — without
// requiring one to exist.
describe('demo .tsx page modules', () => {
  for (const name of Object.keys(modules)) {
    it(`${name} transpiles and renders`, () => {
      const { code } = transform(modules[name], {
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
