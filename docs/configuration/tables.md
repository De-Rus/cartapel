---
description: "Register a table and shape its list: columns, search, filters, sort, display titles and permissions ceilings."
---

# Tables

A `screen.hcl` registers one database table with the panel and describes how it
renders. It lives in a table folder under a group — `screens/<group>/<table>/screen.hcl`
— and the **folder name is the table name**: `screens/sales/orders/screen.hcl`
configures the `orders` table. An empty `screen.hcl` is valid — the table then
renders entirely from introspected defaults.

Only tables with a `screen.hcl` are exposed. See
[the allowlist model](/configuration/overview#layout-config-screens).

## A worked example

The 80% case: pick list columns, wire up search/filters/sort, style a column or
two, and cap what can be changed. From the reference config, lightly abridged:

```hcl
# screens/sales/orders/screen.hcl
label        = "order"
label_plural = "Orders"

list {
  columns  = ["id", "customer_id", "status", "total", "item_count", "placed_at"]
  search   = ["status"]
  filters  = ["status"]
  sort     = "-placed_at"

  filter "needs_attention" {
    label = "Needs attention"
    sql   = "t.status = 'pending' AND t.placed_at < now() - interval '2 days'"
  }
}

display {
  title = "Order #{id}"
}

detail {
  section {
    title  = "Identity"
    fields = ["id", "customer_id", "status"]
  }
  section {
    title  = "Amounts"
    fields = ["total", "item_count", "placed_at"]
  }
}

edit {
  readonly = ["id", "customer_id", "placed_at"]
}

relations {
  inlines = ["order_items"]
}

permissions {
  create = false
  delete = false
}

field "status" {
  widget = "badge"
  params = { colors = { pending = "gray", paid = "blue", shipped = "green", refunded = "orange", cancelled = "red" } }
}

field "item_count" {
  label  = "Items"
  widget = "custom:minibar"
  sql    = "(SELECT count(*) FROM order_items oi WHERE oi.order_id = t.id)::int"
  params = { field = "item_count", max = 10, warn_at = 8 }
}

action "refund" {
  label   = "Refund"
  kind    = "update"
  set     = { status = "refunded" }
  confirm = "Refund {count} orders? This is a demo — no money moves."
  danger  = true
}
```

## Reference: everything a `screen.hcl` can hold

Every entry is optional; leave it out and cartapel uses a sensible introspected
default.

| Key | Type | Description |
| --- | --- | --- |
| `label` / `label_plural` | string | Singular / plural label (nav + list heading). Default: the humanized table name. |
| `labels` / `labels_plural` | map | Per-locale label overrides; the instance `locale` picks one. See [Localization](/localization). |
| `from { }` | block | Serve from another postgres source / schema / physical table (see below). |
| `list { }` | block | The list view: columns, search, filters, sort, page size. |
| `display { }` | block | The record title template. |
| `detail { }` | block | The detail-view layout — [Detail views](/configuration/detail-views). |
| `edit { }` | block | Columns read-only on the edit form. |
| `relations { }` | block | Inline child tables — [Inlines](/configuration/detail-views#inlines). |
| `permissions { }` | block | Create / update / delete / export ceilings for the whole table. |
| `field "col" { }` | block | Per-column widget & presentation (repeatable) — [Fields & widgets](/configuration/fields-and-widgets). |
| `action "name" { }` | block | Bulk actions (repeatable). |

## `list { }` — the list view

```hcl
list {
  columns  = ["id", "name", "sku", "price", "active"]
  search   = ["name", "sku"]
  filters  = ["active"]
  sort     = "-id"
  per_page = 50
}
```

| Key | Type | Description |
| --- | --- | --- |
| `columns` | list | Columns shown in the list, in order. Omit → the primary key plus the first few introspected columns (six total, JSON and binary columns skipped). |
| `search` | list | Columns the search box matches against. Omit → the first four text columns. |
| `filters` | list | Which filters are available. **Omit it → every real column is filterable**, the "+ Filter" picker lists them all. **Set it → it's the whole allowlist**: only the named filters exist, on the picker *and* on the API — anything else is rejected, even a real unmasked column. A name matching a `filter "name" { }` block surfaces that custom filter instead of a column. Masked columns can never be filtered, for anyone, regardless of `filters`. |
| `sort` | string | Default sort column. Prefix with `-` for descending (`"-created_at"`). Omit → the primary key, descending (pk-less tables: the first column, ascending). |
| `per_page` | number | Page size for this table (overrides the global `per_page`; `100` when neither is set). |
| `filter "name" { }` | block | A custom filter: a `label` plus a raw `sql` predicate. |

### Custom filters

A `filter` block is a named boolean predicate. The `sql` is a trusted fragment
from your config (never user input) and can reference the current table as `t`:

```hcl
filter "needs_attention" {
  label = "Needs attention"
  sql   = "t.status = 'past_due' OR (t.renews_at IS NOT NULL AND t.renews_at < now() + interval '7 days')"
}
```

List `"needs_attention"` in `filters` to surface it as an on/off chip in the "+ Filter" picker. Every active filter — real column or custom — combines with the others using **AND**.

Locking a table down to just a couple of filters (real or custom) is one line:

```hcl
list {
  filters = ["status", "needs_attention"]   # only these two are filterable at all
}
```

## `display { }` — the record title

```hcl
display {
  title = "{name} · {country}"
}
```

`title` is a template with `{column}` placeholders, used wherever a single
record needs a human label (detail heading, breadcrumbs, inline row labels).
Omit it and cartapel picks a name-ish text column (`name`, `title`, `email`, `username`, …) when one exists; otherwise the title is `Label #pk` ("Subscription #8"), never a bare id.

## `edit { }` — read-only columns

```hcl
edit {
  readonly = ["id", "customer_id", "placed_at"]
}
```

`readonly` columns render on the detail/edit form but cannot be changed. This is
distinct from role-level `editable` whitelists (see
[Roles & permissions](/roles-and-permissions)) — `edit.readonly` applies to
everyone.

## `permissions { }` — table-level gates

```hcl
permissions {
  create = false
  delete = false
  write  = true
  export = false
}
```

| Key | Default | Description |
| --- | --- | --- |
| `create` | `true` | Whether new rows can be created. |
| `delete` | `true` | Whether rows can be deleted. |
| `write` | `true` | Whether existing rows can be updated. |
| `export` | `true` | Whether the whole result set can be downloaded as CSV/JSON. |

`export` is separate from `write` on purpose: a table can be perfectly safe to
read a page at a time and unsafe to carry out of the building in bulk. Masking
and role `row_filter`s apply to an export exactly as they do to a list, so an
export never reveals more than the screen does — but it does remove up to
100,000 rows of it at once. Every export is recorded in the
[audit log](/security#audit-log) with the row count and the active filter.

These are the **ceiling** for the whole table. A role can only ever narrow them
further — never widen them. A structurally read-only table (a view, or a table
with no primary key) is read-only regardless of what you set here.

## `from { }` — serve from another source

```hcl
from {
  source = "replica"
  schema = "billing"
  table  = "orders_v"
}
```

All three keys are optional: `source` names another postgres `source` (an
unknown or non-postgres alias is a load error), `schema` and `table` point at
the physical relation when they differ from the defaults (primary source,
introspected schemas, folder name).

## `detail { }` and `relations { }`

Detail layout (sections, sidebar, stats, tabs, mode) and inline child tables
have their own page: [Detail views](/configuration/detail-views). Two things
worth knowing from here:

- With no `relations` block at all, cartapel derives **zero-config inlines**
  from introspected reverse foreign keys — every exposed table pointing at this
  one becomes an inline. `auto = false` opts out.
- An `inlines` entry is a table name (`"order_items"`) or a full object
  (`{ table = "...", fk_col = "...", columns = [...], can_create = false, can_delete = false }`).

## `field "col" { }` — per-column presentation

Each `field` block styles one column: its widget, formatting, color rules,
computed SQL, and more. This is the heart of customization —
[Fields & widgets](/configuration/fields-and-widgets) covers every option.

```hcl
field "plan" {
  widget = "badge"
  params = { colors = { free = "gray", pro = "blue", enterprise = "violet" } }
}

field "active" {
  widget = "toggle"
}
```

## `action "name" { }` — bulk actions

Actions apply to the rows a user selects in the list. Three kinds:

```hcl
action "deactivate" {
  label   = "Deactivate"
  kind    = "update"
  set     = { active = false }
  confirm = "Deactivate {count} products?"
  danger  = false
}

action "resync" {
  label  = "Resync"
  kind   = "webhook"
  url    = "https://internal.example.com/hooks/resync"
  method = "POST"
}
```

| Key | Type | Description |
| --- | --- | --- |
| `label` | string | Button label. **Required.** |
| `labels` | map | Per-locale label overrides; the instance `locale` picks one. |
| `kind` | enum | `update`, `delete`, or `webhook`. **Required.** |
| `set` | map | For `update`: the column → value assignments applied to selected rows. |
| `url` | string | For `webhook`: the endpoint to call. |
| `method` | string | For `webhook`: HTTP method (default `POST`). |
| `confirm` | string | Confirmation prompt. `{count}` interpolates the selection size. |
| `danger` | bool | Style the action as destructive (red). |

- **`update`** runs a single parameterized `UPDATE … SET … WHERE pk IN (…)`.
- **`delete`** deletes the selected rows.
- **`webhook`** calls `url` with a JSON body of
  `{action, table, pks, actor, ts}` — an escape hatch into your real backend.
  Signed with `X-Cartapel-Signature` (HMAC-SHA256 of the body) when
  `CARTAPEL_WEBHOOK_SECRET` is set; disabled entirely by the
  `disable_webhooks` hardening toggle. See [Security](/security#webhook-actions).

Which roles may invoke an action is controlled in `config/auth.hcl` via the role's
`actions` list, entries of the form `"<table>.<action>"`.
