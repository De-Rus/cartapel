import { ApiError } from './client'
import { modelFromMeta, modelToApi, type TableConfigData } from '../lib/configModel'
import type {
  AccessUser,
  ActionResult,
  AuditRow,
  ColumnMeta,
  DashboardResponse,
  InlinePageResponse,
  ListResponse,
  Meta,
  OptionItem,
  RoleDefinition,
  RoleInfo,
  RolesResponse,
  RoleSource,
  RoleWrite,
  Row,
  RowResponse,
  TableMeta,
  User,
} from './types'

const now = Date.now()
const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = mulberry32(66)
const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]

const CRYPTO = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'TON', 'TRX', 'NEAR', 'ATOM', 'APT', 'ARB', 'OP', 'SUI', 'INJ', 'TIA']
const EXCHANGES = ['BINANCE', 'BYBIT', 'OKX']
const STOCKS: Array<[string, string]> = [
  ['AAPL', 'Apple Inc.'],
  ['MSFT', 'Microsoft Corp.'],
  ['NVDA', 'NVIDIA Corp.'],
  ['AMZN', 'Amazon.com Inc.'],
  ['GOOGL', 'Alphabet Inc.'],
  ['META', 'Meta Platforms'],
  ['TSLA', 'Tesla Inc.'],
  ['AVGO', 'Broadcom Inc.'],
  ['JPM', 'JPMorgan Chase'],
  ['V', 'Visa Inc.'],
  ['UNH', 'UnitedHealth'],
  ['XOM', 'Exxon Mobil'],
  ['LLY', 'Eli Lilly'],
  ['COST', 'Costco Wholesale'],
  ['HD', 'Home Depot'],
  ['NFLX', 'Netflix Inc.'],
  ['AMD', 'Advanced Micro Devices'],
  ['CRM', 'Salesforce Inc.'],
]
const ETFS: Array<[string, string]> = [
  ['SPY', 'SPDR S&P 500'],
  ['QQQ', 'Invesco QQQ'],
  ['IWM', 'iShares Russell 2000'],
  ['GLD', 'SPDR Gold Shares'],
  ['TLT', 'iShares 20+ Year Treasury'],
]

const uuid = () => {
  const h = () => Math.floor(rnd() * 16).toString(16)
  return `${'x'.repeat(8)}-xxxx-4xxx-yxxx-${'x'.repeat(12)}`.replace(/[xy]/g, (c) =>
    c === 'x' ? h() : ((Math.floor(rnd() * 4) + 8) as number).toString(16),
  )
}

const instruments: Row[] = []
let iid = 0
for (const sym of CRYPTO) {
  for (const ex of EXCHANGES) {
    iid += 1
    instruments.push({
      id: iid,
      symbol: `${sym}USDC`,
      logo: `${sym.toLowerCase()}.svg`,
      name: `${sym} / USD Coin`,
      exchange: ex,
      asset_class: 'crypto',
      active: rnd() > 0.15,
      last: Math.round(rnd() * 60000 * 100) / 100,
      change_24h: Math.round((rnd() * 12 - 6) * 100) / 100,
      uid: uuid(),
      tags: rnd() > 0.6 ? ['perp', 'hi-vol'] : ['spot'],
      meta: { tick_size: 0.01, lot: 0.001, quote: 'USDC' },
      created_at: iso(rnd() * 400 * DAY),
      last_price_at: iso(rnd() > 0.8 ? rnd() * 5 * HOUR : rnd() * 4 * MIN),
    })
  }
}
for (const [sym, name] of STOCKS) {
  iid += 1
  instruments.push({
    id: iid,
    symbol: sym,
    logo: `${sym.toLowerCase()}.svg`,
    name,
    exchange: 'NASDAQ',
    asset_class: 'stock',
    active: true,
    last: Math.round(rnd() * 900 * 100) / 100,
    change_24h: Math.round((rnd() * 6 - 3) * 100) / 100,
    uid: uuid(),
    tags: ['sp500'],
    meta: { tick_size: 0.01, lot: 1, quote: 'USD' },
    created_at: iso(rnd() * 700 * DAY),
    last_price_at: iso(rnd() * 20 * MIN),
  })
}
for (const [sym, name] of ETFS) {
  iid += 1
  instruments.push({
    id: iid,
    symbol: sym,
    logo: `${sym.toLowerCase()}.svg`,
    name,
    exchange: 'ARCA',
    asset_class: 'etf',
    active: true,
    last: Math.round(rnd() * 500 * 100) / 100,
    change_24h: Math.round((rnd() * 4 - 2) * 100) / 100,
    uid: uuid(),
    tags: ['etf'],
    meta: { tick_size: 0.01, lot: 1, quote: 'USD' },
    created_at: iso(rnd() * 700 * DAY),
    last_price_at: iso(rnd() * 20 * MIN),
  })
}

const BOT_NAMES = ['keltner-ssl', 'renko-htf', 'grid-atr', 'chandelier-ls', 'tlb-quality', 'breadth-timer', 'fib-pullback', 'orb-15', 'sma200-hold', 'vol-target', 'momentum-rs', 'dip-ladder']
const STATUSES = ['live', 'alerts_only', 'halted', 'off']
const bots: Row[] = BOT_NAMES.map((name, i) => {
  const inst = instruments[Math.floor(rnd() * instruments.length)]
  const status = i === 2 ? 'halted' : pick(STATUSES)
  return {
    id: uuid(),
    name,
    status,
    instrument_id: inst.id,
    instrument_id__label: `${inst.symbol as string} · ${inst.exchange as string}`,
    equity: Math.round(rnd() * 30000 * 100) / 100,
    equity_curve: Array.from({ length: 24 }, (_, k) =>
      Math.round((10000 + k * (rnd() * 200 - 60) + Math.sin(k / 3) * 800) * 100) / 100,
    ),
    pnl_pct: Math.round((rnd() * 40 - 10) * 100) / 100,
    leverage: [1, 1, 1, 2, 3][Math.floor(rnd() * 5)],
    interval: pick(['15m', '1h', '4h', '1d']),
    script: `def on_bar(bar):\n    fast = ta.ema(close, 12)\n    slow = ta.ema(close, 26)\n    if ta.crossover(fast, slow):\n        strategy.entry("L", size=1)\n`,
    config: { risk_pct: 1.5, max_positions: 4, session: '24/7' },
    notes: i % 3 === 0 ? 'Paper account only. Re-validated after the July data migration.' : '',
    api_key: 'sk_live_9f…e2',
    tags: i % 2 === 0 ? ['prod', 'crypto'] : ['research'],
    state_blob: { __bytes__: Math.floor(rnd() * 400000) + 800 },
    active: status === 'live' || status === 'alerts_only',
    created_at: iso(rnd() * 200 * DAY),
    last_tick: iso(status === 'halted' ? 9 * HOUR : status === 'off' ? 30 * DAY : rnd() * 90 * 1000),
  }
})

const CHANNELS = ['telegram', 'webhook', 'email']
const NOTIF_TITLES = ['Order filled', 'Stop triggered', 'Webhook 500', 'Daily summary', 'Position opened', 'Halt requested', 'Reconnect ok']
const notifications: Row[] = Array.from({ length: 64 }, (_, i) => {
  const bot = bots[Math.floor(rnd() * bots.length)]
  const title = pick(NOTIF_TITLES)
  return {
    id: i + 1,
    bot_id: bot.id,
    bot_id__label: bot.name,
    title,
    body: `${title} for ${bot.name} — see payload for details.`,
    channel: pick(CHANNELS),
    http_status: title === 'Webhook 500' ? 500 : 200,
    payload: { attempt: 1 + Math.floor(rnd() * 3), latency_ms: Math.floor(rnd() * 900) },
    sent_at: iso(rnd() * 14 * DAY),
  }
})

const users: Row[] = [
  { id: 1, email: 'admin@example.com', role: 'admin', created_at: iso(500 * DAY), last_login: iso(3 * MIN) },
  { id: 2, email: 'ops@example.com', role: 'admin', created_at: iso(300 * DAY), last_login: iso(2 * DAY) },
  { id: 3, email: 'viewer@example.com', role: 'viewer', created_at: iso(120 * DAY), last_login: iso(20 * DAY) },
]

const EVENT_KINDS = ['fill', 'signal', 'reject', 'reconnect', 'tick', 'halt']
const priceEvents: Row[] = Array.from({ length: 25000 }, (_, i) => {
  const inst = instruments[i % instruments.length]
  return {
    id: i + 1,
    instrument_id: inst.id,
    instrument_id__label: `${inst.symbol as string} · ${inst.exchange as string}`,
    kind: EVENT_KINDS[i % EVENT_KINDS.length],
    price: Math.round(rnd() * 60000 * 100) / 100,
    qty: Math.round(rnd() * 1000) / 100,
    ok: i % 9 !== 0,
    ts: iso(i * 90_000 + rnd() * 60_000),
  }
})

const col = (name: string, partial: Partial<ColumnMeta>): ColumnMeta => ({
  name,
  kind: 'text',
  widget: 'text',
  params: {},
  nullable: true,
  readonly: false,
  masked: false,
  fk: null,
  ...partial,
})

