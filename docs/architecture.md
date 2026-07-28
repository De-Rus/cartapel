---
description: "How cartapel works inside: one Rust binary, introspection, hot-reloadable HCL config, SQLite app state and the request path."
---

# Architecture

cartapel is deliberately small: **one binary, three stores**. The binary serves
everything; the stores it touches are **your Postgres** (read-mostly — written
only when a user edits data), **cartapel's own SQLite state** (users, sessions,
audit, config history), and **the config directory** (files, hot-reloaded).
This page explains how those pieces fit together.

## The self-contained binary

The whole product ships in one executable:

- A Rust HTTP server (axum) that introspects your schema and serves a JSON API.
- The admin **single-page app**, compiled once and **embedded into the binary** —
  there is no Node runtime at serve time and no static-file directory to deploy.
- Everything the panel needs beyond your database is either in the binary or in
  the config bundle.

At startup cartapel:

1. Loads and validates the config directory.
2. Connects to Postgres and **introspects** the configured schema(s) — columns,
   types, primary keys, foreign keys.
3. Opens (or creates) its SQLite state directory and bootstraps an admin user if
   there are none.
4. Serves the SPA, the API under `{base}/api`, and static assets under
   `{base}/static`.

## Three stores, strictly apart

- **Your Postgres** — the data you administer. Read-mostly: cartapel only ever
  writes to it in response to a user editing a row, running an action, or
  importing data.
- **cartapel's SQLite state** (`--data`) — its own bookkeeping, never mixed into
  your database:
  - **users** — panel accounts (argon2id password hashes).
  - **sessions** — active login sessions.
  - **saved_views** — saved list filters, personal or shared with the whole team.
  - **audit_log** — every write, with actor, timestamp and before/after diffs.
  - **config_versions** — the history of config edits (see below).
- **The config directory** (`--config`) — plain files, described next.

This separation is the reason cartapel is safe to point at a production database:
its own state never contaminates yours.

## The config bundle

The `--config` directory is a portable, self-contained bundle: HCL config,
role/permission definitions, dashboards, named queries, and any custom widget
JavaScript, all in one folder. It reads like the sidebar — one folder per
navigation group plus the reserved `config/`. See
[Configuration overview](/configuration/overview).

Because the bundle is just files, it is naturally versioned in your repo and
reviewable in pull requests.

## Config hot-reload

The config directory is **watched** (notify-based, `.hcl` files and the
custom widget `.js` under `config/widgets/`): edits from your editor, a `git checkout` or a volume
sync all hot-swap the live configuration with no restart. In-app builder edits
don't need the watcher — they are trial-parsed, written atomically (temp file +
rename) and reloaded synchronously; the watcher just re-runs an idempotent load
after them. The swap is safe by construction:

- The whole directory is re-read on every change; if that load fails, the
  previous good config is kept and the error is logged.
- Disk events are debounced (a save's tmp-write + rename collapse to one
  reload).

A bad edit therefore can never replace the running config.

## Config versioning

When the config directory is writable, every applied edit is snapshotted into the
SQLite `config_versions` table — no git dependency required. For each table (and
for the dashboard) you get:

- A **history** of versions with actor and timestamp.
- The **published** version currently in effect.
- **Rollback** — republish an older version. It is trial-parsed first, so a
  version that no longer parses against the current schema is refused rather than
  applied.

This is admin-only, and every publish is itself audited.

## The visual builder

cartapel ships an in-app configuration UI that is a first-class alternative to
hand-editing HCL. It offers:

- **Table config editors** — list columns, field widgets and params with a live
  preview, detail sections, permissions, and actions — plus a raw-HCL editor for
  each table.
- **Discover tables** — a list of introspected tables that have no config yet, to
  register with one click.
- **Groups editor** — create/rename/reorder groups and drag tables between them.
- **Dashboard editor** — build widgets with a preview that runs the query
  read-only without saving.
- **Roles matrix** — the granular per-table permission grid.
- **Config version history** — browse and roll back.

The builder reads and writes the exact same HCL as your files: it returns both
the raw text and a parsed model, and edits round-trip back to canonical HCL.
(Round-tripping through the visual model regenerates HCL and drops comments — edit
raw HCL when you want to preserve them.) When the bundle is read-only, the builder
becomes a read-only viewer that hands you the HCL to commit yourself.

## Request path, in brief

```
Browser ──▶ {base}/api/*        JSON API (auth, meta, rows, config, dashboard, queries)
        ──▶ {base}/static/*     path-confined bundle assets (widget/page JS, logos)
        ──▶ {base}/assets/*     the hashed SPA bundle (immutable, cached for a year)
        ──▶ {base}/*            the embedded SPA (client-side routing)
        ──▶ /                   redirects to {base}/
```

Every API call carries the signed session cookie; every mutation additionally
carries the `X-Cartapel` CSRF header. See [Security](/security).

## Runtime mount path — one build, any prefix

`{base}` above is the runtime `--base-path` / `CARTAPEL_BASE_PATH` (default
`/admin`, `''` for the domain root). It is **not baked in at build time**: Vite
builds with `base: '/'`, and the server injects the live prefix into
`index.html` at serve time — it replaces a placeholder so the SPA reads
`window.__CARTAPEL_BASE__` and threads it through the router basename, the API
base, and every link. Asset URLs follow the same rule: the server rewrites
`index.html`'s entry references to `{base}/assets/…`, and lazy JS chunks resolve
through `window.__cartapelAsset` — so *everything* lives under the prefix and a
sub-path reverse proxy only ever forwards `{base}/*`. The API and static routes
are nested under the prefix; `GET /` redirects to it.

The upshot: **one published image serves under any path with no rebuild** — pull
`ghcr.io/de-rus/cartapel` and set `CARTAPEL_BASE_PATH` to `/admin`, `/panel`, or
`''`. See [Deployment](/deployment#base-path-and-mounting).
