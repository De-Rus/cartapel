import type { ActionWhenMeta } from '../api/types'

/** Whether an action with an optional `when` condition should show for one
 *  row. No `when` → always shows. Only meaningful for a single row (the
 *  detail view) — a multi-row bulk selection has no one row to test, so
 *  callers there should ignore `when` entirely, not call this. */
export function actionWhenPasses(when: ActionWhenMeta | null | undefined, row: Record<string, unknown>): boolean {
  if (!when) return true
  const actual = String(row[when.column] ?? '')
  return when.op === 'ne' ? actual !== when.value : actual === when.value
}
