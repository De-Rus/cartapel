import { describe, expect, it } from 'vitest'
import type { RoleWrite, TableMeta } from '../api/types'
import {
  type TableConfigData,
  badgeColors,
  interpretPut,
  modelChanged,
  modelFromApi,
  modelFromMeta,
  modelToApi,
  numParam,
  prune,
  withParam,
} from './configModel'

const RICH: TableConfigData = {
  label: 'bot',
  label_plural: 'Bots',
  list: {
    columns: ['name', 'status', 'equity'],
    search: ['name'],
    filters: ['status'],
    sort: '-equity',
    per_page: 50,
  },
  display: { title: '{name} · {status}' },
  detail: {
    sections: [
      { title: 'Identity', fields: ['name', 'status'] },
      { title: 'Money', fields: ['equity'] },
    ],
  },
  permissions: { create: false },
  fields: {
    status: { widget: 'badge', params: { colors: { live: 'green', halted: 'red' } } },
    last_tick: { widget: 'relative_time', params: { warn_after: 120 }, readonly: true },
    api_key: { widget: 'masked', masked: true, readonly: true },
    equity: { widget: 'money', params: { currency: 'USD' }, readonly: true },
  },
  actions: {
    halt: { label: 'Halt', kind: 'update', set: { status: 'halted' }, confirm: 'Halt {count}?', danger: true },
    ping: { label: 'Ping', kind: 'webhook', url: 'https://x.io/hook', method: 'POST' },
  },
}

describe('visual model ↔ API JSON round-trip', () => {
  it('is idempotent: modelToApi(modelFromApi(json)) equals the pruned json', () => {
    const json = modelToApi(RICH)
    const back = modelFromApi(json)
    expect(modelToApi(back)).toEqual(json)
  })

  it('preserves the full structure through a round-trip', () => {
    const back = modelFromApi(modelToApi(RICH))
    expect(back.label).toBe('bot')
    expect(back.list?.columns).toEqual(['name', 'status', 'equity'])
    expect(back.list?.sort).toBe('-equity')
    expect(back.list?.per_page).toBe(50)
    expect(back.display?.title).toBe('{name} · {status}')
    expect(back.detail?.sections).toHaveLength(2)
    expect(back.detail?.sections?.[1]).toEqual({ title: 'Money', fields: ['equity'] })
    expect(back.permissions).toEqual({ create: false })
    expect(back.fields?.status?.params?.colors).toEqual({ live: 'green', halted: 'red' })
    expect(back.fields?.api_key?.masked).toBe(true)
    expect(back.actions?.halt).toMatchObject({ kind: 'update', danger: true })
    expect(back.actions?.halt?.set).toEqual({ status: 'halted' })
    expect(back.actions?.ping).toMatchObject({ kind: 'webhook', url: 'https://x.io/hook', method: 'POST' })
  })

  it('bridges the Rust HCL block names field/action/filter to the visual plural forms', () => {
    const apiJson = {
      label: 'bot',
      field: { status: { widget: 'badge' }, name: { label: 'Name' } },
      action: { halt: { label: 'Halt', kind: 'update', set: { status: 'halted' } } },
      list: { columns: ['name'], filter: { live: { label: 'Live', sql: "status='live'" } } },
    }
    const m = modelFromApi(apiJson)
    expect(m.fields?.status?.widget).toBe('badge')
    expect(m.fields?.name?.label).toBe('Name')
    expect(m.actions?.halt?.kind).toBe('update')
    expect(m.list?.filter_defs?.live?.sql).toBe("status='live'")
    // no leaked Rust keys on the visual model
    expect((m as Record<string, unknown>).field).toBeUndefined()
    expect((m as Record<string, unknown>).action).toBeUndefined()
    expect((m.list as Record<string, unknown>).filter).toBeUndefined()

    // …and modelToApi emits the Rust names back
    const out = modelToApi(m) as Record<string, unknown>
    expect(out.field).toBeDefined()
    expect(out.action).toBeDefined()
    expect(out.fields).toBeUndefined()
    expect((out.list as Record<string, unknown>).filter).toBeDefined()
  })

  it('modelToApi strips empty leaves so it mirrors skip_serializing_if', () => {
    const json = modelToApi({ label: 'bot', list: { columns: [] }, fields: {} })
    expect(json).toEqual({ label: 'bot' })
  })

  it('emits the Rust `section` key (not `sections`) and preserves stats/sidebar/mode', () => {
    const json = modelToApi({
      detail: {
        mode: 'page',
        columns: 1,
        stats: ['installs', 'rating'],
        sidebar: { fields: ['id'] },
        sections: [{ title: 'A', fields: ['x'] }],
      },
    }) as { detail?: Record<string, unknown> }
    expect(json.detail?.section).toEqual([{ title: 'A', fields: ['x'] }])
    expect(json.detail).not.toHaveProperty('sections')
    expect(json.detail?.stats).toEqual(['installs', 'rating'])
    expect(json.detail?.sidebar).toEqual({ fields: ['id'] })
    expect(json.detail?.mode).toBe('page')
    expect(json.detail?.columns).toBe(1)
  })

  it('modelFromApi maps the Rust `section` key back to `sections`', () => {
    const back = modelFromApi({
      detail: { columns: 2, stats: ['a'], section: [{ title: 'A', fields: ['x'] }] },
    })
    expect(back.detail?.sections).toEqual([{ title: 'A', fields: ['x'] }])
    expect(back.detail).not.toHaveProperty('section')
    expect(back.detail?.stats).toEqual(['a'])
    expect(back.detail?.columns).toBe(2)
  })

  it('an empty model serializes to {} and hydrates from a missing payload', () => {
    expect(modelToApi({})).toEqual({})
    expect(modelFromApi(undefined)).toEqual({})
    expect(modelFromApi(null)).toEqual({})
  })
})

