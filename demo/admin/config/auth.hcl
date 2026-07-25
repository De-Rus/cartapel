# The hosted demo skips login: anonymous visitors act as admin (public creds
# anyway); dangerous surfaces stay off via the hardening toggles + daily reset.
public_role = "admin"

role "support" {
  tables = {
    "*" = "read"
  }
  masked = {
    "subscriptions" = ["api_token"]
  }
}
