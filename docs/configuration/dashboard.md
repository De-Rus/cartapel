---
description: "SQL-defined dashboards: stat tiles, charts, tables, template variables and the window selector."
---

# Dashboard

The home dashboard is a grid of SQL-defined panels declared in
`config/dashboard.hcl`. Every panel's SQL runs read-only, so the dashboard can
never mutate your data.

```hcl
# config/dashboard.hcl
columns = 4

panel {
  type          = "stat"
  label         = "Orders 30d"
  category      = "Sales"
  sql           = "SELECT count(*) AS v FROM orders WHERE placed_at > now() - interval '30 days'"
  compare_sql   = "SELECT count(*) AS v FROM orders WHERE placed_at BETWEEN now() - interval '60 days' AND now() - interval '30 days'"
  compare_label = "prev 30d"
  spark         = "SELECT count(*) AS v FROM orders WHERE placed_at > now() - interval '30 days' GROUP BY date_trunc('day', placed_at) ORDER BY date_trunc('day', placed_at)"
  good_when     = "up"
}
```

## Grid

| Key | Type | Description |
| --- | --- | --- |
| `columns` | number | Number of grid columns the dashboard lays out. |

Panels flow into the grid in declaration order. Each may set its own `w` (column
span) and `h` (row span), and a `category` used to group panels under headings.

## Panel types

Set `type` to one of `stat`, `chart`, `table`, `iframe`.

### `stat` — a single number

A big-number tile with an optional period-over-period comparison and an inline
sparkline.

```hcl
panel {
  type          = "stat"
  label         = "Revenue 14d"
  category      = "Revenue"
  format        = "money"
  sql           = "SELECT coalesce(sum(total),0) AS v FROM orders WHERE placed_at > now() - interval '14 days'"
  compare_sql   = "SELECT coalesce(sum(total),0) AS v FROM orders WHERE placed_at BETWEEN now() - interval '28 days' AND now() - interval '14 days'"
  compare_label = "prev 14d"
  spark         = "SELECT coalesce(sum(total),0) AS v FROM ... GROUP BY date_trunc('day', placed_at) ORDER BY 1"
  good_when     = "up"
  alert_above   = 20
}
```

| Key | Description |
| --- | --- |
| `sql` | Returns a single numeric column `v` — the headline value. |
| `format` | `number`, `money`, `percent`, or `duration`. |
| `compare_sql` | A second `v` query for the comparison baseline; the tile shows the delta. |
| `compare_label` | Label for the comparison period (e.g. `prev 24h`). |
| `spark` | A query returning an ordered series of `v` values, drawn as an inline sparkline. |
| `good_when` | Which delta direction is favorable: `up` (default) paints a rising value green; `down` paints a falling value green (for errors, latency, …). |
| `alert_above` / `alert_below` | Thresholds that flag the tile as critical when the value rises above / falls below them. |

### `chart` — a time or category series

```hcl
panel {
  type     = "chart"
  label    = "Revenue per day (30d)"
  category = "Trends"
  format   = "money"
  chart    = "area"          # "line" | "bar" | "area"
  sql      = "SELECT date_trunc('day', placed_at) AS t, coalesce(sum(total),0) AS v FROM orders WHERE placed_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1"
}
```

| Key | Description |
| --- | --- |
| `chart` | Chart kind: `line`, `bar`, or `area`. |
| `sql` | Returns `t` (the x label/timestamp) and `v` (the numeric value) per row. |
| `format` | Value formatter for axes and tooltips. |

### `table` — a live query as rows

```hcl
panel {
  type     = "table"
  label    = "Past-due subscriptions"
  category = "Attention"
  link     = "subscriptions"   # rows deep-link into this table's records
  roles    = ["support"]
  sql      = "SELECT id, customer_id, product_id, status, renews_at FROM subscriptions WHERE status = 'past_due' ORDER BY renews_at NULLS FIRST LIMIT 10"
}
```

| Key | Description |
| --- | --- |
| `sql` | The rows to display; column set is taken from the query. |
| `link` | A table name — each row links to that table's matching record. |

A `table` panel can style its columns with repeated `field { }` blocks; without
them the column set comes straight from the query and cells fall back to
sensible defaults (headers humanized, ISO timestamps date-formatted):

```hcl
panel {
  type  = "table"
  label = "Top products"
  sql   = "SELECT name, revenue, status FROM …"

  field {
    key     = "revenue"
    format  = "money"
    align   = "right"
    display = "bar"          # in-cell data bar ("heat" tints by magnitude)
  }
  field {
    key   = "status"
    badge = { active = "green", churned = "red" }
  }
}
```

