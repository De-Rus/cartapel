label = "refund"
label_plural = "Refunds"

list {
  columns = ["id", "order_id", "amount", "reason", "created_at"]
  search  = ["reason"]
  sort    = "-created_at"
}

display {
  title = "Refund #{id}"
}

field "amount" {
  format = "currency"
}
