import { describe, expect, it } from 'vitest'
import type { RoleDefinition } from '../api/types'
import {
  actionTable,
  definitionToMatrix,
  matrixToDefinition,
  validateRoleName,
  validateUserPayload,
  WILDCARD,
} from './access'

const TABLES = ['bots', 'instruments', 'price_events']

describe('definition ↔ matrix mapping', () => {
  it('maps a definition into a row per schema table', () => {
    const def: RoleDefinition = {
      tables: { bots: 'read', instruments: 'write' },
      actions: ['bots.halt'],
      masked: { bots: ['secret'] },
      row_filter: { bots: 'owner_email = {actor.email}' },
    }
    const m = definitionToMatrix(def, TABLES)
    expect(m.rows).toHaveLength(3)
    expect(m.rows.find((r) => r.table === 'bots')).toMatchObject({
      level: 'read',
      masked: ['secret'],
      rowFilter: 'owner_email = {actor.email}',
    })
    expect(m.rows.find((r) => r.table === 'instruments')?.level).toBe('write')
    expect(m.rows.find((r) => r.table === 'price_events')?.level).toBe('none')
    expect(m.wildcard).toBe('none')
    expect(m.actions).toEqual(['bots.halt'])
  })

  it('treats a null definition as an all-none matrix', () => {
    const m = definitionToMatrix(null, TABLES)
    expect(m.rows.every((r) => r.level === 'none')).toBe(true)
    expect(m.wildcard).toBe('none')
    expect(m.actions).toEqual([])
  })

  it('reads a wildcard table grant', () => {
    const def: RoleDefinition = { tables: { [WILDCARD]: 'read' }, actions: [], masked: {}, row_filter: {} }
    expect(definitionToMatrix(def, TABLES).wildcard).toBe('read')
  })

  it('round-trips definition → matrix → definition, dropping none rows and empties', () => {
    const def: RoleDefinition = {
      tables: { [WILDCARD]: 'read', bots: 'write' },
      actions: ['bots.halt', 'instruments.deactivate'],
      masked: { bots: ['api_key'] },
      row_filter: { bots: 'owner = {actor.email}' },
    }
    const back = matrixToDefinition(definitionToMatrix(def, TABLES))
    expect(back.tables).toEqual({ [WILDCARD]: 'read', bots: 'write' })
    expect(back.actions).toEqual(['bots.halt', 'instruments.deactivate'])
    expect(back.masked).toEqual({ bots: ['api_key'] })
    expect(back.row_filter).toEqual({ bots: 'owner = {actor.email}' })
  })

  it('round-trips extends and omits it when unset', () => {
    const def: RoleDefinition = {
      extends: 'viewer',
      tables: { bots: 'write' },
      actions: [],
      masked: {},
      row_filter: {},
    }
    const back = matrixToDefinition(definitionToMatrix(def, TABLES))
    expect(back.extends).toBe('viewer')
    const bare = matrixToDefinition(definitionToMatrix(null, TABLES))
    expect('extends' in bare).toBe(false)
  })

  it('omits masked/row_filter for tables with no level but keeps them when configured', () => {
    const m = definitionToMatrix(null, TABLES)
    const bots = m.rows.find((r) => r.table === 'bots')!
    bots.masked = ['x', '', ' ']
    bots.rowFilter = '  '
    const def = matrixToDefinition(m)
    expect(def.tables).toEqual({})
    expect(def.masked).toEqual({ bots: ['x'] })
    expect(def.row_filter).toEqual({})
  })

  it('threads per-row perms/editable through the round-trip', () => {
    const def: RoleDefinition = {
      tables: { bots: 'write' },
      actions: [],
      masked: {},
      row_filter: {},
      perms: { bots: { view: true, update: true, delete: false } },
      editable: { bots: ['name', 'notes'] },
    }
    const m = definitionToMatrix(def, TABLES)
    const bots = m.rows.find((r) => r.table === 'bots')!
    expect(bots.perm).toEqual({ view: true, update: true, delete: false })
    expect(bots.editableCols).toEqual(['name', 'notes'])
    const others = m.rows.filter((r) => r.table !== 'bots')
    expect(others.every((r) => r.perm === undefined && r.editableCols === undefined)).toBe(true)
    const back = matrixToDefinition(m)
    expect(back.perms).toEqual(def.perms)
    expect(back.editable).toEqual(def.editable)
  })

  it('drops empty per-row perm/editable blocks and keeps coarse-only roles clean', () => {
    const m = definitionToMatrix(null, TABLES)
    const bots = m.rows.find((r) => r.table === 'bots')!
    bots.level = 'read'
    bots.perm = {}
    bots.editableCols = ['', ' ']
    const instruments = m.rows.find((r) => r.table === 'instruments')!
    instruments.level = 'write'
    const back = matrixToDefinition(m)
    expect(back.tables).toEqual({ bots: 'read', instruments: 'write' })
    expect('perms' in back).toBe(false)
    expect('editable' in back).toBe(false)
  })

  it('emits only the tables that carry a granular override', () => {
    const m = definitionToMatrix(null, TABLES)
    const bots = m.rows.find((r) => r.table === 'bots')!
    bots.level = 'read'
    bots.perm = { update: true }
    bots.editableCols = ['name', 'name', 'notes']
    const back = matrixToDefinition(m)
    expect(back.perms).toEqual({ bots: { update: true } })
    expect(back.editable).toEqual({ bots: ['name', 'notes'] })
  })

  it('omits perms/editable when the definition has none', () => {
    const back = matrixToDefinition(definitionToMatrix(null, TABLES))
    expect('perms' in back).toBe(false)
    expect('editable' in back).toBe(false)
  })

  it('carries wildcard granular blocks + non-vocab table blocks through a matrix edit', () => {
    const def: RoleDefinition = {
      tables: { [WILDCARD]: 'read', bots: 'write', secret_ledger: 'read' },
      actions: [],
      masked: { '*': ['token'], hidden_table: ['pin'] },
      row_filter: { '*': 'tenant = {actor.tenant}' },
      perms: { '*': { view: true, delete: false } },
      editable: { hidden_table: ['note'] },
    }
    const m = definitionToMatrix(def, TABLES)
    const bots = m.rows.find((r) => r.table === 'bots')!
    bots.level = 'read'
    const back = matrixToDefinition(m)
    expect(back.tables).toEqual({ [WILDCARD]: 'read', bots: 'read', secret_ledger: 'read' })
    expect(back.masked).toEqual({ '*': ['token'], hidden_table: ['pin'] })
    expect(back.row_filter).toEqual({ '*': 'tenant = {actor.tenant}' })
    expect(back.perms).toEqual({ '*': { view: true, delete: false } })
    expect(back.editable).toEqual({ hidden_table: ['note'] })
  })

  it('does not fabricate carry blocks for a plain role', () => {
    const def: RoleDefinition = {
      tables: { bots: 'write' },
      actions: [],
      masked: {},
      row_filter: {},
    }
    const back = matrixToDefinition(definitionToMatrix(def, TABLES))
    expect(back.masked).toEqual({})
    expect(back.row_filter).toEqual({})
    expect('perms' in back).toBe(false)
    expect('editable' in back).toBe(false)
  })

  it('dedupes masked columns and actions', () => {
    const m = definitionToMatrix(null, TABLES)
    m.actions = ['a.x', 'a.x', 'b.y']
    m.rows[0].masked = ['c', 'c', 'd']
    m.rows[0].level = 'read'
    const def = matrixToDefinition(m)
    expect(def.actions).toEqual(['a.x', 'b.y'])
    expect(def.masked[m.rows[0].table]).toEqual(['c', 'd'])
  })
})

