---
description: "From a fresh binary to a working Postgres admin panel: install, connect your database, and register tables with the setup wizard."
---

# Getting started

This walks you from a fresh binary to a working panel with your first table
registered.

::: tip Prefer to click around first?
A hosted demo runs the bundled Acme dataset at
**<https://demo.cartapel.com>** (no login needed) — or run it locally
with `docker compose up` from a repo checkout.
:::

## Install

cartapel is a single binary. Get it one of three ways:

::: code-group

```bash [Build from source]
# Requires a recent Rust toolchain and pnpm (for the embedded SPA).
cd ui && pnpm install && pnpm build && cd ..
cargo build --release
# → target/release/cartapel
```

```bash [Docker]
docker pull ghcr.io/de-rus/cartapel:latest
```

```bash [Binary release]
# Download the prebuilt binary for your platform, then:
chmod +x cartapel
./cartapel --help
```

:::

The frontend is a single-page app that is compiled once and **embedded into the
binary**, so the release binary is entirely self-contained: no Node runtime at
serve time, no static-file directory to ship.

## First run

cartapel needs, at minimum, a database URL and a secret key.

```bash
export CARTAPEL_SECRET_KEY="$(openssl rand -hex 32)"

cartapel serve \
  --db postgres://user:pass@host:5432/mydb \
  --schema public \
  --config ./admin \
  --data ./cartapel-data
```

- `--db` — the Postgres connection URL. It overrides the URL of the primary
  `source` declared in config (see below); you can also set it via `CARTAPEL_DB`.
- `--schema` — the Postgres schema to introspect (defaults to `public`). Set the
  source's `schemas` list for more than one.
- `--config` — a directory of HCL config files (see below). Optional, but
  without it no tables are exposed.
- `--data` — where cartapel keeps its **own** state (users, sessions, audit log,
  config history) as a SQLite database. Defaults to `./cartapel-data`.

On startup cartapel introspects your schema, loads the config directory, and logs
how many tables it found:

```
INFO cartapel: introspected 41 tables from schemas ["public"]
INFO cartapel: cartapel listening on http://127.0.0.1:8686/admin/
```

The panel is served under **`/admin`** by default (so `http://…:8686/` redirects
to `/admin`). Change the mount path with `--base-path` — e.g. `--base-path ''`
to serve at the root, or `--base-path /panel` for a sub-path. It's applied at
runtime, so one binary/image serves any prefix.

::: warning cartapel never writes to your database on its own
Your Postgres is only ever written to when a panel user edits a row, runs a bulk
action, or imports data. All of cartapel's own bookkeeping lives in the separate
SQLite state directory.
:::

## Bootstrap the admin user

The first time you run `serve` against an empty state directory (zero users),
cartapel **bootstraps an admin account** so you can log in:

```bash
export CARTAPEL_ADMIN_EMAIL="you@example.com"
export CARTAPEL_ADMIN_PASSWORD="a-strong-password"
cartapel serve ...
```

- With both env vars set, that account is created.
- If `CARTAPEL_ADMIN_EMAIL` is unset it defaults to `admin@localhost`.
- If `CARTAPEL_ADMIN_PASSWORD` is unset, cartapel **generates** a random password
  and prints it once to the log:

  ```
  WARN cartapel: bootstrapped admin user you@example.com with password: 7hK2mQ...
  ```

Passwords are stored as argon2id hashes; login is rate-limited per IP.

You can add or update users later without the server running:

```bash
cartapel user add teammate@example.com --role support --data ./cartapel-data
# → user teammate@example.com (support) — generated password: ...
```

See the [CLI reference](/cli) for every flag.

## Register your first tables

The panel is an **allowlist**: only tables that have a config file are exposed.
An introspected-but-unconfigured table is absent from the navigation and 404s if
you hit its URL directly. So a fresh panel starts empty — and cartapel offers two
ways to fill it: the first-run setup wizard, or config files by hand.

### The setup wizard

When an admin logs into a panel with **zero configured tables**, cartapel
redirects them to the setup wizard at `/_setup`. It lists every introspected
table (with approximate row counts) and builds the whole first config in one
screen:

- Everything is pre-selected **except** framework noise (`schema_migrations`,
  `_prisma_migrations`, `django_migrations`, …) and tables without a primary
  key — both stay in the list, flagged, and can be ticked back on. Views are
  labeled too.
- Tables arrive pre-sorted into **suggested groups**: one group per schema when
  you introspect several, otherwise by shared name prefix (`order_items`,
  `order_events` → an "Order" group).
- You can rename any group inline, move a table to another group, or create a
  new group on the spot.

One click then writes the plan as a **single atomic batch**: a `_group.hcl` per
group plus an empty config file per table (empty = introspected defaults), and
hot-swaps it into the live panel — no restart. If the config directory is
**read-only**, nothing is written: the wizard shows every would-be file with a
copy button so you can commit them to your repo instead.

### By hand

The wizard writes ordinary files; you can just as well author them yourself.
First, tell cartapel which database to read — the reserved `config/cartapel.hcl`
declares the primary `source` (its URL comes from `CARTAPEL_DB` / `--db`):

```hcl
# admin/config/cartapel.hcl
source "main" {
  type    = "postgres"
  url     = "env:CARTAPEL_DB"
  primary = true
}
```

Now expose a table. The smallest possible table config is an empty `screen.hcl`
in a table folder under a group — the **folder name is the table**:

```bash
mkdir -p admin/screens/catalog/products
touch admin/screens/catalog/products/screen.hcl
```

That empty `screen.hcl` registers the `products` table. It renders with
introspected defaults: all columns in the list, sensible widgets for each type,
FKs as links, timestamps localized.

From there you refine it:

```hcl
# admin/screens/catalog/products/screen.hcl
label_plural = "Products"

list {
  columns = ["id", "name", "price", "in_stock", "created_at"]
  search  = ["name", "sku"]
  filters = ["in_stock"]
  sort    = "-created_at"
}

field "price" {
  widget = "money"
  params = { currency = "USD" }
}

field "in_stock" {
  widget = "toggle"
}
```

And a `_group.hcl` in the group folder names the sidebar group:

```hcl
# admin/screens/catalog/_group.hcl
label = "Catalog"
icon  = "package"   # any lucide icon name
order = 1
```

Save the files — cartapel **watches the config directory** and hot-reloads on
change (debounced; a broken edit keeps the last good config and logs the
error). The Catalog group appears with your Products table inside it, no
restart. In-app builder edits — including the setup wizard — hot-swap the same
way.

## What's next

- **[Configuration overview](/configuration/overview)** — the full config model.
- **[Tables](/configuration/tables)** — every option in a `screen.hcl`.
- **[Fields & widgets](/configuration/fields-and-widgets)** — the widget library.
