---
title: cartapel documentation
titleTemplate: false
description: "cartapel documentation: what it is, two ideas that make it different, and every page — data sources, tables, roles, dashboards, deployment — grouped by topic."
---

# cartapel documentation

cartapel is an open-source, single-binary admin panel for an existing
PostgreSQL, MySQL or MariaDB database — a Django-admin / Forest / Retool
alternative you run yourself. Point the Rust binary at your database, register
the tables you want to expose, and you get a polished CRUD panel: paginated
lists, search, filters, detail pages, inline child rows, bulk actions,
dashboards, roles and an audit log. A ClickHouse database can be attached too,
read-only, for browsing and SQL.

Two ideas make it different:

- **Your database is the schema.** cartapel introspects your live database for
  columns, types, primary keys and foreign keys. There is no separate model
  definition to keep in sync.
- **Customization is code.** Everything you tune — which columns show in a
  list, how a field renders, who can edit what — lives in a directory of HCL
  files you commit to your repo. The in-app visual builder writes the same
  HCL, so even click-made changes are versioned and reviewable.

::: tip Try it without installing
A hosted demo runs the bundled Acme dataset at
**<https://demo.cartapel.com>** — no login needed. Source on
[GitHub](https://github.com/De-Rus/cartapel).
:::

## How these docs are organized

- **[Getting started](/getting-started)** is a tutorial — read it once, in
  order, and you end with a running panel and one real table registered.
- **Basics** and **Advanced** below are reference — one page per concern (a
  data source, a table, a widget, a dashboard…), each complete on its own,
  meant to be dipped into rather than read start to finish.
- **Operations** is for running it for real: deploying it, and how the pieces
  fit together once it's up.

## First steps

- **[Getting started](/getting-started)** — install, first run, bootstrap the
  admin user, and register your first table. Start here.
- **[vs the alternatives](/comparisons)** — where cartapel fits next to Django
  admin, Retool, Metabase, Directus, NocoDB, Baserow and pgAdmin.
- **[CLI & environment](/cli)** — every subcommand, flag and environment
  variable, including `cartapel check` for CI.

## Basics

The shape of a config bundle, one topic per page.

- **[Configuration overview](/configuration/overview)** — the HCL model:
  folders as groups, the reserved `config/` folder, hot reload.
- **[Data sources](/configuration/sources)** — Postgres, MySQL & MariaDB,
  ClickHouse, Grafana, files, S3-compatible storage and HTTP, each with a
  worked example.
- **[Uploads & file storage](/configuration/uploads)** — the `file { }` field
  (`widget = "image"` or generic), the upload request, and local-disk or
  S3-compatible storage.
- **[Tables](/configuration/tables)** — register a table and shape its list:
  columns, search, filters, sort, permissions.
- **[Detail views](/configuration/detail-views)** — sections, tabs, stats, the
  meta sidebar and inline child tables.
- **[Groups & navigation](/configuration/groups-and-nav)** — sidebar groups
  from folders: labels, icons, ordering.
- **[Dashboard](/configuration/dashboard)** — SQL-defined stat tiles, charts,
  tables and template variables.
- **[Grafana panels](/configuration/grafana-panels)** — Prometheus, Loki and
  Tempo as panel rows, with PromQL/LogQL/TraceQL examples.

## Advanced

Customization, access control, and how it looks.

- **[Fields & widgets](/configuration/fields-and-widgets)** — per-column
  options: formats, colors, masking, computed columns.
- **[Widgets](/configuration/widgets)** — every built-in renderer, grouped
  by kind, plus `custom:<name>` web-component widgets.
- **[Pages, queries & custom widgets](/configuration/pages-and-queries)** —
  declarative pages, named read-only queries, template variables.
- **[Theming](/theming)** — presets, accent colors, per-mode design tokens and
  logos, one HCL block.
- **[Localization](/localization)** — every viewer picks their own language;
  built-in locales plus per-string and per-label overrides.
- **[Roles & permissions](/roles-and-permissions)** — the granular permission
  matrix, inheritance, masking and row filters.
- **[Security model](/security)** — signed sessions, bound SQL, masking, row
  filters, path confinement, hardening toggles.

## Operations

- **[Deployment](/deployment)** — Docker, Fly.io, Render, or a bare binary,
  plus secrets, volumes and connection-pooler notes.
- **[Architecture](/architecture)** — how it works inside: introspection,
  hot-reloadable config, the SQLite app state, the request path.
