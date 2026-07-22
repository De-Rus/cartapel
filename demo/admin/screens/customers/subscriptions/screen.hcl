label = "subscription"
label_plural = "Subscriptions"

list {
  columns = ["id", "customer_id", "product_id", "status", "started_at", "renews_at"]
  filters = ["status"]
  sort    = "-started_at"
}

field "api_token" {
  masked = true
}
