import { describe, expect, it } from 'vitest'
import { pickBrandLogo, resolveBrandLogo } from './brand'
import type { Meta } from '../api/types'

const meta = (theme: Meta['theme'], brand_logo: string | null = null) =>
  ({ brand_logo, theme }) as Pick<Meta, 'brand_logo' | 'theme'>

describe('resolveBrandLogo', () => {
  it('passes through http/data urls and resolves bare filenames under /static', () => {
    expect(resolveBrandLogo('https://x/a.png')).toBe('https://x/a.png')
    expect(resolveBrandLogo('data:image/svg+xml,x')).toBe('data:image/svg+xml,x')
    expect(resolveBrandLogo('logo.svg')).toBe('/admin/static/logo.svg')
    expect(resolveBrandLogo(null)).toBeNull()
  })
})

describe('pickBrandLogo — per active mode', () => {
  const themed = meta({ logo_light: 'light.svg', logo_dark: 'dark.svg' })

  it('picks the dark logo in dark mode and the light logo in light mode', () => {
    expect(pickBrandLogo(themed, true)).toBe('/admin/static/dark.svg')
    expect(pickBrandLogo(themed, false)).toBe('/admin/static/light.svg')
  })

  it('falls back to top-level brand_logo when the per-mode logo is absent', () => {
    const partial = meta({ logo_dark: 'dark.svg' }, 'fallback.svg')
    expect(pickBrandLogo(partial, true)).toBe('/admin/static/dark.svg')
    expect(pickBrandLogo(partial, false)).toBe('/admin/static/fallback.svg')
  })

  it('returns null (→ wordmark) when nothing is configured', () => {
    expect(pickBrandLogo(meta(null), true)).toBeNull()
    expect(pickBrandLogo(undefined, false)).toBeNull()
  })
})
