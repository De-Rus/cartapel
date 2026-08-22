#!/bin/sh
# Prometheus in the background, Grafana in the foreground so the container's
# life is Grafana's. No `set -e`: a Prometheus that refuses to start must not
# take the panels with it — better an empty chart with a reason in the log
# than a machine that restarts forever.
/bin/node_exporter \
  --web.listen-address=127.0.0.1:9100 \
  --collector.disable-defaults \
  --collector.cpu --collector.meminfo --collector.loadavg \
  --collector.filesystem --collector.netdev &

/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time=6h \
  --web.listen-address=127.0.0.1:9090 &

exec /run.sh
