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

Set `type` to one of `stat`, `chart`, `table`, `iframe` — keys and a worked
example for each on its own page: [Panel types](/configuration/panel-types).

## `refresh` — a live page

<details>
<summary>Show</summary>

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

</details>

## Where a panel reads from

<details>
<summary>Show</summary>

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

A `grafana` source turns Prometheus, Loki and Tempo into panel rows — full
query examples, `$__interval` substitution and a Grafana-style time picker
are on their own page: [Grafana panels](/configuration/grafana-panels).

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

</details>

## Common panel keys

<details>
<summary>Show</summary>

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
| `source` / `ds` / `expr` / `range` / `step` | stat, chart, table | A Grafana datasource query — see [Grafana panels](/configuration/grafana-panels). |
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

</details>

## Template variables

<details>
<summary>Show</summary>

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

</details>

## Safety

<details>
<summary>Show</summary>

Every dashboard and panel query runs in a **read-only transaction** with a
5-second statement timeout and hard row caps (500 chart points, 100 sparkline
points, 50 table rows). The visual dashboard editor additionally offers a
**preview** that runs a panel through the same read-only path and returns the
rendered result without writing anything to config. Like all config, the
dashboard is versioned — see [Architecture](/architecture#config-versioning).

</details>