const instrumentsMeta: TableMeta = {
  name: 'instruments',
  label: 'instrument',
  label_plural: 'Instruments',
  group: 'Market data',
  pk: 'id',
  read_only: false,
  columns: [
    col('id', { kind: 'int', widget: 'number', readonly: true }),
    col('logo', { kind: 'binary', widget: 'image', params: { uploadable: true, max_px: 512 } }),
    col('symbol', { readonly: true, nullable: false }),
    col('name', {}),
    col('exchange', { readonly: true }),
    col('asset_class', {
      widget: 'badge',
      params: { colors: { crypto: 'orange', stock: 'blue', etf: 'violet' } },
    }),
    col('active', { kind: 'bool', widget: 'toggle', nullable: false }),
    col('last', { kind: 'float', widget: 'money', params: { currency: 'USD' }, readonly: true }),
    col('change_24h', { kind: 'float', widget: 'percent', readonly: true }),
    col('uid', { kind: 'uuid', widget: 'uuid', readonly: true }),
    col('tags', { kind: 'array', widget: 'array' }),
    col('meta', { kind: 'json', widget: 'json' }),
    col('created_at', { kind: 'datetime', widget: 'datetime', readonly: true }),
    col('last_price_at', { kind: 'datetime', widget: 'relative_time', params: { warn_after: 300 }, readonly: true }),
    col('age_days', {
      kind: 'int',
      widget: 'number',
      readonly: true,
      computed: true,
      label: 'Age (days)',
    }),
  ],
  list: {
    columns: ['logo', 'symbol', 'exchange', 'asset_class', 'last', 'change_24h', 'active', 'age_days', 'last_price_at'],
    search: ['symbol', 'name'],
    filters: [
      {
        name: 'asset_class',
        label: 'Asset class',
        type: 'enum',
        kind: 'text',
        ops: ['eq', 'ne', 'in', 'isnull'],
        options: [
          { value: 'crypto', label: 'crypto', count: CRYPTO.length * EXCHANGES.length },
          { value: 'stock', label: 'stock', count: STOCKS.length },
          { value: 'etf', label: 'etf', count: ETFS.length },
        ],
      },
      { name: 'active', label: 'Active', type: 'bool', kind: 'bool', options: [] },
      { name: 'last', label: 'Last price', type: 'enum', kind: 'float', ops: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isnull'], options: [] },
      { name: 'created_at', label: 'Created', type: 'date', kind: 'datetime', ops: ['eq', 'gt', 'lt', 'between', 'isnull'], options: [] },
      { name: 'stale', label: 'Sin precio reciente', type: 'custom', options: [] },
    ],
    default_sort: 'symbol',
    per_page: 50,
  },
  display_title: '{symbol} · {exchange}',
  sections: [
    { title: 'Identity', fields: ['logo', 'symbol', 'name', 'exchange', 'asset_class'] },
    { title: 'Market', fields: ['active', 'last', 'change_24h', 'tags', 'meta'] },
    { title: 'Timestamps', fields: ['created_at', 'last_price_at', 'age_days'] },
  ],
  approx_rows: CRYPTO.length * EXCHANGES.length + STOCKS.length + ETFS.length,
  inlines: [{ table: 'bots', fk_col: 'instrument_id', label: 'Bots' }],
  actions: [
    {
      name: 'deactivate',
      label: 'Deactivate',
      danger: false,
      confirm: 'Deactivate {count} instruments?',
      kind: 'update',
    },
  ],
  perms: { read: true, write: true, create: false, delete: false, actions: ['deactivate'] },
}

const botsMeta: TableMeta = {
  name: 'bots',
  label: 'bot',
  label_plural: 'Bots',
  group: 'Trading',
  pk: 'id',
  read_only: false,
  columns: [
    col('id', { kind: 'uuid', widget: 'uuid', readonly: true }),
    col('name', { nullable: false }),
    col('status', {
      widget: 'badge',
      params: { colors: { live: 'green', alerts_only: 'orange', halted: 'red', off: 'gray' } },
    }),
    col('instrument_id', { kind: 'int', widget: 'fk', fk: { table: 'instruments', label_col: 'symbol' } }),
    col('equity', { kind: 'float', widget: 'money', params: { currency: 'USD' }, readonly: true }),
    col('equity_curve', {
      kind: 'json',
      widget: 'custom:sparkline',
      params: { field: 'equity_curve', color: 'var(--accent)' },
      readonly: true,
    }),
    col('pnl_pct', { kind: 'float', widget: 'percent', readonly: true }),
    col('leverage', { kind: 'int', widget: 'number' }),
    col('interval', {}),
    col('script', { widget: 'code', params: { lang: 'python' } }),
    col('config', { kind: 'json', widget: 'json' }),
    col('notes', { widget: 'textarea' }),
    col('api_key', { widget: 'masked', masked: true, readonly: true }),
    col('tags', { kind: 'array', widget: 'array' }),
    col('state_blob', { kind: 'binary', widget: 'binary', readonly: true }),
    col('active', { kind: 'bool', widget: 'toggle', nullable: false }),
    col('created_at', { kind: 'datetime', widget: 'datetime', readonly: true }),
    col('last_tick', { kind: 'datetime', widget: 'relative_time', params: { warn_after: 120 }, readonly: true }),
  ],
  list: {
    columns: ['name', 'status', 'instrument_id', 'equity', 'equity_curve', 'pnl_pct', 'active', 'last_tick'],
    search: ['name'],
    filters: [
      {
        name: 'status',
        label: 'Status',
        type: 'enum',
        kind: 'text',
        ops: ['eq', 'ne', 'in', 'isnull'],
        options: STATUSES.map((s) => ({
          value: s,
          label: s,
          count: bots.filter((b) => b.status === s).length,
        })),
      },
      { name: 'active', label: 'Active', type: 'bool', kind: 'bool', options: [] },
      { name: 'equity', label: 'Equity', type: 'enum', kind: 'float', ops: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isnull'], options: [] },
      { name: 'leverage', label: 'Leverage', type: 'enum', kind: 'int', ops: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'isnull'], options: [] },
      { name: 'created_at', label: 'Created', type: 'date', kind: 'datetime', ops: ['eq', 'gt', 'lt', 'between', 'isnull'], options: [] },
    ],
    default_sort: '-created_at',
    per_page: 50,
  },
  display_title: '{name}',
  sections: [
    { title: 'Overview', fields: ['name', 'status', 'instrument_id', 'interval', 'leverage', 'active'] },
    { title: 'Performance', fields: ['equity', 'equity_curve', 'pnl_pct'] },
    { title: 'Config', fields: ['script', 'config', 'notes', 'tags'] },
  ],
  approx_rows: BOT_NAMES.length,
  inlines: [{ table: 'bot_notifications', fk_col: 'bot_id', label: 'Notifications' }],
  actions: [
    { name: 'restart', label: 'Restart', danger: false, confirm: 'Restart {count} bots?', kind: 'update' },
    {
      name: 'halt',
      label: 'Halt',
      danger: true,
      confirm: 'Halt {count} bots? Open orders will be cancelled.',
      kind: 'update',
    },
  ],
  perms: { read: true, write: true, create: true, delete: true, actions: ['restart', 'halt'] },
}

const notificationsMeta: TableMeta = {
  name: 'bot_notifications',
  label: 'notification',
  label_plural: 'Notifications',
  group: 'Trading',
  pk: 'id',
  read_only: true,
  columns: [
    col('id', { kind: 'int', widget: 'number', readonly: true }),
    col('bot_id', { kind: 'uuid', widget: 'fk', readonly: true, fk: { table: 'bots', label_col: 'name' } }),
    col('title', { readonly: true }),
    col('body', { widget: 'textarea', readonly: true }),
    col('channel', {
      widget: 'badge',
      readonly: true,
      params: { colors: { telegram: 'blue', webhook: 'violet', email: 'gray' } },
    }),
    col('http_status', { kind: 'int', widget: 'number', readonly: true }),
    col('payload', { kind: 'json', widget: 'json', readonly: true }),
    col('sent_at', { kind: 'datetime', widget: 'datetime', readonly: true }),
  ],
  list: {
    columns: ['bot_id', 'title', 'channel', 'http_status', 'sent_at'],
    search: ['title', 'body'],
    filters: [
      {
        name: 'channel',
        label: 'Channel',
        type: 'enum',
        options: CHANNELS.map((c) => ({
          value: c,
          label: c,
          count: notifications.filter((n) => n.channel === c).length,
        })),
      },
      { name: 'sent_at', label: 'Sent', type: 'date', options: [] },
    ],
    default_sort: '-sent_at',
    per_page: 50,
  },
  display_title: '{title}',
  inlines: [],
  actions: [],
  perms: { read: true, write: false, create: false, delete: false, actions: [] },
}

const usersMeta: TableMeta = {
  name: 'users',
  label: 'user',
  label_plural: 'Users',
  group: null,
  pk: 'id',
  read_only: false,
  columns: [
    col('id', { kind: 'int', widget: 'number', readonly: true }),
    col('email', { nullable: false }),
    col('role', { widget: 'badge', params: { colors: { admin: 'red', viewer: 'gray' } } }),
    col('created_at', { kind: 'datetime', widget: 'datetime', readonly: true }),
    col('last_login', { kind: 'datetime', widget: 'relative_time', params: { warn_after: 604800 }, readonly: true }),
  ],
  list: {
    columns: ['email', 'role', 'created_at', 'last_login'],
    search: ['email'],
    filters: [
      {
        name: 'role',
        label: 'Role',
        type: 'enum',
        options: [
          { value: 'admin', label: 'admin', count: 2 },
          { value: 'viewer', label: 'viewer', count: 1 },
        ],
      },
    ],
    default_sort: 'email',
    per_page: 50,
  },
  display_title: '{email}',
  inlines: [],
  actions: [],
  perms: { read: true, write: true, create: true, delete: true, actions: [] },
}

const priceEventsMeta: TableMeta = {
  name: 'price_events',
  label: 'event',
  label_plural: 'Price events',
  group: 'Market data',
  pk: 'id',
  read_only: false,
  columns: [
    col('id', { kind: 'int', widget: 'number', readonly: true }),
    col('instrument_id', { kind: 'int', widget: 'fk', fk: { table: 'instruments', label_col: 'symbol' } }),
    col('kind', {
      widget: 'badge',
      params: { colors: { fill: 'green', signal: 'blue', reject: 'red', reconnect: 'violet', tick: 'gray', halt: 'orange' } },
    }),
    col('price', { kind: 'float', widget: 'money', params: { currency: 'USD' } }),
    col('qty', { kind: 'float', widget: 'number' }),
    col('ok', { kind: 'bool', widget: 'toggle', nullable: false }),
    col('ts', { kind: 'datetime', widget: 'datetime', readonly: true }),
  ],
  list: {
    columns: ['id', 'instrument_id', 'kind', 'price', 'qty', 'ok', 'ts'],
    search: ['kind'],
    filters: [
      {
        name: 'kind',
        label: 'Kind',
        type: 'enum',
        kind: 'text',
        ops: ['eq', 'ne', 'in', 'isnull'],
        options: EVENT_KINDS.map((k) => ({ value: k, label: k })),
      },
      { name: 'ok', label: 'OK', type: 'bool', kind: 'bool', options: [] },
      { name: 'price', label: 'Price', type: 'enum', kind: 'float', ops: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isnull'], options: [] },
    ],
    default_sort: '-ts',
    per_page: 200,
  },
  display_title: '{kind} #{id}',
  approx_rows: priceEvents.length,
  inlines: [],
  actions: [
    { name: 'mark_ok', label: 'Mark OK', danger: false, confirm: 'Mark {count} events OK?', kind: 'update' },
  ],
  perms: { read: true, write: true, create: true, delete: true, actions: ['mark_ok'] },
}

const alertsMeta: TableMeta = {
  name: 'alerts',
  label: 'alert',
  label_plural: 'Alerts',
  group: 'Trading',
  pk: 'id',
  read_only: false,
  columns: [
    col('id', { kind: 'int', widget: 'number', readonly: true }),
    col('name', { nullable: false }),
    col('instrument_id', { kind: 'int', widget: 'fk', fk: { table: 'instruments', label_col: 'symbol' } }),
    col('condition', {
      widget: 'badge',
      params: { colors: { above: 'green', below: 'red', crosses: 'blue' } },
    }),
    col('threshold', { kind: 'float', widget: 'money', params: { currency: 'USD' } }),
    col('active', { kind: 'bool', widget: 'toggle', nullable: false }),
    col('created_at', { kind: 'datetime', widget: 'datetime', readonly: true }),
  ],
  list: {
    columns: ['name', 'instrument_id', 'condition', 'threshold', 'active', 'created_at'],
    search: ['name'],
    filters: [
      { name: 'active', label: 'Active', type: 'bool', kind: 'bool', options: [] },
      {
        name: 'condition',
        label: 'Condition',
        type: 'enum',
        kind: 'text',
        ops: ['eq', 'ne', 'in', 'isnull'],
        options: [
          { value: 'above', label: 'above' },
          { value: 'below', label: 'below' },
          { value: 'crosses', label: 'crosses' },
        ],
      },
    ],
    default_sort: '-created_at',
    per_page: 50,
  },
  display_title: '{name}',
  sections: [{ title: 'Alert', fields: ['name', 'instrument_id', 'condition', 'threshold', 'active'] }],
  approx_rows: 0,
  inlines: [],
  actions: [],
  perms: { read: true, write: true, create: true, delete: true, actions: [] },
}

const DATA: Record<string, Row[]> = {
  instruments,
  bots,
  bot_notifications: notifications,
  users,
  price_events: priceEvents,
  alerts: [],
}

const TABLES: TableMeta[] = [instrumentsMeta, botsMeta, notificationsMeta, usersMeta, priceEventsMeta, alertsMeta]

const CURRENT_USER: User = { email: 'admin@example.com', role: 'admin' }

const NAV: Meta['nav'] = [
  { label: 'Trading', icon: 'bot', tables: ['bots', 'bot_notifications', 'alerts'] },
  { label: 'Market data', icon: 'trending-up', tables: ['instruments', 'price_events'] },
  { label: 'Other', icon: '📦', tables: ['users'] },
]

const MARK_LOGO =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='20'%20height='20'%3E%3Crect%20width='20'%20height='20'%20rx='5'%20fill='%23FF8C00'/%3E%3Ctext%20x='10'%20y='15'%20font-family='system-ui'%20font-size='11'%20font-weight='800'%20text-anchor='middle'%20fill='%23111'%3E66%3C/text%3E%3C/svg%3E"

const META: Meta = {
  brand: 'Acme Admin',
  base_path: '/admin',
  tables: TABLES,
  nav: NAV,
  user: CURRENT_USER,
  has_dashboard: true,
  pages: [
    { id: 'ops/reconcile', slug: 'reconcile', label: 'Reconciliation', module: 'reconcile.js', group: 'Ops', icon: 'scale' },
  ],
  locale: 'es',
  strings: null,
  brand_logo: null,
  theme: {
    preset: 'steward',
    mode: 'auto',
    logo_light: MARK_LOGO,
    logo_dark: MARK_LOGO,
    light: {
      band: 'hsl(220 30% 7%)',
      'band-ink': 'hsl(210 20% 92%)',
      'band-border': 'hsl(33 100% 50% / 0.22)',
      accent: 'hsl(33 100% 50%)',
      'accent-btn': 'hsl(33 100% 50%)',
      'accent-btn-ink': 'hsl(220 30% 7%)',
    },
    dark: {
      band: 'hsl(220 38% 4%)',
      'band-ink': 'hsl(210 20% 92%)',
      'band-border': 'hsl(33 100% 50% / 0.22)',
      accent: 'hsl(33 100% 50%)',
      'accent-btn': 'hsl(33 100% 50%)',
      'accent-btn-ink': 'hsl(220 30% 7%)',
    },
  },
  roles: ['admin', 'analyst', 'viewer', 'support'],
  can_manage_access: true,
}

const auditRows: AuditRow[] = Array.from({ length: 41 }, (_, i) => {
  const kinds = ['update', 'update', 'create', 'delete', 'action:halt', 'login'] as const
  const action = kinds[i % kinds.length]
  const table = action === 'login' ? '' : i % 2 === 0 ? 'bots' : 'instruments'
  const changes: Record<string, { from: unknown; to: unknown }> | null =
    action === 'update'
      ? i % 4 === 0
        ? { active: { from: true, to: false }, status: { from: 'live', to: 'halted' } }
        : { leverage: { from: 1, to: 2 } }
      : action === 'create'
        ? { name: { from: null, to: 'grid-atr' } }
        : null
  return {
    id: 41 - i,
    ts: iso(i * 7 * HOUR + rnd() * HOUR),
    actor: i % 5 === 0 ? 'ops@example.com' : 'admin@example.com',
    table_name: table,
    pk: table === 'bots' ? String(bots[i % bots.length].id).slice(0, 8) : String(1 + (i % 40)),
    action,
    changes,
  }
})

function makeDashboard(): DashboardResponse {
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    t: iso((23 - i) * HOUR),
    v: Math.floor(6 + Math.sin(i / 2.4) * 5 + rnd() * 6),
  }))
  const daily = Array.from({ length: 14 }, (_, i) => ({
    t: iso((13 - i) * DAY),
    v: Math.floor(20 + Math.sin(i / 1.8) * 12 + rnd() * 10),
  }))
  const monthly = Array.from({ length: 30 }, (_, i) => ({
    t: iso((29 - i) * DAY),
    v: Math.floor(140 + i * 4 + Math.sin(i / 3) * 22 + rnd() * 14),
  }))
  const errors = notifications.filter((n) => n.http_status === 500).slice(0, 6)
  const spark = (base: number, amp: number) =>
    Array.from({ length: 16 }, (_, i) => Math.round(base + Math.sin(i / 2.2) * amp + rnd() * amp * 0.4))
  const seriesFor = (base: number, drift: number) =>
    Array.from({ length: 14 }, (_, i) => ({
      t: iso((13 - i) * DAY),
      v: Math.round(base + i * drift + Math.sin(i / 1.7) * 8 + rnd() * 6),
    }))
  const resp: DashboardResponse = {
    widgets: [
      {
        id: 'w0',
        type: 'stat',
        label: 'Bots activos',
        value: bots.filter((b) => b.active).length,
        format: 'number',
        compare: { value: 5, label: '24h' },
        alert: null,
        spark: spark(8, 3),
      },
      {
        id: 'w1',
        type: 'stat',
        label: 'Errores 24h',
        value: 3,
        format: 'number',
        compare: { value: 1, label: 'ayer' },
        alert: 'warn',
        spark: spark(4, 3),
        good_when: 'down',
      },
      {
        id: 'w2',
        type: 'stat',
        label: 'Equity total',
        value: bots.reduce((a, b) => a + (b.equity as number), 0),
        format: 'money',
        currency: 'USD',
        compare: { value: 161200, label: '7d' },
        alert: null,
        spark: spark(160000, 12000),
      },
      {
        id: 'w3',
        type: 'stat',
        label: 'Uptime feed',
        value: 99.97,
        format: 'percent',
        compare: { value: 99.91, label: '7d' },
        alert: null,
        spark: spark(99, 1),
      },
      {
        id: 'w4',
        type: 'stat',
        label: 'Latencia media eval',
        value: 4.2,
        format: 'duration',
        compare: { value: 6.8, label: '7d' },
        alert: 'critical',
        spark: spark(5, 2),
        good_when: 'down',
      },
      { id: 'w5', type: 'chart', label: 'Notificaciones / hora', kind: 'line', points: hourly, format: 'number' },
      { id: 'w6', type: 'chart', label: 'Backtests / día', kind: 'bar', points: daily, format: 'number' },
      {
        id: 'w7',
        type: 'chart',
        label: 'Señales por estrategia',
        kind: 'line',
        points: seriesFor(30, 2),
        series: [
          { label: 'grid', points: seriesFor(30, 2) },
          { label: 'trend', points: seriesFor(20, 3) },
          { label: 'renko', points: seriesFor(14, 1) },
        ],
        format: 'number',
        w: 2,
      },
      { id: 'w8', type: 'chart', label: 'Usuarios activos 30d', kind: 'area', points: monthly, format: 'number', w: 2 },
      {
        id: 'w9',
        type: 'table',
        label: 'Últimos errores',
        link: 'bot_notifications',
        columns: ['bot_id', 'title', 'http_status', 'sent_at'],
        rows: errors,
        pk: 'id',
        w: 2,
      },
      { id: 'w10', type: 'iframe', label: 'Grafana', url: 'https://example.com/grafana', w: 2, h: 2 },
    ],
  }
  const CATS: Record<string, string> = {
    w0: 'Resumen', w1: 'Resumen', w2: 'Resumen', w3: 'Resumen', w4: 'Resumen',
    w5: 'Actividad', w6: 'Actividad', w7: 'Actividad', w8: 'Actividad',
    w9: 'Detalle', w10: 'Detalle',
  }
  for (const w of resp.widgets) w.category = CATS[w.id]
  return resp
}

