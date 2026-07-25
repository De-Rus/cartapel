/// create/delete audit entries carry `{ row: {…} }` — a full-row snapshot, not
/// a per-column {from,to} diff. Detect that shape so the UI renders values
/// instead of "∅ → ∅".
export function rowSnapshot(
  changes: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!changes || Object.keys(changes).length !== 1) return null
  const row = changes.row
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  if ('from' in row || 'to' in row) return null
  return row as Record<string, unknown>
}

/// Whether one payload entry is a {from,to} diff (row updates) — anything else
/// (role definitions, layout summaries) renders as a plain value pill.
export function isDiffEntry(v: unknown): v is { from?: unknown; to?: unknown } {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v) && ('from' in v || 'to' in v)
  )
}
