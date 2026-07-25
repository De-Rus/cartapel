import { describe, expect, it } from 'vitest'
import { resolveIcon } from './icon'

describe('resolveIcon', () => {
  it('resolves a known lucide name (kebab-case) to a lucide icon', () => {
    expect(resolveIcon('bot')).toEqual({ kind: 'lucide', name: 'bot' })
    expect(resolveIcon('trending-up')).toEqual({ kind: 'lucide', name: 'trending-up' })
    expect(resolveIcon('  shield  ')).toEqual({ kind: 'lucide', name: 'shield' })
  })

  it('renders an emoji as literal text', () => {
    expect(resolveIcon('📦')).toEqual({ kind: 'text', text: '📦' })
    expect(resolveIcon('⚖️')).toEqual({ kind: 'text', text: '⚖️' })
  })

  it('treats unknown kebab-case optimistically as lucide (render falls back lazily)', () => {
    expect(resolveIcon('not-a-real-icon')).toEqual({ kind: 'lucide', name: 'not-a-real-icon' })
  })

  it('returns null for empty/null/undefined', () => {
    expect(resolveIcon(null)).toBeNull()
    expect(resolveIcon(undefined)).toBeNull()
    expect(resolveIcon('   ')).toBeNull()
  })
})
