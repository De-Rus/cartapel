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

The grid packs **densely**: when a wide panel leaves a hole at the end of a row,
a later panel narrow enough to fit slides up into it rather than leaving a gap.
So `w = 3` in a four-column grid is not a mistake you have to correct by hand —
the next `w = 1` panel fills the remainder. The trade is that a panel can appear
earlier than you declared it; if a strict reading order matters more than a
tight layout, size the panels so each row adds up.

Stat tiles and the other panels pack as two separate rows within a category —
tiles first, then the rest — so a tile never slots into a hole left by a table.

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
| `format` | `number`, `money`, `percent`, `duration` or `bytes`. |
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
default, or `green`/`red`/`orange`/`blue`/`violet`), `wrap` (`true` lets a long
text run onto several lines instead of clipping — a log line, an error).

### `iframe` — an embedded view

```hcl
panel {
  type  = "iframe"
  label = "Grafana"
  url   = "https://grafana.example/d/abc"
}
```

`iframe` panels require a `url` instead of `sql`.

`{{theme}}` anywhere in the url is replaced with the viewer's actual theme
(`light` or `dark`), resolving `system` against the OS and re-rendering when
either changes — so an embedded panel follows the admin instead of staying on
whichever theme the config author happened to write:

```hcl
panel {
  type  = "iframe"
  label = "Host"
  url   = "https://grafana.example/d-solo/abc?panelId=13&refresh=1m&theme={{theme}}"
  w     = 2
  h     = 2
}
```

Embedding someone else's page is a negotiation with that server, not with
cartapel: it must allow framing (Grafana needs `allow_embedding`), and if it
requires a login the viewer needs a session with it — which for a cross-site
iframe means its session cookie must be `SameSite=None`.

## `refresh` — a live page

```hcl
label   = "Background jobs"
refresh = "30s"     # also accepts "5m", "1h", or a bare number of seconds
```

Set it on a page (`screen.hcl` / `page.hcl`) or on `config/dashboard.hcl`, and
the whole surface re-queries on that clock without a reload. Two guarantees
worth knowing, because they are what keep a live page from becoming a problem:

- **A hidden tab never polls.** A dashboard left open on a spare monitor would
  otherwise re-run every panel's SQL forever, all night.
- **There is a five-second floor.** Every poll re-runs *every* panel on the
  page, so a one-second dashboard is a load generator aimed at your production
  database. Faster values are raised to the floor rather than refused; a value
  of `0` or an unparseable one leaves the page static.

Pick the interval from how fast the underlying thing actually moves. A queue
depth or a fleet health count is worth 30s; a revenue chart is not worth more
than a few minutes. If a panel reads a `files` or `s3` source, remember the
listing has its own `ttl_secs` — polling faster than that just re-serves the
same cached scan.

## Where a panel reads from

Every panel reads from exactly one origin. `sql` is the common case; the others
save you from repeating yourself or reach data that is not in the database.

| Key | Description |
| --- | --- |
| `sql` | Inline read-only SQL. |
| `query` | The name of a `query { }` block — it carries its own `source`, so one query can feed several panels. |
| `source` | An `http` source alias: cartapel fetches it server-side (the secret never reaches the browser) and renders the JSON array it returns. Pair with `path` for a sub-path and `rows_at` for a dotted path to the array inside the payload. Or a `grafana` source alias — then the panel names a `ds` and an `expr` (below). |
| `table` | A configured table slug: the panel renders **that screen's own list** — its columns, widgets, formats and permissions — instead of raw query rows. `sort` and `pp` tune it. |

```hcl
panel {
  type  = "table"
  label = "Latest orders"
  query = "recent_orders"    # a query { } block declared elsewhere — see Pages & queries
}
```

On a table panel, `max` is how many rows travel to the browser (50 by default,
20000 at most) and `pp` is how many show at once — the panel pages through the
rest in place, and `search = true` adds a box that filters them. A listing with thousands of rows wants both: `max` high enough to
carry them, `pp` small enough to read.

`filter_by` adds a dropdown per column, above the rows:

```hcl
panel {
  type      = "table"
  label     = "Cached series"
  source    = "cache_fs"
  filter_by = ["source", "tf"]
  max       = 8000
  pp        = 25
  search    = true
}
```

The choices are the values the rows actually contain, so there is no list to
keep in sync and a filter can never offer something that matches nothing; a
column whose values are all the same is left out, since it could not narrow
anything. Filters apply before the search box and the pager, so searching within
a selection works as you would expect.

