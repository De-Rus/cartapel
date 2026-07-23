# steward

Point a single binary at your existing Postgres and get a Django-admin-quality
panel. No framework, no ORM, no Node runtime — your database schema is the
source of truth, and customization is code you version, not a GUI you click.

**[▶ Live demo](https://steward-demo-derus.fly.dev)** (log in with `admin` / `admin`) · **[📖 Docs](https://de-rus.github.io/steward/)**

```bash
git clone … && cd steward
docker compose up            # → populated demo on http://localhost:8686/admin
```

- **Opt-in tables**: the admin exposes only the tables you register with a
  config file — an introspected-but-unconfigured table is not part of the panel.
  Once registered, columns, PKs and FKs are introspected: lists get pagination,
  search, sorting and sane widgets (FKs as links, enums as badges, timestamps
  localized). Views and PK-less tables degrade to read-only.
- **Code-first customization**: a directory of per-table HCL files — list
  columns, search fields, filters (incl. raw-SQL filters), field widgets,
  readonly/masked fields, inline child tables, bulk actions (declarative
  `UPDATE`s or HMAC-signed webhooks into your real backend).
- **Auth, roles, audit**: built-in users/sessions (stored in steward's own
  SQLite file — your database is never written to unless you edit a row),
  per-table/per-field/row-level permissions, and an audit log of every write
  with before/after diffs.
- **Dashboards**: SQL-defined stat tiles, charts and tables, evaluated
  read-only.

## Try the demo

A self-contained "Acme" dataset (customers, products, orders, subscriptions)
with a ready-made config, so you can click around before pointing steward at
your own database:

```bash
docker compose up
```

Then open **http://localhost:8686** and log in with
`admin@acme.test` / `acme-admin`. The stack is `db` (Postgres, auto-seeded from
[`demo/seed.sql`](demo/seed.sql)) + `steward` (built from this repo, config in
[`demo/admin/`](demo/admin/)). Nothing is written to your machine outside the
containers; `docker compose down -v` removes everything.

## Point it at your own database

steward is config-first: a table appears only once you give it a `.hcl` file,
and the database it reads is declared as a `source`. A minimal `config/steward.hcl`:

```hcl
source "main" {
  type    = "postgres"
  url     = "env:STEWARD_DB"   # or a literal postgres:// url
  primary = true
}
```

```bash
export STEWARD_DB=postgres://user:pass@host:5432/mydb
export STEWARD_SECRET_KEY=$(openssl rand -hex 32)
export STEWARD_ADMIN_EMAIL=you@example.com STEWARD_ADMIN_PASSWORD=change-me
steward serve \
  --config ./admin --data ./steward-data \
  --listen 0.0.0.0:8686
```

`--db postgres://…` / `STEWARD_DB` overrides the primary source's URL, so the
same config runs against staging or prod by swapping one env var. To serve the
panel under a sub-path (e.g. behind a reverse proxy at `/admin`), add
`--base-path /admin`.

`--config` points at a directory of HCL files:

```
admin/
├── config/                   # reserved — globals, never a sidebar group
│   ├── steward.hcl          #   brand, defaults, the `main` postgres source
│   ├── auth.hcl             #   roles, field masking, row-level filters
│   └── dashboard.hcl        #   home widgets (SQL stat tiles, charts, tables)
└── screens/                  # every table and page lives here
    ├── customers/            # a folder under screens/ IS a sidebar group
    │   ├── _group.hcl       #   its label, icon (lucide), order
    │   ├── customers/       #   one folder per table — the folder name is the table
    │   │   └── screen.hcl   #     list/fields/actions (empty file = introspected defaults)
    │   └── subscriptions/
    │       └── screen.hcl
    └── overview/
        └── summary/          # a scripted page instead of a table
            ├── screen.hcl   #   module = "summary.tsx"
            └── summary.tsx  #   authored with the sx SDK
```

`config/` is never a sidebar group and is never scanned for tables — it holds
only the three globals (`steward.hcl`/`auth.hcl`/`dashboard.hcl`).

Under `screens/`, each folder is a sidebar group carrying a `_group.hcl`
(`label`, `icon`, `order`); groups sort by `order` then `label`. Inside a group,
each table is a subfolder whose `screen.hcl` configures it — and the folder name
*is* the table name. A scripted page is the same shape: a subfolder whose
`screen.hcl` sets `module = "<name>.tsx"` next to the module authored with the
`sx` SDK. See the [configuration docs](docs/configuration/pages-and-queries.md).

The admin is an allowlist: only tables with a `screen.hcl` are exposed (an empty
file is enough — it renders with introspected defaults), and an admin can author
one in-app from the generated template. Unconfigured tables are absent from the
nav and 404 by direct URL, so there is no denylist to maintain. See [`docs/`](docs/)
for the full option surface and [`demo/admin/`](demo/admin/) for a worked example.

## Configuration sketch

```hcl
# admin/screens/market-data/instruments/screen.hcl
list {
  columns = ["symbol", "exchange", "asset_class", "active"]
  search  = ["symbol", "name"]
  filters = ["asset_class", "active", "stale"]
  sort    = "-id"

  filter_def "stale" {
    label = "No recent price"
    sql   = "id NOT IN (SELECT instrument_id FROM prices WHERE ts > now() - interval '7 days')"
  }
}

field "asset_class" {
  widget = "badge"
  params = { colors = { crypto = "orange", stock = "blue" } }
}

edit {
  readonly = ["id", "source", "symbol"]
}

action "deactivate" {
  label   = "Deactivate"
  kind    = "update"
  set     = { active = false }
  confirm = "Deactivate {count} instruments?"
}
```

## Build

```bash
cd ui && pnpm install && pnpm build && cd ..   # SPA, embedded into the binary
cargo build --release                          # → target/release/steward
```

## Security model

- Session cookies (HttpOnly, SameSite=Lax) are HMAC-SHA256-signed with the
  app secret key; a tampered or unsigned cookie is treated as no session.
  The signature is verified before any DB session lookup.
- **Secret key** — steward's signing/encryption root. **REQUIRED**: steward
  refuses to start without it. Resolved at startup by precedence:
  `STEWARD_SECRET_KEY` env → `[steward].secret_key` in `config/steward.hcl`
  (env-interpolated, e.g. `secret_key = "env:STEWARD_SECRET_KEY"`). Prefer the
  env var or `${...}` interpolation — never commit a literal key to config.
  Rotating the key invalidates all existing sessions (users re-login once).
- Passwords are argon2id; login is rate-limited per IP.
- Every SQL identifier is validated against the introspected schema; every
  value is a bound parameter. Raw-SQL fragments exist only in your config
  files, which live in your repo and are trusted like code.
- Dashboard SQL runs in `READ ONLY` transactions with a statement timeout.
- Webhook actions are signed (`X-Steward-Signature`, HMAC-SHA256 with
  `STEWARD_WEBHOOK_SECRET`).

MIT licensed.
