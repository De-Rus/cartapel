import { describe, expect, it } from 'vitest'
import { actionWhenPasses } from './actions'

describe('actionWhenPasses', () => {
  it('always passes with no when', () => {
    expect(actionWhenPasses(undefined, { status: 'shipped' })).toBe(true)
    expect(actionWhenPasses(null, { status: 'shipped' })).toBe(true)
  })

  it('ne passes when the column differs from value', () => {
    const when = { column: 'status', op: 'ne' as const, value: 'shipped' }
    expect(actionWhenPasses(when, { status: 'pending' })).toBe(true)
    expect(actionWhenPasses(when, { status: 'shipped' })).toBe(false)
  })

  it('eq passes when the column matches value', () => {
    const when = { column: 'status', op: 'eq' as const, value: 'pending' }
    expect(actionWhenPasses(when, { status: 'pending' })).toBe(true)
    expect(actionWhenPasses(when, { status: 'shipped' })).toBe(false)
  })

  it('treats a missing column as an empty string', () => {
    const when = { column: 'status', op: 'ne' as const, value: 'shipped' }
    expect(actionWhenPasses(when, {})).toBe(true)
  })
})
