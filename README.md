<div align="center">
  <img src="site/public/logo.svg" width="84" alt="cartapel logo" />

  # cartapel

  **An admin panel for your existing database — Postgres, MySQL or MariaDB.**
  One Rust binary · config as code · no framework, no ORM, no Node runtime.

  [![CI](https://github.com/De-Rus/cartapel/actions/workflows/ci.yml/badge.svg)](https://github.com/De-Rus/cartapel/actions/workflows/ci.yml)
  [![Release](https://img.shields.io/github/v/tag/De-Rus/cartapel?label=release&sort=semver)](https://github.com/De-Rus/cartapel/releases)
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

  **[cartapel.com](https://cartapel.com)** · **[▶ Live demo](https://demo.cartapel.com)** (no login) · **[📖 Docs](https://docs.cartapel.com)** · **[🚀 Deploy to Render](https://render.com/deploy?repo=https://github.com/De-Rus/cartapel)**

  <img src="site/public/shots/list.png" alt="cartapel — list view with filter chips, saved views and inline editing" width="820" />
</div>

## Why

Every project ends up needing an admin: support wants to fix a record, ops wants
a dashboard, someone needs to flip a flag. The usual options are heavy (Retool),
framework-locked (Django admin) or become a second codebase to maintain.

cartapel takes a different bet: **your database schema is the source of truth,
and every customization is code you version** — a directory of small HCL files
reviewed in pull requests, not a GUI you click. The binary introspects your
database — Postgres, MySQL or MariaDB, picked from the connection URL — and
renders a complete panel; config only refines it.

```hcl
# screens/sales/orders/screen.hcl — this is the whole customization
list {
  columns = ["id", "customer_id", "status", "total"]
  filters = ["status"]
  sort    = "-placed_at"
}

field "status" {
  widget = "badge"
  params = { colors = { paid = "green", refunded = "red" } }
}

action "refund" {
  label   = "Refund"
  kind    = "update"
  set     = { status = "refunded" }
  confirm = "Refund {count} orders?"
}
```

An **empty** `screen.hcl` is already a working table: pagination, search,
Notion-style filter chips on any column, sorting, inline editing, and foreign
keys rendered as links carrying the related record's *name*, not a bare id.

## Try it

```bash
# The bundled demo (Acme dataset + a worked config), nothing touches your machine:
git clone https://github.com/De-Rus/cartapel && cd cartapel
docker compose up            # → http://localhost:8686/admin

# Or against YOUR database, in one command (postgres:// or mysql://):
docker run -p 8686:8686 \
  -e CARTAPEL_DB=postgres://user:pass@host/db \
  -e CARTAPEL_SECRET_KEY=$(openssl rand -hex 32) \
  -e CARTAPEL_ADMIN_EMAIL=you@example.com -e CARTAPEL_ADMIN_PASSWORD=change-me \
  ghcr.io/de-rus/cartapel serve
```

First boot with an empty config drops you into a **setup wizard** that
discovers your tables, suggests groups and writes the HCL for you — ready to
commit.

## What you get

| | |
|---|---|
| **Introspected CRUD** | Lists, detail pages, inline child tables from reverse FKs, bulk actions, CSV/JSON import & export. Views and PK-less tables degrade to read-only. |
| **Roles & permissions** | Per-table / per-column / row-level, in versioned config. Role inheritance (`extends`), multi-role union, a per-role `customize` grant, and a read-only **view-as** mode to verify what a role sees. |
| **Audit & revert** | Every write logged with before/after diffs. Field edits revert in one click — and the revert is itself audited. |
| **SQL dashboards** | Stat tiles, charts and tables straight from SQL, with template variables (`{{window}}`), all in read-only transactions with timeouts. |
| **Custom pages** | Drop a `.tsx` module next to your config — transpiled in the browser with the `sx` SDK in scope. No build step, no npm. Typed via `{base}/sx.d.ts`. |
| **Theming & i18n** | Presets (including a faithful Django look), your accent, per-mode design tokens, per-locale labels — one hot-reloaded HCL block. |
| **Ops-friendly** | Single static binary or Docker image. Config hot-reloads from disk (a broken edit keeps the last good config). `cartapel check` validates the bundle in CI. Optional `public_role` for kiosk/demo access. |

## Security model, in short

Sessions are HMAC-signed HttpOnly cookies; passwords are argon2id; login is
rate-limited. Every SQL identifier is validated against the introspected
schema and every value is a bound parameter. Secret-shaped columns (`*token*`,
`*secret*`, `*password*`, …) are auto-masked for **everyone, admins included**.
Dashboard SQL runs `READ ONLY` with statement timeouts; webhook actions are
HMAC-signed. Details: [docs → Security](https://docs.cartapel.com/security).

## Build from source

```bash
cd ui && pnpm install && pnpm build && cd ..   # SPA, embedded into the binary
cargo build --release                          # → target/release/cartapel
```

## The name

A *cartapel* is old Spanish for the bundle of papers that holds all the
records. That's the job: one place where everything in your database is
findable, readable and safely editable.

MIT licensed.