`field` keys: `key` (required), `label`, `format` (`money`/`percent`/`number`/
`bytes`/`duration`/`date`/`datetime`/`rel`, plus the aliases `currency`/`pct`/
`num`/`dur` — validated at load), `align`, `max`, `badge` (value → tone map),
`display` (`bar` | `heat`), `tone` (hue for badge-less dataviz: `accent`
default, or `green`/`red`/`orange`/`blue`/`violet`).

### `iframe` — an embedded view

```hcl
panel {
  type  = "iframe"
  label = "Grafana"
  url   = "https://grafana.example/d/abc"
}
```

`iframe` panels require a `url` instead of `sql`.

## Where a panel reads from

Every panel reads from exactly one origin. `sql` is the common case; the others
save you from repeating yourself or reach data that is not in the database.

| Key | Description |
| --- | --- |
| `sql` | Inline read-only SQL. |
| `query` | The name of a `query { }` block — it carries its own `source`, so one query can feed several panels. |
| `source` | An `http` source alias: cartapel fetches it server-side (the secret never reaches the browser) and renders the JSON array it returns. Pair with `path` for a sub-path and `rows_at` for a dotted path to the array inside the payload. |
| `table` | A configured table slug: the panel renders **that screen's own list** — its columns, widgets, formats and permissions — instead of raw query rows. `sort` and `pp` tune it. |

`pp` also raises the row cap on a `sql`, `query` or `source` table panel (50 by
default, 2000 at most) — useful when a listing source has more rows than a
dashboard tile would normally show.

```hcl
panel {
  type  = "table"
  label = "Latest orders"
  table = "orders"          # the configured screen, not a hand-written SELECT
  sort  = "-placed_at"
  pp    = 8
  link  = "orders"
}

panel {
  type    = "table"
  label   = "Cache coverage"
  source  = "cache_coverage"
  rows_at = "items"         # omit when the payload is the array itself
}
```

A `sql` panel may also carry `source` to run against a secondary database
rather than the primary one.

## Common panel keys

| Key | Applies to | Description |
| --- | --- | --- |
| `type` | all | `stat`, `chart`, `table`, `iframe`. **Required.** |
| `label` | all | The panel's title. **Required.** |
| `id` | all | Optional stable id; when omitted the panel is identified by its position. |
| `category` | all | Heading this panel groups under. |
| `w` / `h` | all | Column / row span in the grid. |
| `roles` | all | Restrict the panel to these roles. Omit → visible to all who can see the dashboard. |
| `link` | table | Target table for row links. |
| `url` | iframe | The embedded URL. |

## Template variables

Declare a variable once and every panel that references it grows a live
selector at the top of the dashboard — flip it and the whole grid re-queries in
place. The selection lives in the URL, so "the dashboard, last 90 days" is a
link you can send to a teammate.

Mechanically: `{{name}}` placeholders work in **every panel's `sql`,
`compare_sql` and `spark`**. They reference the global
[template variables](/configuration/pages-and-queries#template-variables)
declared in a `variables.hcl`, and are resolved **per request** from `v_<name>`
URL parameters (falling back to each variable's default) and bound as SQL
parameters — never string-spliced.

```hcl
panel {
  type  = "stat"
  label = "Orders"
  sql   = "SELECT count(*) AS v FROM orders WHERE placed_at > now() - {{window}} * interval '1 day'"
}
```

Whenever any variables are in scope, the dashboard renders a selector bar above
the grid — a **segmented control** when a variable has up to six options, a
select otherwise. Changing a value re-runs every panel that references it and
updates the URL (`?v_window=90`). A supplied value outside a variable's static
option set is a hard 400.

The common case has a shorthand — `type = "window"` declares a ready-made
time-window selector (7/30/90 days, default 30, label "Window", `int`
semantics), each part overridable by declaring it yourself:

```hcl
# variables.hcl
variable "days" {
  type = "window"
}
```

```sql
-- any panel:
… WHERE placed_at > now() - {{days}} * interval '1 day'
```

## Safety

Every dashboard and panel query runs in a **read-only transaction** with a
5-second statement timeout and hard row caps (500 chart points, 100 sparkline
points, 50 table rows). The visual dashboard editor additionally offers a
**preview** that runs a panel through the same read-only path and returns the
rendered result without writing anything to config. Like all config, the
dashboard is versioned — see [Architecture](/architecture#config-versioning).
