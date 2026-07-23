import { describe, expect, it } from 'vitest'
import { autoCols, fmt, hrefFor, niceMax, readParam, sortRows, toMs, writeParam } from './sx'

describe('toMs', () => {
  it('passes millisecond epochs through', () => {
    expect(toMs(1752000000000)).toBe(1752000000000)
  })
  it('scales second epochs to ms', () => {
    expect(toMs(1752000000)).toBe(1752000000000)
  })
  it('parses ISO strings', () => {
    expect(toMs('2026-07-20T00:00:00Z')).toBe(Date.parse('2026-07-20T00:00:00Z'))
  })
  it('rejects garbage', () => {
    expect(toMs(null)).toBeNull()
    expect(toMs('')).toBeNull()
    expect(toMs('not a date')).toBeNull()
  })
})

describe('fmt', () => {
  it('bytes', () => {
    expect(fmt.bytes(512)).toBe('512 B')
    expect(fmt.bytes(2048)).toBe('2.0 KB')
    expect(fmt.bytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
  it('money', () => {
    expect(fmt.money(1234.5)).toBe('$1,235')
    expect(fmt.money(12.34)).toBe('$12.34')
    expect(fmt.money(-50)).toBe('-$50')
    expect(fmt.money(null)).toBe('—')
  })
  it('dur', () => {
    expect(fmt.dur(42)).toBe('42s')
    expect(fmt.dur(90)).toBe('2m')
    expect(fmt.dur(7200)).toBe('2h')
    expect(fmt.dur(200000)).toBe('2d')
  })
  it('num handles null', () => {
    expect(fmt.num(null)).toBe('—')
    expect(fmt.num(1234)).toBe('1,234')
  })
})

describe('niceMax', () => {
  it('rounds up to 1/2/5 steps', () => {
    expect(niceMax(3)).toBe(5)
    expect(niceMax(7)).toBe(10)
    expect(niceMax(12)).toBe(20)
    expect(niceMax(50)).toBe(50)
    expect(niceMax(0)).toBe(1)
  })
})

describe('sortRows', () => {
  const rows = [{ n: 2 }, { n: 10 }, { n: null }, { n: 1 }]
  it('sorts numerically, nulls last', () => {
    expect(sortRows(rows, 'n', 1).map((r) => r.n)).toEqual([1, 2, 10, null])
    expect(sortRows(rows, 'n', -1).map((r) => r.n)).toEqual([10, 2, 1, null])
  })
  it('sorts strings case-aware and does not mutate', () => {
    const src = [{ s: 'b' }, { s: 'a' }]
    expect(sortRows(src, 's', 1).map((r) => r.s)).toEqual(['a', 'b'])
    expect(src.map((r) => r.s)).toEqual(['b', 'a'])
  })
})

describe('autoCols', () => {
  it('infers labels, alignment and time columns', () => {
    const cols = autoCols([{ user_name: 'x', count: 3, created_at: '2026-07-20T00:00:00Z' }])
    expect(cols.map((c) => c.key)).toEqual(['user_name', 'count', 'created_at'])
    expect(cols[0].label).toBe('user name')
    expect(cols[0].align).toBe('l')
    expect(cols[1].align).toBe('r')
    expect(cols[2].render).toBeTypeOf('function')
  })
  it('handles empty rows', () => {
    expect(autoCols([])).toEqual([])
  })
})

describe('param codec', () => {
  it('reads and writes keys', () => {
    expect(readParam('?a=1&b=x', 'b')).toBe('x')
    expect(writeParam('?a=1', 'b', 'y')).toBe('?a=1&b=y')
  })
  it('deletes on null/empty/default', () => {
    expect(writeParam('?a=1&b=x', 'b', null)).toBe('?a=1')
    expect(writeParam('?b=x', 'b', '')).toBe('')
    expect(writeParam('?b=x', 'b', '1h', '1h')).toBe('')
  })
})

describe('hrefFor', () => {
  it('fills templates with encoded row values', () => {
    expect(hrefFor('bots/{id}', { id: 42 })).toBe('/admin/bots/42')
    expect(hrefFor('t/{sym}', { sym: 'BRK B' })).toBe('/admin/t/BRK%20B')
  })
  it('accepts functions and absolute paths', () => {
    expect(hrefFor((r) => `/admin/u/${r.id}`, { id: 7 })).toBe('/admin/u/7')
  })
})
