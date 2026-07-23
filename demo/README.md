# Acme demo

A self-contained example so steward has something to show on first run — and a
worked reference for how a config directory is laid out.

- [`seed.sql`](seed.sql) — schema + data for a small SaaS: `customers`,
  `products`, `orders`, `order_items`, `subscriptions` (FKs, enum-like status
  columns, money, timestamps, and one secret `api_token` column to demonstrate
  field masking).
- [`admin/`](admin/) — the config directory (`--config`):
  - `config/` — the reserved globals: `steward.hcl` (brand + the `main`
    Postgres source), `auth.hcl` (a read-only `demo` role — the public login —
    plus a `support` role, both masking `subscriptions.api_token`),
    `dashboard.hcl` (stat tiles + a bar chart + a recent-orders table).
  - `screens/` — one folder per sidebar group (`_group.hcl`), each holding a
    folder per table with its `screen.hcl` (currency formatting, filters, and
    `update` actions like "Mark shipped"):
    - `screens/customers/{customers,subscriptions}/screen.hcl`
    - `screens/catalog/products/screen.hcl`
    - `screens/sales/{orders,order_items}/screen.hcl`
    - `screens/overview/summary/` — a **scripted page** (`screen.hcl` with
      `module = "summary.tsx"` + the `summary.tsx` module) built on the `sx` SDK.

Run it from the repo root with `docker compose up`, then open
http://localhost:8686/admin (`demo` / `demo`).

## Hosting a public demo safely

The `demo` login is **read-only** (view everything; no create/edit/delete,
actions, dashboard-SQL, config edits, or user management — those are all
admin-only), so an "anyone can log in" demo can't be defaced or used to run
arbitrary SQL. The hosted demo bootstraps it via `STEWARD_ADMIN_ROLE=demo`.
[`reset.sql`](reset.sql) re-seeds the data on demand (optional — schedule it via
`pg_cron` or an hourly cron if you also expose an admin login).
