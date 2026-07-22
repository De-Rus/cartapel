import { describe, expect, it } from 'vitest'
import { PRESETS, presetOf, resolveTheme, themeCss } from './themes'

describe('theme presets', () => {
  it('ships only the brand-neutral steward preset', () => {
    expect(Object.keys(PRESETS)).toEqual(['steward'])
    expect(PRESETS.steward.dark.accent).toBe('#3987e5')
    expect(PRESETS.steward.dark.page).toBe('#0d0d0d')
    expect(PRESETS.steward.light.page).toBe('#f9f9f7')
  })

  it('keeps zero brand colors in the lib (no amber, no chrome tokens)', () => {
    for (const mode of [PRESETS.steward.light, PRESETS.steward.dark]) {
      const serialized = JSON.stringify(mode).toLowerCase()
      expect(serialized).not.toContain('ff8c00')
      expect(serialized).not.toContain('hsl(33')
      expect(mode.band).toBeUndefined()
      expect(mode['band-ink']).toBeUndefined()
      expect(mode['accent-btn-ink']).toBeUndefined()
    }
  })

  it('maps unknown / legacy preset names to the steward base', () => {
    expect(presetOf('legacy')).toBe('steward')
    expect(presetOf('django')).toBe('steward')
    expect(presetOf(null)).toBe('steward')
    expect(presetOf('anything')).toBe('steward')
  })

  it('applies accent / accent_btn shorthand to both modes', () => {
    const { light, dark } = resolveTheme({ accent: '#ff0000', accent_btn: '#aa0000' })
    expect(light.accent).toBe('#ff0000')
    expect(dark.accent).toBe('#ff0000')
    expect(light['accent-btn']).toBe('#aa0000')
    expect(dark['accent-btn']).toBe('#aa0000')
  })

  it('paints brand chrome tokens purely from config overrides', () => {
    const cfg = {
      preset: 'steward',
      light: { band: 'hsl(220 30% 7%)', 'accent-btn-ink': 'hsl(220 30% 7%)' },
      dark: { band: 'hsl(220 38% 4%)', 'accent-btn-ink': 'hsl(220 30% 7%)' },
    }
    const { light, dark } = resolveTheme(cfg)
    expect(light.band).toBe('hsl(220 30% 7%)')
    expect(dark.band).toBe('hsl(220 38% 4%)')
    expect(light['accent-btn-ink']).toBe('hsl(220 30% 7%)')
    const css = themeCss(cfg)
    expect(css).toContain('--band:hsl(220 38% 4%);')
    expect(css).toContain('--accent-btn-ink:hsl(220 30% 7%);')
  })

  it('legacy preset:"legacy" still resolves to the neutral base + its own overrides', () => {
    const { dark } = resolveTheme({ preset: 'legacy', dark: { band: '#000' } })
    expect(dark.page).toBe('#0d0d0d')
    expect(dark.band).toBe('#000')
  })

  it('emits forced single-block css for a fixed mode', () => {
    const css = themeCss({ mode: 'light', light: { band: '#111' } })
    expect(css).toContain(':root{color-scheme:light;')
    expect(css).toContain('--band:#111;')
    expect(css).not.toContain('prefers-color-scheme')
    expect(css).toContain('--accent-hover:')
  })

  it('emits tri-state css for auto mode', () => {
    const css = themeCss({ mode: 'auto' })
    expect(css).toContain('prefers-color-scheme')
    expect(css).toContain(":root[data-theme='light']{")
    expect(css).toContain(":root[data-theme='dark']{")
  })
})
