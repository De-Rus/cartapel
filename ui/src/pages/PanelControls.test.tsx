import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PanelControls } from './Dashboard'

function paged(over: Record<string, unknown> = {}) {
  return {
    slice: [],
    matched: 0,
    page: 0,
    pages: 1,
    setPage: () => {},
    q: '',
    setQ: () => {},
    options: {} as Record<string, string[]>,
    picked: {} as Record<string, string>,
    pick: () => {},
    ...over,
  } as never
}

describe('PanelControls', () => {
  it('renders a dropdown per filter_by column with its values', () => {
    const html = renderToStaticMarkup(
      <PanelControls
        paged={paged({ options: { source: ['binance', 'okx'], tf: ['1d', '1h'] } })}
        search={false}
      />,
    )
    expect(html.match(/<select/g)).toHaveLength(2)
    expect(html).toContain('binance')
    expect(html).toContain('okx')
    // The "all" option must be labelled, not an empty line you cannot aim at.
    expect(html).toMatch(/<option value=""[^>]*>[^<]+<\/option>/)
  })

  it('names a column the way its header does', () => {
    const html = renderToStaticMarkup(
      <PanelControls
        paged={paged({ options: { source: ['binance', 'okx'] } })}
        search={false}
        cols={[{ key: 'source', label: 'Feed' }] as never}
      />,
    )
    expect(html).toContain('Feed')
    expect(html).not.toContain('source')
  })

  it('marks the picked value as selected', () => {
    const html = renderToStaticMarkup(
      <PanelControls
        paged={paged({ options: { source: ['binance', 'okx'] }, picked: { source: 'okx' } })}
        search={false}
      />,
    )
    expect(html).toMatch(/<option value="okx" selected="">/)
  })

  it('renders nothing when there is neither a filter nor a search box', () => {
    expect(renderToStaticMarkup(<PanelControls paged={paged()} search={false} />)).toBe('')
  })

  it('still renders the search box on its own', () => {
    const html = renderToStaticMarkup(<PanelControls paged={paged()} search={true} />)
    expect(html).toContain('type="search"')
  })
})
