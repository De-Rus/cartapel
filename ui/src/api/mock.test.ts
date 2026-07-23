import { describe, expect, it } from 'vitest'
import { imageUrl, ApiError } from './client'
import { mockExport, mockRequest } from './mock'
import type {
  ConfigGet,
  ConfigPublishResult,
  ConfigPut,
  ConfigVersionBody,
  ConfigVersionsResponse,
  DashboardConfigGet,
  DashboardPreviewResult,
  DashboardVersionBody,
  DiscoverResponse,
  GroupsLayout,
  GroupWrite,
} from './types'
import type {
  AccessUser,
  ActionResult,
  AuditResponse,
  BulkResult,
  ImportResult,
  ListResponse,
  Meta,
  OptionItem,
  RolesResponse,
  RoleWrite,
  RowResponse,
  SavedViewsResponse,
  SearchResponse,
} from './types'

describe('mock API contract', () => {
  it('serves meta with tables and perms', async () => {
    const meta = (await mockRequest('GET', '/meta')) as Meta
    expect(meta.tables.length).toBeGreaterThan(2)
    const instruments = meta.tables.find((t) => t.name === 'instruments')!
    expect(instruments.list.filters.map((f) => f.type)).toContain('custom')
    expect(instruments.perms.actions).toContain('deactivate')
    const logo = instruments.columns.find((c) => c.widget === 'image')!
    expect(logo.params.uploadable).toBe(true)
    expect(instruments.list.columns).toContain('logo')
  })

  it('exposes a custom widget column, pages, and locale', async () => {
    const meta = (await mockRequest('GET', '/meta')) as Meta
    const bots = meta.tables.find((t) => t.name === 'bots')!
    const spark = bots.columns.find((c) => c.widget === 'custom:sparkline')!
    expect(spark).toBeTruthy()
    expect(spark.params.field).toBe('equity_curve')
    expect(bots.list.columns).toContain('equity_curve')
    expect(meta.pages?.[0].slug).toBe('reconcile')
    expect(meta.pages?.[0].id).toBe('ops/reconcile')
    expect(meta.locale).toBe('es')
  })

  it('builds image URLs per the contract (real mode)', () => {
    expect(imageUrl('instruments', 'logo', '7', 'abc')).toBe(
      '/admin/api/t/instruments/image/logo/7?v=abc',
    )
    expect(imageUrl('bots', 'avatar', 'a b')).toBe('/admin/api/t/bots/image/avatar/a%20b')
  })

  it('lists with search, filter, sort and pagination', async () => {
    const all = (await mockRequest('GET', '/t/instruments?page=1&pp=10')) as ListResponse
    expect(all.rows).toHaveLength(10)
    expect(all.total).toBeGreaterThan(50)

    const filtered = (await mockRequest(
      'GET',
      '/t/instruments?f_asset_class=stock&sort=-symbol&pp=100',
    )) as ListResponse
    expect(filtered.rows.every((r) => r.asset_class === 'stock')).toBe(true)
    const syms = filtered.rows.map((r) => String(r.symbol))
    expect([...syms].sort().reverse()).toEqual(syms)

    const searched = (await mockRequest('GET', '/t/instruments?q=btc')) as ListResponse
    expect(searched.rows.every((r) => String(r.symbol).includes('BTC'))).toBe(true)
  })

  it('serves row detail with inlines', async () => {
    const list = (await mockRequest('GET', '/t/bots?pp=1')) as ListResponse
    const pk = String(list.rows[0].id)
    const detail = (await mockRequest('GET', `/t/bots/r/${pk}`)) as RowResponse
    expect(detail.row.id).toBe(pk)
    expect(detail.inlines[0].table).toBe('bot_notifications')
  })

  it('rejects patches to readonly columns', async () => {
    const list = (await mockRequest('GET', '/t/instruments?pp=1')) as ListResponse
    const pk = String(list.rows[0].id)
    await expect(
      mockRequest('PATCH', `/t/instruments/r/${pk}`, { set: { symbol: 'HACK' } }),
    ).rejects.toThrow(/solo lectura/)
    const ok = (await mockRequest('PATCH', `/t/instruments/r/${pk}`, {
      set: { active: false },
    })) as { row: Record<string, unknown> }
    expect(ok.row.active).toBe(false)
  })

  it('runs bulk actions and reports affected count', async () => {
    const list = (await mockRequest('GET', '/t/bots?pp=2')) as ListResponse
    const pks = list.rows.map((r) => String(r.id))
    const res = (await mockRequest('POST', '/t/bots/action/halt', { pks })) as ActionResult
    expect(res.affected).toBe(2)
  })

  it('serves fk options with labels', async () => {
    const opts = (await mockRequest('GET', '/t/bots/options/instrument_id?q=aapl')) as OptionItem[]
    expect(opts.length).toBeGreaterThan(0)
    expect(opts[0].label).toContain('AAPL')
  })

  it('advertises sections, computed columns, ops, and approx_rows in meta', async () => {
    const meta = (await mockRequest('GET', '/meta')) as Meta
    const instruments = meta.tables.find((t) => t.name === 'instruments')!
    expect(instruments.sections?.[0].title).toBe('Identity')
    expect(instruments.approx_rows).toBeGreaterThan(0)
    const computed = instruments.columns.find((c) => c.name === 'age_days')!
    expect(computed.computed).toBe(true)
    expect(computed.readonly).toBe(true)
    const numericFilter = instruments.list.filters.find((f) => f.name === 'last')!
    expect(numericFilter.ops).toContain('between')
  })

  it('folds computed columns into list and detail rows', async () => {
    const list = (await mockRequest('GET', '/t/instruments?pp=3')) as ListResponse
    expect(typeof list.rows[0].age_days).toBe('number')
    const detail = (await mockRequest(
      'GET',
      `/t/instruments/r/${list.rows[0].id}`,
    )) as RowResponse
    expect(typeof detail.row.age_days).toBe('number')
  })

  it('applies advanced filter operators', async () => {
    const gt = (await mockRequest('GET', '/t/bots?f_equity__gt=15000&pp=100')) as ListResponse
    expect(gt.rows.every((r) => Number(r.equity) > 15000)).toBe(true)

    const contains = (await mockRequest('GET', '/t/bots?f_name__contains=grid&pp=100')) as ListResponse
    expect(contains.rows.every((r) => String(r.name).includes('grid'))).toBe(true)

    const between = (await mockRequest('GET', '/t/bots?f_leverage__between=2..3&pp=100')) as ListResponse
    expect(between.rows.every((r) => Number(r.leverage) >= 2 && Number(r.leverage) <= 3)).toBe(true)
  })

  it('supports multi-column sort', async () => {
    const res = (await mockRequest(
      'GET',
      '/t/instruments?sort=asset_class,-symbol&pp=100',
    )) as ListResponse
    for (let i = 1; i < res.rows.length; i++) {
      const a = res.rows[i - 1]
      const b = res.rows[i]
      const ca = String(a.asset_class)
      const cb = String(b.asset_class)
      expect(ca <= cb).toBe(true)
      if (ca === cb) expect(String(a.symbol) >= String(b.symbol)).toBe(true)
    }
  })

  it('serves global search grouped by table', async () => {
    const res = (await mockRequest('GET', '/search?q=btc')) as SearchResponse
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results[0]).toHaveProperty('table')
    expect(res.results[0]).toHaveProperty('pk')
    expect(res.results[0]).toHaveProperty('title')
    expect((await mockRequest('GET', '/search?q=') as SearchResponse).results).toHaveLength(0)
  })

  it('lists, creates and deletes saved views', async () => {
    const before = (await mockRequest('GET', '/views?table=bots')) as SavedViewsResponse
    const created = (await mockRequest('POST', '/views', {
      table: 'bots',
      name: 'Test view',
      query: 'f_status=live',
      shared: false,
    })) as { id: number }
    const after = (await mockRequest('GET', '/views?table=bots')) as SavedViewsResponse
    expect(after.rows.length).toBe(before.rows.length + 1)
    await mockRequest('DELETE', `/views/${created.id}`)
    const final = (await mockRequest('GET', '/views?table=bots')) as SavedViewsResponse
    expect(final.rows.find((v) => v.id === created.id)).toBeUndefined()
  })

  it('exports csv and json carrying the active filters', () => {
    const csv = mockExport('bots', 'csv', 'f_status=halted')
    const header = csv.body.split('\n')[0]
    expect(header).toContain('name')
    expect(csv.mime).toBe('text/csv')
    const json = mockExport('bots', 'json', 'f_status=halted')
    const rows = JSON.parse(json.body)
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.every((r: Record<string, unknown>) => r.status === 'halted')).toBe(true)
  })

  it('reports approx totals for huge tables', async () => {
    const res = (await mockRequest('GET', '/t/price_events?pp=50')) as ListResponse
    expect(res.approx).toBe(true)
    expect(res.total % 1000).toBe(0)
    expect(res.rows).toHaveLength(50)
  })

  it('bulk-updates the selected rows', async () => {
    const list = (await mockRequest('GET', '/t/bots?pp=3')) as ListResponse
    const pks = list.rows.map((r) => String(r.id))
    const res = (await mockRequest('POST', '/t/bots/bulk', {
      pks,
      set: { leverage: 4 },
    })) as BulkResult
    expect(res.affected).toBe(3)
    const after = (await mockRequest('GET', `/t/bots/r/${pks[0]}`)) as RowResponse
    expect(after.row.leverage).toBe(4)
  })

  it('rejects bulk edits to readonly columns', async () => {
    const list = (await mockRequest('GET', '/t/bots?pp=1')) as ListResponse
    await expect(
      mockRequest('POST', '/t/bots/bulk', { pks: [String(list.rows[0].id)], set: { equity: 1 } }),
    ).rejects.toThrow(/solo lectura/)
  })

  it('imports CSV rows and reports the tally', async () => {
    const res = (await mockRequest('POST', '/t/users/import', {
      format: 'csv',
      data: 'email,role\nnew1@x.com,viewer\nnew2@x.com,admin',
      mode: 'insert',
    })) as ImportResult
    expect(res.inserted).toBe(2)
    expect(res.errors).toHaveLength(0)
  })

  it('upserts existing rows on import', async () => {
    const list = (await mockRequest('GET', '/t/users?pp=1')) as ListResponse
    const id = list.rows[0].id
    const res = (await mockRequest('POST', '/t/users/import', {
      format: 'json',
      data: JSON.stringify([{ id, role: 'viewer' }]),
      mode: 'upsert',
    })) as ImportResult
    expect(res.updated).toBe(1)
    expect(res.inserted).toBe(0)
  })

  it('serves a per-row audit timeline', async () => {
    const res = (await mockRequest('GET', '/t/instruments/r/1/audit')) as AuditResponse
    expect(Array.isArray(res.rows)).toBe(true)
    expect(res.rows.every((r) => r.table_name === 'instruments')).toBe(true)
  })
})

