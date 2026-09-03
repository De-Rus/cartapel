import type { Meta } from '../api/types'

import { BASE } from './base'

export function resolveBrandLogo(logo: string | null | undefined): string | null {
  if (!logo) return null
  if (/^(https?:|data:)/.test(logo)) return logo
  // The login screen renders before there's a session — `public/` is the one
  // part of the config bundle served with no auth, unlike `static/`.
  return `${BASE}/public/${logo}`
}

type LogoMeta = Pick<Meta, 'brand_logo' | 'theme'> | null | undefined

export function pickBrandLogo(meta: LogoMeta, isDark: boolean): string | null {
  const perMode = isDark ? meta?.theme?.logo_dark : meta?.theme?.logo_light
  return resolveBrandLogo(perMode ?? meta?.brand_logo)
}
