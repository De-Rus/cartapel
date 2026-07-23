import { describe, expect, it } from 'vitest'
import {
  applyFormat,
  fmtBytes,
  fmtDuration,
  fmtNumber,
  interpolate,
  interpolateHref,
  isIdColumn,
  truncateUuid,
} from './format'

describe('isIdColumn', () => {
  it('flags pk, id-suffixed and int fk columns', () => {
    expect(isIdColumn('id')).toBe(true)
    expect(isIdColumn('bot_id')).toBe(true)
    expect(isIdColumn('uid', { pk: 'uid' })).toBe(true)
    expect(isIdColumn('instrument', { kind: 'int', fk: true })).toBe(true)
    expect(isIdColumn('leverage')).toBe(false)
    expect(isIdColumn('count')).toBe(false)
  })
})

describe('fmtNumber', () => {
  it('renders integers without decimals', () => {
    expect(fmtNumber(1202218)).not.toContain(',')
    expect(fmtNumber(3)).toBe('3')
  })
})

describe('fmtDuration', () => {
  it('humanizes seconds', () => {
    expect(fmtDuration(0.5)).toBe('500 ms')
    expect(fmtDuration(42)).toContain('s')
    expect(fmtDuration(192)).toBe('3 min 12 s')
    expect(fmtDuration(3600 * 26 + 120)).toBe('1 d 2 h')
  })
})

describe('fmtBytes', () => {
  it('scales units', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1229)).toMatch(/KB$/)
    expect(fmtBytes(5 * 1024 * 1024)).toMatch(/MB$/)
  })
})

describe('truncateUuid', () => {
  it('shortens long ids', () => {
    expect(truncateUuid('a3f4bc90-1234-4cde-9abc-001122334455')).toBe('a3f4…')
    expect(truncateUuid('short')).toBe('short')
  })
})

describe('interpolate', () => {
  it('replaces placeholders', () => {
    expect(interpolate('Deactivate {count} instruments?', { count: 2 })).toBe(
      'Deactivate 2 instruments?',
    )
    expect(interpolate('{symbol} · {exchange}', { symbol: 'BTCUSDC', exchange: 'BINANCE' })).toBe(
      'BTCUSDC · BINANCE',
    )
  })
})

describe('applyFormat', () => {
  it('formats by kind then composes prefix/suffix', () => {
    expect(applyFormat(1234.5, { format: 'currency', currency: 'EUR' })).toContain('€')
    expect(applyFormat(12.4, { format: 'percent' })).toBe('12,4 %')
    expect(applyFormat(1048576, { format: 'bytes' })).toMatch(/MB$/)
    expect(applyFormat(5, { format: 'number', prefix: '≈ ', suffix: ' u' })).toBe('≈ 5 u')
  })
  it('truncates to N chars with an ellipsis', () => {
    expect(applyFormat('abcdefghij', { truncate: 4 })).toBe('abcd…')
    expect(applyFormat('abc', { truncate: 4 })).toBe('abc')
  })
  it('with no format just stringifies then affixes', () => {
    expect(applyFormat('hi', { suffix: '!' })).toBe('hi!')
  })
})

describe('interpolateHref', () => {
  it('substitutes and URL-encodes each value', () => {
    expect(interpolateHref('https://x.io/u/{id}', { id: 'a b/c?d' })).toBe(
      'https://x.io/u/a%20b%2Fc%3Fd',
    )
  })
  it('blocks javascript: and data: schemes', () => {
    expect(interpolateHref('javascript:alert(1)', {})).toBe('#')
    expect(interpolateHref('data:text/html,<script>1</script>', {})).toBe('#')
  })
  it('cannot be tricked into a javascript: url via an injected value', () => {
    expect(interpolateHref('{u}', { u: 'javascript:alert(1)' })).toBe('#')
  })
  it('allows the http/mailto/tel allowlist and relative paths', () => {
    expect(interpolateHref('http://x.io', {})).toBe('http://x.io')
    expect(interpolateHref('mailto:{e}', { e: 'a@b.io' })).toBe('mailto:a%40b.io')
    expect(interpolateHref('tel:{p}', { p: '+34600' })).toBe('tel:%2B34600')
    expect(interpolateHref('/rows/{id}', { id: 7 })).toBe('/admin/rows/7')
  })
  it('blocks protocol-relative and bare hosts', () => {
    expect(interpolateHref('//evil.io', {})).toBe('#')
    expect(interpolateHref('evil.io/path', {})).toBe('#')
  })
})
