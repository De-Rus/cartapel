import { useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import type { VarDef } from '../api/types'
import { useMeta } from '../lib/meta'

// A pick follows the reader from page to page: the URL is the source of truth
// when it names a value, the last pick fills in when it does not — so a window
// chosen on Errors is the window on Data feeds, and a shared link still wins.
const STICKY = 'cartapel:var:'

function remembered(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k?.startsWith(STICKY)) out[k.slice(STICKY.length)] = sessionStorage.getItem(k) ?? ''
    }
  } catch {
    /* storage unavailable: nothing sticks */
  }
  return out
}

function remember(name: string, value: string) {
  try {
    sessionStorage.setItem(STICKY + name, value)
  } catch {
    /* storage unavailable: nothing sticks */
  }
}

export function useVarQuery(): string {
  const [sp] = useSearchParams()
  const out = new URLSearchParams()
  for (const [name, v] of Object.entries(remembered())) out.set(`v_${name}`, v)
  for (const [k, v] of sp) if (k.startsWith('v_')) out.set(k, v)
  out.sort()
  return out.toString()
}

const SEGMENT_MAX = 6

/// `only` narrows the bar to the variables the current surface actually reads —
/// a control that changes nothing on the page you are looking at is noise.
export function VarBar({ only }: { only?: string[] }) {
  const meta = useMeta()
  const [sp, setSp] = useSearchParams()
  const all: VarDef[] = meta.variables ?? []
  const vars = only ? all.filter((v) => only.includes(v.name)) : all
  if (vars.length === 0) return null

  const set = (name: string, value: string) => {
    remember(name, value)
    setSp(
      (p) => {
        const n = new URLSearchParams(p)
        n.set(`v_${name}`, value)
        return n
      },
      { replace: true },
    )
  }
  const sticky = remembered()

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {vars.map((d) => {
        const value = sp.get(`v_${d.name}`) ?? sticky[d.name] ?? d.default ?? d.options[0]?.value ?? ''
        return (
          <div key={d.name} className="flex items-center gap-1.5 text-xxs text-muted">
            <span>{d.label}</span>
            {d.options.length > 0 && d.options.length <= SEGMENT_MAX ? (
              <div className="flex overflow-hidden rounded-full border">
                {d.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={clsx(
                      'h-6 px-2.5 text-xxs tabular-nums transition-colors',
                      o.value === value
                        ? 'bg-selected font-medium text-accent'
                        : 'text-sec hover:bg-surface2 hover:text-ink',
                    )}
                    onClick={() => set(d.name, o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ) : (
              <select className="input-sm" value={value} onChange={(e) => set(d.name, e.target.value)}>
                {d.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        )
      })}
    </div>
  )
}
