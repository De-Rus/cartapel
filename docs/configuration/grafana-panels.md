---
description: "Prometheus, Loki and Tempo as dashboard panel rows through a grafana source — PromQL/LogQL/TraceQL examples, $__interval substitution, a Grafana-style time picker, and embedding a Grafana panel directly as an iframe."
---

# Grafana panels

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
