# Prometheus and Grafana in one container, for the demo's `type = "grafana"`
# source. One machine rather than two because the pair is the smallest thing
# that can answer a PromQL query, and the demo pays for it by the month.
FROM prom/prometheus:v2.53.0 AS prom
FROM prom/node-exporter:v1.8.2 AS node

FROM grafana/grafana:11.1.0
USER root

COPY --from=prom /bin/prometheus /bin/prometheus
COPY --from=prom /usr/share/prometheus/consoles /usr/share/prometheus/consoles
COPY --from=prom /usr/share/prometheus/console_libraries /usr/share/prometheus/console_libraries
# CPU, memory, disk and network of the machine itself. Inside a Firecracker
# VM /proc is the VM's own, so these are this demo's real numbers.
COPY --from=node /bin/node_exporter /bin/node_exporter

COPY prometheus.yml /etc/prometheus/prometheus.yml
COPY provisioning /etc/grafana/provisioning
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /prometheus && chown -R grafana:root /prometheus

# Grafana's settings live in the image so the compose demo and the Fly machine
# behave identically — a fly.toml the local stack never reads is how the two
# drift apart.
#
# Anonymous ADMIN, not Viewer: cartapel resolves a datasource name to its uid
# and kind through `/api/datasources`, which Grafana reserves for admins. The
# reader gains nothing by it — the datasource is provisioned from a file, so it
# is read-only in the UI — and neither deployment gives this app a route from
# the internet.
#
# On a Grafana anyone can reach, do the opposite: leave anonymous off, mint a
# service-account token and name it with `token_env` in the source.
ENV GF_AUTH_ANONYMOUS_ENABLED=true \
    GF_AUTH_ANONYMOUS_ORG_ROLE=Admin \
    GF_AUTH_BASIC_ENABLED=false \
    GF_USERS_ALLOW_SIGN_UP=false \
    GF_ANALYTICS_REPORTING_ENABLED=false \
    GF_ANALYTICS_CHECK_FOR_UPDATES=false \
    GF_SERVER_HTTP_PORT=3000

USER grafana
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
