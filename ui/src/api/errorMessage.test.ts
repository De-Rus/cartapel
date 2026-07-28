import { describe, expect, it } from 'vitest'
import { errorMessage } from './client'

describe('errorMessage', () => {
  it('prefers the server explanation when it survives', () => {
    expect(errorMessage(504, { error: 'the query timed out' }, 'Gateway Timeout')).toBe(
      'the query timed out',
    )
  })

  it('recovers meaning when a proxy swallowed the body', () => {
    // Cloudflare answers a 504 with its own page, so `data` parses to null.
    expect(errorMessage(504, null, 'Gateway Timeout')).toContain('expiró')
    expect(errorMessage(502, null, 'Bad Gateway')).toContain('índice')
  })

  it('falls back to the status text for anything else', () => {
    expect(errorMessage(404, null, 'Not Found')).toBe('Not Found')
  })
})
