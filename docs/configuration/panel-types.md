---
description: "The four dashboard panel types — stat, chart, table, iframe — with keys and a worked example each."
---

# Panel types

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
