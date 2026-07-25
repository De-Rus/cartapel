const LIST_KEYS = ['q', 'sort', 'pp']

export function viewQueryFromParams(sp: URLSearchParams): string {
  const p = new URLSearchParams()
  const keys = [...sp.keys()].filter((k) => LIST_KEYS.includes(k) || k.startsWith('f_'))
  keys.sort()
  const seen = new Set<string>()
  for (const k of keys) {
    if (seen.has(k)) continue
    seen.add(k)
    for (const v of sp.getAll(k)) p.append(k, v)
  }
  return p.toString()
}

export function applyViewQuery(query: string, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const k of [...next.keys()]) {
    if (LIST_KEYS.includes(k) || k.startsWith('f_')) next.delete(k)
  }
  next.delete('page')
  const incoming = new URLSearchParams(query)
  for (const [k, v] of incoming.entries()) next.append(k, v)
  return next
}

export function viewMatchesParams(query: string, sp: URLSearchParams): boolean {
  return viewQueryFromParams(new URLSearchParams(query)) === viewQueryFromParams(sp)
}

export interface ColumnState {
  order: string[]
  hidden: string[]
  widths: Record<string, number>
}

const COLS_PREFIX = 'cartapel.cols.'

export function loadColumnState(table: string): ColumnState {
  try {
    const raw = localStorage.getItem(COLS_PREFIX + table)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        order: Array.isArray(parsed.order) ? parsed.order : [],
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
        widths: parsed.widths && typeof parsed.widths === 'object' ? parsed.widths : {},
      }
    }
  } catch {
    /* ignore */
  }
  return { order: [], hidden: [], widths: {} }
}

export function saveColumnState(table: string, state: ColumnState): void {
  try {
    localStorage.setItem(COLS_PREFIX + table, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

export function resolveColumns(base: string[], state: ColumnState): string[] {
  const ordered = state.order.length
    ? [...state.order.filter((c) => base.includes(c)), ...base.filter((c) => !state.order.includes(c))]
    : base
  return ordered.filter((c) => !state.hidden.includes(c))
}