describe('prune drops empties but keeps meaningful false', () => {
  it('drops undefined, null, empty string, empty array/object', () => {
    expect(
      prune({ a: undefined, b: null, c: '', d: [], e: {}, f: 'x', g: [1], h: { z: 1 } }),
    ).toEqual({ f: 'x', g: [1], h: { z: 1 } })
  })
  it('keeps false booleans and zero', () => {
    expect(prune({ create: false, n: 0 })).toEqual({ create: false, n: 0 })
  })
})

describe('modelChanged — dirty detection on the pruned form', () => {
  it('is false for an identical model and its round-trip', () => {
    expect(modelChanged(RICH, RICH)).toBe(false)
    expect(modelChanged(RICH, modelFromApi(modelToApi(RICH)))).toBe(false)
  })
  it('ignores cosmetic empties that prune away', () => {
    expect(modelChanged({ label: 'bot' }, { label: 'bot', list: { columns: [] }, fields: {} })).toBe(false)
  })
  it('detects a scalar change', () => {
    expect(modelChanged(RICH, { ...RICH, label: 'robot' })).toBe(true)
  })
  it('detects an array reorder and length change', () => {
    expect(modelChanged(RICH, { ...RICH, list: { ...RICH.list, columns: ['status', 'name', 'equity'] } })).toBe(true)
    expect(modelChanged(RICH, { ...RICH, list: { ...RICH.list, columns: ['name'] } })).toBe(true)
  })
  it('detects a nested field edit and a false→absent boolean flip', () => {
    expect(modelChanged(RICH, { ...RICH, permissions: { create: true } })).toBe(true)
    expect(modelChanged(RICH, { ...RICH, permissions: {} })).toBe(true)
  })
})

