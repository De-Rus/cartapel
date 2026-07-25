import type { RoleDefinition, RoleLevel, RolePerm } from '../api/types'

export type Level = 'none' | RoleLevel

export const WILDCARD = '*'

export const CRUD_KEYS = ['view', 'create', 'update', 'delete'] as const
export type CrudKey = (typeof CRUD_KEYS)[number]

export interface MatrixRow {
  table: string
  level: Level
  masked: string[]
  rowFilter: string
  perm?: RolePerm
  editableCols?: string[]
}

export interface RoleCarry {
  tables: Record<string, RoleLevel>
  masked: Record<string, string[]>
  row_filter: Record<string, string>
  perms: Record<string, RolePerm>
  editable: Record<string, string[]>
}

export interface MatrixModel {
  wildcard: Level
  rows: MatrixRow[]
  actions: string[]
  carry: RoleCarry
  extends?: string
}

const EMPTY_DEF: RoleDefinition = { tables: {}, actions: [], masked: {}, row_filter: {} }

function carried<T>(src: Record<string, T> | undefined, vocab: Set<string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(src ?? {})) {
    if ((k === WILDCARD || !vocab.has(k)) && v !== undefined) out[k] = v
  }
  return out
}

function levelOf(def: RoleDefinition, table: string): Level {
  const l = def.tables[table]
  return l === 'read' || l === 'write' ? l : 'none'
}

function cleanPerm(perm: RolePerm | undefined): RolePerm | undefined {
  if (!perm) return undefined
  const out: RolePerm = {}
  for (const k of CRUD_KEYS) if (perm[k] !== undefined) out[k] = perm[k]
  return Object.keys(out).length > 0 ? out : undefined
}

export function definitionToMatrix(
  definition: RoleDefinition | null,
  tables: string[],
): MatrixModel {
  const def = definition ?? EMPTY_DEF
  const vocab = new Set(tables)
  const rows: MatrixRow[] = tables.map((table) => {
    const perm = cleanPerm(def.perms?.[table])
    const editable = def.editable?.[table]
    return {
      table,
      level: levelOf(def, table),
      masked: [...(def.masked[table] ?? [])],
      rowFilter: def.row_filter[table] ?? '',
      ...(perm ? { perm } : {}),
      ...(editable ? { editableCols: [...editable] } : {}),
    }
  })
  const carryTables: Record<string, RoleLevel> = {}
  for (const [k, v] of Object.entries(def.tables)) {
    if (k !== WILDCARD && !vocab.has(k) && (v === 'read' || v === 'write')) carryTables[k] = v
  }
  return {
    wildcard: levelOf(def, WILDCARD),
    rows,
    actions: [...(def.actions ?? [])],
    ...(def.extends ? { extends: def.extends } : {}),
    carry: {
      tables: carryTables,
      masked: carried(def.masked, vocab),
      row_filter: carried(def.row_filter, vocab),
      perms: carried(def.perms, vocab),
      editable: carried(def.editable, vocab),
    },
  }
}

export function matrixToDefinition(model: MatrixModel): RoleDefinition {
  const tables: Record<string, RoleLevel> = {}
  const masked: Record<string, string[]> = {}
  const row_filter: Record<string, string> = {}
  const perms: Record<string, RolePerm> = {}
  const editable: Record<string, string[]> = {}

  if (model.wildcard !== 'none') tables[WILDCARD] = model.wildcard
  for (const r of model.rows) {
    if (r.level !== 'none') tables[r.table] = r.level
    const cols = r.masked.filter((c) => c.trim() !== '')
    if (cols.length > 0) masked[r.table] = [...new Set(cols)]
    const rf = r.rowFilter.trim()
    if (rf !== '') row_filter[r.table] = rf
    const perm = cleanPerm(r.perm)
    if (perm) perms[r.table] = perm
    const editableCols = (r.editableCols ?? []).filter((c) => c.trim() !== '')
    if (editableCols.length > 0) editable[r.table] = [...new Set(editableCols)]
  }

  const carry = model.carry
  if (carry) {
    Object.assign(tables, carry.tables)
    Object.assign(masked, carry.masked)
    Object.assign(row_filter, carry.row_filter)
    Object.assign(perms, carry.perms)
    Object.assign(editable, carry.editable)
  }

  const definition: RoleDefinition = {
    tables,
    actions: [...new Set(model.actions)].sort(),
    masked,
    row_filter,
  }
  if (Object.keys(perms).length > 0) definition.perms = perms
  if (Object.keys(editable).length > 0) definition.editable = editable
  if (model.extends) definition.extends = model.extends
  return definition
}

const LEVEL_PERM: Record<Level, RolePerm> = {
  none: { view: false, create: false, update: false, delete: false },
  read: { view: true, create: false, update: false, delete: false },
  write: { view: true, create: true, update: true, delete: true },
}

export function effectivePerm(level: Level): Record<CrudKey, boolean> {
  const base = LEVEL_PERM[level]
  return {
    view: base.view ?? false,
    create: base.create ?? false,
    update: base.update ?? false,
    delete: base.delete ?? false,
  }
}

export function actionTable(action: string): string {
  const dot = action.indexOf('.')
  return dot > 0 ? action.slice(0, dot) : action
}

const ROLE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export function validateRoleName(name: string): string | null {
  const n = name.trim()
  if (n === '') return 'name_required'
  if (!ROLE_NAME_RE.test(n)) return 'role_name_invalid'
  return null
}

export interface UserPayloadInput {
  email: string
  password: string
  role: string
}

export interface UserPayloadResult {
  ok: boolean
  errors: Partial<Record<'email' | 'password' | 'role', string>>
  value: { email: string; password: string; role: string }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateUserPayload(
  input: UserPayloadInput,
  roles: string[],
  opts: { requirePassword?: boolean } = { requirePassword: true },
): UserPayloadResult {
  const email = input.email.trim().toLowerCase()
  const password = input.password
  const role = input.role
  const errors: UserPayloadResult['errors'] = {}

  if (email === '') errors.email = 'email_required'
  else if (!EMAIL_RE.test(email)) errors.email = 'email_invalid'

  const passwordGiven = password.length > 0
  if (opts.requirePassword && !passwordGiven) errors.password = 'password_required'
  else if (passwordGiven && password.length < 8) errors.password = 'password_too_short'

  if (!role || !roles.includes(role)) errors.role = 'role_invalid'

  return { ok: Object.keys(errors).length === 0, errors, value: { email, password, role } }
}
