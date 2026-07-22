label = "customer"
label_plural = "Customers"

list {
  columns = ["id", "name", "email", "country", "plan", "mrr", "active", "created_at"]
  search  = ["name", "email"]
  filters = ["plan", "country", "active"]
  sort    = "-created_at"
}

display {
  title = "{name}"
}

field "mrr" {
  format = "currency"
}
