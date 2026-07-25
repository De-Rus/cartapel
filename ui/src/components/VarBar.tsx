import { useSearchParams } from 'react-router-dom'
import type { VarDef } from '../api/types'
import { useMeta } from '../lib/meta'

export function useVarQuery(): string {
  const [sp] = useSearchParams()
  const out = new URLSearchParams()
  for (const [k, v] of sp) if (k.startsWith('v_')) out.set(k, v)
  out.sort()
  return out.toString()
}

export function VarBar() {
  const meta = useMeta()
  const [sp, setSp] = useSearchParams()
  const vars: VarDef[] = meta.variables ?? []
  if (vars.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {vars.map((d) => {
        const value = sp.get(`v_${d.name}`) ?? d.default ?? d.options[0]?.value ?? ''
        return (
          <label key={d.name} className="flex items-center gap-1.5 text-xxs text-muted">
            <span>{d.label}</span>
            <select
              className="input-sm"
              value={value}
              onChange={(e) =>
                setSp(
                  (p) => {
                    const n = new URLSearchParams(p)
                    n.set(`v_${d.name}`, e.target.value)
                    return n
                  },
                  { replace: true },
                )
              }
            >
              {d.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )
      })}
    </div>
  )
}
