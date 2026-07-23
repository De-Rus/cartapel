# Architecture

steward is deliberately small: one Rust binary, your Postgres, and a directory of
config. This page explains how those pieces fit together.

## The self-contained binary

The whole product ships in one executable:

- A Rust HTTP server (axum) that introspects your schema and serves a JSON API.
- The admin **single-page app**, compiled once and **embedded into the binary** —
  there is no Node runtime at serve time and no static-file directory to deploy.
- Everything the panel needs beyond your database is either in the binary or in
  the config bundle.

At startup steward:

1. Loads and validates the config directory.
2. Connects to Postgres and **introspects** the configured schema(s) — columns,
   types, primary keys, foreign keys.
3. Opens (or creates) its SQLite state directory and bootstraps an admin user if
   there are none.
4. Serves the SPA, the API under `{base}/api`, and static assets under
   `{base}/static`.

## Two databases

steward touches two separate stores, and keeps them strictly apart:

- **Your Postgres** — the data you administer. steward only ever writes to it in
  response to a user editing a row, running an action, or importing data.
- **steward's SQLite state** (`--data`) — its own bookkeeping, never mixed into
  your database:
  - **users** — panel accounts (argon2id password hashes).
  - **sessions** — active login sessions.
  - **roles** — runtime-created roles (additive to config roles).
  - **saved_views** — users' saved list filters.
  - **audit_log** — every write, with actor, timestamp and before/after diffs.
  - **config_versions** — the history of config edits (see below).

This separation is the reason steward is safe to point at a production database:
its own state never contaminates yours.

## The config bundle

The `--config` directory is a portable, self-contained bundle: HCL config,
role/permission definitions, dashboards, named queries, and any custom widget or
page JavaScript, all in one folder. It reads like the sidebar — one folder per
navigation group plus the reserved `config/`. See
[Configuration overview](/configuration/overview).

Because the bundle is just files, it is naturally versioned in your repo and
reviewable in pull requests.

## Config hot-reload

Config edits made through the in-app builder **hot-swap the live configuration
with no restart**. The swap is safe by construction:

- A write is trial-parsed before it is applied.
- The whole directory is re-read; if that fails, the previous good config is
  kept.
- Files are written atomically (temp file + rename).

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

steward ships an in-app configuration UI that is a first-class alternative to
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
        ──▶ {base}/*            the embedded SPA (client-side routing)
        ──▶ /assets/*           the hashed SPA bundle (served from the root)
```

Every API call carries the signed session cookie; every mutation additionally
carries the `X-Steward` CSRF header. See [Security](/security).

## Runtime mount path — one build, any prefix

`{base}` above is the runtime `--base-path` / `STEWARD_BASE_PATH` (default
`/admin`, `''` for the domain root). It is **not baked in at build time**: Vite
builds with `base: '/'` (so the hashed bundle lives at `/assets/…`), and the
server injects the live prefix into `index.html` at serve time — it replaces a
placeholder so the SPA reads `window.__STEWARD_BASE__` and threads it through the
router basename, the API base, and every link. The API and static routes are
nested under the prefix; `GET /` redirects to it.

The upshot: **one published image serves under any path with no rebuild** — pull
`ghcr.io/de-rus/steward` and set `STEWARD_BASE_PATH` to `/admin`, `/panel`, or
`''`. See [Deployment](/deployment#base-path-and-mounting).
