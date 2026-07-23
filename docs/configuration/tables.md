# Tables

A `screen.hcl` registers one database table with the panel and describes how it
renders. It lives in a table folder under a group — `screens/<group>/<table>/screen.hcl`
— and the **folder name is the table name**: `screens/sales/orders/screen.hcl`
configures the `orders` table. An empty `screen.hcl` is valid — the table then
renders entirely from introspected defaults.

Only tables with a `screen.hcl` are exposed. See
[the allowlist model](/configuration/overview#layout-config-screens).

## Anatomy

A complete table config is made of a handful of optional blocks:

```hcl
label        = "product"           # singular label
label_plural = "Products"          # plural label (nav + list heading)

list      { … }        # the list view: columns, search, filters, sort
display   { … }         # the record title template
detail    { … }         # the detail-view layout (sections, sidebar, mode)
edit      { … }         # readonly columns on the edit form
relations { … }         # inline child tables
permissions { … }       # create / update / delete gates

field  "col" { … }      # per-column widget & presentation (repeatable)
action "name" { … }     # bulk actions (repeatable)
```

Everything below is optional; leave a block out and steward uses a sensible
introspected default.

## `list { }` — the list view

```hcl
list {
  columns = ["id", "name", "sku", "price", "active"]
  search  = ["name", "sku"]
  filters = ["active"]
  sort    = "-id"
  per_page = 50

  filter_def "never_ordered" {
    label = "Never ordered"
    sql   = "NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = t.id)"
  }
}
```

| Key | Type | Description |
| --- | --- | --- |
| `columns` | list | Columns shown in the list, in order. Omit → all introspected columns. |
| `search` | list | Columns the search box matches against. |
| `filters` | list | Filterable columns. A name here that matches a `filter_def` uses that custom filter; otherwise it filters on the column's own values. |
| `sort` | string | Default sort column. Prefix with `-` for descending (`"-created_at"`). |
| `per_page` | number | Page size for this table (overrides the global `per_page`). |
| `filter_def "name" { }` | block | A custom filter: a `label` plus a raw `sql` predicate. |

### Custom filters

A `filter_def` is a named boolean predicate. The `sql` is a trusted fragment
from your config (never user input) and can reference the current table as `t`:

```hcl
filter_def "needs_attention" {
  label = "Needs attention"
  sql   = "t.status = 'past_due' OR (t.renews_at IS NOT NULL AND t.renews_at < now() + interval '7 days')"
}
```

List `"needs_attention"` in `filters` to surface it as a toggle in the UI.

## `display { }` — the record title

```hcl
display {
  title = "{name} · {country}"
}
```

`title` is a template with `{column}` placeholders, used wherever a single
record needs a human label (detail heading, breadcrumbs, inline row labels).
Omit it and steward falls back to the primary key.

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
  write  = true      # write (update) — default true
}
```

| Key | Default | Description |
| --- | --- | --- |
| `create` | `true` | Whether new rows can be created. |
| `delete` | `true` | Whether rows can be deleted. |
| `write` | `true` | Whether existing rows can be updated. |

These are the **ceiling** for the whole table. A role can only ever narrow them
further — never widen them. A structurally read-only table (a view, or a table
with no primary key) is read-only regardless of what you set here.

## `detail { }` — the record layout

Detail views get their own page: [Detail views](/configuration/detail-views).
In brief:

```hcl
detail {
  mode    = "page"        # "page" | "drawer" | "modal"
  columns = 2
  section {
    title  = "Identity"
    fields = ["id", "name", "email", "country"]
  }
  section {
    title  = "Status"
    fields = ["plan", "active"]
  }
}
```

## `relations { }` — inline child tables

Also covered in [Detail views](/configuration/detail-views#inlines):

```hcl
relations {
  inlines = ["orders", "subscriptions"]
}
```

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
  kind    = "update"                       # "update" | "delete" | "webhook"
  set     = { active = false }             # for kind = "update"
  confirm = "Deactivate {count} products?"
  danger  = false
}
```

| Key | Type | Description |
| --- | --- | --- |
| `label` | string | Button label. **Required.** |
| `kind` | enum | `update`, `delete`, or `webhook`. **Required.** |
| `set` | map | For `update`: the column → value assignments applied to selected rows. |
| `url` | string | For `webhook`: the endpoint to call with the selected primary keys. |
| `method` | string | For `webhook`: HTTP method (default `POST`). |
| `confirm` | string | Confirmation prompt. `{count}` interpolates the selection size. |
| `danger` | bool | Style the action as destructive (red). |

- **`update`** runs a single parameterized `UPDATE … SET … WHERE pk IN (…)`.
- **`delete`** deletes the selected rows.
- **`webhook`** POSTs the selected primary keys to `url` — an escape hatch into
  your real backend. Signed with `X-Steward-Signature` (HMAC-SHA256) when
  `STEWARD_WEBHOOK_SECRET` is set. See [Security](/security#webhook-actions).

Which roles may invoke an action is controlled in `config/auth.hcl` via the role's
`actions` list, entries of the form `"<table>.<action>"`.

## A full example

From the reference config, lightly abridged:

```hcl
# screens/sales/orders/screen.hcl
label        = "order"
label_plural = "Orders"

list {
  columns  = ["id", "customer_id", "status", "total", "item_count", "placed_at"]
  search   = ["status"]
  filters  = ["status"]
  sort     = "-placed_at"

  filter_def "needs_attention" {
    label = "Needs attention"
    sql   = "t.status = 'pending' AND t.placed_at < now() - interval '2 days'"
  }
}

display { title = "Order #{id}" }

detail {
  section { title = "Identity"  fields = ["id", "customer_id", "status"] }
  section { title = "Amounts"   fields = ["total", "item_count", "placed_at"] }
}

edit        { readonly = ["id", "customer_id", "placed_at"] }
relations   { inlines  = ["order_items"] }
permissions { create = false, delete = false }

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