describe('param helpers', () => {
  it('withParam sets and clears a key, dropping an empty params map', () => {
    expect(withParam(undefined, 'currency', 'USD')).toEqual({ currency: 'USD' })
    expect(withParam({ currency: 'USD', lang: 'py' }, 'currency', '')).toEqual({ lang: 'py' })
    expect(withParam({ currency: 'USD' }, 'currency', undefined)).toBeUndefined()
  })
  it('numParam tolerates string values from the payload', () => {
    expect(numParam({ warn_after: 120 }, 'warn_after')).toBe(120)
    expect(numParam({ warn_after: '120' }, 'warn_after')).toBe(120)
    expect(numParam(undefined, 'warn_after')).toBeUndefined()
  })
  it('badgeColors extracts a string→string map', () => {
    expect(badgeColors({ colors: { a: 'green', b: 'red', c: 5 } })).toEqual({ a: 'green', b: 'red' })
    expect(badgeColors(undefined)).toEqual({})
  })
})

const META: TableMeta = {
  name: 'bots',
  label: 'bot',
  label_plural: 'Bots',
  group: 'Trading',
  pk: 'id',
  read_only: false,
  columns: [
    { name: 'id', kind: 'uuid', widget: 'uuid', params: {}, nullable: false, readonly: true, masked: false, fk: null },
    { name: 'name', kind: 'text', widget: 'text', params: {}, nullable: false, readonly: false, masked: false, fk: null },
    {
      name: 'status',
      kind: 'text',
      widget: 'badge',
      params: { colors: { live: 'green' } },
      nullable: true,
      readonly: false,
      masked: false,
      fk: null,
    },
    { name: 'api_key', kind: 'text', widget: 'masked', params: {}, nullable: true, readonly: true, masked: true, fk: null },
  ],
  list: {
    columns: ['name', 'status'],
    search: ['name'],
    filters: [{ name: 'status', label: 'Status', type: 'enum', options: [] }],
    default_sort: 'name',
    per_page: 50,
  },
  display_title: '{name}',
  sections: [{ title: 'Identity', fields: ['name', 'status'] }],
  inlines: [],
  actions: [{ name: 'halt', label: 'Halt', danger: true, confirm: 'Halt {count}?', kind: 'update' }],
  perms: { read: true, write: true, create: false, delete: true, actions: ['halt'] },
}

describe('modelFromMeta', () => {
  it('derives fields only for non-default widgets or flags', () => {
    const m = modelFromMeta(META)
    expect(Object.keys(m.fields ?? {})).toEqual(['id', 'status', 'api_key'])
    expect(m.fields?.name).toBeUndefined()
    expect(m.fields?.status?.widget).toBe('badge')
    expect(m.fields?.api_key?.masked).toBe(true)
  })
  it('carries list, display, sections, permissions and actions', () => {
    const m = modelFromMeta(META)
    expect(m.list?.columns).toEqual(['name', 'status'])
    expect(m.list?.sort).toBe('name')
    expect(m.display?.title).toBe('{name}')
    expect(m.detail?.sections?.[0].title).toBe('Identity')
    expect(m.permissions).toMatchObject({ create: false })
    expect(m.actions?.halt).toMatchObject({ label: 'Halt', kind: 'update', danger: true })
  })
  it('modelToApi(modelFromMeta) produces a clean structured payload', () => {
    const json = modelToApi(modelFromMeta(META))
    expect(json.label).toBe('bot')
    expect(json.list?.columns).toEqual(['name', 'status'])
  })
})

describe('interpretPut — writable vs copy-to-repo branch', () => {
  it('applied when the config hot-reloaded', () => {
    expect(interpretPut({ ok: true, reloaded: true })).toEqual({ kind: 'applied' })
  })
  it('readonly with the validated hcl when the dir is not writable', () => {
    expect(interpretPut({ ok: false, writable: false, hcl: 'label = "x"' })).toEqual({
      kind: 'readonly',
      hcl: 'label = "x"',
    })
  })
  it('interprets a role write the same way (applied vs readonly)', () => {
    const applied: RoleWrite = { ok: true, reloaded: true }
    const readonly: RoleWrite = { ok: false, writable: false, hcl: 'role "x" {}' }
    expect(interpretPut(applied).kind).toBe('applied')
    expect(interpretPut(readonly)).toEqual({ kind: 'readonly', hcl: 'role "x" {}' })
  })
})