function tableMeta(name: string): TableMeta {
  const t = TABLES.find((t) => t.name === name)
  if (!t) throw new ApiError(404, `tabla desconocida: ${name}`)
  return t
}

const configModelStore: Record<string, TableConfigData> = {}
const configHclStore: Record<string, string> = {}

function isHclObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function hclScalar(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  return JSON.stringify(v)
}

function hclValue(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map((x) => (isHclObj(x) ? `{ ${hclInline(x)} }` : hclScalar(x))).join(', ')}]`
  }
  if (isHclObj(v)) return `{ ${hclInline(v)} }`
  return hclScalar(v)
}

function hclInline(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, val]) => val !== undefined)
    .map(([k, val]) => `${k} = ${hclValue(val)}`)
    .join(', ')
}

function renderHclBlock(o: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = []
  for (const [k, val] of Object.entries(o)) {
    if (val === undefined || val === null) continue
    if (Array.isArray(val)) {
      lines.push(`${indent}${k} = ${hclValue(val)}`)
    } else if (isHclObj(val)) {
      lines.push(`${indent}${k} {`)
      lines.push(...renderHclBlock(val, `${indent}  `))
      lines.push(`${indent}}`)
    } else {
      lines.push(`${indent}${k} = ${hclScalar(val)}`)
    }
  }
  return lines
}

function renderMockHcl(model: TableConfigData): string {
  const body = renderHclBlock(model as Record<string, unknown>, '').join('\n')
  return body ? `${body}\n` : ''
}

interface ConfigVersionRow {
  id: number
  actor: string
  note: string | null
  created_at: string
  model: TableConfigData
  hcl: string
  published: boolean
}

const configVersions: Record<string, ConfigVersionRow[]> = {}
let nextConfigVersionId = 1

const byteLen = (s: string): number => new TextEncoder().encode(s).length

function seedConfig(name: string): { model: TableConfigData; hcl: string } {
  const meta = tableMeta(name)
  const model = modelToApi(modelFromMeta(meta))
  const hcl = renderMockHcl(model)
  configModelStore[name] = model
  configHclStore[name] = hcl
  return { model, hcl }
}

function ensureVersions(name: string): ConfigVersionRow[] {
  const existing = configVersions[name]
  if (existing) return existing
  const base = configModelStore[name]
    ? { model: configModelStore[name], hcl: configHclStore[name] }
    : seedConfig(name)
  const olderModel = modelToApi({ ...base.model, list: { ...base.model.list, per_page: 25 } })
  const rows: ConfigVersionRow[] = [
    {
      id: nextConfigVersionId++,
      actor: 'ops@example.com',
      note: 'ajuste de columnas',
      created_at: iso(9 * DAY),
      model: olderModel,
      hcl: renderMockHcl(olderModel),
      published: false,
    },
    {
      id: nextConfigVersionId++,
      actor: CURRENT_USER.email,
      note: null,
      created_at: iso(2 * HOUR),
      model: base.model,
      hcl: base.hcl,
      published: true,
    },
  ].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  configVersions[name] = rows
  return rows
}

function getConfig(name: string): {
  table: string
  hcl: string
  model: TableConfigData
  writable: boolean
} {
  tableMeta(name)
  const seeded = configModelStore[name] ? undefined : seedConfig(name)
  const model = configModelStore[name] ?? seeded!.model
  const hcl = configHclStore[name] ?? seeded!.hcl
  return { table: name, hcl, model, writable: true }
}

function appendPublishedVersion(name: string, model: TableConfigData, hcl: string) {
  const rows = ensureVersions(name)
  for (const v of rows) v.published = false
  rows.unshift({
    id: nextConfigVersionId++,
    actor: CURRENT_USER.email,
    note: null,
    created_at: new Date().toISOString(),
    model,
    hcl,
    published: true,
  })
}

function putConfig(name: string, body: Record<string, unknown>): { ok: true; reloaded: true } {
  const group = typeof body.group === 'string' ? body.group : undefined
  if (unconfiguredTables.some((u) => u.name === name)) {
    adoptUnconfigured(name, group)
    pushAudit('config:create', name, name, null)
    return { ok: true, reloaded: true }
  }
  tableMeta(name)
  let model: TableConfigData
  let hcl: string
  if (typeof body.hcl === 'string') {
    hcl = body.hcl
    if (!hcl.trim()) throw new ApiError(400, 'HCL vacío')
    model = configModelStore[name] ?? getConfig(name).model
  } else if (isHclObj(body.model)) {
    model = modelToApi(body.model as TableConfigData)
    hcl = renderMockHcl(model)
  } else {
    throw new ApiError(400, 'se esperaba { model } o { hcl }')
  }
  configModelStore[name] = model
  configHclStore[name] = hcl
  appendPublishedVersion(name, model, hcl)
  pushAudit('config:update', name, name, null)
  return { ok: true, reloaded: true }
}

function configVersionsList(name: string) {
  const rows = ensureVersions(name)
  return {
    versions: rows.map((v) => ({
      id: v.id,
      actor: v.actor,
      note: v.note,
      created_at: v.created_at,
      published: v.published,
      bytes: byteLen(v.hcl),
    })),
  }
}

function configVersionBody(name: string, id: number): { hcl: string } {
  const rows = ensureVersions(name)
  const v = rows.find((r) => r.id === id)
  if (!v) throw new ApiError(404, 'versión no encontrada')
  return { hcl: v.hcl }
}

function publishConfigVersion(name: string, id: number) {
  const rows = ensureVersions(name)
  const v = rows.find((r) => r.id === id)
  if (!v) throw new ApiError(404, 'versión no encontrada')
  for (const r of rows) r.published = false
  v.published = true
  configModelStore[name] = v.model
  configHclStore[name] = v.hcl
  pushAudit('config:publish', name, String(id), null)
  return { ok: true, reloaded: true }
}

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b))
}

function withinDate(value: unknown, spec: string): boolean {
  if (typeof value !== 'string') return false
  const ts = Date.parse(value)
  if (Number.isNaN(ts)) return false
  if (spec === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return ts >= d.getTime()
  }
  const preset = /^(\d+)d$/.exec(spec)
  if (preset) return ts >= now - Number(preset[1]) * DAY
  const range = /^(.+)\.\.(.+)$/.exec(spec)
  if (range) {
    const from = Date.parse(range[1])
    const to = Date.parse(range[2])
    return (Number.isNaN(from) || ts >= from) && (Number.isNaN(to) || ts <= to + DAY)
  }
  return true
}

function applyCustomFilter(table: string, name: string, rows: Row[]): Row[] {
  if (table === 'instruments' && name === 'stale') {
    return rows.filter((r) => now - Date.parse(String(r.last_price_at)) > HOUR)
  }
  return rows
}

const OP_SUFFIXES = ['ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'between', 'isnull']

function parseFilterKey(key: string): { col: string; op: string } {
  const rest = key.slice(2)
  const idx = rest.lastIndexOf('__')
  if (idx > 0) {
    const op = rest.slice(idx + 2)
    if (OP_SUFFIXES.includes(op)) return { col: rest.slice(0, idx), op }
  }
  return { col: rest, op: 'eq' }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Date.parse(String(v)) || Number(v)
}

function applyOp(rows: Row[], col: string, op: string, value: string): Row[] {
  switch (op) {
    case 'ne':
      return rows.filter((r) => String(r[col]) !== value)
    case 'contains':
      return rows.filter((r) => String(r[col] ?? '').toLowerCase().includes(value.toLowerCase()))
    case 'in': {
      const set = value.split(',').map((s) => s.trim())
      return rows.filter((r) => set.includes(String(r[col])))
    }
    case 'gt':
      return rows.filter((r) => num(r[col]) > num(value))
    case 'gte':
      return rows.filter((r) => num(r[col]) >= num(value))
    case 'lt':
      return rows.filter((r) => num(r[col]) < num(value))
    case 'lte':
      return rows.filter((r) => num(r[col]) <= num(value))
    case 'between': {
      const [a, b] = value.split('..')
      return rows.filter((r) => num(r[col]) >= num(a) && num(r[col]) <= num(b))
    }
    case 'isnull':
      return rows.filter((r) => (value === '0' ? r[col] != null : r[col] == null))
    default:
      return rows.filter((r) => String(r[col]) === value)
  }
}

function computedValue(table: string, name: string, row: Row): unknown {
  if (table === 'instruments' && name === 'age_days') {
    const created = Date.parse(String(row.created_at))
    if (Number.isNaN(created)) return null
    return Math.floor((now - created) / DAY)
  }
  return null
}

function foldComputed(name: string, rows: Row[]): Row[] {
  const meta = tableMeta(name)
  const computed = meta.columns.filter((c) => c.computed)
  if (computed.length === 0) return rows
  return rows.map((r) => {
    const out = { ...r }
    for (const c of computed) out[c.name] = computedValue(name, c.name, r)
    return out
  })
}

function filterRows(name: string, sp: URLSearchParams): Row[] {
  const meta = tableMeta(name)
  let rows = [...DATA[name]]

  const q = (sp.get('q') ?? '').trim().toLowerCase()
  if (q) {
    rows = rows.filter((r) =>
      meta.list.search.some((c) => String(r[c] ?? '').toLowerCase().includes(q)),
    )
  }

  for (const [key, value] of sp.entries()) {
    if (!key.startsWith('f_')) continue
    const { col: colName, op } = parseFilterKey(key)
    const filter = meta.list.filters.find((f) => f.name === colName)
    if (op === 'eq') {
      if (filter?.type === 'custom') {
        if (value === '1') rows = applyCustomFilter(name, colName, rows)
        continue
      }
      if (filter?.type === 'date') {
        rows = rows.filter((r) => withinDate(r[colName], value))
        continue
      }
      if (value === '__null__') {
        rows = rows.filter((r) => r[colName] == null)
        continue
      }
      if (filter?.type === 'bool') {
        rows = rows.filter((r) => Boolean(r[colName]) === (value === 'true'))
        continue
      }
      rows = rows.filter((r) => String(r[colName]) === value)
      continue
    }
    rows = applyOp(rows, colName, op, value)
  }

  const sortSpec = sp.get('sort') || meta.list.default_sort
  const cols = sortSpec.split(',').filter(Boolean)
  rows.sort((a, b) => {
    for (const s of cols) {
      const desc = s.startsWith('-')
      const c = desc ? s.slice(1) : s
      const r = (desc ? -1 : 1) * cmp(a[c], b[c])
      if (r !== 0) return r
    }
    return 0
  })
  return rows
}

const APPROX_THRESHOLD = 10000

function listRows(name: string, sp: URLSearchParams): ListResponse {
  const meta = tableMeta(name)
  const rows = filterRows(name, sp)
  const page = Math.max(1, Number(sp.get('page') ?? 1))
  const pp = Math.max(1, Number(sp.get('pp') ?? meta.list.per_page))
  const start = (page - 1) * pp
  const approx = rows.length > APPROX_THRESHOLD
  const total = approx ? Math.round(rows.length / 1000) * 1000 : rows.length
  return { rows: foldComputed(name, rows.slice(start, start + pp)), total, page, pp, approx }
}

function findRow(name: string, pk: string): Row {
  const meta = tableMeta(name)
  const row = DATA[name].find((r) => String(r[meta.pk]) === pk)
  if (!row) throw new ApiError(404, 'fila no encontrada')
  return row
}

function rowDetail(name: string, pk: string): RowResponse {
  const meta = tableMeta(name)
  const row = findRow(name, pk)
  const inlines = meta.inlines.map((inl) => {
    const rows = DATA[inl.table].filter((r) => String(r[inl.fk_col]) === String(row[meta.pk]))
    return { ...inl, rows: foldComputed(inl.table, rows.slice(0, 50)), total: rows.length }
  })
  return { row: foldComputed(name, [row])[0], inlines }
}

function inlinePage(name: string, pk: string, child: string, page: number): InlinePageResponse {
  const meta = tableMeta(name)
  const inl = meta.inlines.find((i) => i.table === child)
  if (!inl) throw new ApiError(404, `${child} no es un inline de ${name}`)
  const row = findRow(name, pk)
  const all = DATA[child].filter((r) => String(r[inl.fk_col]) === String(row[meta.pk]))
  const cap = 50
  const start = (page - 1) * cap
  return { ...inl, rows: foldComputed(child, all.slice(start, start + cap)), total: all.length, page, cap }
}

function patchRow(name: string, pk: string, set: Row): { row: Row } {
  const meta = tableMeta(name)
  if (meta.read_only || !meta.perms.write) throw new ApiError(403, 'tabla de solo lectura')
  const row = findRow(name, pk)
  for (const [k, v] of Object.entries(set)) {
    const colMeta = meta.columns.find((c) => c.name === k)
    if (!colMeta) throw new ApiError(400, `columna desconocida: ${k}`)
    if (colMeta.readonly || colMeta.masked) throw new ApiError(400, `columna de solo lectura: ${k}`)
    row[k] = v
  }
  pushAudit('update', name, pk, set)
  return { row }
}

function createRow(name: string, set: Row): { row: Row } {
  const meta = tableMeta(name)
  if (!meta.perms.create) throw new ApiError(403, 'sin permiso de creación')
  const rows = DATA[name]
  const pkVal =
    meta.columns.find((c) => c.name === meta.pk)?.kind === 'uuid'
      ? uuid()
      : rows.reduce((m, r) => Math.max(m, Number(r[meta.pk]) || 0), 0) + 1
  const row: Row = { [meta.pk]: pkVal, created_at: new Date().toISOString() }
  for (const c of meta.columns) {
    if (c.name in set && !c.readonly && !c.masked) row[c.name] = set[c.name]
  }
  rows.unshift(row)
  pushAudit('create', name, String(pkVal), set)
  return { row }
}

function pushAudit(action: string, table: string, pk: string, set: Row | null) {
  auditRows.unshift({
    id: (auditRows[0]?.id ?? 0) + 1,
    ts: new Date().toISOString(),
    actor: CURRENT_USER.email,
    table_name: table,
    pk,
    action,
    changes: set
      ? Object.fromEntries(Object.entries(set).map(([k, v]) => [k, { from: '…', to: v }]))
      : null,
  })
}

function runAction(name: string, action: string, pks: Array<string | number>): ActionResult {
  const meta = tableMeta(name)
  if (!meta.perms.actions.includes(action)) throw new ApiError(403, 'acción no permitida')
  const rows = DATA[name].filter((r) => pks.map(String).includes(String(r[meta.pk])))
  for (const r of rows) {
    if (name === 'instruments' && action === 'deactivate') r.active = false
    if (name === 'bots' && action === 'halt') {
      r.status = 'halted'
      r.active = false
    }
    if (name === 'bots' && action === 'restart') {
      r.status = 'live'
      r.active = true
    }
    if (name === 'price_events' && action === 'mark_ok') r.ok = true
  }
  pushAudit(`action:${action}`, name, pks.join(','), null)
  return { affected: rows.length }
}

function bulkUpdate(name: string, pks: Array<string | number>, set: Row): { affected: number } {
  const meta = tableMeta(name)
  if (meta.read_only || !meta.perms.write) throw new ApiError(403, 'tabla de solo lectura')
  for (const [k] of Object.entries(set)) {
    const colMeta = meta.columns.find((c) => c.name === k)
    if (!colMeta) throw new ApiError(400, `columna desconocida: ${k}`)
    if (colMeta.readonly || colMeta.masked || colMeta.computed) throw new ApiError(400, `columna de solo lectura: ${k}`)
  }
  const wanted = new Set(pks.map(String))
  const rows = DATA[name].filter((r) => wanted.has(String(r[meta.pk])))
  for (const r of rows) Object.assign(r, set)
  pushAudit('bulk_update', name, pks.join(','), set)
  return { affected: rows.length }
}

function importRows(
  name: string,
  format: string,
  data: string,
  mode: string,
): { inserted: number; updated: number; skipped: number; errors: Array<{ row: number; message: string }> } {
  const meta = tableMeta(name)
  if (meta.read_only || !meta.perms.create) throw new ApiError(403, 'sin permiso de creación')
  let parsed: Row[]
  const errors: Array<{ row: number; message: string }> = []
  if (format === 'json') {
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch (e) {
      throw new ApiError(400, e instanceof Error ? e.message : 'JSON inválido')
    }
    parsed = (Array.isArray(raw) ? raw : [raw]).filter(
      (r): r is Row => r != null && typeof r === 'object' && !Array.isArray(r),
    )
  } else {
    const text = data.replace(/\r\n?/g, '\n').trim()
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    const headers = (lines[0] ?? '').split(',').map((h) => h.trim())
    parsed = lines.slice(1).map((line) => {
      const cells = line.split(',')
      const r: Row = {}
      headers.forEach((h, i) => {
        const v = (cells[i] ?? '').trim()
        r[h] = v === '' ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v
      })
      return r
    })
  }
  let inserted = 0
  let updated = 0
  let skipped = 0
  parsed.forEach((incoming, i) => {
    const pkVal = incoming[meta.pk]
    const existing = pkVal != null ? DATA[name].find((r) => String(r[meta.pk]) === String(pkVal)) : undefined
    if (existing) {
      if (mode === 'upsert') {
        Object.assign(existing, incoming)
        updated++
      } else {
        errors.push({ row: i + 1, message: `pk ${String(pkVal)} ya existe` })
        skipped++
      }
      return
    }
    const nextPk =
      pkVal != null
        ? pkVal
        : meta.columns.find((c) => c.name === meta.pk)?.kind === 'uuid'
          ? uuid()
          : DATA[name].reduce((m, r) => Math.max(m, Number(r[meta.pk]) || 0), 0) + 1
    DATA[name].unshift({ ...incoming, [meta.pk]: nextPk })
    inserted++
  })
  pushAudit('import', name, '', null)
  return { inserted, updated, skipped, errors }
}

function optionsFor(name: string, colName: string, q: string): OptionItem[] {
  const meta = tableMeta(name)
  const colMeta = meta.columns.find((c) => c.name === colName)
  if (!colMeta?.fk) throw new ApiError(400, 'columna sin FK')
  const target = tableMeta(colMeta.fk.table)
  const lq = q.toLowerCase()
  return DATA[colMeta.fk.table]
    .filter((r) => !lq || String(r[colMeta.fk!.label_col] ?? '').toLowerCase().includes(lq))
    .slice(0, 20)
    .map((r) => ({
      value: r[target.pk] as string | number,
      label:
        colMeta.fk!.table === 'instruments'
          ? `${r.symbol as string} · ${r.exchange as string}`
          : String(r[colMeta.fk!.label_col] ?? r[target.pk]),
    }))
}

function auditList(sp: URLSearchParams) {
  let rows = [...auditRows]
  const table = sp.get('table')
  if (table) rows = rows.filter((r) => r.table_name === table)
  const page = Math.max(1, Number(sp.get('page') ?? 1))
  const pp = Math.max(1, Number(sp.get('pp') ?? 50))
  return { rows: rows.slice((page - 1) * pp, page * pp), total: rows.length }
}

function rowAudit(table: string, pk: string) {
  const rows = auditRows
    .filter((r) => r.table_name === table && (r.pk === pk || pk.startsWith(r.pk)))
    .slice(0, 200)
  return { rows, total: rows.length }
}

function fillTitle(template: string, row: Row): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(row[k] ?? ''))
}

function search(q: string) {
  const query = q.trim().toLowerCase()
  const results: Array<{ table: string; label: string; pk: string; title: string; sub?: string | null }> = []
  if (!query) return { results }
  for (const meta of TABLES) {
    if (!meta.perms.read) continue
    const hits = (DATA[meta.name] ?? [])
      .filter((r) => meta.list.search.some((c) => String(r[c] ?? '').toLowerCase().includes(query)))
      .slice(0, 5)
    for (const r of hits) {
      results.push({
        table: meta.name,
        label: meta.label,
        pk: String(r[meta.pk]),
        title: fillTitle(meta.display_title, r) || String(r[meta.pk]),
        sub: meta.group,
      })
    }
    if (results.length >= 40) break
  }
  return { results: results.slice(0, 40) }
}

interface ViewRow {
  id: number
  owner_email: string
  table_name: string
  name: string
  query: string
  shared: boolean
  created_at: string
  own: boolean
}

const savedViews: ViewRow[] = [
  {
    id: 1,
    owner_email: CURRENT_USER.email,
    table_name: 'bots',
    name: 'Live only',
    query: 'f_status=live&sort=-equity',
    shared: false,
    created_at: iso(2 * DAY),
    own: true,
  },
  {
    id: 2,
    owner_email: 'ops@example.com',
    table_name: 'bots',
    name: 'Halted (shared)',
    query: 'f_status=halted',
    shared: true,
    created_at: iso(5 * DAY),
    own: false,
  },
]
let nextViewId = 3

function listViews(sp: URLSearchParams) {
  const table = sp.get('table')
  const rows = savedViews.filter(
    (v) => (v.own || v.shared) && (!table || v.table_name === table),
  )
  return { rows }
}

function createView(b: Record<string, unknown>) {
  const id = nextViewId++
  savedViews.push({
    id,
    owner_email: CURRENT_USER.email,
    table_name: String(b.table),
    name: String(b.name),
    query: String(b.query),
    shared: Boolean(b.shared),
    created_at: new Date().toISOString(),
    own: true,
  })
  pushAudit('view.create', String(b.table), String(id), null)
  return { id }
}

function deleteView(id: number) {
  const idx = savedViews.findIndex((v) => v.id === id)
  if (idx >= 0) savedViews.splice(idx, 1)
  return {}
}

function csvCell(v: unknown): string {
  let s: string
  if (v === null || v === undefined) s = ''
  else if (typeof v === 'object') {
    if ('__bytes__' in (v as object)) s = `<${(v as { __bytes__: number }).__bytes__} bytes>`
    else s = JSON.stringify(v)
  } else s = String(v)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function mockExport(
  table: string,
  format: string,
  qs: string,
): { body: string; filename: string; mime: string } {
  const meta = tableMeta(table)
  const sp = new URLSearchParams(qs)
  const rows = foldComputed(table, filterRows(table, sp).slice(0, 100000))
  const cols = meta.list.columns
  if (format === 'json') {
    return {
      body: JSON.stringify(rows, null, 2),
      filename: `${table}.json`,
      mime: 'application/json',
    }
  }
  const lines = [cols.join(',')]
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','))
  return { body: lines.join('\n'), filename: `${table}.csv`, mime: 'text/csv' }
}

const ACCESS_TABLES = TABLES.map((t) => t.name)
const ACCESS_ACTIONS = TABLES.flatMap((t) => t.actions.map((a) => `${t.name}.${a.name}`))

interface DbRole {
  name: string
  source: RoleSource
  editable: boolean
  definition: RoleDefinition | null
  created_at?: string
}

const roleStore: DbRole[] = [
  { name: 'admin', source: 'builtin', editable: false, definition: null },
  {
    name: 'analyst',
    source: 'config',
    editable: true,
    definition: { tables: { bots: 'read', instruments: 'read' }, actions: [], masked: {}, row_filter: {} },
  },
  {
    name: 'viewer',
    source: 'config',
    editable: true,
    definition: { tables: { '*': 'read' }, actions: [], masked: {}, row_filter: {} },
  },
  {
    name: 'support',
    source: 'config',
    editable: true,
    created_at: iso(30 * DAY),
    definition: {
      tables: { bots: 'write', instruments: 'read' },
      actions: ['bots.halt'],
      masked: { bots: ['api_key'] },
      row_filter: { bots: 'owner_email = {actor.email}' },
    },
  },
]

const accessUsers: AccessUser[] = [
  { id: 1, email: 'admin@example.com', role: 'admin', created_at: iso(500 * DAY) },
  { id: 2, email: 'ops@example.com', role: 'admin', created_at: iso(300 * DAY) },
  { id: 3, email: 'ana@example.com', role: 'analyst', created_at: iso(120 * DAY) },
  { id: 4, email: 'sup@example.com', role: 'support', created_at: iso(60 * DAY) },
]
let nextAccessUserId = 5

const effectiveRoleNames = () => roleStore.map((r) => r.name)

function listAccessUsers(): AccessUser[] {
  return accessUsers.map((u) => ({ ...u }))
}

function adminCount(): number {
  return accessUsers.filter((u) => u.role === 'admin').length
}

function createAccessUser(b: Record<string, unknown>): AccessUser {
  const email = String(b.email ?? '').trim().toLowerCase()
  const password = String(b.password ?? '')
  const role = String(b.role ?? '')
  if (!email) throw new ApiError(400, 'email is required')
  if (password.length < 8) throw new ApiError(400, 'password too short')
  if (!effectiveRoleNames().includes(role)) throw new ApiError(400, `unknown role: ${role}`)
  if (accessUsers.some((u) => u.email === email)) throw new ApiError(409, 'email already exists')
  const user: AccessUser = { id: nextAccessUserId++, email, role, created_at: new Date().toISOString() }
  accessUsers.push(user)
  pushAudit('user:create', 'users', String(user.id), { email, role })
  return { ...user }
}

function updateAccessUser(id: number, b: Record<string, unknown>): AccessUser {
  const user = accessUsers.find((u) => u.id === id)
  if (!user) throw new ApiError(404, 'user not found')
  if ('password' in b && b.password != null) {
    if (String(b.password).length < 8) throw new ApiError(400, 'password too short')
  }
  if ('role' in b && b.role != null && b.role !== user.role) {
    const role = String(b.role)
    if (!effectiveRoleNames().includes(role)) throw new ApiError(400, `unknown role: ${role}`)
    if (user.role === 'admin' && role !== 'admin' && adminCount() <= 1) {
      throw new ApiError(400, 'no puedes quitar el último admin')
    }
    user.role = role
  }
  pushAudit('user:update', 'users', String(id), { role: user.role, password: 'password' in b ? 'reset' : undefined })
  return { ...user }
}

function deleteAccessUser(id: number): Record<string, never> {
  const idx = accessUsers.findIndex((u) => u.id === id)
  if (idx < 0) throw new ApiError(404, 'user not found')
  if (accessUsers[idx].role === 'admin' && adminCount() <= 1) {
    throw new ApiError(400, 'no puedes quitar el último admin')
  }
  accessUsers.splice(idx, 1)
  pushAudit('user:delete', 'users', String(id), null)
  return {}
}

function rolesResponse(): RolesResponse {
  const roles: RoleInfo[] = roleStore.map((r) => ({
    name: r.name,
    source: r.source,
    editable: r.editable,
    definition: r.definition,
    created_at: r.created_at,
    user_count: accessUsers.filter((u) => u.role === r.name).length,
  }))
  return { roles, tables: ACCESS_TABLES, actions: ACCESS_ACTIONS }
}

const ROLE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

function validateRoleDefinition(def: RoleDefinition): void {
  const known = new Set(ACCESS_TABLES)
  for (const [tbl, level] of Object.entries(def.tables ?? {})) {
    if (tbl !== '*' && !known.has(tbl)) throw new ApiError(400, `unknown table: ${tbl}`)
    if (level !== 'read' && level !== 'write') throw new ApiError(400, `invalid level: ${level}`)
  }
  for (const a of def.actions ?? []) {
    if (!ACCESS_ACTIONS.includes(a)) throw new ApiError(400, `unknown action: ${a}`)
  }
  for (const tbl of Object.keys(def.masked ?? {})) {
    if (!known.has(tbl)) throw new ApiError(400, `unknown table: ${tbl}`)
  }
  for (const tbl of Object.keys(def.row_filter ?? {})) {
    if (!known.has(tbl)) throw new ApiError(400, `unknown table: ${tbl}`)
  }
}

function createRole(b: Record<string, unknown>): RoleWrite {
  const name = String(b.name ?? '').trim()
  if (!ROLE_NAME_RE.test(name)) throw new ApiError(400, 'invalid role name')
  if (roleStore.some((r) => r.name === name)) throw new ApiError(409, `role '${name}' already exists`)
  const definition = (b.definition ?? {}) as RoleDefinition
  validateRoleDefinition(definition)
  roleStore.push({ name, source: 'config', editable: true, definition, created_at: new Date().toISOString() })
  pushAudit('role:create', 'roles', name, null)
  return { ok: true, reloaded: true }
}

function updateRole(name: string, b: Record<string, unknown>): RoleWrite {
  const role = roleStore.find((r) => r.name === name)
  if (!role) throw new ApiError(404, 'role not found')
  if (!role.editable) throw new ApiError(403, `role '${name}' is not editable`)
  const definition = (b.definition ?? {}) as RoleDefinition
  validateRoleDefinition(definition)
  role.definition = definition
  pushAudit('role:update', 'roles', name, null)
  return { ok: true, reloaded: true }
}

function deleteRole(name: string): RoleWrite {
  const role = roleStore.find((r) => r.name === name)
  if (!role) throw new ApiError(404, 'role not found')
  if (!role.editable) throw new ApiError(403, `role '${name}' is not editable`)
  const holders = accessUsers.filter((u) => u.role === name)
  if (holders.length > 0) {
    throw new ApiError(
      409,
      `role '${name}' is assigned to ${holders.length} user(s): ${holders.map((u) => u.email).join(', ')} — reassign them first`,
    )
  }
  roleStore.splice(roleStore.indexOf(role), 1)
  pushAudit('role:delete', 'roles', name, null)
  return { ok: true, reloaded: true }
}

interface MockGroup {
  slug: string
  label: string
  icon: string | null
  order: number
  tables: string[]
}

const groupStore: MockGroup[] = [
  { slug: 'trading', label: 'Trading', icon: 'bot', order: 0, tables: ['bots', 'bot_notifications', 'alerts'] },
  { slug: 'market-data', label: 'Market data', icon: 'trending-up', order: 1, tables: ['instruments', 'price_events'] },
]
let ungroupedTables: string[] = ['users']

interface UnconfiguredTable {
  name: string
  schema: string
  is_view: boolean
  pk: string | null
  column_count: number
}
const unconfiguredTables: UnconfiguredTable[] = [
  { name: 'webhooks', schema: 'public', is_view: false, pk: 'id', column_count: 6 },
  { name: 'api_tokens', schema: 'public', is_view: false, pk: 'id', column_count: 5 },
  { name: 'active_bots', schema: 'public', is_view: true, pk: null, column_count: 9 },
]

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

function groupsLayout() {
  return {
    writable: true,
    groups: groupStore
      .slice()
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map((g) => ({ slug: g.slug, label: g.label, icon: g.icon, order: g.order, tables: [...g.tables] })),
    ungrouped: [...ungroupedTables],
    unconfigured: unconfiguredTables.map((t) => t.name),
  }
}

function createGroup(b: Record<string, unknown>) {
  const slug = String(b.slug ?? '').trim()
  const label = String(b.label ?? '').trim()
  if (!SLUG_RE.test(slug)) throw new ApiError(400, 'slug inválido')
  if (!label) throw new ApiError(400, 'la etiqueta es obligatoria')
  if (groupStore.some((g) => g.slug === slug)) throw new ApiError(409, `el grupo '${slug}' ya existe`)
  groupStore.push({
    slug,
    label,
    icon: b.icon != null ? String(b.icon) : null,
    order: typeof b.order === 'number' ? b.order : groupStore.length,
    tables: [],
  })
  pushAudit('group:create', 'config', slug, null)
  return { ok: true, reloaded: true }
}

function findGroup(slug: string): MockGroup {
  const g = groupStore.find((x) => x.slug === slug)
  if (!g) throw new ApiError(404, `grupo '${slug}' no encontrado`)
  return g
}

function patchGroup(slug: string, b: Record<string, unknown>) {
  const g = findGroup(slug)
  if ('label' in b && b.label != null) g.label = String(b.label)
  if ('icon' in b) g.icon = b.icon != null ? String(b.icon) : null
  if ('order' in b && typeof b.order === 'number') g.order = b.order
  if (Array.isArray(b.table_order)) {
    const wanted = b.table_order.map(String).filter((t) => g.tables.includes(t))
    g.tables = [...wanted, ...g.tables.filter((t) => !wanted.includes(t))]
  }
  pushAudit('group:update', 'config', slug, null)
  return { ok: true, reloaded: true }
}

function renameGroup(slug: string, to: string) {
  const g = findGroup(slug)
  const next = to.trim()
  if (!SLUG_RE.test(next)) throw new ApiError(400, 'slug inválido')
  if (next === slug) throw new ApiError(400, 'el nuevo slug es igual al actual')
  if (groupStore.some((x) => x.slug === next)) throw new ApiError(409, `el grupo '${next}' ya existe`)
  g.slug = next
  pushAudit('group:rename', 'config', next, null)
  return { ok: true, reloaded: true }
}

function deleteGroup(slug: string) {
  const g = findGroup(slug)
  if (g.tables.length > 0) {
    throw new ApiError(409, `el grupo '${slug}' no está vacío — reasigna sus tablas primero`)
  }
  groupStore.splice(groupStore.indexOf(g), 1)
  pushAudit('group:delete', 'config', slug, null)
  return { ok: true, reloaded: true }
}

function putGroupLayout(b: Record<string, unknown>) {
  const known = new Set<string>([...groupStore.flatMap((g) => g.tables), ...ungroupedTables])
  const layoutGroups = Array.isArray(b.groups) ? (b.groups as Array<Record<string, unknown>>) : []
  const placed = new Set<string>()
  for (const lg of layoutGroups) {
    const g = groupStore.find((x) => x.slug === String(lg.slug))
    if (!g) continue
    const tables = (Array.isArray(lg.tables) ? lg.tables.map(String) : []).filter((t) => known.has(t))
    g.tables = tables
    for (const t of tables) placed.add(t)
  }
  const ung = (Array.isArray(b.ungrouped) ? (b.ungrouped as unknown[]).map(String) : []).filter((t) => known.has(t))
  ungroupedTables = ung
  for (const t of ung) placed.add(t)
  pushAudit('group:layout', 'config', String(placed.size), null)
  return { ok: true, reloaded: true }
}

function discoverTables() {
  return { tables: unconfiguredTables.map((t) => ({ ...t })) }
}

function adoptUnconfigured(name: string, group: string | undefined) {
  const idx = unconfiguredTables.findIndex((t) => t.name === name)
  if (idx < 0) return
  unconfiguredTables.splice(idx, 1)
  if (group) {
    const g = groupStore.find((x) => x.slug === group)
    if (g) {
      if (!g.tables.includes(name)) g.tables.push(name)
      return
    }
  }
  if (!ungroupedTables.includes(name)) ungroupedTables.push(name)
}

const WIDGET_KINDS = ['stat', 'chart', 'table', 'iframe']

function validateWidget(w: Record<string, unknown>) {
  const kind = String(w.type ?? '')
  if (!WIDGET_KINDS.includes(kind)) throw new ApiError(400, `tipo de widget desconocido: ${kind}`)
  const label = String(w.label ?? '').trim()
  if (!label) throw new ApiError(400, 'el widget necesita una etiqueta')
  if (kind === 'iframe') {
    if (!String(w.url ?? '').trim()) throw new ApiError(400, `el widget '${label}' necesita url`)
  } else if (!String(w.sql ?? '').trim()) {
    throw new ApiError(400, `el widget '${label}' necesita sql`)
  }
}

function widgetsToHcl(widgets: Array<Record<string, unknown>>): string {
  const order = ['type', 'label', 'id', 'sql', 'compare_sql', 'compare_label', 'spark', 'good_when', 'chart', 'format', 'alert_above', 'alert_below', 'link', 'url', 'roles']
  const blocks = widgets.map((w) => {
    const lines = order
      .filter((k) => w[k] !== undefined && w[k] !== null && !(Array.isArray(w[k]) && (w[k] as unknown[]).length === 0))
      .map((k) => `  ${k} = ${hclValue(w[k])}`)
    return `widget {\n${lines.join('\n')}\n}`
  })
  return blocks.length ? `${blocks.join('\n\n')}\n` : ''
}

let dashboardWidgets: Array<Record<string, unknown>> = [
  { type: 'stat', label: 'Bots activos', sql: 'select count(*) from bots where active', format: 'number', compare_sql: 'select count(*) from bots', compare_label: 'total' },
  { type: 'stat', label: 'Errores 24h', sql: "select count(*) from bot_notifications where http_status >= 500", format: 'number', alert_above: 5 },
  { type: 'chart', label: 'Notificaciones / hora', sql: "select bucket as t, n as v from notif_hourly", chart: 'line', format: 'number' },
  { type: 'table', label: 'Últimos errores', sql: "select * from bot_notifications where http_status >= 500 limit 5", link: 'bot_notifications' },
  { type: 'iframe', label: 'Grafana', url: 'https://example.com/grafana' },
]

function dashboardConfig() {
  return { writable: true, widgets: dashboardWidgets.map((w) => ({ ...w })), hcl: widgetsToHcl(dashboardWidgets) }
}

interface DashVersionRow {
  id: number
  actor: string
  note: string | null
  created_at: string
  widgets: Array<Record<string, unknown>>
  hcl: string
  published: boolean
}
let nextDashVersionId = 1
const dashboardVersions: DashVersionRow[] = [
  {
    id: nextDashVersionId++,
    actor: 'ops@example.com',
    note: 'panel inicial',
    created_at: iso(6 * DAY),
    widgets: dashboardWidgets.slice(0, 3),
    hcl: widgetsToHcl(dashboardWidgets.slice(0, 3)),
    published: false,
  },
  {
    id: nextDashVersionId++,
    actor: CURRENT_USER.email,
    note: null,
    created_at: iso(3 * HOUR),
    widgets: dashboardWidgets,
    hcl: widgetsToHcl(dashboardWidgets),
    published: true,
  },
].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))

function putDashboardConfig(b: Record<string, unknown>) {
  const widgets = Array.isArray(b.widgets) ? (b.widgets as Array<Record<string, unknown>>) : []
  for (const w of widgets) validateWidget(w)
  dashboardWidgets = widgets.map((w) => ({ ...w }))
  const hcl = widgetsToHcl(dashboardWidgets)
  for (const v of dashboardVersions) v.published = false
  dashboardVersions.unshift({
    id: nextDashVersionId++,
    actor: CURRENT_USER.email,
    note: null,
    created_at: new Date().toISOString(),
    widgets: dashboardWidgets,
    hcl,
    published: true,
  })
  pushAudit('dashboard:update', 'config', 'dashboard', null)
  return { ok: true, reloaded: true }
}

function dashboardPreview(b: Record<string, unknown>) {
  const w = (b.widget ?? {}) as Record<string, unknown>
  validateWidget(w)
  const kind = String(w.type)
  const label = String(w.label)
  const fmt = (w.format as string | undefined) ?? 'number'
  if (kind === 'iframe') {
    return { widget: { id: 'preview', type: 'iframe', label, url: String(w.url) } }
  }
  if (kind === 'stat') {
    const value = Math.round(rnd() * 1000)
    const compare = w.compare_sql
      ? { value: Math.round(value * (0.7 + rnd() * 0.5)), label: String(w.compare_label ?? 'prev') }
      : null
    const above = typeof w.alert_above === 'number' ? (w.alert_above as number) : undefined
    const below = typeof w.alert_below === 'number' ? (w.alert_below as number) : undefined
    const alert = above != null && value > above ? 'critical' : below != null && value < below ? 'critical' : null
    const spark = w.spark
      ? Array.from({ length: 16 }, (_, i) => Math.round(value * (0.8 + Math.sin(i / 2.2) * 0.15 + rnd() * 0.1)))
      : undefined
    const good_when = w.good_when === 'down' ? 'down' : 'up'
    return { widget: { id: 'preview', type: 'stat', label, value, format: fmt, compare, alert, spark, good_when } }
  }
  if (kind === 'chart') {
    const points = Array.from({ length: 16 }, (_, i) => ({
      t: iso((15 - i) * HOUR),
      v: Math.round(20 + Math.sin(i / 2.2) * 10 + rnd() * 8),
    }))
    return { widget: { id: 'preview', type: 'chart', label, kind: (w.chart as string) ?? 'line', points, format: fmt } }
  }
  const link = String(w.link ?? 'bots')
  const src = (DATA[link] ?? bots).slice(0, 5)
  const columns = src.length ? Object.keys(src[0]).slice(0, 4) : []
  const pk = tableMeta(DATA[link] ? link : 'bots').pk
  return { widget: { id: 'preview', type: 'table', label, link, columns, rows: src, pk } }
}

function dashboardVersionsList() {
  return {
    versions: dashboardVersions.map((v) => ({
      id: v.id,
      actor: v.actor,
      note: v.note,
      created_at: v.created_at,
      published: v.published,
      bytes: byteLen(v.hcl),
    })),
  }
}

function dashboardVersionBody(id: number) {
  const v = dashboardVersions.find((r) => r.id === id)
  if (!v) throw new ApiError(404, 'versión no encontrada')
  return { hcl: v.hcl }
}

function publishDashboardVersion(id: number) {
  const v = dashboardVersions.find((r) => r.id === id)
  if (!v) throw new ApiError(404, 'versión no encontrada')
  for (const r of dashboardVersions) r.published = false
  v.published = true
  dashboardWidgets = v.widgets.map((w) => ({ ...w }))
  pushAudit('dashboard:publish', 'config', String(id), null)
  return { ok: true, reloaded: true }
}

export async function mockRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 120))
  const url = new URL(path, 'http://mock')
  const p = url.pathname
  const sp = url.searchParams
  const b = (body ?? {}) as Record<string, unknown>

  if (p === '/auth/login' && method === 'POST') {
    if (!b.email || b.password === 'wrong') throw new ApiError(401, 'Credenciales inválidas')
    return CURRENT_USER
  }
  if (p === '/auth/logout') return {}
  if (p === '/me') return CURRENT_USER
  if (p === '/meta') return META
  if (p === '/public')
    return {
      brand: META.brand,
      brand_logo: META.brand_logo,
      theme: META.theme,
      locale: META.locale,
      strings: META.strings,
      base_path: META.base_path,
    }
  if (p === '/dashboard') return makeDashboard()
  if (p === '/audit') return auditList(sp)
  if (p === '/search') return search(sp.get('q') ?? '')
  if (p === '/health') return { ok: true }

  if (p === '/views') {
    if (method === 'GET') return listViews(sp)
    if (method === 'POST') return createView(b)
  }
  let m = /^\/views\/(\d+)$/.exec(p)
  if (m && method === 'DELETE') return deleteView(Number(m[1]))

  if (p === '/users') {
    if (method === 'GET') return listAccessUsers()
    if (method === 'POST') return createAccessUser(b)
  }
  m = /^\/users\/(\d+)$/.exec(p)
  if (m) {
    if (method === 'PATCH') return updateAccessUser(Number(m[1]), b)
    if (method === 'DELETE') return deleteAccessUser(Number(m[1]))
  }

  if (p === '/config/groups') {
    if (method === 'GET') return groupsLayout()
    if (method === 'POST') return createGroup(b)
  }
  if (p === '/config/groups/layout' && method === 'POST') return putGroupLayout(b)
  m = /^\/config\/groups\/([^/]+)\/rename$/.exec(p)
  if (m && method === 'POST') return renameGroup(decodeURIComponent(m[1]), String(b.to ?? ''))
  m = /^\/config\/groups\/([^/]+)$/.exec(p)
  if (m) {
    const slug = decodeURIComponent(m[1])
    if (method === 'PATCH') return patchGroup(slug, b)
    if (method === 'DELETE') return deleteGroup(slug)
  }

  if (p === '/config/discover' && method === 'GET') return discoverTables()

  if (p === '/config/dashboard') {
    if (method === 'GET') return dashboardConfig()
    if (method === 'PUT') return putDashboardConfig(b)
  }
  if (p === '/config/dashboard/preview' && method === 'POST') return dashboardPreview(b)
  if (p === '/config/dashboard/versions' && method === 'GET') return dashboardVersionsList()
  m = /^\/config\/dashboard\/versions\/(\d+)\/publish$/.exec(p)
  if (m && method === 'POST') return publishDashboardVersion(Number(m[1]))
  m = /^\/config\/dashboard\/versions\/(\d+)$/.exec(p)
  if (m && method === 'GET') return dashboardVersionBody(Number(m[1]))

  m = /^\/config\/([^/]+)\/versions$/.exec(p)
  if (m && method === 'GET') return configVersionsList(decodeURIComponent(m[1]))

  m = /^\/config\/([^/]+)\/versions\/(\d+)\/publish$/.exec(p)
  if (m && method === 'POST') return publishConfigVersion(decodeURIComponent(m[1]), Number(m[2]))

  m = /^\/config\/([^/]+)\/versions\/(\d+)$/.exec(p)
  if (m && method === 'GET') return configVersionBody(decodeURIComponent(m[1]), Number(m[2]))

  m = /^\/config\/([^/]+)$/.exec(p)
  if (m) {
    const name = decodeURIComponent(m[1])
    if (method === 'GET') return getConfig(name)
    if (method === 'PUT') return putConfig(name, b)
  }

  if (p === '/roles') {
    if (method === 'GET') return rolesResponse()
    if (method === 'POST') return createRole(b)
  }
  m = /^\/roles\/([^/]+)$/.exec(p)
  if (m) {
    const name = decodeURIComponent(m[1])
    if (method === 'PATCH') return updateRole(name, b)
    if (method === 'DELETE') return deleteRole(name)
  }

  m = /^\/t\/([^/]+)\/export$/.exec(p)
  if (m) {
    const url = new URL(path, 'http://mock')
    return mockExport(m[1], sp.get('format') ?? 'csv', url.search.replace(/^\?/, ''))
  }

  m = /^\/t\/([^/]+)\/r\/([^/]+)\/audit$/.exec(p)
  if (m) return rowAudit(m[1], decodeURIComponent(m[2]))

  m = /^\/t\/([^/]+)\/r\/([^/]+)\/inline\/([^/]+)$/.exec(p)
  if (m && method === 'GET')
    return inlinePage(m[1], decodeURIComponent(m[2]), m[3], Math.max(1, Number(sp.get('page') ?? 1)))

  m = /^\/t\/([^/]+)\/options\/([^/]+)$/.exec(p)
  if (m) return optionsFor(m[1], m[2], sp.get('q') ?? '')

  m = /^\/t\/([^/]+)\/action\/([^/]+)$/.exec(p)
  if (m && method === 'POST') return runAction(m[1], m[2], (b.pks ?? []) as Array<string | number>)

  m = /^\/t\/([^/]+)\/bulk$/.exec(p)
  if (m && method === 'POST')
    return bulkUpdate(m[1], (b.pks ?? []) as Array<string | number>, (b.set ?? {}) as Row)

  m = /^\/t\/([^/]+)\/import$/.exec(p)
  if (m && method === 'POST')
    return importRows(m[1], String(b.format ?? 'csv'), String(b.data ?? ''), String(b.mode ?? 'insert'))

  m = /^\/t\/([^/]+)\/r\/([^/]+)$/.exec(p)
  if (m) {
    const pk = decodeURIComponent(m[2])
    if (method === 'GET') return rowDetail(m[1], pk)
    if (method === 'PATCH') return patchRow(m[1], pk, (b.set ?? {}) as Row)
    if (method === 'DELETE') {
      const meta = tableMeta(m[1])
      if (!meta.perms.delete) throw new ApiError(403, 'sin permiso de borrado')
      const idx = DATA[m[1]].findIndex((r) => String(r[meta.pk]) === pk)
      if (idx >= 0) DATA[m[1]].splice(idx, 1)
      pushAudit('delete', m[1], pk, null)
      return {}
    }
  }

  m = /^\/t\/([^/]+)$/.exec(p)
  if (m) {
    if (method === 'GET') return listRows(m[1], sp)
    if (method === 'POST') return createRow(m[1], (b.set ?? {}) as Row)
  }

  throw new ApiError(404, `ruta mock desconocida: ${method} ${p}`)
}
