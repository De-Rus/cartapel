# Roles & permissions

Access is governed by **roles**. Each user has one role; a role grants access to
tables, columns, rows and actions. The authoritative roles live in
`config/auth.hcl` — versioned config you review like code. (Additional roles can
be created at runtime from the in-app builder and are stored in steward's SQLite
state; config roles always win a name collision.)

## The `admin` role

`admin` is built in. It has full access to everything and cannot be edited or
deleted. It bypasses the per-table and per-column refinements below — but it is
still bound by structural read-only-ness (a view or a PK-less table is never
writable, even for an admin).

## `config/auth.hcl`

Every role is a `role "<name>" { }` block:

```hcl
role "staff" {
  tables = {
    "*"          = "read"
    "orders"     = "write"
    "products"   = "write"
    "customers"  = "write"
  }

  actions = [
    "orders.mark_shipped",
    "orders.refund",
    "products.activate",
    "products.deactivate",
  ]

  masked = {
    "subscriptions" = ["api_token"]
  }
}
```

| Key | Type | Description |
| --- | --- | --- |
| `tables` | map | The coarse access level per table: `"read"` or `"write"`. `"*"` sets a default for every table. |
| `perm "<table>" { }` | block | Fine-grained per-capability override (view/create/update/delete). |
| `editable` | map | Per-table whitelist of columns this role may edit. |
| `actions` | list | Bulk actions this role may invoke, as `"<table>.<action>"`. |
| `masked` | map | Per-table columns whose values are hidden from this role. |
| `row_filter` | map | Per-table SQL predicate scoping which rows this role sees. |

## Coarse table access

`tables` is the baseline. Two levels:

- **`"read"`** — the role may view the table but not change it.
- **`"write"`** — the role may view, create, update and delete.

The `"*"` wildcard sets a default for all tables; per-table entries override it:

```hcl
tables = {
  "*"      = "read"      # read everything by default
  "orders" = "write"     # …but fully manage orders
}
```

## Granular capabilities (`perm`)

A `perm "<table>"` block refines the coarse level one capability at a time. Each
of `view`, `create`, `update`, `delete` is optional: unset defers to the coarse
`tables` level; set forces that value.

```hcl
role "support" {
  tables = { orders = "write" }

  perm "orders" {
    view   = true
    update = true
    create = false      # can edit rows, but not add or remove them
    delete = false
  }
}
```

The effective capability is always **intersected** with the table's own
`permissions { }` ceiling and the structural read-only gate:

```
effective = (perm.capability ?? coarse level) AND table ceiling AND not read-only
```

So `create = true` on a role means nothing if the table config sets
`permissions { create = false }` — the ceiling wins.

## Editable-column whitelist

`editable` restricts which columns a role can write, table by table. When a
table has an `editable` list, any column **not** in it is rejected on every write
path (update, create, bulk, import) — on top of the usual masked / readonly / PK
/ computed rejections. Absent means no per-column restriction.

```hcl
role "support" {
  tables   = { orders = "write" }
  editable = { orders = ["status", "total"] }   # may only change these two columns
}
```

This is orthogonal to `masked`: a column can be readable-but-not-editable, or
editable-but-masked-in-display, independently.

## Column masking

`masked` lists columns whose values this role should not see. Masked values come
back pre-masked (never the real value), are excluded from search and export, and
cannot be used as a sort key.

```hcl
masked = {
  "subscriptions" = ["api_token"]
}
```

See [Security → Column masking](/security#column-masking).

## Row-level filters

`row_filter` scopes a role to a subset of rows via a SQL predicate that is ANDed
into every query touching that table — list, count, search, and writes. A user
can never see or touch a row outside their filter.

```hcl
role "support" {
  tables     = { "*" = "read" }
  row_filter = {
    "customers" = "t.active AND t.plan <> 'free'"
  }
}
```

The current row is aliased `t`. The token `{actor.email}` is substituted with the
signed-in user's email (safely escaped), so you can scope rows to their owner:

```hcl
row_filter = {
  "orders" = "t.customer_id IN (SELECT id FROM customers WHERE email = '{actor.email}')"
}
```

## Actions

`actions` lists which bulk actions the role can invoke, each as
`"<table>.<action>"` matching an `action "…"` block in that table's config. A
role can only run actions listed here.

```hcl
actions = ["orders.mark_shipped", "orders.refund", "products.deactivate"]
```

## Managing roles & users at runtime

Admins can manage roles and users from the in-app access screens (backed by
steward's SQLite state, additive to the config roles). Guardrails:

- A config or builtin role cannot be edited or deleted from the UI.
- A role still assigned to users cannot be deleted.
- You cannot delete or demote the **last** admin user.
- New roles are validated against the live schema — every referenced table,
  column and action must exist.

Users can also be provisioned offline with
[`steward user add`](/cli#steward-user-add).