describe('actionTable', () => {
  it('splits table.action', () => {
    expect(actionTable('bots.halt')).toBe('bots')
    expect(actionTable('noop')).toBe('noop')
  })
})

describe('validateRoleName', () => {
  it('accepts valid names', () => {
    expect(validateRoleName('support-2')).toBeNull()
    expect(validateRoleName('a_b')).toBeNull()
  })
  it('rejects empty and illegal chars', () => {
    expect(validateRoleName('')).toBe('name_required')
    expect(validateRoleName('has space')).toBe('role_name_invalid')
    expect(validateRoleName('a'.repeat(65))).toBe('role_name_invalid')
  })
})

describe('validateUserPayload', () => {
  const roles = ['admin', 'analyst']
  it('normalizes email and accepts a valid payload', () => {
    const r = validateUserPayload({ email: '  A@X.io ', password: 'longenough', role: 'admin' }, roles)
    expect(r.ok).toBe(true)
    expect(r.value.email).toBe('a@x.io')
  })
  it('flags a bad email, short password and unknown role', () => {
    const r = validateUserPayload({ email: 'nope', password: 'short', role: 'ghost' }, roles)
    expect(r.ok).toBe(false)
    expect(r.errors.email).toBe('email_invalid')
    expect(r.errors.password).toBe('password_too_short')
    expect(r.errors.role).toBe('role_invalid')
  })
  it('requires a password by default but not when editing', () => {
    expect(validateUserPayload({ email: 'a@x.io', password: '', role: 'admin' }, roles).errors.password).toBe(
      'password_required',
    )
    const edit = validateUserPayload(
      { email: 'a@x.io', password: '', role: 'admin' },
      roles,
      { requirePassword: false },
    )
    expect(edit.ok).toBe(true)
  })
})
