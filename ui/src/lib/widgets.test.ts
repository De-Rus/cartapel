import { describe, expect, it } from 'vitest'
import { widgetModuleUrl } from './widgets'

describe('widget module loading', () => {
  it('appends a cache-busting version param to a shared widget-kind url', () => {
    const url = widgetModuleUrl('config/widgets/reconcile.js')
    expect(url).toMatch(/^\/admin\/static\/config\/widgets\/reconcile\.js\?v=\d+$/)
  })

  it('preserves path segments for a pathy page module', () => {
    const url = widgetModuleUrl('overview/ops/ops.js')
    expect(url).toMatch(/^\/admin\/static\/overview\/ops\/ops\.js\?v=\d+$/)
  })

  it('uses a stable per-load token across calls (dedup-friendly)', () => {
    expect(widgetModuleUrl('a.js')).toBe(widgetModuleUrl('a.js'))
    const v1 = widgetModuleUrl('a.js').split('?v=')[1]
    const v2 = widgetModuleUrl('b.js').split('?v=')[1]
    expect(v1).toBe(v2)
  })
})
