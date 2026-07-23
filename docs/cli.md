# CLI & environment

steward is one binary with two subcommands: `serve` (run the panel) and `user`
(manage panel users offline). Every flag has a matching environment variable, so
you can drive it entirely from the environment in a container.

## `steward serve`

Runs the admin server.

```bash
steward serve \
  --db postgres://user:pass@host:5432/mydb \
  --schema public \
  --config ./admin \
  --data ./steward-data \
  --listen 0.0.0.0:8686
# → panel on http://0.0.0.0:8686/admin  (the default mount path)
```

| Flag | Env var | Default | Description |
| --- | --- | --- | --- |
| `--db` | `STEWARD_DB` | — | Postgres connection URL. Falls back to the URL of the `primary` `source` in `config/steward.hcl` (which supports `env:NAME` / `${NAME}` interpolation). |
| `--schema` | `STEWARD_SCHEMA` | `public` | Schema to introspect. Falls back to the primary source's `schemas` list. |
| `--config` | `STEWARD_CONFIG` | — | Directory of HCL config files. Optional — without it, no tables are exposed. |
| `--data` | `STEWARD_DATA` | `./steward-data` | Directory for steward's own SQLite state (users, sessions, audit, config history). |
| `--base-path` | `STEWARD_BASE_PATH` | `/admin` | URL prefix the panel is served under. Injected into the SPA at runtime, so one build serves any prefix. A trailing slash is trimmed; pass `''` (or `/`) to serve at the domain root. |
| `--listen` | `STEWARD_LISTEN` | `127.0.0.1:8686` | Address and port to bind. |
| `--secure-cookies` | `STEWARD_SECURE_COOKIES` | `true` | Sets the `Secure` attribute on session cookies. Keep on behind HTTPS; pass `--secure-cookies=false` for local plain-HTTP development. |

The connection URL and schema resolve in this order: **CLI flag → environment
variable → config file**. When more than one schema is introspected, a table
name that is unique across them keeps its bare key; a name that collides is keyed
as `schema.table`.

## `steward user add`

Create or update a panel user without the server running. Useful for
provisioning and password resets.

```bash
steward user add <email> [--role <role>] [--password <pw>] [--data <dir>]
```

| Argument / flag | Env var | Default | Description |
| --- | --- | --- | --- |
| `<email>` | — | — | The user's email (lowercased on save). Positional, required. |
| `--role` | — | `admin` | Role to assign. Must be a known role (`admin`, or one you define). |
| `--password` | `STEWARD_PASSWORD` | *generated* | The password. When omitted, a strong random password is generated and printed once. |
| `--data` | `STEWARD_DATA` | `./steward-data` | The state directory to write to. |

Running `user add` for an existing email updates that user's role and/or
password.

## Environment variables

Beyond the per-flag variables above, steward reads:

| Variable | Required | Purpose |
| --- | --- | --- |
| `STEWARD_SECRET_KEY` | **Yes** | The app signing root for session cookies. steward refuses to start if this is unset **and** `[steward].secret_key` is also unset. See [Security](/security#secret-key). |
| `STEWARD_ADMIN_EMAIL` | No | Email for the bootstrap admin created on first run. Defaults to `admin@localhost`. |
| `STEWARD_ADMIN_PASSWORD` | No | Password for the bootstrap admin. When unset, a random one is generated and logged. |
| `STEWARD_WEBHOOK_SECRET` | No | HMAC secret for signing outbound webhook actions (`X-Steward-Signature`). |
| `STEWARD_DB_TX_POOL` | No | Set to `1` to force transaction-pooler mode (disables sqlx's prepared-statement cache). Auto-detected for Supabase's port `6543` pooler. |
| `RUST_LOG` | No | Standard `tracing` filter. Defaults to `steward=info,tower_http=warn`. |

::: tip Config values can read the environment
Anywhere config accepts a value, `env:NAME` or `${NAME}` is replaced with the
environment variable `NAME`. This is how you keep secrets — the DB URL, the
secret key — out of committed HCL. See
[Configuration overview](/configuration/overview#environment-interpolation).
:::

## Health check

`serve` exposes an unauthenticated health endpoint for load balancers at
`{base-path}/api/health`, returning `{"ok": true}`.
