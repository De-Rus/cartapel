import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrandMark } from './Shell'

const html = (node: React.ReactElement) => renderToStaticMarkup(node)

describe('BrandMark', () => {
  it('renders only the logo image when a logo is present (lockup includes the wordmark)', () => {
    const out = html(<BrandMark logo="data:image/svg+xml,mark" name="Acme" size="sidebar" />)
    expect(out).toContain('<img')
    expect(out).toContain('src="data:image/svg+xml,mark"')
    expect(out).toContain('alt="Acme"')
    expect(out).not.toMatch(/>Acme</)
  })

  it('renders the lowercase wordmark from name when no logo, defaulting to cartapel', () => {
    const named = html(<BrandMark logo={null} name="Acme" size="login" />)
    expect(named).not.toContain('<img')
    expect(named).toContain('Acme')

    const fallback = html(<BrandMark logo={null} name={null} size="sidebar" />)
    expect(fallback).toContain('cartapel')
  })

  it('colors the name with --band-ink on the band, --ink otherwise', () => {
    const onBand = html(<BrandMark logo={null} name="Acme" size="sidebar" onBand />)
    expect(onBand).toContain('var(--band-ink)')
    const offBand = html(<BrandMark logo={null} name="Acme" size="sidebar" />)
    expect(offBand).toContain('text-ink')
  })
})
