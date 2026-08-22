label = "payment"
label_plural = "Payments"

list {
  columns = ["id", "order_id", "method", "status", "amount", "captured_at"]
  search  = ["provider_ref"]
  filters = ["status", "method"]
  sort    = "-created_at"
}

display {
  title = "{provider_ref}"
}

field "amount" {
  format = "currency"
}
