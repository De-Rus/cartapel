---
description: "Every cartapel subcommand, flag and environment variable — serve, user management, and the CI-ready config validator."
---

# CLI & environment

cartapel is one binary with three subcommands:

```bash
cartapel serve --db postgres://… --config ./admin      # run the panel
cartapel user add you@example.com --role support       # create/update a user (offline)
cartapel check --config ./admin --db postgres://…      # validate config — CI-ready
```

Every `serve` and `check` flag has a matching environment variable, so in a
container you can drive them entirely from the environment.

## `cartapel serve`

Runs the admin server.

```bash
cartapel serve \
  --db postgres://user:pass@host:5432/mydb \
  --schema public \
  --config ./admin \
  --data ./cartapel-data \
  --listen 0.0.0.0:8686
# → panel on http://0.0.0.0:8686/admin  (the default mount path)
```

| Flag | Env var | Default | Description |
| --- | --- | --- | --- |
| `--db` | `CARTAPEL_DB` | — | Postgres connection URL. Falls back to the URL of the `primary` `source` in `config/cartapel.hcl` (which supports `env:NAME` / `${NAME}` interpolation). |
| `--schema` | `CARTAPEL_SCHEMA` | `public` | Schema to introspect. Falls back to the primary source's `schemas` list. |
| `--config` | `CARTAPEL_CONFIG` | — | Directory of HCL config files. Optional — without it, no tables are exposed. |
| `--data` | `CARTAPEL_DATA` | `./cartapel-data` | Directory for cartapel's own SQLite state (users, sessions, audit, config history). |
| `--base-path` | `CARTAPEL_BASE_PATH` | `/admin` | URL prefix the panel is served under. Injected into the SPA at runtime, so one build serves any prefix. A trailing slash is trimmed; pass `''` (or `/`) to serve at the domain root. |
| `--listen` | `CARTAPEL_LISTEN` | `127.0.0.1:8686` | Address and port to bind. |
| `--secure-cookies` | `CARTAPEL_SECURE_COOKIES` | `true` | Sets the `Secure` attribute on session cookies. Keep on behind HTTPS; pass `--secure-cookies=false` for local plain-HTTP development. |

The connection URL and schema resolve in this order: **CLI flag → environment
variable → config file**.

When more than one schema is introspected, a table name that is unique across
them keeps its bare key; a name that collides is keyed as `schema.table`.

## `cartapel user add`

<details>
<summary>Show</summary>

Create or update a panel user without the server running. Useful for
provisioning and password resets.

```bash
cartapel user add <email> [--role <role>] [--password <pw>] [--data <dir>]
```

| Argument / flag | Env var | Default | Description |
| --- | --- | --- | --- |
| `<email>` | — | — | The user's email (lowercased on save). Positional, required. |
| `--role` | — | `admin` | Role(s) to assign — comma-separate for several (`support,billing`; permissions union). Not validated offline: a name with no matching role in `auth.hcl` simply grants nothing. |
| `--password` | `CARTAPEL_PASSWORD` | *generated* | The password. When omitted, a strong random password is generated and printed once. |
| `--data` | `CARTAPEL_DATA` | `./cartapel-data` | The state directory to write to. |

Running `user add` for an existing email updates that user's role and/or
password.

</details>

## `cartapel check`

<details>
<summary>Show</summary>

Validate a config directory without running the server. Exit 0 = valid; exit 1
with the errors printed — ready for CI.

```bash
cartapel check --config ./admin                    # parse + validate the bundle
cartapel check --config ./admin --db postgres://…  # + verify every configured
                                                  #   table/column against the
                                                  #   live schema
```

| Flag | Env var | Default | Description |
| --- | --- | --- | --- |
| `--config` | `CARTAPEL_CONFIG` | — | The config directory to validate. Required. |
| `--db` | `CARTAPEL_DB` | — | When given, every configured table is verified to exist, and list/search/sort/readonly columns are verified to be real columns. |
| `--schema` | `CARTAPEL_SCHEMA` | primary source's `schemas` | Narrows the live check to one schema. |

Run it in CI next to your migrations: config drift against a schema change
becomes a red build instead of a silently broken panel.

</details>

## `cartapel i18n extract`

<details>
<summary>Show</summary>

Prints the `config/i18n/<locale>.hcl` stub for everything the locale has not
translated yet — group, table, field, filter, action, section, page and panel
names, in config order — ready to fill in. See [Localization](/localization).

```bash
cartapel i18n extract --config ./admin --locale es                  # from the config alone
cartapel i18n extract --config ./admin --locale es --db postgres://… # + the column names the panel humanizes
```

| Flag | Env var | Default | Description |
| --- | --- | --- | --- |
| `--config` | `CARTAPEL_CONFIG` | — | The config directory. Required. |
| `--locale` | — | — | The language to extract for, e.g. `es`. Required. |
| `--format` | — | `hcl` | `hcl` (with comments) or `json` (a flat object for translation tools). Both load from `config/i18n/`. |
| `--db` | `CARTAPEL_DB` | primary source url | With a Postgres URL, introspected column names are included. |
| `--schema` | `CARTAPEL_SCHEMA` | primary source's `schemas` | Narrows introspection to one schema. |

</details>

## Environment variables

<details>
<summary>Show</summary>

Beyond the per-flag variables above, cartapel reads:

| Variable | Required | Purpose |
| --- | --- | --- |
| `CARTAPEL_SECRET_KEY` | **Yes** | The app signing root for session cookies. cartapel refuses to start if this is unset **and** `[cartapel].secret_key` is also unset. See [Security](/security#secret-key). |
| `CARTAPEL_ADMIN_EMAIL` | No | Email for the bootstrap admin created on first run. Defaults to `admin@localhost`. |
| `CARTAPEL_ADMIN_PASSWORD` | No | Password for the bootstrap admin. When unset, a random one is generated and logged. |
| `CARTAPEL_ADMIN_ROLE` | No | Role(s) for the bootstrap user (comma-separate for several). Defaults to `admin`; a public demo can bootstrap a restricted role (e.g. a read-mostly `demo` role from `auth.hcl`) instead. |
| `CARTAPEL_WEBHOOK_SECRET` | No | HMAC secret for signing outbound webhook actions (`X-Cartapel-Signature`). |
| `CARTAPEL_DB_TX_POOL` | No | Set to `1` to force transaction-pooler mode (disables sqlx's prepared-statement cache). Auto-detected for Supabase's port `6543` pooler. |
| `RUST_LOG` | No | Standard `tracing` filter. Defaults to `cartapel=info,tower_http=warn`. |

::: tip Config values can read the environment
Anywhere config accepts a value, `env:NAME` or `${NAME}` is replaced with the
environment variable `NAME`. This is how you keep secrets — the DB URL, the
secret key — out of committed HCL. See
[Configuration overview](/configuration/overview#environment-interpolation).
:::

</details>

## Health check

<details>
<summary>Show</summary>

`serve` exposes an unauthenticated health endpoint for load balancers at
`{base-path}/api/health`, returning `{"ok": true}`.

</details>

