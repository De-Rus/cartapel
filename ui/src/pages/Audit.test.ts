import { describe, expect, it } from 'vitest'
import { hasChanges } from './Audit'

describe('hasChanges', () => {
  /** `{}` is truthy, so a plain `&&` offered Revert on entries the server then
   *  rejected with "audit entry has no revertable changes". */
  it('treats an empty diff as nothing to revert', () => {
    expect(hasChanges({})).toBe(false)
    expect(hasChanges(null)).toBe(false)
  })

  it('accepts an entry that changed a column', () => {
    expect(hasChanges({ status: { from: 'paid', to: 'refunded' } })).toBe(true)
  })
})
