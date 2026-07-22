# Getting started

This walks you from a fresh binary to a working panel with your first table
registered.

## Install

steward is a single binary. Get it one of three ways:

::: code-group

```bash [Build from source]
# Requires a recent Rust toolchain and pnpm (for the embedded SPA).
cd ui && pnpm install && pnpm build && cd ..
cargo build --release
# → target/release/steward
```

```bash [Docker]
docker pull ghcr.io/your-org/steward:latest
```

```bash [Binary release]
# Download the prebuilt binary for your platform, then:
chmod +x steward
./steward --help
```

:::

The frontend is a single-page app that is compiled once and **embedded into the
binary**, so the release binary is entirely self-contained: no Node runtime at
serve time, no static-file directory to ship.

## First run

steward needs, at minimum, a database URL and a secret key.

```bash
export STEWARD_SECRET_KEY="$(openssl rand -hex 32)"

steward serve \
  --db postgres://user:pass@host:5432/mydb \
  --schema public \
  --config ./admin \
  --data ./steward-data
```

- `--db` — the Postgres connection URL. It overrides the URL of the primary
  `source` declared in config (see below); you can also set it via `STEWARD_DB`.
- `--schema` — the Postgres schema to introspect (defaults to `public`). Set the
  source's `schemas` list for more than one.
- `--config` — a directory of HCL config files (see below). Optional, but
  without it no tables are exposed.
- `--data` — where steward keeps its **own** state (users, sessions, audit log,
  config history) as a SQLite database. Defaults to `./steward-data`.

On startup steward introspects your schema, loads the config directory, and logs
how many tables it found:

```
INFO steward: introspected 41 tables from schemas ["public"]
INFO steward: steward listening on http://127.0.0.1:8686/
```

::: warning steward never writes to your database on its own
Your Postgres is only ever written to when a panel user edits a row, runs a bulk
action, or imports data. All of steward's own bookkeeping lives in the separate
SQLite state directory.
:::

## Bootstrap the admin user

The first time you run `serve` against an empty state directory (zero users),
steward **bootstraps an admin account** so you can log in:

```bash
export STEWARD_ADMIN_EMAIL="you@example.com"
export STEWARD_ADMIN_PASSWORD="a-strong-password"
steward serve ...
```

- With both env vars set, that account is created.
- If `STEWARD_ADMIN_EMAIL` is unset it defaults to `admin@localhost`.
- If `STEWARD_ADMIN_PASSWORD` is unset, steward **generates** a random password
  and prints it once to the log:

  ```
  WARN steward: bootstrapped admin user you@example.com with password: 7hK2mQ...
  ```

Passwords are stored as argon2id hashes; login is rate-limited per IP.

You can add or update users later without the server running:

```bash
steward user add teammate@example.com --role support --data ./steward-data
# → user teammate@example.com (support) — generated password: ...
```

See the [CLI reference](/cli) for every flag.

## Register your first table

The panel is an **allowlist**: only tables that have a config file are exposed.
An introspected-but-unconfigured table is absent from the navigation and 404s if
you hit its URL directly. This means an empty panel is normal until you add a
config.

First, tell steward which database to read — the reserved `config/steward.hcl`
declares the primary `source` (its URL comes from `STEWARD_DB` / `--db`):

```hcl
# admin/config/steward.hcl
source "main" {
  type    = "postgres"
  url     = "env:STEWARD_DB"
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

Save, and steward hot-reloads the config with no restart. Reload the panel and
the Catalog group appears with your Products table inside it.

## What's next

- **[Configuration overview](/configuration/overview)** — the full config model.
- **[Tables](/configuration/tables)** — every option in a `screen.hcl`.
- **[Fields & widgets](/configuration/fields-and-widgets)** — the widget library.
