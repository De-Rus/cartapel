label   = "Services"
columns = 4

panel {
  type      = "stat"
  label     = "Targets up"
  category  = "Scraping"
  format    = "number"
  source    = "grafana"
  ds        = "demo-prometheus"
  expr      = "sum(up)"
  good_when = "up"
}

panel {
  type     = "stat"
  label    = "Series in memory"
  category = "Scraping"
  format   = "number"
  source   = "grafana"
  ds       = "demo-prometheus"
  expr     = "prometheus_tsdb_head_series"
}

panel {
  type     = "stat"
  label    = "Samples / s"
  category = "Scraping"
  format   = "number"
  source   = "grafana"
  ds       = "demo-prometheus"
  expr     = "rate(prometheus_tsdb_head_samples_appended_total[5m])"
}

panel {
  type      = "stat"
  label     = "Grafana errors / 5m"
  category  = "Serving"
  format    = "number"
  source    = "grafana"
  ds        = "demo-prometheus"
  # `or vector(0)` because an absent series is not an absent panel: with no
  # 5xx yet the query returns nothing and the stat reads blank, which looks
  # broken rather than healthy.
  expr      = "sum(rate(grafana_http_request_duration_seconds_count{statuscode=~\"5..\"}[5m])) or vector(0)"
  good_when = "down"
}

panel {
  type   = "chart"
  label  = "Grafana requests by status"
  w      = 2
  h      = 2
  source = "grafana"
  ds     = "demo-prometheus"
  expr   = "sum by (statuscode) (rate(grafana_http_request_duration_seconds_count[5m]))"
  range  = "1h"
  step   = "1m"
}

panel {
  type   = "chart"
  label  = "Scrape duration by job"
  w      = 2
  h      = 2
  source = "grafana"
  ds     = "demo-prometheus"
  expr   = "scrape_duration_seconds"
  range  = "1h"
  step   = "1m"
}

# A table asks for a RANGE — only a stat reads the value now — so "targets
# right now" as a table is one row per sample. What the data actually is, is a
# line per target that sits at 1 and dips when something stops answering.
panel {
  type   = "chart"
  label  = "Target up / down"
  w      = 4
  h      = 2
  source = "grafana"
  ds     = "demo-prometheus"
  expr   = "up"
  range  = "1h"
  step   = "1m"
}
