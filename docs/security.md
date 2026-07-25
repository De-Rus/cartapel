# Security model

steward is designed to sit in front of a production database, so its defaults are
conservative: it never writes to your database on its own, every value is a bound
parameter, and reads that could leak data are gated by roles.

## Secret key

steward signs its session cookies with an app secret. **It is required** —
steward refuses to start without one.

Resolution order at startup:

1. `STEWARD_SECRET_KEY` environment variable.
2. `[steward].secret_key` in `config/steward.hcl` (env-interpolated, e.g.
   `secret_key = "env:STEWARD_SECRET_KEY"`).

Prefer the environment variable or `${...}` interpolation — never commit a
literal key. Rotating the key invalidates all existing sessions (everyone
re-logs-in once).

```bash
export STEWARD_SECRET_KEY="$(openssl rand -hex 32)"
```

## Sessions & cookies

- The session cookie is `HttpOnly` and `SameSite=Lax`, and (by default) `Secure`.
- Its value is HMAC-SHA256-signed with the secret key. The signature is verified
  in constant time **before any database session lookup**, so a tampered or
  unsigned cookie is treated as no session.
- Every route except login requires a valid session (returns 401 otherwise).
- Behind HTTPS, keep `--secure-cookies` on (the default). For local plain-HTTP
  development, pass `--secure-cookies=false`.

## CSRF

Every mutating request (POST / PATCH / DELETE) must carry the `X-Steward: 1`
header. The bundled SPA sends it automatically; the `api` object injected into
custom widgets and pages sends it for you too.

## Authentication

- Passwords are hashed with **argon2id**.
- Login is **rate-limited per IP** — repeated failures are throttled.

## Column masking

A column can be masked three ways, and all are protected end to end:

- **Automatically** — a column whose name looks secret-shaped (contains
  `token`, `secret`, `password`, `passwd`, `api_key`, `apikey` or
  `private_key`) is masked by default for **everyone, admins included**.
  Declaring a `field` block on the column hands control back to you.
- **Per field** — `masked = true` in a table config. The author's call — it
  also binds admins.
- **Per role** — `masked` in `config/auth.hcl`, hiding the column from that
  role only. (With several roles, it holds only when every view-granting
  role masks it.)

Whichever way a column is masked:

- Its value is returned pre-masked (e.g. `a3f…`), never in the clear.
- It is skipped in global search and in the record title.
- It is rejected as a sort key and as a filter key.
- It is masked in CSV/JSON exports.

Use it for tokens, wallets, secrets and PII you want visible to some roles but
not others.

## Row-level filters

A role's `row_filter` predicate is ANDed into the `WHERE` clause of every query
that touches the table — list, count, search, and the `WHERE` of bulk updates and
imports. A scoped user can never read or write a row outside their filter. When a
filter, search or row-filter applies, `count(*)` is still computed exactly. With
several roles, per-role filters OR together — a view-granting role with no
filter lifts the restriction for that table. See
[Roles & permissions](/roles-and-permissions#multiple-roles-per-user).

## SQL safety

- Every SQL **identifier** (table, column) is validated against the introspected
  schema. An unknown column is a 400; a masked column used where it may not be is
  a 403. No request string is ever interpolated as an identifier.
- Every **value** is a bound parameter cast to the column's real Postgres type.
- Raw-SQL fragments (`filter_def` predicates, computed-column `sql`, `row_filter`,
  dashboard and named-query SQL) exist only in your config files — which live in
  your repo and are trusted like code, not accepted from the browser.
- Dashboard and named-query SQL run in **`READ ONLY` transactions with a
  statement timeout**, so a widget can never mutate data or run away.

## The admin gate

Access management, config editing, config-version history, the discover flow and
the audit log are **admin-only** — every one of those endpoints returns 403 for a
non-admin caller.

## Static-asset path confinement

Custom widget and page assets are served from the config bundle at `{base}/static/*`,
but only safely:

- Directory traversal (`..`) and out-of-tree symlinks are rejected.
- Only an extension allowlist is served: `js`, `mjs`, `css`, `svg`, `png`,
  `webp`, `jpg`, `jpeg`, `gif`, `ico`.
- Config and secret material (`.hcl`, `.toml`, `.env`, dotfiles) is **never**
  served.

Config-write paths apply the same discipline: they reject `/`, `\`, `..` and the
reserved stems (`config`, `_group`, `page`, `queries`).

## Webhook actions

A `kind = "webhook"` action proxies the selected primary keys to a URL you
configure — an escape hatch into your real backend rather than a direct DB write.
When `STEWARD_WEBHOOK_SECRET` is set, outbound webhooks are signed with an
`X-Steward-Signature` (HMAC-SHA256) header your backend can verify. Webhooks
can be disabled outright with `disable_webhooks` — see
[Hardening toggles](#hardening-toggles).

## Audit log

Every write — create, update, delete, bulk action, config change, user/role
change — is recorded in steward's SQLite audit log with actor, timestamp and, for
row edits, a before/after diff. Per-record history is available on each detail
view; the full log is an admin-only view.

### One-click revert

An audited **field edit** (an `update`, or a previous `revert`) can be reverted
in one click from the record's history or the audit log. Guardrails:

- **Admin-only** — and the revert still passes through the normal update path,
  so table permissions, row filters and masking all apply.
- **Refused on drift (409)** — if any affected column has changed since the
  audited edit, the revert is rejected with a conflict. Staleness is enforced
  inside the `UPDATE`'s own `WHERE` clause, never check-then-act.
- **A revert is itself audited** as a `revert` entry with its own diff — so it
  can be reverted in turn, and the UI offers an immediate undo toast.

## Hardening toggles

Two opt-in switches in `config/steward.hcl` narrow the surface further:

- `disable_sql_preview = true` — disables the dashboard builder's ad-hoc SQL
  preview, blocking arbitrary read-SQL even for admins.
- `disable_webhooks = true` — disables outbound webhook actions entirely (an
  SSRF surface).

Both default to `false`. See the globals table in the
[configuration overview](/configuration/overview).
