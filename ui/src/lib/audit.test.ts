import { describe, expect, it } from 'vitest'
import { rowSnapshot } from './audit'

describe('rowSnapshot', () => {
  it('detects a create/delete row payload', () => {
    expect(rowSnapshot({ row: { id: 1, name: 'x' } })).toEqual({ id: 1, name: 'x' })
  })

  it('rejects per-column diffs', () => {
    expect(rowSnapshot({ status: { from: 'a', to: 'b' } })).toBeNull()
  })

  it('rejects an update touching only a column named row', () => {
    expect(rowSnapshot({ row: { from: 1, to: 2 } })).toBeNull()
  })

  it('rejects multi-key payloads and non-objects', () => {
    expect(rowSnapshot({ row: { id: 1 }, other: 2 })).toBeNull()
    expect(rowSnapshot({ row: 'x' })).toBeNull()
    expect(rowSnapshot({ row: [1] })).toBeNull()
    expect(rowSnapshot(null)).toBeNull()
  })
})