describe('access subsystem (users + roles)', () => {
  it('advertises effective roles and can_manage_access in meta', async () => {
    const meta = (await mockRequest('GET', '/meta')) as Meta
    expect(meta.can_manage_access).toBe(true)
    expect(meta.roles).toContain('admin')
    expect(meta.roles).toContain('support')
  })

  it('lists access users without a password hash', async () => {
    const users = (await mockRequest('GET', '/users')) as AccessUser[]
    expect(users.length).toBeGreaterThan(0)
    expect(users[0]).toHaveProperty('email')
    expect(users[0]).not.toHaveProperty('pw_hash')
  })

  it('creates a user and rejects a duplicate email (409)', async () => {
    const created = (await mockRequest('POST', '/users', {
      email: 'New@X.io',
      password: 'longenough',
      role: 'analyst',
    })) as AccessUser
    expect(created.email).toBe('new@x.io')
    await expect(
      mockRequest('POST', '/users', { email: 'new@x.io', password: 'longenough', role: 'analyst' }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('rejects a short password on create (400)', async () => {
    await expect(
      mockRequest('POST', '/users', { email: 'short@x.io', password: 'nope', role: 'analyst' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('guards the last admin on role change and delete', async () => {
    const users = (await mockRequest('GET', '/users')) as AccessUser[]
    const admins = users.filter((u) => u.role === 'admin')
    // demote all but one admin
    for (let i = 1; i < admins.length; i++) {
      await mockRequest('PATCH', `/users/${admins[i].id}`, { role: 'analyst' })
    }
    const last = admins[0]
    await expect(mockRequest('PATCH', `/users/${last.id}`, { role: 'analyst' })).rejects.toMatchObject({
      status: 400,
    })
    await expect(mockRequest('DELETE', `/users/${last.id}`)).rejects.toMatchObject({ status: 400 })
  })

  it('serves the roles vocabulary with source + user_count', async () => {
    const res = (await mockRequest('GET', '/roles')) as RolesResponse
    const admin = res.roles.find((r) => r.name === 'admin')!
    expect(admin.source).toBe('builtin')
    expect(admin.editable).toBe(false)
    const support = res.roles.find((r) => r.name === 'support')!
    expect(support.source).toBe('config')
    expect(support.editable).toBe(true)
    expect(support.definition?.tables.bots).toBe('write')
    expect(res.tables).toContain('bots')
    expect(res.actions).toContain('bots.halt')
  })

  it('refuses to edit a builtin role (403)', async () => {
    await expect(
      mockRequest('PATCH', '/roles/admin', { definition: { tables: {}, actions: [], masked: {}, row_filter: {} } }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('creates, validates, and prevents deletion of an in-use role', async () => {
    await mockRequest('POST', '/roles', {
      name: 'auditor',
      definition: { tables: { bots: 'read' }, actions: [], masked: {}, row_filter: {} },
    })
    await expect(
      mockRequest('POST', '/roles', {
        name: 'auditor',
        definition: { tables: {}, actions: [], masked: {}, row_filter: {} },
      }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      mockRequest('POST', '/roles', {
        name: 'bad',
        definition: { tables: { nope: 'read' }, actions: [], masked: {}, row_filter: {} },
      }),
    ).rejects.toMatchObject({ status: 400 })
    // assign a user, then deletion must 409
    await mockRequest('POST', '/users', { email: 'hold@x.io', password: 'longenough', role: 'auditor' })
    await expect(mockRequest('DELETE', '/roles/auditor')).rejects.toMatchObject({ status: 409 })
  })

  it('returns the config-builder write result shape and still mutates the store', async () => {
    const created = (await mockRequest('POST', '/roles', {
      name: 'reviewer',
      definition: { tables: { bots: 'read' }, actions: [], masked: {}, row_filter: {} },
    })) as RoleWrite
    expect(created).toEqual({ ok: true, reloaded: true })
    let roles = ((await mockRequest('GET', '/roles')) as RolesResponse).roles
    expect(roles.some((r) => r.name === 'reviewer')).toBe(true)

    const updated = (await mockRequest('PATCH', '/roles/reviewer', {
      definition: { tables: { bots: 'write' }, actions: [], masked: {}, row_filter: {} },
    })) as RoleWrite
    expect(updated).toEqual({ ok: true, reloaded: true })

    const removed = (await mockRequest('DELETE', '/roles/reviewer')) as RoleWrite
    expect(removed).toEqual({ ok: true, reloaded: true })
    roles = ((await mockRequest('GET', '/roles')) as RolesResponse).roles
    expect(roles.some((r) => r.name === 'reviewer')).toBe(false)
  })

  it('preserves hand-authored perms/editable blocks through create and update', async () => {
    const definition = {
      tables: { bots: 'write' },
      actions: [],
      masked: {},
      row_filter: {},
      perms: { bots: { view: true, update: true } },
      editable: { bots: ['name', 'notes'] },
    }
    await mockRequest('POST', '/roles', { name: 'granular', definition })
    const created = ((await mockRequest('GET', '/roles')) as RolesResponse).roles.find(
      (r) => r.name === 'granular',
    )!
    expect(created.definition?.perms).toEqual(definition.perms)
    expect(created.definition?.editable).toEqual(definition.editable)

    const next = { ...definition, tables: { bots: 'read' } }
    await mockRequest('PATCH', '/roles/granular', { definition: next })
    const updated = ((await mockRequest('GET', '/roles')) as RolesResponse).roles.find(
      (r) => r.name === 'granular',
    )!
    expect(updated.definition?.tables.bots).toBe('read')
    expect(updated.definition?.perms).toEqual(definition.perms)
    expect(updated.definition?.editable).toEqual(definition.editable)
  })
})

describe('config endpoints (mock)', () => {
  it('GET returns a structured model + hcl with writable:true', async () => {
    const res = (await mockRequest('GET', '/config/instruments')) as ConfigGet
    expect(res.table).toBe('instruments')
    expect(res.writable).toBe(true)
    expect(res.model.label_plural).toBe('Instruments')
    expect((res.model.list as { columns: string[] }).columns).toContain('symbol')
    expect(typeof res.hcl).toBe('string')
    expect(res.hcl).toContain('label_plural = "Instruments"')
  })

  it('PUT { model } stores and re-renders the hcl on the next GET', async () => {
    const model = { label: 'widget', label_plural: 'Widgets' }
    const put = (await mockRequest('PUT', '/config/bots', { model })) as ConfigPut
    expect(put).toEqual({ ok: true, reloaded: true })
    const res = (await mockRequest('GET', '/config/bots')) as ConfigGet
    expect(res.model).toEqual(model)
    expect(res.hcl).toContain('label = "widget"')
  })

  it('PUT { hcl } stores the raw text verbatim on the next GET', async () => {
    const hcl = 'label = "raw"\nlabel_plural = "Raws"\n'
    const put = (await mockRequest('PUT', '/config/bots', { hcl })) as ConfigPut
    expect(put).toEqual({ ok: true, reloaded: true })
    const res = (await mockRequest('GET', '/config/bots')) as ConfigGet
    expect(res.hcl).toBe(hcl)
  })

  it('PUT rejects a body without model or hcl (400)', async () => {
    await expect(mockRequest('PUT', '/config/bots', {})).rejects.toMatchObject({ status: 400 })
    await expect(mockRequest('PUT', '/config/bots', { hcl: '  ' })).rejects.toMatchObject({
      status: 400,
    })
  })

  it('unknown table 404s', async () => {
    await expect(mockRequest('GET', '/config/nope')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('config version history (mock)', () => {
  it('seeds versions newest-first with exactly one published, carrying bytes', async () => {
    const res = (await mockRequest('GET', '/config/alerts/versions')) as ConfigVersionsResponse
    expect(res.versions.length).toBeGreaterThanOrEqual(2)
    const times = res.versions.map((v) => Date.parse(v.created_at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(res.versions.filter((v) => v.published)).toHaveLength(1)
    expect(res.versions.every((v) => v.bytes > 0)).toBe(true)
  })

  it('serves a version body by id and 404s an unknown id', async () => {
    const list = (await mockRequest('GET', '/config/users/versions')) as ConfigVersionsResponse
    const body = (await mockRequest(
      'GET',
      `/config/users/versions/${list.versions[0].id}`,
    )) as ConfigVersionBody
    expect(typeof body.hcl).toBe('string')
    expect(body.hcl.length).toBeGreaterThan(0)
    await expect(mockRequest('GET', '/config/users/versions/999999')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('appends a published version on save (putConfig)', async () => {
    const before = (await mockRequest('GET', '/config/price_events/versions')) as ConfigVersionsResponse
    const hcl = 'label = "event"\nlabel_plural = "Events"\n'
    await mockRequest('PUT', '/config/price_events', { hcl })
    const after = (await mockRequest('GET', '/config/price_events/versions')) as ConfigVersionsResponse
    expect(after.versions.length).toBe(before.versions.length + 1)
    expect(after.versions[0].published).toBe(true)
    expect(after.versions.filter((v) => v.published)).toHaveLength(1)
    const head = (await mockRequest(
      'GET',
      `/config/price_events/versions/${after.versions[0].id}`,
    )) as ConfigVersionBody
    expect(head.hcl).toBe(hcl)
  })

  it('publish rolls back to an older version and flips the published flag', async () => {
    const list = (await mockRequest('GET', '/config/bots/versions')) as ConfigVersionsResponse
    const older = list.versions.find((v) => !v.published)!
    const res = (await mockRequest(
      'POST',
      `/config/bots/versions/${older.id}/publish`,
    )) as ConfigPublishResult
    expect(res).toEqual({ ok: true, reloaded: true })
    const after = (await mockRequest('GET', '/config/bots/versions')) as ConfigVersionsResponse
    expect(after.versions.find((v) => v.published)!.id).toBe(older.id)
    expect(after.versions.filter((v) => v.published)).toHaveLength(1)
    const body = (await mockRequest('GET', `/config/bots/versions/${older.id}`)) as ConfigVersionBody
    const live = (await mockRequest('GET', '/config/bots')) as ConfigGet
    expect(live.hcl).toBe(body.hcl)
  })

  it('publish 404s an unknown version id', async () => {
    await expect(
      mockRequest('POST', '/config/bots/versions/999999/publish'),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('navigation groups (mock)', () => {
  it('lists writable groups, ungrouped and unconfigured tables', async () => {
    const res = (await mockRequest('GET', '/config/groups')) as GroupsLayout
    expect(res.writable).toBe(true)
    const slugs = res.groups.map((g) => g.slug)
    expect(slugs).toContain('trading')
    expect(slugs).toContain('market-data')
    const trading = res.groups.find((g) => g.slug === 'trading')!
    expect(trading.tables).toContain('bots')
    expect(res.ungrouped).toContain('users')
    expect(res.unconfigured).toContain('webhooks')
  })

  it('creates a group and rejects duplicates and bad slugs', async () => {
    const ok = (await mockRequest('POST', '/config/groups', {
      slug: 'ops',
      label: 'Operations',
      icon: 'wrench',
    })) as GroupWrite
    expect(ok).toEqual({ ok: true, reloaded: true })
    const after = (await mockRequest('GET', '/config/groups')) as GroupsLayout
    expect(after.groups.map((g) => g.slug)).toContain('ops')

    await expect(
      mockRequest('POST', '/config/groups', { slug: 'ops', label: 'Dup' }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      mockRequest('POST', '/config/groups', { slug: 'Bad Slug', label: 'x' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('patches label/icon and reorders member tables', async () => {
    await mockRequest('PATCH', '/config/groups/market-data', { label: 'Markets', icon: 'candlestick-chart' })
    const res = (await mockRequest('GET', '/config/groups')) as GroupsLayout
    const g = res.groups.find((x) => x.slug === 'market-data')!
    expect(g.label).toBe('Markets')
    expect(g.icon).toBe('candlestick-chart')

    await mockRequest('PATCH', '/config/groups/trading', { table_order: ['alerts', 'bots'] })
    const res2 = (await mockRequest('GET', '/config/groups')) as GroupsLayout
    const trading = res2.groups.find((x) => x.slug === 'trading')!
    expect(trading.tables.slice(0, 2)).toEqual(['alerts', 'bots'])
  })

  it('renames a group slug and rejects collisions', async () => {
    await mockRequest('POST', '/config/groups', { slug: 'temp', label: 'Temp' })
    const ok = (await mockRequest('POST', '/config/groups/temp/rename', { to: 'temp2' })) as GroupWrite
    expect(ok).toEqual({ ok: true, reloaded: true })
    const res = (await mockRequest('GET', '/config/groups')) as GroupsLayout
    const slugs = res.groups.map((g) => g.slug)
    expect(slugs).toContain('temp2')
    expect(slugs).not.toContain('temp')
    await expect(
      mockRequest('POST', '/config/groups/temp2/rename', { to: 'trading' }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('deletes an empty group but 409s a non-empty one', async () => {
    await mockRequest('POST', '/config/groups', { slug: 'empty', label: 'Empty' })
    const ok = (await mockRequest('DELETE', '/config/groups/empty')) as GroupWrite
    expect(ok).toEqual({ ok: true, reloaded: true })
    await expect(mockRequest('DELETE', '/config/groups/trading')).rejects.toMatchObject({ status: 409 })
  })

  it('saves a layout that moves a table between placements', async () => {
    const before = (await mockRequest('GET', '/config/groups')) as GroupsLayout
    const trading = before.groups.find((g) => g.slug === 'trading')!
    const market = before.groups.find((g) => g.slug === 'market-data')!
    const res = (await mockRequest('POST', '/config/groups/layout', {
      groups: [
        { slug: 'trading', tables: trading.tables.filter((t) => t !== 'bots') },
        { slug: 'market-data', tables: [...market.tables, 'bots'] },
      ],
      ungrouped: before.ungrouped,
    })) as GroupWrite
    expect(res).toEqual({ ok: true, reloaded: true })
    const after = (await mockRequest('GET', '/config/groups')) as GroupsLayout
    expect(after.groups.find((g) => g.slug === 'market-data')!.tables).toContain('bots')
    expect(after.groups.find((g) => g.slug === 'trading')!.tables).not.toContain('bots')
  })

  it('adopts an unconfigured table into a group via putConfig(group)', async () => {
    const put = (await mockRequest('PUT', '/config/api_tokens', {
      group: 'trading',
    })) as ConfigPut
    expect(put).toEqual({ ok: true, reloaded: true })
    const groups = (await mockRequest('GET', '/config/groups')) as GroupsLayout
    expect(groups.groups.find((g) => g.slug === 'trading')!.tables).toContain('api_tokens')
    expect(groups.unconfigured).not.toContain('api_tokens')
    const disc = (await mockRequest('GET', '/config/discover')) as DiscoverResponse
    expect(disc.tables.map((t) => t.name)).not.toContain('api_tokens')
  })
})

describe('discover tables (mock)', () => {
  it('lists unconfigured tables and views with metadata', async () => {
    const res = (await mockRequest('GET', '/config/discover')) as DiscoverResponse
    expect(res.tables.length).toBeGreaterThan(0)
    const view = res.tables.find((t) => t.is_view)!
    expect(view).toBeTruthy()
    expect(view.pk).toBeNull()
    const withPk = res.tables.find((t) => !t.is_view)!
    expect(typeof withPk.pk).toBe('string')
    expect(withPk.column_count).toBeGreaterThan(0)
    expect(withPk.schema).toBe('public')
  })
})

describe('dashboard config (mock)', () => {
  it('serves widgets, writable flag and hcl', async () => {
    const res = (await mockRequest('GET', '/config/dashboard')) as DashboardConfigGet
    expect(res.writable).toBe(true)
    expect(res.widgets.length).toBeGreaterThan(0)
    expect(res.widgets[0].type).toBeTruthy()
    expect(res.hcl).toContain('widget {')
  })

  it('rejects a stat widget without sql and an iframe without url', async () => {
    await expect(
      mockRequest('PUT', '/config/dashboard', { widgets: [{ type: 'stat', label: 'Count' }] }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      mockRequest('PUT', '/config/dashboard', { widgets: [{ type: 'iframe', label: 'X' }] }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('saves widgets, appends a published version and reflects live', async () => {
    const before = (await mockRequest('GET', '/config/dashboard/versions')) as ConfigVersionsResponse
    const widgets = [
      { type: 'stat', label: 'Live bots', sql: 'select count(*) from bots' },
      { type: 'iframe', label: 'Docs', url: 'https://docs.example.com' },
    ]
    const put = (await mockRequest('PUT', '/config/dashboard', { widgets })) as ConfigPut
    expect(put).toEqual({ ok: true, reloaded: true })
    const live = (await mockRequest('GET', '/config/dashboard')) as DashboardConfigGet
    expect(live.widgets.map((w) => w.label)).toEqual(['Live bots', 'Docs'])
    const after = (await mockRequest('GET', '/config/dashboard/versions')) as ConfigVersionsResponse
    expect(after.versions.length).toBe(before.versions.length + 1)
    expect(after.versions[0].published).toBe(true)
    expect(after.versions.filter((v) => v.published)).toHaveLength(1)
  })

  it('previews stat, chart and iframe widgets', async () => {
    const stat = (await mockRequest('POST', '/config/dashboard/preview', {
      widget: { type: 'stat', label: 'N', sql: 'select 1' },
    })) as DashboardPreviewResult
    expect(stat.widget?.type).toBe('stat')
    expect(typeof (stat.widget as { value: number }).value).toBe('number')

    const frame = (await mockRequest('POST', '/config/dashboard/preview', {
      widget: { type: 'iframe', label: 'G', url: 'https://g.example.com' },
    })) as DashboardPreviewResult
    expect(frame.widget?.type).toBe('iframe')

    await expect(
      mockRequest('POST', '/config/dashboard/preview', { widget: { type: 'chart', label: 'C' } }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('reads a version body as hcl and publishes an older version', async () => {
    const list = (await mockRequest('GET', '/config/dashboard/versions')) as ConfigVersionsResponse
    const body = (await mockRequest(
      'GET',
      `/config/dashboard/versions/${list.versions[0].id}`,
    )) as DashboardVersionBody
    expect(typeof body.hcl).toBe('string')

    const older = list.versions.find((v) => !v.published)!
    const res = (await mockRequest(
      'POST',
      `/config/dashboard/versions/${older.id}/publish`,
    )) as ConfigPublishResult
    expect(res).toEqual({ ok: true, reloaded: true })
    const after = (await mockRequest('GET', '/config/dashboard/versions')) as ConfigVersionsResponse
    expect(after.versions.find((v) => v.published)!.id).toBe(older.id)

    await expect(
      mockRequest('GET', '/config/dashboard/versions/999999'),
    ).rejects.toMatchObject({ status: 404 })
  })
})
