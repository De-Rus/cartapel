import type { Row } from '../api/types'

/// Dropdown choices for a panel's `filter_by` columns, taken from the rows the
/// panel already carries — a configured list could offer a value that matches
/// nothing, or miss one that appeared. A column with a single distinct value is
/// dropped: a filter that cannot narrow anything is noise.
export function filterOptions(rows: Row[], filterBy?: string[] | null): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const key of filterBy ?? []) {
    const seen = new Set<string>()
    for (const r of rows) {
      const v = r[key]
      if (v != null && v !== '') seen.add(String(v))
    }
    if (seen.size > 1) out[key] = [...seen].sort()
  }
  return out
}

/// Keep rows matching every picked value. An empty pick is "no filter", so the
/// default state of a dropdown shows everything.
export function applyFilters(rows: Row[], picked: Record<string, string>): Row[] {
  const active = Object.entries(picked).filter(([, v]) => v !== '')
  if (!active.length) return rows
  return rows.filter((r) => active.every(([k, v]) => String(r[k] ?? '') === v))
}
