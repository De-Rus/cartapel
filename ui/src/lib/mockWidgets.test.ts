import { describe, expect, it } from 'vitest'
import { mockElement } from './mockWidgets'
import { widgetElementName } from './widgets'

describe('mockElement tag derivation', () => {
  it('maps a widget module to sx-widget-<stem>', () => {
    expect(mockElement('config/widgets/minibar.js')).toEqual({
      name: 'minibar',
      tag: widgetElementName('minibar'),
    })
  })

  it('maps the sparkline widget module to sx-widget-sparkline', () => {
    expect(mockElement('config/widgets/sparkline.js')?.tag).toBe(widgetElementName('sparkline'))
  })

  it('ignores a module that is not a field widget', () => {
    expect(mockElement('reconcile.js')).toBeNull()
    expect(mockElement('overview/ops/ops.js')).toBeNull()
  })
})
