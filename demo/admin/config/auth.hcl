role "support" {
  tables = {
    "*" = "read"
  }
  masked = {
    "subscriptions" = ["api_token"]
  }
}
