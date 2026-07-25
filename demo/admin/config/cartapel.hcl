brand = "Acme Admin"
per_page = 50

# Public demo: the login is a full admin (so visitors see the real thing), but
# harden the two capabilities that would make an open admin weaponizable.
disable_sql_preview = true
disable_webhooks    = true

source "main" {
  type    = "postgres"
  url     = "env:CARTAPEL_DB"
  primary = true
}
