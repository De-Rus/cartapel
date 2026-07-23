---
layout: home

hero:
  name: steward
  text: An admin panel for your existing Postgres
  tagline: One binary. No ORM, no framework, no Node runtime. Your schema is the source of truth, and every customization is code you version — not a GUI you click.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Configuration
      link: /configuration/overview

features:
  - icon: 🗄️
    title: Point it at Postgres
    details: Introspects tables, primary keys, foreign keys and enums. Lists get pagination, search, sorting and sensible widgets automatically. Views and PK-less tables degrade to read-only.
  - icon: 📝
    title: Code-first config
    details: A directory of HCL files. Folders become sidebar groups, one file per table. List columns, filters, field widgets, detail layouts, inline child tables and bulk actions — all reviewable in your repo.
  - icon: 🔒
    title: Auth, roles, audit
    details: Built-in users and sessions in steward's own SQLite file. Granular per-table / per-field / row-level permissions, column masking, and an audit log of every write with before/after diffs.
  - icon: 📊
    title: Dashboards
    details: SQL-defined stat tiles, sparklines, line/bar/area charts and tables — all evaluated in read-only transactions with a statement timeout.
  - icon: 🧩
    title: Extensible
    details: A JS-plugin escape hatch. Drop custom field widgets and full-screen pages into the config bundle as web components — no rebuild, no npm.
  - icon: 🚀
    title: One-file deploy
    details: A single static binary or a Docker image. Bake the config read-only, or mount a writable volume to edit and version config live from the in-app builder.
---

## What is steward?

steward is an open-source, single-binary admin panel for an existing PostgreSQL
database — a Django-admin / Forest / Retool alternative you run yourself. You
point the Rust binary at your database, register the tables you want to expose,
and get a polished CRUD panel: paginated lists, search, filters, detail pages,
inline child rows, bulk actions, dashboards, roles and an audit log.

Two ideas make it different:

- **Your database is the schema.** steward introspects your live Postgres for
  columns, types, primary keys and foreign keys. There is no separate model
  definition to keep in sync.
- **Customization is code.** Everything you tune — which columns show in a list,
  how a field renders, who can edit what — lives in a directory of HCL files you
  commit to your repo. There is an in-app visual builder, but it writes the same
  HCL, versioned and reviewable.

## 60-second quickstart

steward needs three things: a Postgres URL, a signing secret, and (optionally) a
directory of config. With no config directory it still runs — but the panel is
an **allowlist**, so you will see no tables until you register at least one.

::: code-group

```bash [Docker]
docker run --rm -p 8686:8686 \
  -e STEWARD_DB="postgres://user:pass@host:5432/mydb" \
  -e STEWARD_SECRET_KEY="a-long-random-string" \
  -e STEWARD_ADMIN_EMAIL="you@example.com" \
  -e STEWARD_ADMIN_PASSWORD="change-me" \
  -v "$PWD/admin:/config:ro" \
  ghcr.io/de-rus/steward:latest \
  serve --config /config --schema public
```

```bash [Cargo]
export STEWARD_SECRET_KEY="a-long-random-string"
export STEWARD_ADMIN_EMAIL="you@example.com"
export STEWARD_ADMIN_PASSWORD="change-me"

cargo run --release -- serve \
  --db postgres://user:pass@host:5432/mydb \
  --schema public \
  --config ./admin \
  --data ./steward-data
```

:::

Open <http://localhost:8686/admin>, log in with the bootstrap admin, and you are in.

::: tip The secret key is required
steward **refuses to start** without a secret key — it signs your session
cookies. Set `STEWARD_SECRET_KEY` (or `[steward].secret_key` in the config). See
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