Use `filter_by` when the control belongs to one panel. Use a
[template variable](pages-and-queries.md#template-variables) when one control
should narrow the whole page — a variable travels into the SQL, so it can also
cut work at the database instead of in the browser.

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

### Metrics, logs and traces through Grafana

A `grafana` source turns any Grafana datasource — Prometheus, Loki, Tempo —
into panel rows, so an operations page mixes database numbers with metrics and
log lines and never opens Grafana's own UI. Cartapel asks through Grafana's
datasource proxy with one service-account token; it never learns where the
backends live, and the browser never sees the token.

```hcl
source "grafana" {
  type      = "grafana"
  url       = "http://grafana:3000"       # inside your network, or the public host
  token_env = "GRAFANA_TOKEN"            # a service account token, Viewer is enough
}
```

A panel then names the datasource (`ds`, by Grafana name or uid) and an `expr`
in that datasource's language:

```hcl
panel {                                  # PromQL — a stat reads the value now
  type      = "stat"
  label     = "Bots active"
  source    = "grafana"
  ds        = "prometheus"
  expr      = "sum(bots_active)"
  spark     = "sum(bots_active)"          # a second expr, drawn over `range`
  range     = "6h"
}

panel {                                  # PromQL over time — one line per series
  type   = "chart"
  label  = "Errors / 5m by container"
  source = "grafana"
  ds     = "loki"
  expr   = "sum by (container) (count_over_time({level=\"error\"}[5m]))"
  range  = "6h"
  step   = "5m"
}

panel {                                  # LogQL — log lines, newest first
  type   = "table"
  label  = "Errors — last hour"
  source = "grafana"
  ds     = "loki"
  expr   = "{level=\"error\"}"
  range  = "1h"
  max    = 100
  field {
    key    = "t"
    label  = "when"
    format = "datetime"
  }
  field {
    key = "node"
  }
  field {
    key  = "message"
    wrap = true
  }
}

panel {                                  # TraceQL — one row per trace
  type   = "table"
  label  = "Slow backtests"
  source = "grafana"
  ds     = "tempo"
  expr   = "{ name = \"backtest_job\" && duration > 5s }"
  range  = "24h"
  max    = 20
  field {
    key     = "duration_ms"
    format  = "number"
    align   = "r"
    display = "bar"
  }
}
```

What comes back, by datasource: a Prometheus (or Loki metric) query gives
`v` plus the series labels as columns — a stat takes the first value, a chart
draws one line per series over `range` at `step` (about 200 points unless
you say otherwise, never finer than 15s); a Loki log query gives `t`, `line`,
the stream labels, and `message` when the line is JSON carrying one; a Tempo
search gives `trace_id`, `service`, `name`, `started_at`, `duration_ms`.
A range query answers on the full window: every series is laid on the same
`range`/`step` grid, a slot without a sample is a gap (not a zero), so a chart
spans what was asked for even when the metric only existed for part of it, and
its series line up point for point. Grafana's `$__interval` (the step) and
`$__rate_interval` (a rate window that grows with the step) substitute inside
`expr`, so `rate(x[$__rate_interval])` reads sensibly at 15 minutes and at 7
days alike.

`{{variable}}` substitutes inside `expr` — and inside `range` and `step` — like
everywhere else, and `max` caps log lines and traces. That is how a page gets a
Grafana-style time picker: declare a `window` variable with the ranges you want
and write `range = "{{window}}"` on the panels; the variable bar shows the
choices, the URL carries the pick. A page's `refresh` may be a variable too
(`refresh = "{{refresh}}"`, with `off` among the options for "no clock").

For log lines and anything else that wants reading rather than scanning, a
`field { wrap = true }` lets the text run onto several lines, and `expand = true`
on the panel opens a clicked row beneath itself with every field of it in full —
the raw line, the labels the columns left out.

### Aggregating and filtering a listing

A SQL panel groups in SQL. A `files` or `s3` listing has no SQL to group in, so
a panel can fold the rows itself with a deliberately small vocabulary —
`count`, `count_distinct:col`, `sum:col`, `min:col`, `max:col`, each optionally
`as <alias>`:

```hcl
panel {
  type   = "stat"
  label  = "Total size"
  source = "cache"
  value  = "sum:bytes"
  format = "bytes"
}

panel {
  type     = "table"
  label    = "By feed"
  source   = "cache"
  group_by = "source"
  agg      = ["count as series", "count_distinct:symbol as symbols", "sum:bytes as bytes"]
}

panel {
  type      = "table"
  label     = "Series"
  source    = "cache"
  filter_by = ["source"]   # a dropdown on this panel, options from the rows
  max       = 8000
  pp        = 25
}
```

`filter_by` is the short way: the control sits on the panel and needs nothing
declared. When one control should drive *several* panels at once, promote it to
a [template variable](/configuration/dashboard#template-variables) whose options
come from the listing, and filter against it explicitly:

```hcl
variable "feed" {
  label  = "Feed"
  source = "cache"
  field  = "source"     # distinct values of this column become the options
}

panel {
  type   = "table"
  label  = "Series"
  source = "cache"
  filter = { source = "{{feed}}" }   # empty variable → no filtering
}
```

If you find yourself wanting a richer aggregate than the five above, that is a
sign the data wants a database in front of it — point a query engine at the
files and declare it as a database source instead.

## Common panel keys

| Key | Applies to | Description |
| --- | --- | --- |
| `type` | all | `stat`, `chart`, `table`, `iframe`. **Required.** |
| `label` | all | The panel's title. **Required.** |
| `id` | all | Optional stable id; when omitted the panel is identified by its position. |
| `category` | all | Heading this panel groups under. |
| `w` / `h` | all | Column / row span in the grid. |
| `roles` | all | Restrict the panel to these roles. Omit → visible to all who can see the dashboard. |
| `max` / `pp` | table | Rows carried, and rows per page inside the panel. |
| `search` | table | Adds a search box that filters the rows the panel carries. |
| `filter_by` | table | Columns offered as dropdowns on the panel; the options come from the rows themselves. |
| `expand` | table | A clicked row opens beneath itself with every field of it in full (panels without `link`). |
| `link` | table | Target table for row links. |
| `source` / `ds` / `expr` / `range` / `step` | stat, chart, table | A Grafana datasource query — see [Metrics, logs and traces through Grafana](#metrics-logs-and-traces-through-grafana). |
| `url` | iframe | The embedded URL. |

```hcl
panel {
  id     = "mrr"          # stable id — survives reordering panels
  type   = "table"
  label  = "Recent errors"
  sql    = "SELECT * FROM error_log ORDER BY ts DESC"
  expand = true            # a clicked row opens with every field in full
}
```

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
