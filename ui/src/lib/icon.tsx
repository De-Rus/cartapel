import { lazy, Suspense } from 'react'

// The lucide dynamic-import map is ~550KB of JS — it lives in its own lazy
// chunk (lucideIcon.tsx) so the entry bundle never pays for it. Name validation
// happens inside that chunk; here a kebab-case string is optimistically lucide,
// anything else (emoji, text) renders as-is.
const Lucide = lazy(() => import('./lucideIcon'))

const LUCIDE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

export type IconResolution = { kind: 'lucide'; name: string } | { kind: 'text'; text: string } | null

/// Optimistic: kebab-case names are treated as lucide (unknown ones fall back
/// to text inside the lazy chunk); anything else is literal text.
export function resolveIcon(icon: string | null | undefined): IconResolution {
  const s = icon?.trim()
  if (!s) return null
  if (LUCIDE_NAME.test(s)) return { kind: 'lucide', name: s }
  return { kind: 'text', text: s }
}

export function AppIcon({
  icon,
  size = 15,
  className,
}: {
  icon: string | null | undefined
  size?: number
  className?: string
}) {
  const s = icon?.trim()
  if (!s) return null
  if (LUCIDE_NAME.test(s)) {
    return (
      <Suspense
        fallback={
          <span
            className={className}
            style={{ display: 'inline-block', width: size, height: size }}
            aria-hidden
          />
        }
      >
        <Lucide name={s} size={size} className={className} />
      </Suspense>
    )
  }
  return (
    <span className={className} aria-hidden>
      {s}
    </span>
  )
}
