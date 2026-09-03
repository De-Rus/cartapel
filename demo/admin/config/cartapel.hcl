brand      = "cartapel"
# Compact mark for the collapsed rail; full lockups below for light/dark.
# public/ (not config/) because the login screen renders before there's a
# session, and only public/ is served with no auth.
brand_logo = "logo-mark.png"
per_page = 50

theme {
  logo_light = "logo-light.png"
  logo_dark  = "logo-dark.png"
}

# Public demo: the login is a full admin (so visitors see the real thing), but
# harden the two capabilities that would make an open admin weaponizable.
disable_sql_preview = true
disable_webhooks    = true

source "main" {
  type    = "postgres"
  url     = "env:CARTAPEL_DB"
  primary = true
}

# The panels on the Platform pages come from here. No `token_env`: this Grafana
# is on the private network only, with anonymous read, so the demo holds no
# secret to leak. On a Grafana anyone can reach, set `token_env` and give the
# service account the Viewer role.
#
# The browser never opens Grafana. cartapel asks the datasource proxy
# server-side and renders rows, which is why there is no iframe on those pages
# and no CORS, cookie or theme argument to have.
source "grafana" {
  type = "grafana"
  url  = "env:CARTAPEL_GRAFANA_URL"
}
