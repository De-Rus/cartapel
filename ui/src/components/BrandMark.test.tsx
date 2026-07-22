import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrandMark } from './Shell'

const html = (node: React.ReactElement) => renderToStaticMarkup(node)

describe('BrandMark', () => {
  it('renders the logo image AND the brand name together when a logo is present', () => {
    const out = html(<BrandMark logo="data:image/svg+xml,mark" name="Acme" size="sidebar" />)
    expect(out).toContain('<img')
    expect(out).toContain('src="data:image/svg+xml,mark"')
    expect(out).toContain('Acme')
  })

  it('renders the lowercase wordmark from name when no logo, defaulting to steward', () => {
    const named = html(<BrandMark logo={null} name="Acme" size="login" />)
    expect(named).not.toContain('<img')
    expect(named).toContain('Acme')

    const fallback = html(<BrandMark logo={null} name={null} size="sidebar" />)
    expect(fallback).toContain('steward')
  })

  it('colors the name with --band-ink on the band, --ink otherwise', () => {
    const onBand = html(<BrandMark logo="x" name="Acme" size="sidebar" onBand />)
    expect(onBand).toContain('var(--band-ink)')
    const offBand = html(<BrandMark logo="x" name="Acme" size="sidebar" />)
    expect(offBand).toContain('text-ink')
  })
})
