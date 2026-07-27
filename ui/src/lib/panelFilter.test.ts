import { describe, expect, it } from 'vitest'
import { applyFilters, filterOptions } from './panelFilter'

const rows = [
  { source: 'binance', symbol: 'BTC', tf: '1h', bytes: 100 },
  { source: 'binance', symbol: 'ETH', tf: '1d', bytes: 50 },
  { source: 'okx', symbol: 'BTC', tf: '1h', bytes: 10 },
  { source: 'okx', symbol: 'SOL', tf: null, bytes: 1 },
]

describe('filterOptions', () => {
  it('offers only values the rows actually hold', () => {
    const o = filterOptions(rows, ['source', 'tf'])
    expect(o.source).toEqual(['binance', 'okx'])
    expect(o.tf).toEqual(['1d', '1h'])
  })

  it('drops a column that cannot narrow anything', () => {
    const same = [{ source: 'a' }, { source: 'a' }]
    expect(filterOptions(same, ['source'])).toEqual({})
  })

  it('ignores unknown columns and no config at all', () => {
    expect(filterOptions(rows, ['nope'])).toEqual({})
    expect(filterOptions(rows, null)).toEqual({})
  })
})

describe('applyFilters', () => {
  it('narrows on one column and combines several', () => {
    expect(applyFilters(rows, { source: 'okx' })).toHaveLength(2)
    expect(applyFilters(rows, { source: 'binance', tf: '1h' })).toEqual([rows[0]])
  })

  it('treats an unset dropdown as no filter', () => {
    expect(applyFilters(rows, { source: '' })).toHaveLength(4)
    expect(applyFilters(rows, {})).toHaveLength(4)
  })

  it('matches a null cell as empty rather than dropping the row silently', () => {
    expect(applyFilters(rows, { tf: '1h' })).toHaveLength(2)
  })
})
