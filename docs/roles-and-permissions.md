---
description: "Roles in config you review like code: table levels, granular capabilities, inheritance, multi-role union, masking and row filters."
---

# Roles & permissions

Access is governed by **roles**. Each user carries one or more roles
(permissions union — see [Multiple roles per user](#multiple-roles-per-user));
a role grants access to
tables, columns, rows and actions. Roles are authoritative in
`config/auth.hcl` — versioned config you review like code. The in-app roles
screen edits that same file: creates, edits and deletes write `config/auth.hcl`
atomically and hot-swap the live config (on a read-only bundle it hands you the
HCL to commit yourself).

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
| `extends` | string | Parent role to inherit from — see [Role inheritance](#role-inheritance). |
| `customize` | bool | May open Personalizar and edit **table configs** (visual + raw HCL + version history). Config authorship — grant to trusted power users only; groups, dashboard, discover and access screens stay admin-only. Inherits through `extends` and unions across multiple roles. |
| `tables` | map | The coarse access level per table: `"read"` or `"write"`. `"*"` sets a default for every table. |
| `perm "<table>" { }` | block | Fine-grained per-capability override (view/create/update/delete). |
| `editable` | map | Per-table whitelist of columns this role may edit. |
| `actions` | list | Bulk actions this role may invoke, as `"<table>.<action>"`. |
| `masked` | map | Per-table columns whose values are hidden from this role. |
| `row_filter` | map | Per-table SQL predicate scoping which rows this role sees. |

## Role inheritance

A role can extend another with `extends` — the parent resolves first, then the
child's own entries override it key by key:

```hcl
role "viewer" {
  tables = { "*" = "read" }
}

role "support" {
  extends = "viewer"
  tables  = { "orders" = "write" }   # everything else stays read from viewer
}
```

- `tables`, `perm`, `editable`, `masked` and `row_filter` merge **per key**: a
  child entry for a table replaces the parent's entry for that table wholesale.
- `actions` is the **union** of parent and child.
- Chains are allowed (`a` → `b` → `c`). An `extends` naming an unknown role or
  forming a cycle is a startup/config error, and the runtime editors reject it
  with a 400 — a broken hierarchy never loads silently.
- The runtime Roles editor exposes this as the **Inherits from** selector,
  plus a **show effective permissions** toggle that renders the fully-resolved
  matrix (parents flattened in) read-only — what the role actually grants, not
  just its own overrides.

## Multiple roles per user

A user may carry several roles (comma-separated in the Users editor — chips in
the UI). Permissions are the **union**, Django-groups style:

- **Privileges add up**: table levels take the highest (`read` + `write` =
  `write`), granular `perm` capabilities OR together, `actions` union.
- **Restrictions hold only when every view-granting role imposes them**: a
  column stays masked only if masked in ALL roles that can see the table;
  `row_filter`s OR together (a role with no filter lifts the restriction);
  an `editable` whitelist applies only if every write-granting role has one
  (then the union of the lists).
- `admin` anywhere in the list makes the user an admin.

::: warning A broad role lifts restrictions
Because restrictions need unanimity, adding a generic role (e.g. a `viewer`
with `"*" = "read"` and no masks/filters) to a user whose other role masked
columns or filtered rows **unmasks and unfilters everything that role can
see**. Keep broad roles narrow, or give them the same masks.
:::

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

Independent of roles, secret-shaped column names auto-mask for everyone
(admins included), and a field-level `masked = true` binds admins too — see
[Security → Column masking](/security#column-masking).

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

Admins can manage roles and users from the in-app access screens. Role edits
write `config/auth.hcl` (atomically, versioned, hot-swapped); users live in
cartapel's SQLite state. Guardrails:

- The builtin `admin` role cannot be edited or deleted — and a new role named
  any casing of it (`Admin`, `ADMIN`) is rejected. Role names are 1–64 chars
  of letters, digits, `_` or `-`.
- A role still assigned to users cannot be deleted — reassign them first.
- A role other roles `extends` cannot be deleted — remove the inheritance first.
- You cannot delete or demote the **last** admin user.
- Role definitions are validated against the live schema — every referenced
  table, column and action must exist.
- On a read-only config bundle, role edits change nothing — the screen returns
  the would-be HCL for you to commit.

Users can also be provisioned offline with
[`cartapel user add`](/cli#cartapel-user-add).

## View as a role

An admin can **impersonate any other defined role** to verify exactly what it
sees — pick "View as" from the user menu. While impersonating:

- Every request is evaluated with the impersonated role's permissions, masking
  and row filters.
- The session is **read-only**: any mutation is rejected with a 403 until you
  exit.
- It **never escalates** — only admins are honored, and viewing as `admin` is a
  no-op.

A banner shows the active role the whole time; exit via the banner or the user
menu.
