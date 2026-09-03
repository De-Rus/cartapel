---
description: "Every source type cartapel can read from, with a working example each: Postgres, MySQL & MariaDB, ClickHouse, Grafana, files and S3-compatible storage, HTTP."
---

# Data sources

A **source** is anything cartapel reads rows from. Declare one with a
`source "alias" { }` block in `config/cartapel.hcl`:

```hcl
source "main" {
  type    = "postgres"
  url     = "env:CARTAPEL_DB"
  primary = true
}
```

| Key | Description |
| --- | --- |
| `type` | `postgres`, `mysql` (`mariadb` also works), `clickhouse`, `grafana`, `http`, `files`, or `s3`. |
| `url` | Connection string or endpoint. Accepts `env:NAME` / `${NAME}`. |
| `primary` | The source cartapel introspects and shows in the sidebar. Implied with a single database source. |
| `roles` | Restrict who can see this source. Omit → admin only, once *any* source sets `roles`. |

No `source` block at all → `--db` / `CARTAPEL_DB` becomes the primary implicitly.
A table points at a non-default source with
[`from { source = "…" }`](/configuration/tables#from-—-serve-from-another-source).

## Postgres

```hcl
source "main" {
  type    = "postgres"
  url     = "env:CARTAPEL_DB"    # postgres://user:pass@host:5432/db
  schemas = ["public"]           # default
  primary = true
}
```

- `schemas` — every schema to introspect; `from { schema = "…" }` picks between them on name clashes.
- Connection params (`sslmode=require`, …) go in the URL — cartapel doesn't reinterpret them.
- Behind a transaction-mode pooler (Supabase pgbouncer, port `6543`): see [connection pooling](/deployment#connection-pooling-note).

## MySQL & MariaDB

```hcl
source "main" {
  type = "mysql"        # or CARTAPEL_DB=mysql://… with no type at all
  url  = "env:CARTAPEL_DB"    # mysql://user:pass@host:3306/db
}
```

- MySQL 8.0+ / MariaDB 10.6+. No `schemas` — scoped to the URL's database.
- `tinyint(1)` → boolean, `enum` → text, unsigned ids read losslessly.
- No array columns. Upsert import is refused on a table with a row filter.
- Create the user with `mysql_native_password` — MariaDB's `ed25519` plugin isn't supported.

## ClickHouse

Read-only by construction — no write path exists for this source.

```hcl
source "events" {
  type = "clickhouse"
  url  = "env:CLICKHOUSE_URL"    # clickhouse://user:pass@host:8123/db
}
```

- Addresses the HTTP interface (port `8123`); empty username → `default`.
- Every query runs with `readonly=1`, a statement timeout, a row cap.
- MergeTree has no unique PK — a detail page shows the first matching row.

## Grafana

```hcl
source "grafana" {
  type      = "grafana"
  url       = "http://grafana:3000"
  token_env = "GRAFANA_TOKEN"    # service-account token, Viewer role is enough
}
```

Panels reference it by name with a `ds` (datasource) and an `expr` — full
examples in [Grafana panels](/configuration/grafana-panels).
The token is attached server-side; the browser never sees Grafana directly.

## Files & S3 — a storage backend as rows

`pattern` maps path segments to columns, so a directory or a bucket reads as
a table with no scanner to write.

```hcl
source "cache" {
  type    = "files"
  root    = "env:CACHE_DIR"
  pattern = "{source}/{symbol}/{tf}.parquet"
}
```

```hcl
source "ohlcv" {
  type           = "s3"
  endpoint       = "env:AWS_ENDPOINT_URL"
  bucket         = "feed-cache"
  region         = "auto"                # R2 wants this
  pattern        = "{source}/{symbol}/{tf}.parquet"
  access_key_env = "R2_ACCESS_KEY_ID"
  secret_key_env = "R2_SECRET_ACCESS_KEY"
}
```

| Key | Applies to | Description |
| --- | --- | --- |
| `root` | files | Directory the listing is confined to. |
| `pattern` | both | Path template; each `{name}` captures a column. |
| `prefix` | s3 | Server-side key filter, stripped before matching `pattern`. |
| `max_entries` | both | Rows a listing *returns*. Default 5000. |
| `max_scan` | s3 | Objects a refresh *walks* before stopping. Default 50000 — not the same cap as `max_entries`. |
| `ttl_secs` | both | How long a listing is cached. Default 60. |

Metadata only — names, sizes, mtimes (`bytes`, `modified_ms`, `path` columns);
file/object **contents** are never read. Need contents? Write an
[`http`](#http) source instead.

Writing a *new* file — not listing existing ones — is a field concern:
[Uploads & file storage](/configuration/uploads).

## HTTP

The extension point: a server-side `GET`, JSON response rendered as rows.

```hcl
source "pricing" {
  type      = "http"
  url       = "https://internal-pricing.example.com/api"
  token_env = "PRICING_API_TOKEN"    # attached under `header`, default x-admin-token
}
```

A panel pairs it with `path` (sub-path) / `rows_at` (dotted path to the array) —
see [Dashboard → panel keys](/configuration/dashboard#where-a-panel-reads-from).
