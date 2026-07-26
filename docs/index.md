---
layout: home

hero:
  name: cartapel
  text: An admin panel for your existing Postgres
  tagline: One binary. No ORM, no framework, no Node runtime. Your schema is the source of truth, and every customization is code you version — not a GUI you click.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Live demo — no login
      link: https://demo.cartapel.com
    - theme: alt
      text: Configuration
      link: /configuration/overview

features:
  - icon: 🗄️
    title: Point it at Postgres
    details: Introspects tables, keys and enums from your live schema. Lists get pagination, search, sorting, Notion-style filters, saved views and a ⌘K palette automatically.
  - icon: 📝
    title: Code-first config
    details: A directory of HCL files — one per table, folders become sidebar groups. Columns, widgets, layouts and actions are all reviewable in your repo.
  - icon: 🔒
    title: Auth, roles, audit
    details: Built-in users and sessions. Per-table, per-field and row-level permissions, column masking, and an audit log of every write with before/after diffs.
  - icon: 📊
    title: Dashboards
    details: SQL-defined stat tiles, sparklines, charts and tables — every query runs in a read-only transaction with a statement timeout.
  - icon: 🧩
    title: Extensible
    details: Drop custom field widgets and full-screen pages into the config bundle as JS web components. No rebuild, no npm.
  - icon: 🚀
    title: One-file deploy
    details: A single static binary or Docker image. Bake the config in read-only, or mount a volume and edit it live from the in-app builder.
---

## What is cartapel?

cartapel is an open-source, single-binary admin panel for an existing PostgreSQL
database — a Django-admin / Forest / Retool alternative you run yourself. Point
the Rust binary at your database, register the tables you want to expose, and
you get a polished CRUD panel: paginated lists, search, filters, detail pages,
inline child rows, bulk actions, dashboards, roles and an audit log.

::: tip Try it without installing
A hosted demo runs the bundled Acme dataset at
**<https://demo.cartapel.com>** — no login needed.
:::

Two ideas make it different:

- **Your database is the schema.** cartapel introspects your live Postgres for
  columns, types, primary keys and foreign keys. There is no separate model
  definition to keep in sync.
- **Customization is code.** Everything you tune — which columns show in a list,
  how a field renders, who can edit what — lives in a directory of HCL files you
  commit to your repo. The in-app visual builder writes the same HCL, so even
  click-made changes are versioned and reviewable.

## 60-second quickstart

cartapel needs three things: a Postgres URL, a signing secret, and (optionally) a
directory of config. It runs without config — but the panel is an **allowlist**,
so you will see no tables until you register at least one.

::: code-group

```bash [Docker]
docker run --rm -p 8686:8686 \
  -e CARTAPEL_DB="postgres://user:pass@host:5432/mydb" \
  -e CARTAPEL_SECRET_KEY="a-long-random-string" \
  -e CARTAPEL_ADMIN_EMAIL="you@example.com" \
  -e CARTAPEL_ADMIN_PASSWORD="change-me" \
  -v "$PWD/admin:/config:ro" \
  ghcr.io/de-rus/cartapel:latest \
  serve --config /config --schema public
```

```bash [Cargo]
export CARTAPEL_SECRET_KEY="a-long-random-string"
export CARTAPEL_ADMIN_EMAIL="you@example.com"
export CARTAPEL_ADMIN_PASSWORD="change-me"

cargo run --release -- serve \
  --db postgres://user:pass@host:5432/mydb \
  --schema public \
  --config ./admin \
  --data ./cartapel-data
```

:::

Open <http://localhost:8686/admin>, log in with the bootstrap admin, and you are in.

::: tip The secret key is required
cartapel **refuses to start** without a secret key — it signs your session
cookies. Set `CARTAPEL_SECRET_KEY` (or `[cartapel].secret_key` in the config). See
[Security](/security#secret-key).
:::

## Where to next

- **[Getting started](/getting-started)** — install, first run, bootstrap the
  admin user, and register your first table.
- **[Configuration overview](/configuration/overview)** — the HCL config model:
  folders as groups and the reserved `config/` folder.
- **[Fields & widgets](/configuration/fields-and-widgets)** — the full widget
  library with parameters and examples.
- **[Roles & permissions](/roles-and-permissions)** — the granular permission
  matrix, masking and row filters.
