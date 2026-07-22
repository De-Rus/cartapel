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
label        = "instrument"        # singular label
label_plural = "Instruments"       # plural label (nav + list heading)

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
  columns = ["id", "symbol", "exchange", "asset_class", "active"]
  search  = ["symbol", "name", "base"]
  filters = ["source", "asset_class", "active"]
  sort    = "-id"
  per_page = 50

  filter_def "no_logo" {
    label = "Missing logo"
    sql   = "NOT EXISTS (SELECT 1 FROM markets.logos l WHERE l.symbol = t.symbol AND l.status = 'ok')"
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
  sql   = "t.mode <> 'off' AND (t.last_error IS NOT NULL OR t.last_eval_at < now() - interval '30 minutes')"
}
```

List `"needs_attention"` in `filters` to surface it as a toggle in the UI.

## `display { }` — the record title

```hcl
display {
  title = "{symbol} · {exchange}"
}
```

`title` is a template with `{column}` placeholders, used wherever a single
record needs a human label (detail heading, breadcrumbs, inline row labels).
Omit it and steward falls back to the primary key.

## `edit { }` — read-only columns

```hcl
edit {
  readonly = ["id", "source", "symbol", "created_at"]
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
    fields = ["id", "symbol", "name", "exchange"]
  }
  section {
    title  = "Status"
    fields = ["active", "has_logo"]
  }
}
```

## `relations { }` — inline child tables

Also covered in [Detail views](/configuration/detail-views#inlines):

```hcl
relations {
  inlines = ["bot_signals", "bot_notifications"]
}
```

## `field "col" { }` — per-column presentation

Each `field` block styles one column: its widget, formatting, color rules,
computed SQL, and more. This is the heart of customization —
[Fields & widgets](/configuration/fields-and-widgets) covers every option.

```hcl
field "asset_class" {
  widget = "badge"
  params = { colors = { crypto = "orange", stock = "blue", etf = "violet" } }
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
  confirm = "Deactivate {count} instruments?"
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
# screens/bots-live/bots/screen.hcl
label        = "bot"
label_plural = "Bots"

list {
  columns  = ["name", "user_id", "mode", "status", "signals_24h", "last_eval_at", "last_error"]
  search   = ["name", "user_id", "strategy_name"]
  filters  = ["mode", "status", "timeframe"]
  sort     = "-created_at"

  filter_def "needs_attention" {
    label = "Needs attention"
    sql   = "t.mode <> 'off' AND (t.last_error IS NOT NULL OR t.status IN ('error','halted') OR t.last_eval_at < now() - interval '30 minutes')"
  }
}

display { title = "{name}" }

detail {
  section { title = "Identity"  fields = ["name", "id", "user_id", "strategy_name"] }
  section { title = "Runtime"   fields = ["mode", "status", "last_eval_at", "signals_24h", "last_error"] }
}

edit        { readonly = ["id", "user_id", "created_at"] }
relations   { inlines  = ["bot_signals", "bot_notifications"] }
permissions { create = false, delete = false }

field "mode" {
  widget = "badge"
  params = { colors = { off = "gray", alerts_only = "blue", live = "green" } }
}

field "signals_24h" {
  label  = "Signals 24h"
  widget = "custom:minibar"
  sql    = "(SELECT count(*) FROM markets.bot_signals s WHERE s.bot_id = t.id AND s.created_at > now() - interval '24 hours')::int"
  params = { field = "signals_24h", max = 50, warn_at = 40 }
}

action "pause" {
  label   = "Pause (mode off)"
  kind    = "update"
  set     = { mode = "off" }
  confirm = "Pause {count} bots? They stop evaluating immediately."
  danger  = true
}
```
