label   = "Machine"
columns = 4

# An hour, not longer: retention is six hours on ephemeral disk, so a machine
# that restarted an hour ago would draw a mostly-empty three-hour window and
# read as broken rather than as young.
#
# Real numbers from the machine this demo runs on — node_exporter inside the
# same Firecracker VM, so /proc is its own. Nothing here is seeded.

panel {
  type      = "stat"
  label     = "CPU busy"
  category  = "Machine"
  format    = "percent"
  source    = "grafana"
  ds        = "demo-prometheus"
  expr      = "100 * (1 - avg(rate(node_cpu_seconds_total{mode=\"idle\"}[5m])))"
  good_when = "down"
}

panel {
  type      = "stat"
  label     = "Memory used"
  category  = "Machine"
  format    = "percent"
  source    = "grafana"
  ds        = "demo-prometheus"
  expr      = "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)"
  good_when = "down"
}

panel {
  type     = "stat"
  label    = "Load (1m)"
  category = "Machine"
  format   = "number"
  source   = "grafana"
  ds       = "demo-prometheus"
  expr     = "node_load1"
}

panel {
  type      = "stat"
  label     = "Disk free"
  category  = "Machine"
  format    = "percent"
  source    = "grafana"
  ds        = "demo-prometheus"
  # By filesystem type, not by mountpoint: in a container node_exporter sees
  # the container's mounts (`/etc/hostname` and friends) and never a plain
  # `/`, so a mountpoint filter works on the Fly machine and silently
  # returns nothing under `docker compose`.
  expr      = "min(100 * node_filesystem_avail_bytes{fstype=~\"ext4|xfs\"} / node_filesystem_size_bytes{fstype=~\"ext4|xfs\"})"
  good_when = "up"
}

panel {
  type   = "chart"
  label  = "CPU by mode"
  w      = 2
  h      = 2
  source = "grafana"
  ds     = "demo-prometheus"
  expr   = "sum by (mode) (rate(node_cpu_seconds_total{mode!=\"idle\"}[5m]))"
  range  = "1h"
  step   = "1m"
}

panel {
  type   = "chart"
  label  = "Memory in use"
  w      = 2
  h      = 2
  source = "grafana"
  ds     = "demo-prometheus"
  expr   = "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes"
  range  = "1h"
  step   = "1m"
}

panel {
  type   = "chart"
  label  = "Network in / out"
  w      = 4
  h      = 2
  source = "grafana"
  ds     = "demo-prometheus"
  expr   = "sum by (device) (rate(node_network_receive_bytes_total{device!=\"lo\"}[5m]))"
  range  = "1h"
  step   = "1m"
}
