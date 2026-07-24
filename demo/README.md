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

The `demo` login is a **full admin** — visitors see the real thing (create/edit/
delete rows, run actions, browse the config builder). Two general hardening
toggles in `config/steward.hcl` disable the only capabilities that would make an
open admin dangerous:

- `disable_sql_preview = true` — no ad-hoc SQL runner in the dashboard builder
  (blocks arbitrary read-SQL / data exfiltration).
- `disable_webhooks = true` — no outbound webhook actions (blocks SSRF).

These are generic steward options — useful on any sensitive instance, not just a
demo. Defacement of the demo *data* is undone by [`reset.sql`](reset.sql), which
the [`demo-reset`](../.github/workflows/demo-reset.yml) workflow runs daily; the
config lives on the container's ephemeral disk, so config edits reset on restart
too. Point steward at a **throwaway database** for a public demo regardless.
