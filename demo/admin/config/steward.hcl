brand = "Acme Admin"
per_page = 50

# Public demo: pre-fill the read-only `demo` login so visitors enter in one click.
demo_login {
  user     = "demo"
  password = "demo"
}

source "main" {
  type    = "postgres"
  url     = "env:STEWARD_DB"
  primary = true
}
