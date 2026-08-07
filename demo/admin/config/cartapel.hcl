brand      = "cartapel"
# Compact mark for the collapsed rail; full lockups below for light/dark.
brand_logo = "config/widgets/logo-mark.png"
per_page = 50

theme {
  logo_light = "config/widgets/logo-light.png"
  logo_dark  = "config/widgets/logo.png"
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
